/**
 * 掉落物仿真（纯逻辑层，不依赖 cc）—— 需求 4 / §11，v1.10 起接入**滚动世界**
 *
 * 三条口径（都能单测，见 tests/ball-roguelike/DropSim.test.ts）：
 *   ① **掉落物是"世界里的静止物体"**：生成时**散落一次**（`dropScatterRadius` 内的世界内偏移，
 *      由 `BattleView.addDrop()` 一次性烘进 `drop.x / drop.y`，之后**绝不重算** → 不会每帧抖动）；
 *      此后每帧的屏幕位移**只**来自 `world.scrollDelta`（与敌人、背景**同一个值**）→ 三者严格锁步；
 *   ② **磁吸是玩家侧行为，叠加在滚动之上**：`stepDrop()` 里顺序写死「先滚动、再磁吸」，
 *      两者都是**位移**、谁也不覆盖谁 —— 所以「世界暂停时磁吸照常」自然成立
 *      （与"俯冲 Diving 不受世界暂停影响"的既有边界口径一致，见策划案附录 K-3）；
 *   ③ **越过俯冲线即自动收取**（`dropAutoCollectAtDiveLine`）：滚出战场的东西自动回收 → 掉落不丢；
 *      它与正常拾取**共用同一个结果值**，结算仍由玩法层既有的 `BattleView.collectDrop()` 做
 *      （本文件只回答"谁在哪、该不该结算"，**绝不新写一套结算**）。
 *
 * 与 `EnemySim` 的分工完全对称：core 只算，view 只做「摆节点 + 结算」。
 */

import { DropRuntime } from './GameTypes';
import { GameTuning } from './GameTuning';
import { WorldScrollConsumer } from './ScrollWorld';
import { distance } from './BoardMath';

/** 一帧掉落物的处置结果 */
export enum DropOutcome {
    /** 还在场上（下一帧继续） */
    Alive = 'alive',
    /**
     * 本轮**应结算** —— 正常拾取（进入 `pickupRadius`）与越俯冲线自动收取**共用这一个结果**，
     * 因为两者必须走**同一条**结算路径（`BattleView.collectDrop()`）。
     */
    Collected = 'collected',
    /** 存活时间耗尽：按 §11.3 的设计口径**移除但不结算**（超时消失，防止场上堆积） */
    Expired = 'expired',
}

/**
 * 掉落物仿真需要的外部信息。
 *
 * `scrollDelta` 来自 `WorldScrollConsumer`（**必填**，见 core/ScrollWorld.ts）——
 * 与 `EnemySim.EnemyWorld` 是**同一个契约、同一个值**，于是"另算一套速度"在编译期就过不去。
 */
export interface DropWorld extends WorldScrollConsumer {
    /** 玩家当前位置 */
    playerX: number;
    playerY: number;
    /** 本帧磁吸半径 px（= `GameTuning.magnetRadius` + 技能 / 外围加点加成，由玩法层每帧写入） */
    magnetRadius: number;
    /** 拾取半径 px（进入即结算） */
    pickupRadius: number;
    /** 磁吸飞行速度 px/s */
    magnetSpeed: number;
    /** 越过俯冲线（`GameTuning.diveLineY`）是否自动收取 */
    autoCollectAtDiveLine: boolean;
}

/**
 * 掉落物是否已越过俯冲线。
 *
 * 口径：以掉落物**中心**越线为准（`y <= diveLineY`）。
 * 与敌人**刻意不同** —— 敌人用「自身矩形**底边**」（`EnemySim.hasCrossedDiveLine()`），
 * 因为敌人是占格的大块、判定按占格来；掉落物是点状小物件、没有占格，**中心即判定点**。
 */
export function hasDropCrossedDiveLine(drop: DropRuntime): boolean {
    return drop.y <= GameTuning.diveLineY;
}

/**
 * 推进一个掉落物一帧（原地修改 `drop`），返回本帧处置结果。
 *
 * **顺序写死**（这就是"磁吸不被滚动覆盖"的保证）：
 *   ① 存活计时（与世界滚动无关：世界暂停时计时**照走**，与 Telegraph 的 `stateTime` 口径一致）；
 *   ② **世界滚动位移** `drop.y -= world.scrollDelta`（世界里的静止物体，被背景带着走）；
 *   ③ **磁吸位移**（玩家侧行为，**叠加**在 ② 之上，不替换、不覆盖）；
 *   ④ 拾取判定（用本帧**最终**位置）；
 *   ⑤ 越俯冲线自动收取。
 *
 * ⚠️ `dt` 只影响 **① 计时** 与 **③ 磁吸步长**，**不影响 ②** —— `scrollDelta` 本身就是一个
 * **位移**（它已经含了 dt，由 `advanceWorldScroll()` 算出）。这与敌人完全同口径
 * （`EnemySim` 的 Falling 分支同样是 `enemy.y -= world.scrollDelta`，也不再看 dt）。
 *
 * `world.scrollDelta` 不做运行时兜底（与 `EnemySim.stepEnemy()` 的 Falling 分支同一写法）：
 * 它由 `ScrollWorld.effectiveScrollDelta()` 产出，天然是有限非负数，编译期又是必填字段。
 *
 * @param drop 掉落物数据（原地修改）
 * @param dt 帧间隔（s；非有限值 / 负数按 0 处理，此时仍会做拾取与自动收取判定）
 * @param world 世界信息（`scrollDelta` 必填）
 */
export function stepDrop(drop: DropRuntime, dt: number, world: DropWorld): DropOutcome {
    if (!drop) return DropOutcome.Alive;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // ① 存活计时：超时**优先于**拾取（与既有实现一致：先扣 life、超时即移除）
    drop.life -= step;
    if (drop.life <= 0) return DropOutcome.Expired;

    // ② 世界滚动位移：与 EnemySim 的 Falling 分支是同一句；
    //    世界暂停（任一敌人停住）时 scrollDelta = 0 → 这一句天然什么都不做 → 掉落物一起停
    drop.y -= world.scrollDelta;

    // ③ 磁吸：进入范围即永久吸附；朝玩家飞 —— **叠加**在滚动位移之上（世界暂停时磁吸照常）
    const dist = distance(drop.x, drop.y, world.playerX, world.playerY);
    if (!drop.magnetized && dist <= world.magnetRadius) drop.magnetized = true;
    if (drop.magnetized && dist > world.pickupRadius) {
        const magnetStep = world.magnetSpeed * step;
        const ratio = Math.min(1, magnetStep / Math.max(dist, 0.001));
        drop.x += (world.playerX - drop.x) * ratio;
        drop.y += (world.playerY - drop.y) * ratio;
    }

    // ④ 拾取：用**本帧最终位置**判定（先滚动、再磁吸 → 判定不吃上一帧的滞后）
    if (distance(drop.x, drop.y, world.playerX, world.playerY) <= world.pickupRadius) {
        return DropOutcome.Collected;
    }

    // ⑤ 越俯冲线自动收取：滚出战场的掉落物自动回收（掉落不丢；结算路径与 ④ 完全相同）
    if (world.autoCollectAtDiveLine && hasDropCrossedDiveLine(drop)) {
        return DropOutcome.Collected;
    }

    return DropOutcome.Alive;
}