/**
 * 掉落物仿真（纯逻辑层，不依赖 cc）—— 需求 4 / §11，v1.10 起接入**滚动世界**
 *
 * 四条口径（都能单测，见 tests/ball-roguelike/DropSim.test.ts）：
 *   ① **掉落物是"世界里的静止物体"**：生成时**散落一次**（`dropScatterRadius` 内的世界内偏移，
 *      由 `BattleView.addDrop()` 一次性烘进 `drop.x / drop.y`，之后**绝不重算** → 不会每帧抖动）；
 *      此后每帧的屏幕位移**只**来自 `world.scrollDelta`（与敌人、背景**同一个值**）→ 三者严格锁步；
 *   ② **磁吸是玩家侧行为，叠加在滚动之上**：`stepDrop()` 里顺序写死「先滚动、再磁吸」，
 *      两者都是**位移**、谁也不覆盖谁 —— 所以「世界暂停时磁吸照常」自然成立
 *      （与"俯冲 Diving 不受世界暂停影响"的既有边界口径一致，见策划案附录 K-3）；
 *   ③ **绝不向上移动**（`dropNeverMovesUp`）：位移全部算完、判定**之前**做**单调夹取**
 *      （本帧结束的 `y` 不得大于进入本帧时的 `y0`）—— 世界只会向下滚，掉落物就只应该向下；
 *      水平方向**不受限制**（横向被吸是允许的）。玩家在掉落物**上方**时，磁吸只能横向靠拢、抬不起它；
 *   ④ **已结算闸门**（`drop.collected`）：`Collected` 时**立刻置位**，此后**永不再产生收益**
 *      （`stepDrop()` 每帧开头第一件事就是读它 → 直接 `Alive`，不再滚动 / 磁吸 / 判定）——
 *      即使调用方**忘了把它移出场**（曾经的线上 bug：吸收后漏了移除 → 每帧重复结算 → 经验一直涨），
 *      同一个掉落物也**只结算一次**。⚠️ `Fell`（出屏消失）**不置位**：它本来就不产生收益，
 *      置位反而会**掩盖**"该消失却没消失"的簿记错误（见 ⑦ 的注释）。
 *
 * 结算与消失（v1.10 修订，**严格分开**，见 `DropOutcome`）：
 *   · **唯一收益路径 = 进入玩家吸收范围**（`distance(drop, player) <= world.pickupRadius`）→ `Collected`
 *     → 玩法层调既有的 `BattleView.collectDrop()`（磁吸只是"把掉落物送进吸收范围"的手段，不是结算路径）；
 *   · **消失 = 越过屏幕底边再往下 `dropDespawnBelowScreen`(30) px** → `Fell` → 玩法层**只销毁节点、绝不结算**
 *     （隔空加经验 / 金币不是玩法口径）；掉落物会一路下移**穿过** `diveLineY`，玩家在更低处仍能捡到；
 *   · **存活计时 `drop.life` 不参与生死**：耗尽既不结算、也不移除（只作计数 / 未来"最后 3 s 闪烁"钩子）。
 *
 * 与 `EnemySim` 的分工完全对称：core 只算，view 只做「摆节点 + 结算」。
 */

import { DropRuntime } from './GameTypes';
import { GameTuning } from './GameTuning';
import { WorldScrollConsumer } from './ScrollWorld';
import { distance, screenBounds } from './BoardMath';

/** 一帧掉落物的处置结果 */
export enum DropOutcome {
    /** 还在场上（下一帧继续） */
    Alive = 'alive',
    /** **唯一的收益结果**：进入玩家吸收范围（`pickupRadius`）→ 玩法层调 `BattleView.collectDrop()` */
    Collected = 'collected',
    /**
     * **出屏消失**：越过屏幕底边再往下 `dropDespawnBelowScreen` px → 玩法层**只销毁节点**、
     * **绝不结算**。与 `Collected` **严格区分**（两个结果值不同 → 视图层不可能把"消失"当"拾取"）。
     */
    Fell = 'fell',
}

/**
 * 掉落物**出屏消失**的阈值 y = 屏幕**底边**再往下 `dropDespawnBelowScreen` px。
 *
 * 口径：以掉落物**中心**为准（点状小物件，中心即判定点）；`dropDespawnBelowScreen <= 0` → 贴屏幕底即消失。
 * 单测独立按 `screenBounds().bottom - GameTuning.dropDespawnBelowScreen` 复算一遍（不只看本函数）。
 */
export function dropDespawnY(): number {
    return screenBounds().bottom - GameTuning.dropDespawnBelowScreen;
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
    /** 拾取半径 px（**唯一**的结算路径：进入即 `Collected`） */
    pickupRadius: number;
    /** 磁吸飞行速度 px/s */
    magnetSpeed: number;
}

/**
 * 推进一个掉落物一帧（原地修改 `drop`），返回本帧处置结果。
 *
 * **顺序写死**（这就是"磁吸不被滚动覆盖"与"绝不上升"的保证）：
 *   ⓪ **已结算闸门**（`drop.collected`）→ 直接返回 `Alive`（②~⑦ 一概不做：不滚动、不磁吸、不计时、不判定）；
 *   ① 记下进入本帧时的 `y0`（⑤ 单调夹取的基准，**必须在任何位移之前**取）；
 *   ② 存活计时（与世界滚动无关：**世界暂停时冻结**（`dropLifePausesWithWorld` 且 `scrollDelta === 0` 时不扣 life；
 *      磁吸不受影响、照常））—— ⚠️ life **不参与生死**：耗尽既不结算、也不移除；
 *   ③ **世界滚动位移** `drop.y -= world.scrollDelta`（世界里的静止物体，被背景带着走）；
 *   ④ **磁吸位移**（玩家侧行为，**叠加**在 ③ 之上，不替换、不覆盖；水平方向不受限）；
 *   ⑤ **单调夹取**：`dropNeverMovesUp` 且 `drop.y > y0` → `drop.y = y0`（**判定之前**做 —— 判定只看夹取后的位置）；
 *   ⑥ **拾取判定**（唯一收益路径）→ `Collected`；
 *   ⑦ **出屏消失** `drop.y <= 屏幕底 - dropDespawnBelowScreen` → `Fell`（**不结算**）。
 *
 * ⚠️ `dt` 只影响 **② 计时** 与 **④ 磁吸步长**，**不影响 ③** —— `scrollDelta` 本身就是一个
 * **位移**（它已经含了 dt，由 `advanceWorldScroll()` 算出）。这与敌人完全同口径
 * （`EnemySim` 的 Falling 分支同样是 `enemy.y -= world.scrollDelta`，也不再看 dt）。
 *
 * `world.scrollDelta` 不做运行时兜底（与 `EnemySim.stepEnemy()` 的 Falling 分支同一写法）：
 * 它由 `ScrollWorld.effectiveScrollDelta()` 产出，天然是有限非负数，编译期又是必填字段。
 *
 * @param drop 掉落物数据（原地修改）
 * @param dt 帧间隔（s；非有限值 / 负数按 0 处理，此时仍会做拾取与出屏判定）
 * @param world 世界信息（`scrollDelta` 必填）
 */
export function stepDrop(drop: DropRuntime, dt: number, world: DropWorld): DropOutcome {
    if (!drop) return DropOutcome.Alive;

    // 已结算闸门：吸收过的掉落物**绝不再产生收益** —— 即使 view 层忘了把它从场上移除
    if (drop.collected) return DropOutcome.Alive;

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // ① 单调夹取的基准：**进入本帧时**的 y（必须在 ③④ 任何位移之前取）
    const y0 = drop.y;

    // ② 存活计时：世界暂停（scrollDelta === 0）时**冻结**（磁吸照常、寿命冻结）。
    //    ⚠️ life 已**不参与生死**：耗尽既不结算、也不移除（唯一消失路径是 ⑦ 出屏）—— 所以这里没有 return。
    const lifeFrozen = GameTuning.dropLifePausesWithWorld && world.scrollDelta === 0;
    if (!lifeFrozen) drop.life -= step;

    // ③ 世界滚动位移：与 EnemySim 的 Falling 分支是同一句；
    //    世界暂停（任一敌人停住）时 scrollDelta = 0 → 这一句天然什么都不做 → 掉落物一起停
    drop.y -= world.scrollDelta;

    // ④ 磁吸：进入范围即永久吸附；朝玩家飞 —— **叠加**在滚动位移之上（世界暂停时磁吸照常）
    const dist = distance(drop.x, drop.y, world.playerX, world.playerY);
    if (!drop.magnetized && dist <= world.magnetRadius) drop.magnetized = true;
    if (drop.magnetized && dist > world.pickupRadius) {
        const magnetStep = world.magnetSpeed * step;
        const ratio = Math.min(1, magnetStep / Math.max(dist, 0.001));
        drop.x += (world.playerX - drop.x) * ratio;
        drop.y += (world.playerY - drop.y) * ratio;
    }

    // ⑤ 单调夹取（**绝不向上移动**）：位移都算完了才夹，且**先夹后判** →
    //    判定看到的位置永远满足「y <= 进入本帧时的 y0」；水平方向（x）不受限制（横向被吸是允许的）
    if (GameTuning.dropNeverMovesUp && drop.y > y0) drop.y = y0;

    // ⑥ 拾取：用**本帧最终位置**判定（先滚动、再磁吸、再夹取 → 判定不吃上一帧的滞后）
    //    ⚠️ 这是**唯一**会产生收益的路径 —— 也**只有这一处**置「已结算闸门」：
    //    置位后，同一个掉落物即使还留在场上（调用方漏了移除），下一帧起也只会拿到 ⓪ 的 `Alive`
    if (distance(drop.x, drop.y, world.playerX, world.playerY) <= world.pickupRadius) {
        drop.collected = true;
        return DropOutcome.Collected;
    }

    // ⑦ 出屏消失：越过屏幕**底边**再往下 dropDespawnBelowScreen px → 移除但**绝不结算**。
    //    掉落物会一路下移穿过 diveLineY（越俯冲线**不再**收取）→ 玩家在更低处仍能捡到。
    //    ⚠️ 这里**不**置 `drop.collected`：`Fell` 本来就不产生收益（置位是多余的），而且置位会把
    //    "该消失却没消失"的簿记错误**掩盖**掉（下一帧会静默返回 `Alive`）—— 闸门只管"进过账的不许再进"
    if (drop.y <= dropDespawnY()) {
        return DropOutcome.Fell;
    }

    return DropOutcome.Alive;
}