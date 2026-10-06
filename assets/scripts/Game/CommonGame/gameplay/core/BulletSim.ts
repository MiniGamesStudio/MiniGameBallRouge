/**
 * 子弹仿真（纯逻辑层，不依赖 cc）—— 需求 1 的核心实现
 *
 * 三条铁律（策划案 §6.1）：
 *   1. 子弹有限且循环使用：撞敌人、撞墙都只反弹不消失，只有飞回玩家才回收；
 *   2. 撞到底墙必定回家：底墙转入回身、锁定玩家直飞；顶/左/右墙与敌人只反弹；
 *   3. 回身中的子弹穿过敌人、不结算伤害、不被挡下。
 *
 * 防穿模：每帧位移按 maxSubStepDistance 拆成小步逐段检测（§6.2）。
 * 去重：同一接触窗口内同一敌人只结算一次，离开接触后重新计数（§6.4）。
 */

import { BulletKind, BulletRuntime, BulletState, EnemyRuntime } from './GameTypes';
import { GameTuning } from './GameTuning';
import { BoxHit, ScreenBounds, boxFromCells, circleBoxHit, distance, screenBounds } from './BoardMath';

/** 接触判定的额外容差：贴边时不反复进出接触窗口，避免重复扣血 */
const CONTACT_EPSILON = 1;

/**
 * 参与「镜面反射」的边界：顶 / 左 / 右墙。
 * 底墙是唯一例外——它不反射，而是让子弹转入回身（§6.3 铁律 2），所以不在这组里。
 */
export type WallBounds = Pick<ScreenBounds, 'left' | 'right' | 'top'>;

/** 仿真需要的外部世界信息 */
export interface BulletWorld {
    /** 玩家当前位置 */
    playerX: number;
    playerY: number;
    /** 回收半径（玩家判定半径 + 子弹半径 + 技能加成） */
    catchRadius: number;
    /** 查询可能与圆相交的敌人（实现方可用格子加速） */
    queryEnemies(x: number, y: number, radius: number): readonly EnemyRuntime[];
    /** 命中敌人：只做伤害结算，反弹由仿真处理 */
    onEnemyHit?(bullet: BulletRuntime, enemy: EnemyRuntime): void;
    /** 转入回身状态（音效 / 特效） */
    onReturn?(bullet: BulletRuntime): void;
    /** 被回收（音效 / 弹匣返还） */
    onCaught?(bullet: BulletRuntime): void;
}

export interface BulletStepResult {
    /** 本帧被回收 */
    caught: boolean;
    /** 本帧转入回身 */
    returned: boolean;
    /** 本帧结算的命中次数（已去重） */
    hitCount: number;
}

/** 新建一发子弹 */
export function createBullet(
    id: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    fromMagazine: boolean = true,
    kind: BulletKind = BulletKind.Magazine
): BulletRuntime {
    return {
        id,
        x,
        y,
        vx,
        vy,
        state: BulletState.Flying,
        armed: false,
        life: 0,
        hitSet: new Set<number>(),
        fromMagazine,
        kind,
        // 名义速度 = 出膛速率。回程与超时判定都以它为准，
        // 所以「速度倍率」类技能（闪电弹 speedMul）出膛与回家是一致的
        speed: Math.sqrt(vx * vx + vy * vy),
    };
}

/** 由「起点 → 目标点」计算初速度（开火方向 = 玩家 → 游标） */
export function aimVelocity(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    speed: number
): { vx: number; vy: number } {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 1e-6) {
        // 退化：朝正上方（游标与玩家重合时的默认朝向）
        return { vx: 0, vy: speed };
    }
    return { vx: (dx / len) * speed, vy: (dy / len) * speed };
}

/** 当前速率 */
export function bulletSpeedOf(bullet: BulletRuntime): number {
    return Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
}

/**
 * 推进一发子弹
 * @param bullet 子弹数据（原地修改）
 * @param dt 帧间隔（s）
 * @param world 世界信息
 */
export function stepBullet(bullet: BulletRuntime, dt: number, world: BulletWorld): BulletStepResult {
    const result: BulletStepResult = { caught: false, returned: false, hitCount: 0 };
    if (!bullet || dt <= 0) return result;

    const radius = GameTuning.bulletRadius;
    const bounds = screenBounds();
    bullet.life += dt;

    // 兜底：存活超时强制回身（防止近水平子弹永远回不来）
    if (bullet.state === BulletState.Flying && bullet.life >= GameTuning.maxBulletLife) {
        enterReturning(bullet, world, result);
    }
    if (bullet.state === BulletState.Returning) {
        aimAtPlayer(bullet, world);
    }

    // 子步进：把本帧位移拆成不超过 maxSubStepDistance 的小步，逐步检测
    const travel = bulletSpeedOf(bullet) * dt;
    const steps = Math.max(
        1,
        Math.min(GameTuning.maxSubStepCount, Math.ceil(travel / GameTuning.maxSubStepDistance))
    );
    const subDt = dt / steps;

    for (let i = 0; i < steps; i++) {
        // 回身的子弹每小步重新锁定玩家，保证玩家一边移动也不会 miss
        if (bullet.state === BulletState.Returning) {
            aimAtPlayer(bullet, world);
        }

        bullet.x += bullet.vx * subDt;
        bullet.y += bullet.vy * subDt;

        if (bullet.state === BulletState.Flying) {
            // (1) 底墙（玩家身后）：不反射，转入回身
            if (hitsBottomWall(bullet.y, radius, bounds)) {
                bullet.y = bounds.bottom + radius;
                enterReturning(bullet, world, result);
            }

            // (2) 顶 / 左 / 右墙：标准镜面反射
            if (bullet.state === BulletState.Flying) {
                bounceWalls(bullet, bounds, radius);
                // (3) 敌人：最浅轴弹开 + 去重结算
                resolveEnemyHits(bullet, world, result);
            }
        }

        // (4) 回收判定：回身子弹与主动接弹共用
        updateArmed(bullet, world);
        if (bullet.armed && distance(bullet.x, bullet.y, world.playerX, world.playerY) <= world.catchRadius) {
            result.caught = true;
            world.onCaught?.(bullet);
            return result;
        }
    }

    pruneHitSet(bullet, world);
    return result;
}

/** 转入回身状态：锁定玩家直飞、穿透敌人、强制 armed */
export function enterReturning(bullet: BulletRuntime, world: BulletWorld, result?: BulletStepResult): void {
    if (bullet.state === BulletState.Returning) return;
    bullet.state = BulletState.Returning;
    // 回身时强制 armed：子弹完全可能在捕捉圈内部撞到底墙，
    // 不强制置位就会永远贴着玩家打转、回收不掉（§6.3）
    bullet.armed = true;
    bullet.hitSet.clear();
    aimAtPlayer(bullet, world);
    if (result) result.returned = true;
    world.onReturn?.(bullet);
}

/**
 * 朝玩家当前位置调整速度方向。
 *
 * 速率取 `bullet.speed`（出膛时的名义速率）× `returnSpeedScale`，**不是**写死的
 * `GameTuning.bulletSpeed` —— 否则带速度倍率的子弹（闪电弹 speedMul 1.6）只有出膛那一段快、
 * 回家照样爬，回收节奏被慢回程拖住，"闪电快得多"在手感上就不成立。
 * 老存档 / 手工构造的子弹没有 speed 时退回基准速度。
 */
function aimAtPlayer(bullet: BulletRuntime, world: BulletWorld): void {
    const nominal = bullet.speed && bullet.speed > 0 ? bullet.speed : GameTuning.bulletSpeed;
    const speed = nominal * GameTuning.returnSpeedScale;
    const dir = aimVelocity(bullet.x, bullet.y, world.playerX, world.playerY, speed);
    bullet.vx = dir.vx;
    bullet.vy = dir.vy;
}

/** 顶 / 左 / 右墙镜面反射（底墙不在这里处理） —— 直接改子弹 */
function bounceWalls(bullet: BulletRuntime, bounds: WallBounds, radius: number): void {
    const next = reflectOffWalls(bullet.x, bullet.y, bullet.vx, bullet.vy, radius, bounds);
    bullet.x = next.x;
    bullet.y = next.y;
    bullet.vx = next.vx;
    bullet.vy = next.vy;
}

/**
 * 顶 / 左 / 右墙的**标准镜面反射**：把圆心推回墙内侧，并翻转对应轴的速度分量。
 *
 * ⚠️ 这是全工程**唯一**的墙体反射实现：子弹仿真（`stepBullet`）与瞄准辅助射线
 * （`AimGuide.traceAimGuide`）都调它，保证「辅助射线」与「真实弹道」不会各写一套规则后慢慢跑偏。
 *
 * 反射规则（§6.2）：左墙 → `vx = +|vx|`、右墙 → `vx = -|vx|`、顶墙 → `vy = -|vy|`；
 * 入射角 = 反射角（法线沿轴，所以只需翻转该轴分量，另一轴分量保持不变）。
 * 撞到角落（同一子步同时贴到左/右墙与顶墙）时两个分量一起翻转，与 `stepBullet` 的子步行为一致。
 *
 * @returns 反射后的位置与速度（不修改入参，纯函数）
 */
export function reflectOffWalls(
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    bounds: WallBounds
): { x: number; y: number; vx: number; vy: number } {
    let nx = x;
    let ny = y;
    let nvx = vx;
    let nvy = vy;

    if (nx - radius <= bounds.left) {
        nx = bounds.left + radius;
        nvx = Math.abs(nvx);
    } else if (nx + radius >= bounds.right) {
        nx = bounds.right - radius;
        nvx = -Math.abs(nvx);
    }
    if (ny + radius >= bounds.top) {
        ny = bounds.top - radius;
        nvy = -Math.abs(nvy);
    }
    return { x: nx, y: ny, vx: nvx, vy: nvy };
}

/**
 * 是否撞到底墙（回身线）：`圆心 y − 半径 ≤ 底边`。
 * 底墙**不反射**——真实子弹在这里转入回身直飞玩家（§6.3 铁律 2），
 * 所以瞄准辅助射线画到这里就结束，不假装它会弹回来。同样由仿真与射线共用。
 */
export function hitsBottomWall(y: number, radius: number, bounds: Pick<ScreenBounds, 'bottom'>): boolean {
    return y - radius <= bounds.bottom;
}

/** 敌人命中：最浅穿透轴弹开 + 接触窗口去重 */
function resolveEnemyHits(bullet: BulletRuntime, world: BulletWorld, result: BulletStepResult): void {
    const radius = GameTuning.bulletRadius;
    const enemies = world.queryEnemies(bullet.x, bullet.y, radius);
    if (!enemies || enemies.length === 0) return;

    let bounce: BoxHit | null = null;
    for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        const box = boxFromCells(enemy.x, enemy.y, enemy.cols, enemy.rows);
        const hit = circleBoxHit(bullet.x, bullet.y, radius, box);
        if (!hit) continue;

        // 同一接触窗口内只结算一次
        if (!bullet.hitSet.has(enemy.id)) {
            bullet.hitSet.add(enemy.id);
            result.hitCount++;
            world.onEnemyHit?.(bullet, enemy);
        }
        // 多个敌人同时接触时，按穿透更浅的那个弹开
        if (!bounce || hit.depth < bounce.depth) bounce = hit;
    }

    if (bounce) applyBounce(bullet, bounce);
}

/**
 * 敌人（矩形）的**镜面反射**：按 `circleBoxHit` 给出的最浅穿透轴，翻转对应轴的速度分量。
 *
 * ⚠️ 这是全工程**唯一**的敌人反射速度公式：子弹仿真（`applyBounce`）与瞄准辅助射线
 * （`AimGuide.traceAimGuide`）都调它，保证「辅助射线」与「真实弹道」不会各写一套规则后慢慢跑偏。
 *
 * 反射规则（与墙反射同理，入射角 = 反射角）：`BoxHit.normalX / normalY` 只有一个非 0，
 * 沿法线轴取 `|v|` 再乘法线符号（撞左 / 右面翻 vx，撞上 / 下面翻 vy），另一轴分量原样保留。
 *
 * @returns 反射后的速度（不修改入参，纯函数）
 */
export function reflectOffEnemyBox(
    vx: number,
    vy: number,
    normalX: number,
    normalY: number
): { vx: number; vy: number } {
    return {
        vx: normalX !== 0 ? normalX * Math.abs(vx) : vx,
        vy: normalY !== 0 ? normalY * Math.abs(vy) : vy,
    };
}

/** 沿最浅轴弹开，并把子弹推到敌人表面外，避免卡在体内反复触发 */
function applyBounce(bullet: BulletRuntime, hit: BoxHit): void {
    // 速度翻转走共用公式（与辅助射线同源）；位置外推只属于真实子弹（射线没有"位置"要推）
    const next = reflectOffEnemyBox(bullet.vx, bullet.vy, hit.normalX, hit.normalY);
    bullet.vx = next.vx;
    bullet.vy = next.vy;
    if (hit.axis === 'x') {
        bullet.x += hit.normalX * (hit.depth + 0.5);
    } else {
        bullet.y += hit.normalY * (hit.depth + 0.5);
    }
}

/** armed：必须先离开捕捉圈才允许被回收，否则出膛第一帧就被自己收回去 */
function updateArmed(bullet: BulletRuntime, world: BulletWorld): void {
    if (bullet.armed) return;
    if (distance(bullet.x, bullet.y, world.playerX, world.playerY) > world.catchRadius) {
        bullet.armed = true;
    }
}

/** 清除已经不再接触的敌人记录：再次撞上同一敌人应再次结算（§6.4） */
function pruneHitSet(bullet: BulletRuntime, world: BulletWorld): void {
    if (bullet.hitSet.size === 0) return;
    const touching = world.queryEnemies(bullet.x, bullet.y, GameTuning.bulletRadius + CONTACT_EPSILON);
    if (!touching || touching.length === 0) {
        bullet.hitSet.clear();
        return;
    }
    const stillTouching = new Set<number>();
    for (let i = 0; i < touching.length; i++) stillTouching.add(touching[i].id);
    Array.from(bullet.hitSet).forEach(id => {
        if (!stillTouching.has(id)) bullet.hitSet.delete(id);
    });
}