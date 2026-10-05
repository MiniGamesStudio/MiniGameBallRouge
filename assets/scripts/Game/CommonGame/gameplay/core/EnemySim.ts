/**
 * 敌人仿真（纯逻辑层，不依赖 cc）—— 需求 2/3 的核心实现
 *
 * 状态机（策划案 §9）：
 *   Spawning  出生缩放动画（不参与碰撞）
 *   Falling   随**世界滚动**下移（v1.10：敌人自身不动，被背景带着走，见 core/ScrollWorld.ts）
 *   Telegraph 自身矩形底边越过俯冲线后，等待 diveTelegraph 秒（此期间可被击杀）
 *   Diving    放大后快速飞向玩家并缩小，抵达玩家即造成伤害并消失
 *   Dead      已死亡，等待回收
 */

import { Box, EnemyRuntime, EnemyState } from './GameTypes';
import { GameTuning } from './GameTuning';
import { boxFromCells, distance } from './BoardMath';
import { diveDamage } from './MathModels';

/** 敌人仿真需要的外部信息 */
export interface EnemyWorld {
    /** 玩家当前位置 */
    playerX: number;
    playerY: number;
    /**
     * 本帧**世界滚动位移** px（> 0 = 世界向下滚）。
     *
     * v1.10：敌人**不再自己下落**（不再用 `enemy.speed × dt`），Falling 分支一律
     * `enemy.y -= world.scrollDelta`。该值由 `BattleView` 的**唯一滚动源**给出
     * （= 当前波 `waveScaling(wave).fallSpeed × dt`，**世界暂停时为 0**），
     * 与背景用的是**同一个值** → 敌人与背景永远锁步。
     *
     * ⚠️ 故意做成**必填**：这样"另算一套速度"在编译期就过不去。
     * 俯冲（Diving）是敌人**自身**的扑击动作、不是世界滚动，仍走 `diveSpeed`。
     */
    scrollDelta: number;
    /** 俯冲撞到玩家时的回调（结算伤害，由玩法层处理） */
    onDiveHitPlayer?(enemy: EnemyRuntime, damage: number): void;
    /** 敌人抵达俯冲终点（消失在屏幕外）时的回调 */
    onDiveFinished?(enemy: EnemyRuntime): void;
}

export interface EnemyStepResult {
    /** 本帧开始俯冲（放大演出用） */
    startedDive: boolean;
    /** 本帧撞到玩家 */
    hitPlayer: boolean;
    /** 本帧俯冲结束（飞出屏幕） */
    finished: boolean;
}

/** 敌人的判定矩形（当前状态与坐标） */
export function enemyBox(enemy: EnemyRuntime): Box {
    return boxFromCells(enemy.x, enemy.y, enemy.cols, enemy.rows);
}

/** 敌人矩形底边 y */
export function enemyBottomY(enemy: EnemyRuntime): number {
    return enemy.y - (enemy.rows * GameTuning.cellSize) * 0.5;
}

/** 是否已经越过俯冲线（用自身矩形底边判断） */
export function hasCrossedDiveLine(enemy: EnemyRuntime): boolean {
    return enemyBottomY(enemy) <= GameTuning.diveLineY;
}

/**
 * 推进一个敌人的状态机
 * @param enemy 敌人数据（原地修改）
 * @param dt 帧间隔
 * @param world 世界信息
 */
export function stepEnemy(enemy: EnemyRuntime, dt: number, world: EnemyWorld): EnemyStepResult {
    const result: EnemyStepResult = { startedDive: false, hitPlayer: false, finished: false };
    if (!enemy || dt <= 0) return result;
    if (enemy.state === EnemyState.Dead) return result;

    enemy.stateTime += dt;

    switch (enemy.state) {
        case EnemyState.Spawning: {
            // 出生缩放动画（0.6 → 1.0），动画结束才开始下落
            if (enemy.stateTime >= GameTuning.spawnScaleTime) {
                enemy.state = EnemyState.Falling;
                enemy.stateTime = 0;
            }
            break;
        }

        case EnemyState.Falling: {
            // 被同列队首挡住时原地不动（队首恢复移动或被消灭后自动继续下落）
            if (enemy.blocked) break;
            // v1.10：位移量来自**世界滚动**（与背景同一个 delta），不再用 enemy.speed × dt。
            // 世界暂停（任一敌人停住）时 scrollDelta = 0 → 这一句天然什么都不做。
            enemy.y -= world.scrollDelta;
            if (hasCrossedDiveLine(enemy)) {
                // 越线后进入 1 s 判定等待：站住不动，此时仍可被击杀（§9.4）
                enemy.state = EnemyState.Telegraph;
                enemy.stateTime = 0;
            }
            break;
        }

        case EnemyState.Telegraph: {
            if (enemy.stateTime >= GameTuning.diveTelegraph) {
                startDive(enemy, world);
                result.startedDive = true;
            }
            break;
        }

        case EnemyState.Diving: {
            const dx = enemy.diveTargetX - enemy.x;
            const dy = enemy.diveTargetY - enemy.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const step = GameTuning.diveSpeed * dt;

            if (len <= step || len <= 1e-4) {
                // 抵达锁定目标点：只有玩家仍在判定半径内才算命中（可以走位躲开，§9.4）
                enemy.x = enemy.diveTargetX;
                enemy.y = enemy.diveTargetY;
                if (distance(enemy.x, enemy.y, world.playerX, world.playerY) <= GameTuning.diveHitRadius) {
                    world.onDiveHitPlayer?.(enemy, diveDamage(enemy.shape));
                    result.hitPlayer = true;
                }
                killEnemy(enemy);
                result.finished = true;
                world.onDiveFinished?.(enemy);
                break;
            }

            enemy.x += (dx / len) * step;
            enemy.y += (dy / len) * step;

            // 飞过头（玩家移动导致目标点过时）也算抵达：判定半径内的碰撞
            if (distance(enemy.x, enemy.y, world.playerX, world.playerY) <= GameTuning.diveHitRadius) {
                const damage = diveDamage(enemy.shape);
                world.onDiveHitPlayer?.(enemy, damage);
                result.hitPlayer = true;
                killEnemy(enemy);
                break;
            }

            // 飞出屏幕也算结束（目标点在屏幕内时不会发生，兜底用）
            if (isOutsideScreen(enemy)) {
                killEnemy(enemy);
                result.finished = true;
                world.onDiveFinished?.(enemy);
            }
            break;
        }

        default:
            break;
    }

    return result;
}

/**
 * 全场停止（需求）：只要**任意一个**敌人停住不动（到底站住 Telegraph、或被冰冻 / 眩晕等技能定住 frozen），
 * **所有**敌人一律停止下落；该敌人被消灭或恢复后，全场自动恢复移动。
 * 每帧调用一次，纯函数，原地改写 enemy.blocked。
 *
 * v1.10：这个返回值就是**世界暂停标志** —— `BattleView.updateScroll()` 把它交给
 * `ScrollWorld.effectiveScrollDelta()`，于是暂停时 `delta = 0`，
 * **背景与敌人（整个世界）一起停住**，恢复后一起继续。
 *
 * @returns 本帧是否处于「世界暂停」（true = 有敌人停住 → 世界滚动 delta 必须为 0）
 */
export function applyStopBlocking(enemies: EnemyRuntime[]): boolean {
    const anyStopped = enemies.some(isEnemyStopped);
    for (const e of enemies) e.blocked = anyStopped;
    return anyStopped;
}

/** 是否"停住不动"：只看结果、不问原因（到底站住 Telegraph，或被技能定住 frozen） */
export function isEnemyStopped(enemy: EnemyRuntime): boolean {
    return enemy.state === EnemyState.Telegraph || enemy.frozen === true;
}

/** 开始俯冲：锁定玩家当前位置 */
export function startDive(enemy: EnemyRuntime, world: Pick<EnemyWorld, 'playerX' | 'playerY'>): void {
    enemy.state = EnemyState.Diving;
    enemy.stateTime = 0;
    enemy.diveTargetX = world.playerX;
    enemy.diveTargetY = world.playerY;
}

/** 标记死亡 */
export function killEnemy(enemy: EnemyRuntime): void {
    enemy.state = EnemyState.Dead;
    enemy.stateTime = 0;
    enemy.hp = 0;
}

/** 是否已死在场上（等待回收） */
export function isDead(enemy: EnemyRuntime): boolean {
    return enemy.state === EnemyState.Dead;
}

/** 是否可被子弹命中（出生动画与死亡状态不参与碰撞） */
export function isHittable(enemy: EnemyRuntime): boolean {
    return enemy.state === EnemyState.Falling
        || enemy.state === EnemyState.Telegraph
        || enemy.state === EnemyState.Diving;
}

/**
 * 兜底自动瞄准：在候选里挑「**最近的可命中敌人**」（附录 J）
 *
 * 纯函数，不改任何状态；过滤规则与子弹一致（`isHittable` + 血量 > 0），
 * 所以自动瞄准不会去锁一个「子弹打不到」的敌人。
 * 距离用**中心距**（不做到矩形的最近点投影）：目标只是给玩家一个大方向，
 * 而且大怪的占格越大中心越远，中心距能天然偏好近处的小怪，手感更稳。
 *
 * @returns 没有可命中敌人时返回 null（调用方应保持上一次瞄准方向）
 */
export function pickAutoAimTarget(
    playerX: number,
    playerY: number,
    enemies: readonly EnemyRuntime[]
): EnemyRuntime | null {
    let best: EnemyRuntime | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        if (!enemy || !isHittable(enemy) || enemy.hp <= 0) continue;
        const d = distance(playerX, playerY, enemy.x, enemy.y);
        if (d < bestDist) {
            bestDist = d;
            best = enemy;
        }
    }
    return best;
}

/** 当前视觉缩放：出生 0.6→1、俯冲放大到 1.35 再缩到 0.5 */
export function enemyVisualScale(enemy: EnemyRuntime): number {
    if (enemy.state === EnemyState.Spawning) {
        const t = Math.min(1, enemy.stateTime / Math.max(0.0001, GameTuning.spawnScaleTime));
        return GameTuning.spawnScaleFrom + (1 - GameTuning.spawnScaleFrom) * t;
    }
    if (enemy.state === EnemyState.Diving) {
        const t = Math.min(1, enemy.stateTime / Math.max(0.0001, GameTuning.diveScaleUpTime));
        return GameTuning.diveScaleUp + (GameTuning.diveScaleDown - GameTuning.diveScaleUp) * t;
    }
    return 1;
}

/** 飞出屏幕（含边距） */
function isOutsideScreen(enemy: EnemyRuntime): boolean {
    const halfW = GameTuning.designWidth * 0.5;
    const halfH = GameTuning.designHeight * 0.5;
    const margin = GameTuning.cellSize;
    return (
        enemy.x < -halfW - margin ||
        enemy.x > halfW + margin ||
        enemy.y < -halfH - margin ||
        enemy.y > halfH + margin
    );
}