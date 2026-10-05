/**
 * L1 单测：掉落物接入**滚动世界**（v1.10）+ **v1.10 修订口径**（只有吸收范围才结算 / 屏幕底 −30 才消失 / 磁吸可向上）
 *
 * 对应策划案 §11.1（散落）、§11.3（拾取与消失）、§24.5（数值）、§24.8 与**附录 K-4 / K-8**。
 * 全部是纯逻辑（不依赖 cc），被测对象是 core/DropSim.ts + core/ScrollWorld.ts + core/EnemySim.ts。
 *
 * 刻意不做"看起来差不多"的断言，而是把六条口径写成**可证伪的不变量**：
 *   ① **锁步**：同一帧内 掉落物位移 === 敌人位移 === 背景块位移 === `scrollDelta`（**逐帧**断言）；
 *   ② **暂停**：暂停 N 帧 delta ≡ 0、掉落物 y **分毫未动**；恢复后第一帧位移**恰为** `fallSpeed × dt`
 *      （**不补**暂停期间累积的量）；
 *   ③ **磁吸叠加**：磁吸位移与滚动位移**相加**（顺序写死"先滚动、再磁吸"，谁也**不覆盖**谁），
 *      且**世界暂停时磁吸照常**（磁吸是玩家侧行为，与"俯冲不受世界暂停影响"同口径）；
 *   ④ **只有进入吸收范围才结算**：`pickupRadius` 是**唯一**能产生收益的路径（`Collected`）。
 *      越俯冲线、寿命耗尽、一路滚到屏幕底 —— **一条都不结算**（`settleCalls === 0` 且账本为空）；
 *   ⑤ **消失 = 越过屏幕底边再往下 `dropDespawnBelowScreen`(30) px**：返回 `Fell`（与 `Collected`
 *      **严格区分**）→ 视图层**只销毁节点、绝不结算**；没到线就**不消失**（这就是"更晚消失"）；
 *   ⑥ **绝不向上移动**（`dropNeverMovesUp`）：逐帧断言 `y_new <= y_prev`；玩家在掉落物**上方**时，
 *      磁吸只能**横向**靠拢（`x` 照常被吸），**抬不起**掉落物。
 */
import {
    DropKind,
    DropRuntime,
    EnemyRuntime,
    EnemyShape,
    EnemyState,
    EnemyType,
    Quality,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';
import {
    WorldScrollConsumer,
    advanceWorldScroll,
    backgroundTileBottomY,
    gridAlignedBottom,
    wrapBackgroundOffset,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/ScrollWorld';
import { EnemyWorld, applyStopBlocking, stepEnemy } from '../../assets/scripts/Game/CommonGame/gameplay/core/EnemySim';
import { DropOutcome, DropWorld, dropDespawnY, stepDrop } from '../../assets/scripts/Game/CommonGame/gameplay/core/DropSim';
import { waveScaling } from '../../assets/scripts/Game/CommonGame/gameplay/core/MathModels';
import { screenBounds } from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';
import { RunStats, createRunStats, grantExp } from '../../assets/scripts/Game/CommonGame/gameplay/core/PlayerStats';

const DT = 1 / 60;
/** 网格兜底路径的背景周期（与 BattleView / ScrollWorld.test.ts 用的是同一个键） */
const H = GameTuning.backgroundGridPatternHeight;
const CELL = GameTuning.cellSize;
/** 玩家出生点 y（与 `BattleView` 的 `bounds.bottom + playerSpawnBottomOffset` 同一算法） */
const PLAYER_Y = screenBounds().bottom + GameTuning.playerSpawnBottomOffset;
/** 背景块基准（与 BattleView 的 `gridAlignedBottom(spawnLineY, 底边, cellSize)` 同一算法） */
const BASE = gridAlignedBottom(GameTuning.spawnLineY, screenBounds().bottom, CELL);
/** 当前波的世界滚动速度（测试里都用第 1 波） */
const SPEED = waveScaling(1).fallSpeed;
/** 单帧滚动位移 */
const DELTA = SPEED * DT;
/** 屏幕底边（世界坐标） */
const BOTTOM = screenBounds().bottom;

/** 造一个掉落物（默认"离玩家很远、不会磁吸"的坐标；`life` 默认取真源数值） */
function makeDrop(id: number, x: number, y: number, kind: DropKind = DropKind.Exp, value = 6): DropRuntime {
    return {
        id,
        kind,
        x,
        y,
        vx: 0,
        vy: 0,
        value,
        life: GameTuning.dropLifeTime,
        magnetized: false,
    };
}

/** 造一个掉落物仿真世界（默认玩家在出生点、磁吸与拾取都用真源数值） */
function makeWorld(overrides: Partial<DropWorld> = {}): DropWorld {
    return {
        playerX: 0,
        playerY: PLAYER_Y,
        // 默认 0 = **关掉磁吸**，好让"纯滚动"的位移可以逐帧精确断言
        magnetRadius: 0,
        pickupRadius: GameTuning.pickupRadius,
        magnetSpeed: GameTuning.magnetSpeed,
        scrollDelta: DELTA,
        ...overrides,
    };
}

/** 造一个"远远没到俯冲线"的 Falling 敌人（好让它整段测试都在正常下移） */
function makeFallingEnemy(id: number): EnemyRuntime {
    return {
        id,
        defId: 'test_' + id,
        quality: Quality.White,
        type: EnemyType.Normal,
        shape: EnemyShape.Single,
        cols: 1,
        rows: 1,
        x: 0,
        y: GameTuning.spawnLineY - CELL,
        hp: 100,
        maxHp: 100,
        speed: SPEED,
        state: EnemyState.Falling,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

/** 本局账本（只为"结算有没有真的发生"服务） */
interface Ledger {
    coins: number;
    souls: number;
    supers: number;
    levelUps: number;
    level: number;
    exp: number;
}

function emptyLedger(): Ledger {
    return { coins: 0, souls: 0, supers: 0, levelUps: 0, level: 1, exp: 0 };
}

/** 结算入口被调用的次数（证明"只有拾取会结算"，其余出路**一次都不结算**） */
let settleCalls = 0;

/**
 * 与 `BattleView.collectDrop()` **同一套**结算（照抄那 4 个 case，连 `m_PendingLevelUps` 的
 * 累计口径都保留）—— 用来证明"收益只可能来自吸收范围"。
 */
function collectLikeView(stats: RunStats, ledger: Ledger, drop: DropRuntime): void {
    settleCalls++; // ← 唯一的结算入口：调用次数 = "结算真的发生了多少次"
    switch (drop.kind) {
        case DropKind.Exp: {
            const levels = grantExp(stats, drop.value);
            ledger.levelUps += levels;
            break;
        }
        case DropKind.Coin:
            ledger.coins += drop.value;
            break;
        case DropKind.Soul:
            ledger.souls += drop.value;
            break;
        case DropKind.SuperCrystal:
            ledger.supers += drop.value;
            break;
        default:
            break;
    }
    ledger.level = stats.level;
    ledger.exp = stats.exp;
}

/**
 * 镜像 `BattleView.updateDrops()` 的分支结构：core 只回 `DropOutcome`，
 * **结算只有一个入口**（`Collected` → `collectLikeView`），`Fell` **只移除、绝不结算**。
 */
function runDropFrames(
    drops: Array<DropRuntime | null>,
    stats: RunStats,
    ledger: Ledger,
    world: DropWorld,
    frames: number,
    deltaPerFrame: number
): { collected: number[]; fell: number[] } {
    const collected: number[] = [];
    const fell: number[] = [];
    for (let f = 0; f < frames; f++) {
        world.scrollDelta = deltaPerFrame;
        for (let i = 0; i < drops.length; i++) {
            const drop = drops[i];
            if (!drop) continue;
            const outcome = stepDrop(drop, DT, world);
            if (outcome === DropOutcome.Collected) {
                collectLikeView(stats, ledger, drop); // ← 唯一结算入口
                collected.push(drop.id);
                drops[i] = null;
                continue;
            }
            if (outcome === DropOutcome.Fell) {
                fell.push(drop.id); // 出屏消失：只从场上移除，**一分收益都不加**
                drops[i] = null;
            }
        }
    }
    return { collected, fell };
}

describe('锁步：掉落物位移 === 敌人位移 === 背景块位移 === scrollDelta（逐帧）', () => {
    it('每一帧三者位移严格相等，且总位移 = 累计滚动量（不是"几乎没动"）', () => {
        const enemy = makeFallingEnemy(1);
        // 掉落物放在远离玩家的列（x = 300，磁吸半径 0）→ 位移**只能**来自世界滚动
        const drop = makeDrop(1, 300, 600);
        const dropWorld = makeWorld({ magnetRadius: 0 });
        const enemyWorld: EnemyWorld = { playerX: 0, playerY: PLAYER_Y, scrollDelta: 0 };

        const dropY0 = drop.y;
        const enemyY0 = enemy.y;
        let scrollY = 0;
        let travelled = 0;
        // 600 帧只走 200px < 一个背景周期 768 → **不跨回绕**，第 0 块始终是同一块，
        // 所以块位移可以直接相减（与 ScrollWorld.test.ts 的同一处口径一致）
        const frames = 600; // 10 s（远没到出屏线，避免消失干扰锁步断言）

        for (let i = 0; i < frames; i++) {
            const step = advanceWorldScroll(scrollY, SPEED, DT, false, H);
            scrollY = step.scrollY;
            travelled += step.delta;

            const tileBefore = backgroundTileBottomY(BASE, wrapBackgroundOffset(scrollY - step.delta, H), H, 0);
            const tileAfter = backgroundTileBottomY(BASE, wrapBackgroundOffset(scrollY, H), H, 0);

            const dropBefore = drop.y;
            const enemyBefore = enemy.y;
            dropWorld.scrollDelta = step.delta;
            enemyWorld.scrollDelta = step.delta;
            expect(stepDrop(drop, DT, dropWorld)).toBe(DropOutcome.Alive);
            stepEnemy(enemy, DT, enemyWorld);

            // ① 各自位移都恰好等于 delta
            expect(dropBefore - drop.y).toBeCloseTo(step.delta, 9);
            expect(enemyBefore - enemy.y).toBeCloseTo(step.delta, 9);
            // ② 背景块位移也恰好等于 delta
            expect(tileBefore - tileAfter).toBeCloseTo(step.delta, 9);
            // ③ 三者**互相**严格相等 → 锁步
            expect(dropBefore - drop.y).toBeCloseTo(enemyBefore - enemy.y, 9);
            expect(dropBefore - drop.y).toBeCloseTo(tileBefore - tileAfter, 9);
        }

        expect(travelled).toBeGreaterThan(100); // 确实滚了（不是"一直没动"的假通过）
        expect(drop.y).toBeCloseTo(dropY0 - travelled, 6);
        expect(enemy.y).toBeCloseTo(enemyY0 - travelled, 6);
        expect(drop.y).toBeGreaterThan(dropDespawnY()); // 整段都在场上（没到出屏线）
    });

    it('长跑 5000 帧（跨多次背景回绕）不漂移：掉落物与敌人累计位移完全一致', () => {
        const enemy = makeFallingEnemy(2);
        // 故意把两者放到屏幕外**很高处**：整段长跑都不会滚到出屏线
        // → 敌人全程 Falling、掉落物全程 Alive（本条测的是"位移锁步"，不是越线/消失）
        enemy.y = 1300;
        const drop = makeDrop(2, 300, 1300);
        drop.life = 1e9; // 只为不让寿命计数干扰"长跑不漂移"这条性质

        const dropWorld = makeWorld({ magnetRadius: 0 });
        const enemyWorld: EnemyWorld = { playerX: 0, playerY: PLAYER_Y, scrollDelta: 0 };

        let scrollY = 0;
        let travelled = 0;
        let notAlive = 0;
        for (let i = 0; i < 5000; i++) {
            const step = advanceWorldScroll(scrollY, SPEED, DT, false, H);
            scrollY = step.scrollY;
            travelled += step.delta;
            dropWorld.scrollDelta = step.delta;
            enemyWorld.scrollDelta = step.delta;
            if (stepDrop(drop, DT, dropWorld) !== DropOutcome.Alive) notAlive++;
            stepEnemy(enemy, DT, enemyWorld);
        }

        expect(notAlive).toBe(0); // 整段都没消失 / 没被收走（配置确实"到不了出屏线"）
        expect(enemy.state).toBe(EnemyState.Falling); // 敌人也整段保持 Falling
        expect(travelled).toBeGreaterThan(H * 2); // 跨了 2 个以上背景周期（回绕真的发生了）
        expect(drop.y).toBeCloseTo(1300 - travelled, 6);
        expect(enemy.y).toBeCloseTo(1300 - travelled, 6);
        expect(drop.y).toBeCloseTo(enemy.y, 9); // 起点相同 → 终点也必须一位不差
        expect(drop.y).toBeGreaterThan(dropDespawnY()); // 反证：确实还没到出屏线
    });

    it('位移与掉落物类型 / 价值无关（金币与超级水晶的位移一模一样）', () => {
        const coin = makeDrop(11, 300, 600, DropKind.Coin, 1);
        const superDrop = makeDrop(12, 300, 600, DropKind.SuperCrystal, 2);
        const world = makeWorld({ magnetRadius: 0 });

        for (let i = 0; i < 120; i++) {
            stepDrop(coin, DT, world);
            stepDrop(superDrop, DT, world);
        }
        expect(coin.y).toBeCloseTo(superDrop.y, 12);
        expect(coin.y).toBeCloseTo(600 - 120 * DELTA, 9);
    });

    it('生成时散落是"算一次"的世界内偏移：世界静止时不重算、不抖动', () => {
        // 模拟 addDrop()：散落偏移一次性烘进坐标（角度 / 半径都只算一次）
        const drop = makeDrop(21, 0 + Math.cos(0.7) * 20, 300 + Math.sin(0.7) * 20);
        const x0 = drop.x;
        const y0 = drop.y;
        const world = makeWorld({ magnetRadius: 0, scrollDelta: 0 }); // 世界静止

        for (let i = 0; i < 300; i++) {
            expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
            expect(drop.x).toBe(x0); // 分毫未动
            expect(drop.y).toBe(y0);
        }
    });
});

describe('世界暂停：掉落物与敌人 / 背景一起停，恢复后不跳位', () => {
    it('暂停 3 秒：delta ≡ 0、掉落物 y 分毫未动（敌人与背景同样不动）', () => {
        const enemy = makeFallingEnemy(31);
        const stopper = makeFallingEnemy(32);
        stopper.state = EnemyState.Telegraph; // 到底站住 → 全场停（与 BattleView.updateScroll 同一裁决）
        const enemies = [enemy, stopper];
        const drop = makeDrop(31, 300, 400);
        const dropWorld = makeWorld({ magnetRadius: 0 });
        const enemyWorld: EnemyWorld = { playerX: 0, playerY: PLAYER_Y, scrollDelta: 0 };

        // 先正常滚 30 帧，拿到"暂停前"的状态
        let scrollY = 0;
        for (let i = 0; i < 30; i++) {
            const step = advanceWorldScroll(scrollY, SPEED, DT, false, H);
            scrollY = step.scrollY;
            dropWorld.scrollDelta = step.delta;
            enemyWorld.scrollDelta = step.delta;
            stepDrop(drop, DT, dropWorld);
            stepEnemy(enemy, DT, enemyWorld);
        }
        const scrollBefore = scrollY;
        const dropBefore = drop.y;
        const enemyBefore = enemy.y;
        const tileBefore = backgroundTileBottomY(BASE, wrapBackgroundOffset(scrollY, H), H, 0);
        expect(dropBefore).toBeLessThan(400); // 确实滚下去了
        expect(tileBefore).toBeLessThan(BASE);

        // 暂停 3 秒（180 帧）
        for (let i = 0; i < 180; i++) {
            const paused = applyStopBlocking(enemies);
            expect(paused).toBe(true);
            const step = advanceWorldScroll(scrollY, SPEED, DT, paused, H);
            scrollY = step.scrollY;
            dropWorld.scrollDelta = step.delta;
            enemyWorld.scrollDelta = step.delta;
            expect(step.delta).toBe(0);
            stepDrop(drop, DT, dropWorld);
            stepEnemy(enemy, DT, enemyWorld);
            expect(drop.y).toBe(dropBefore); // 掉落物分毫未动
        }
        expect(scrollY).toBe(scrollBefore); // 累计量也没变
        expect(enemy.y).toBe(enemyBefore);
        expect(backgroundTileBottomY(BASE, wrapBackgroundOffset(scrollY, H), H, 0)).toBe(tileBefore);

        // 恢复：从暂停前的位置**继续**，第一帧位移恰为 fallSpeed × dt（不补 3 秒的量）
        const resumed = applyStopBlocking([enemy]);
        expect(resumed).toBe(false);
        const after = advanceWorldScroll(scrollY, SPEED, DT, resumed, H);
        dropWorld.scrollDelta = after.delta;
        const before = drop.y;
        expect(stepDrop(drop, DT, dropWorld)).toBe(DropOutcome.Alive);
        expect(before - drop.y).toBeCloseTo(after.delta, 9);
        expect(before - drop.y).toBeCloseTo(SPEED * DT, 9);
        expect(before - drop.y).toBeLessThan(1); // 绝不可能补上 3 秒的 60px
    });

    it('世界暂停时存活计时**冻结**，磁吸照常', () => {
        // ① 冻结：暂停 180 帧（3 s）→ life **分毫未减**（旧口径"计时照走"下，这颗 life = DT 的掉落物早就没了）
        const frozen = makeDrop(33, 300, 600); // 磁吸范围外（关磁吸）→ 本条只看计时
        frozen.life = DT; // 只剩一帧
        const frozenWorld = makeWorld({ magnetRadius: 0, scrollDelta: 0 }); // 世界暂停
        const frozenLife0 = frozen.life;
        for (let i = 0; i < 180; i++) {
            expect(stepDrop(frozen, DT, frozenWorld)).toBe(DropOutcome.Alive);
        }
        expect(frozen.life).toBe(frozenLife0); // **精确相等**：3 秒一毫秒都没扣
        expect(frozenLife0 - 180 * DT).toBeLessThan(0); // 反证：计时若照走，这 3 秒早把它扣成负数

        // ② 磁吸照常：世界暂停时磁吸仍然生效（magnetized 置位 + 一路朝玩家飞），且寿命同样冻结
        const magnet = makeDrop(34, 0, PLAYER_Y + 150); // 玩家正下方 150px（磁吸范围内、拾取范围外）
        const magnetWorld = makeWorld({ magnetRadius: GameTuning.magnetRadius, scrollDelta: 0 }); // 世界暂停
        const magnetLife0 = magnet.life;
        const magnetY0 = magnet.y;
        let magnetFrames = 0;
        let magnetOutcome = DropOutcome.Alive;
        while (magnetOutcome === DropOutcome.Alive && magnetFrames < 180) {
            magnetOutcome = stepDrop(magnet, DT, magnetWorld);
            expect(magnet.life).toBe(magnetLife0); // 暂停期间每一帧都不扣
            magnetFrames++;
        }
        expect(magnet.magnetized).toBe(true); // 磁吸照常置位
        expect(magnetY0 - magnet.y).toBeGreaterThan(0); // 且确实朝玩家飞了（暂停也照飞）
        expect(magnetOutcome).toBe(DropOutcome.Collected); // 飞到玩家身上照常拾取（暂停不挡拾取）
        expect(magnetFrames).toBeLessThan(180); // 磁吸速度远大于滚动 → 3 秒内早飞到了

        // ③ 恢复后**不补扣**：暂停期间的量一帧都不补，恢复第一帧只扣一个 dt
        const resumed = makeDrop(35, 300, 600);
        resumed.life = 1.0;
        const resumeWorld = makeWorld({ magnetRadius: 0, scrollDelta: 0 });
        for (let i = 0; i < 180; i++) stepDrop(resumed, DT, resumeWorld);
        expect(resumed.life).toBe(1.0); // 暂停 3 秒：一点没扣
        resumeWorld.scrollDelta = DELTA; // 世界恢复滚动
        expect(stepDrop(resumed, DT, resumeWorld)).toBe(DropOutcome.Alive);
        expect(resumed.life).toBe(1.0 - DT); // 精确：只扣了恢复后的这一帧
        expect(resumed.life).toBeGreaterThan(1.0 - 180 * DT); // 绝不补扣暂停期间累积的量
    });

    it('暂停时「**磁吸照常**」与「**寿命冻结**」**同时**成立（同一帧、逐帧断言满 180 帧）', () => {
        // 把磁吸放慢到 1 px/s：掉落物在暂停的 3 秒里始终留在场上 → 两件事可以**同帧**逐帧断言
        const drop = makeDrop(36, 0, PLAYER_Y + 150); // 磁吸范围内、拾取范围外
        drop.life = DT; // 只剩一帧：寿命若照走，第 1 帧就扣成负数
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius, magnetSpeed: 1, scrollDelta: 0 });
        const life0 = drop.life;
        let travelled = 0;
        let prevY = drop.y;

        for (let i = 0; i < 180; i++) {
            expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive); // 既没消失、也没被结算
            expect(drop.life).toBe(life0); // ← 寿命**冻结**（精确相等，不是"差不多"）
            expect(drop.magnetized).toBe(true); // ← 磁吸**照常**置位
            travelled += prevY - drop.y;
            expect(drop.y).toBeLessThan(prevY); // ← 且**每帧**都在朝玩家推进（不是"停就一起停"）
            prevY = drop.y;
        }
        expect(travelled).toBeCloseTo(180 * (1 / 60), 9); // 3 秒共飞 3 px（步长 = magnetSpeed × dt）
        expect(drop.life).toBe(life0); // 跑满 180 帧依旧一毫秒未扣
        expect(life0 - 180 * DT).toBeLessThan(0); // 反证：旧口径下这颗早就"超时"了
    });
});

describe('磁吸：**叠加**在滚动位移之上（不覆盖、不替换）', () => {
    it('两者同时生效时，向下位移 = 滚动位移 + 磁吸位移（精确相加）', () => {
        const MAGNET = GameTuning.magnetRadius;
        const d0 = 150; // 玩家在掉落物**正下方** 150px：已进入磁吸范围、未进拾取范围
        const magnetStep = GameTuning.magnetSpeed * DT; // 1120 × 1/60 ≈ 18.67

        // ① 只有磁吸（世界暂停）：位移 = magnetStep（朝玩家）
        const a = makeDrop(41, 0, PLAYER_Y + d0);
        stepDrop(a, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: 0 }));
        expect(a.y - (PLAYER_Y + d0)).toBeCloseTo(-magnetStep, 9);
        expect(a.x).toBe(0);

        // ② 只有滚动（磁吸关闭）：位移 = delta
        const b = makeDrop(42, 0, PLAYER_Y + d0);
        stepDrop(b, DT, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }));
        expect(b.y - (PLAYER_Y + d0)).toBeCloseTo(-DELTA, 9);

        // ③ 两者同时：**先滚动、再磁吸**（顺序写死在 stepDrop 里）→ 位移精确相加
        const c = makeDrop(43, 0, PLAYER_Y + d0);
        stepDrop(c, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: DELTA }));
        expect(c.y - (PLAYER_Y + d0)).toBeCloseTo(-(DELTA + magnetStep), 9);
        // 证明"不是互相覆盖"：比单滚动多走了整整一个磁吸步长
        expect(Math.abs(c.y - b.y)).toBeCloseTo(magnetStep, 9);
        expect(Math.abs(c.y - a.y)).toBeCloseTo(DELTA, 9);
    });

    it('顺序等价性：一帧内"滚动 + 磁吸" === 先跑一帧纯滚动、再跑一帧纯磁吸', () => {
        const MAGNET = GameTuning.magnetRadius;
        const start = PLAYER_Y + 150; // 已在磁吸范围内（192）、仍在拾取范围外（38）

        // 一帧内两步都做
        const both = makeDrop(44, 40, start);
        stepDrop(both, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: DELTA }));

        // 拆成两帧：先纯滚动，再纯磁吸（第二步的输入状态 = 第一步的输出状态）
        const seq = makeDrop(46, 40, start);
        stepDrop(seq, DT, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }));
        stepDrop(seq, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: 0 }));

        expect(both.y).toBeCloseTo(seq.y, 9); // 顺序确实写死为"先滚动、再磁吸"
        expect(both.x).toBeCloseTo(seq.x, 9);
        // 而且磁吸**真的**生效了（不是"磁吸没参与所以相等"的假通过）：
        // 磁吸的位移**大小**恒为 magnetSpeed × dt（沿"掉落物 → 玩家"方向，所以 x/y 分量各自小于它）
        const magnetDisp = Math.sqrt((both.x - 40) * (both.x - 40) + (both.y - (start - DELTA)) * (both.y - (start - DELTA)));
        expect(magnetDisp).toBeCloseTo(GameTuning.magnetSpeed * DT, 9);
        expect(magnetDisp).toBeGreaterThan(1);
    });

    it('未进入磁吸范围 → 不吸附，x 完全不变（只有滚动在动它）', () => {
        const drop = makeDrop(47, 300, PLAYER_Y + 600);
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius });
        const x0 = drop.x;
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        expect(drop.magnetized).toBe(false);
        expect(drop.x).toBe(x0);
    });

    it('进入磁吸范围后**永久吸附**（同既有口径：`magnetized` 不再复位）', () => {
        const drop = makeDrop(48, 0, PLAYER_Y + 150);
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius });
        stepDrop(drop, DT, world);
        expect(drop.magnetized).toBe(true);

        // 玩家跑远（超出磁吸半径）也不会取消吸附：仍朝玩家飞（既有行为）
        world.playerX = 5000;
        const x0 = drop.x;
        stepDrop(drop, DT, world);
        expect(drop.magnetized).toBe(true);
        expect(drop.x).toBeGreaterThan(x0);
    });
});

describe('俯冲线不再是收取线（v1.10 修订：越线继续向下，直到出屏）', () => {
    it('未越线时 Alive；越线的**那一帧**仍 Alive 且继续向下（不再被收取）', () => {
        const drop = makeDrop(51, 300, GameTuning.diveLineY + 10); // 线上方 10px
        const world = makeWorld({ magnetRadius: 0 });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        settleCalls = 0;

        // 只擦一下：还在线上方 → Alive
        world.scrollDelta = delta;
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        expect(drop.y).toBeGreaterThan(GameTuning.diveLineY);

        // 一直滚到越线：**每一帧**都 Alive（旧口径会在越线那一帧返回 Collected）
        let frames = 1;
        let crossedAt = -1;
        let prevY = drop.y;
        while (crossedAt < 0 && frames < 2000) {
            world.scrollDelta = delta;
            prevY = drop.y;
            expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
            frames++;
            expect(drop.y).toBeLessThan(prevY); // 逐帧继续向下（越线不改变运动）
            if (drop.y <= GameTuning.diveLineY) crossedAt = frames;
        }

        expect(crossedAt).toBeGreaterThan(25); // 10px ÷ 0.333px/帧 ≈ 30 帧
        expect(crossedAt).toBeLessThan(40);
        expect(settleCalls).toBe(0); // 越线**不**走结算
        expect(drop.y).toBeLessThanOrEqual(GameTuning.diveLineY);

        // 越线后还**继续往下走**（正是"更晚消失"：玩家在更低处仍能捡到）
        const yAtCross = drop.y;
        for (let i = 0; i < 60; i++) {
            world.scrollDelta = delta;
            expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        }
        expect(drop.y).toBeLessThan(yAtCross - 19); // 又向下走了 ~20px（60 帧 × 0.333）
        expect(settleCalls).toBe(0);
    });

    it('越线口径仍以**中心**为准（y <= diveLineY 即已越线），但三种边界**都不结算**', () => {
        const world = makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: 0 });
        settleCalls = 0;
        const onLine = makeDrop(52, 0, GameTuning.diveLineY); // 恰好等于 → 已越线
        const justAbove = makeDrop(53, 0, GameTuning.diveLineY + 1e-9); // 差 1e-9 → 还没越线
        const below = makeDrop(54, 0, GameTuning.diveLineY - 1); // 已越线 1px

        expect(onLine.y <= GameTuning.diveLineY).toBe(true);
        expect(justAbove.y <= GameTuning.diveLineY).toBe(false);
        expect(below.y <= GameTuning.diveLineY).toBe(true);

        // 三颗都离出屏线很远 → 无论有没有越线，本帧都只能是 Alive
        const outcomes = [onLine, justAbove, below].map(d => stepDrop(d, DT, world));
        expect(outcomes).toEqual([DropOutcome.Alive, DropOutcome.Alive, DropOutcome.Alive]);
        expect(outcomes).not.toContain(DropOutcome.Collected);
        expect(settleCalls).toBe(0);
    });

    it('玩家在**很远**处（磁吸关闭）越线也**不**结算 —— 越线不再产生任何收益', () => {
        const drop = makeDrop(55, 0, GameTuning.diveLineY + 1);
        const world = makeWorld({ magnetRadius: 0, playerX: 5000, playerY: PLAYER_Y });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        const result = runDropFrames([drop], stats, ledger, world, 60, delta);
        expect(result.collected).toEqual([]); // 旧口径：这里本该收下 4 次…现在一次都没有
        expect(result.fell).toEqual([]); // 60 帧 ≈ 20px，还没到出屏线
        expect(drop.y).toBeLessThan(GameTuning.diveLineY); // 确实越线了
        expect(settleCalls).toBe(0);
        expect(ledger).toEqual(emptyLedger()); // 账本一分不动
        expect(Math.abs(drop.x - world.playerX)).toBeGreaterThan(1000); // 距离玩家仍极远
    });

    it('旧开关 `dropAutoCollectAtDiveLine` 已从真源**删除**（不存在任何"越线收取"）', () => {
        expect('dropAutoCollectAtDiveLine' in GameTuning).toBe(false);
        expect('dropAutoCollectOnTimeout' in GameTuning).toBe(false);
        // 替代它的新口径（见 §24.8 / K-4）：出屏线 + **磁吸可向上**（v1.10 修订**已删除** `dropNeverMovesUp` 夹取）
        expect('dropNeverMovesUp' in GameTuning).toBe(false);
        expect(GameTuning.dropDespawnBelowScreen).toBe(30);

        // 越线之后还会继续往下走很远才消失（旧口径下这里早就被"收"走了）
        const drop = makeDrop(56, 0, GameTuning.diveLineY - 1);
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        settleCalls = 0;
        for (let i = 0; i < 300; i++) {
            world.scrollDelta = delta;
            stepDrop(drop, DT, world);
        }
        expect(drop.y).toBeLessThan(GameTuning.diveLineY - 90); // 又往下走了 ~100px
        expect(settleCalls).toBe(0);

        // 唯一的结局是 Fell（不结算）—— 一路走到出屏
        const stats = createRunStats();
        const ledger = emptyLedger();
        const result = runDropFrames([drop], stats, ledger, world, 2000, delta);
        expect(result.fell).toEqual([56]);
        expect(result.collected).toEqual([]);
        expect(settleCalls).toBe(0);
        expect(ledger).toEqual(emptyLedger());
    });

    it('同一帧内**多个**越线掉落物：全部仍 Alive（一次循环处理完），账本为空', () => {
        const drops: Array<DropRuntime | null> = [
            makeDrop(61, 100, GameTuning.diveLineY - 13),
            makeDrop(62, 0, GameTuning.diveLineY - 100),
            makeDrop(63, -100, GameTuning.diveLineY - 7),
        ];
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });
        settleCalls = 0;

        const result = runDropFrames(drops, stats, ledger, world, 1, DELTA);
        expect(result.collected).toEqual([]);
        expect(result.fell).toEqual([]);
        expect(settleCalls).toBe(0);
        expect(ledger.exp).toBe(0); // 三颗经验水晶（各 6 点）**一分都没进账**
        expect(ledger.level).toBe(1);
        expect(ledger.levelUps).toBe(0);
        // 三颗都确实在俯冲线**下方**（不是"没越线所以 Alive"的假通过）
        expect(drops.every(d => d !== null && d.y <= GameTuning.diveLineY)).toBe(true);
    });

    it('对照：越线组与寿命组**一分收益都没有**，只有拾取组进账（逐项比对）', () => {
        const kinds: Array<[DropKind, number]> = [
            [DropKind.Exp, 6],
            [DropKind.Coin, 7],
            [DropKind.Soul, 3],
            [DropKind.SuperCrystal, 2],
        ];

        // A 组：正常拾取（掉落物就落在玩家脚下 → 第一帧进 pickupRadius 才算数）
        const pickDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => makeDrop(100 + i, 0, PLAYER_Y, kind, value));
        const pickStats = createRunStats();
        const pickLedger = emptyLedger();
        settleCalls = 0;
        const pick = runDropFrames(pickDrops, pickStats, pickLedger, makeWorld({ magnetRadius: 0 }), 1, 0);
        const pickSettle = settleCalls;

        // B 组：越俯冲线（玩家极远 + 磁吸关闭 → 旧口径下"只可能是越线收的"）
        const lineDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) =>
            makeDrop(200 + i, 0, GameTuning.diveLineY + 10, kind, value)
        );
        const lineStats = createRunStats();
        const lineLedger = emptyLedger();
        settleCalls = 0;
        const line = runDropFrames(lineDrops, lineStats, lineLedger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 60, DELTA);
        const lineSettle = settleCalls;

        // C 组：寿命耗尽（离出屏线还很远 → 只可能是"寿命"这条旧口径）
        const lifeDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => {
            const d = makeDrop(300 + i, 0, GameTuning.diveLineY + 10, kind, value);
            d.life = DT; // 只剩一帧 → 第一帧就耗尽
            return d;
        });
        const lifeStats = createRunStats();
        const lifeLedger = emptyLedger();
        settleCalls = 0;
        const life = runDropFrames(lifeDrops, lifeStats, lifeLedger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 60, DELTA);
        const lifeSettle = settleCalls;

        // ① 只有 A 组结算，且恰好 4 次
        expect(pick.collected.length).toBe(4);
        expect(pickSettle).toBe(4);
        // ② B、C 两组**一次都没结算**（这就是本轮要求的核心：不许隔空结算）
        expect(line.collected).toEqual([]);
        expect(line.fell).toEqual([]);
        expect(lineSettle).toBe(0);
        expect(lineLedger).toEqual(emptyLedger());
        expect(life.collected).toEqual([]);
        expect(life.fell).toEqual([]);
        expect(lifeSettle).toBe(0);
        expect(lifeLedger).toEqual(emptyLedger());

        // ③ A 组逐项可见（不是"两边都没结算"的假通过）：经验 6 / 金币 7 / 魂晶 3 / 超级水晶 2
        expect(pickLedger.exp).toBe(6);
        expect(pickLedger.coins).toBe(7);
        expect(pickLedger.souls).toBe(3);
        expect(pickLedger.supers).toBe(2);
        expect(pickLedger).not.toEqual(emptyLedger());
        expect(pickStats.exp).toBe(6);
    });
});

describe('寿命（life）：**不参与生死**（耗尽既不结算、也不移除）', () => {
    it('寿命耗尽 → 仍 Alive（既不是 Collected，也没有 Expired 这个结果值了）：settleCalls === 0、账本为 0', () => {
        const drop = makeDrop(71, 300, 600);
        drop.life = DT; // 只剩一帧
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });
        settleCalls = 0;

        const result = runDropFrames([drop], stats, ledger, world, 5, DELTA);
        expect(result.collected).toEqual([]); // 不再"超时即收取"
        expect(result.fell).toEqual([]); // 也不再"超时即移除"
        expect(settleCalls).toBe(0); // 结算入口**一次都没被调用**
        expect(ledger).toEqual(emptyLedger()); // 一颗 6 点经验水晶**没有**进账
        expect(drop.life).toBeLessThan(0); // 寿命早就耗尽了 —— 却还活着
        expect(drop.y).toBeCloseTo(600 - 5 * DELTA, 6); // 仍在场上、仍在向下
    });

    it('寿命耗尽**不**优先于拾取，也不再产生收益：贴在玩家身上照样 Collected，越线处寿命耗尽仍 Alive', () => {
        const world = makeWorld({ magnetRadius: 0, scrollDelta: DELTA });

        // ① 已经贴在玩家身上（本该拾取）+ 这一帧恰好耗尽寿命 → 仍然是"拾取"（唯一收益路径）
        const onPlayer = makeDrop(72, 0, PLAYER_Y);
        onPlayer.life = DT;
        expect(stepDrop(onPlayer, DT, world)).toBe(DropOutcome.Collected);

        // ② 已经越过俯冲线 + 这一帧恰好耗尽寿命 → Alive（旧口径在这里返回 Collected）
        const onLine = makeDrop(73, 300, GameTuning.diveLineY - 50);
        onLine.life = DT;
        expect(onLine.y).toBeLessThanOrEqual(GameTuning.diveLineY);
        expect(stepDrop(onLine, DT, world)).toBe(DropOutcome.Alive);

        // ③ 证伪"寿命还会移除"：寿命已经负了，连跑 300 帧仍在场上（且位移仍只有滚动量）
        const starved = makeDrop(74, 300, 600);
        starved.life = -100; // 早就"超时"
        let aliveFrames = 0;
        for (let i = 0; i < 300; i++) {
            if (stepDrop(starved, DT, world) === DropOutcome.Alive) aliveFrames++;
        }
        expect(aliveFrames).toBe(300);
        expect(starved.y).toBeCloseTo(600 - 300 * DELTA, 6);
        expect(starved.y).toBeGreaterThan(dropDespawnY()); // 还没到出屏线
    });

    it('对照：拾取组逐项进账（经验 6 / 金币 7 / 魂晶 3 / 超级水晶 2），寿命耗尽组**逐项为 0**', () => {
        const kinds: Array<[DropKind, number]> = [
            [DropKind.Exp, 6],
            [DropKind.Coin, 7],
            [DropKind.Soul, 3],
            [DropKind.SuperCrystal, 2],
        ];

        // A 组：正常拾取
        const pickDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => makeDrop(400 + i, 0, PLAYER_Y, kind, value));
        const pickStats = createRunStats();
        const pickLedger = emptyLedger();
        settleCalls = 0;
        const pick = runDropFrames(pickDrops, pickStats, pickLedger, makeWorld({ magnetRadius: 0 }), 1, 0);
        const pickSettle = settleCalls;

        // B 组：寿命耗尽（玩家极远 + 磁吸关闭 + 离出屏线很远 → **只可能**是"寿命"这条旧口径）
        const timeoutDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => {
            const d = makeDrop(500 + i, 300, 600, kind, value);
            d.life = DT; // 只剩一帧 → 第一帧就耗尽
            return d;
        });
        const timeoutStats = createRunStats();
        const timeoutLedger = emptyLedger();
        settleCalls = 0;
        const timeout = runDropFrames(timeoutDrops, timeoutStats, timeoutLedger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 2, DELTA);
        const timeoutSettle = settleCalls;

        // ① A 组结算 4 次；B 组**一次都没有**
        expect(pick.collected.length).toBe(4);
        expect(pickSettle).toBe(4);
        expect(timeout.collected).toEqual([]);
        expect(timeout.fell).toEqual([]);
        expect(timeoutSettle).toBe(0);

        // ② 逐项比对：B 组四项**全是 0**（旧的"两边账本一字不差"结论已作废）
        expect(timeoutLedger.exp).toBe(0);
        expect(timeoutLedger.coins).toBe(0);
        expect(timeoutLedger.souls).toBe(0);
        expect(timeoutLedger.supers).toBe(0);
        expect(timeoutLedger.level).toBe(1);
        expect(timeoutLedger.levelUps).toBe(0);
        expect(timeoutLedger).toEqual(emptyLedger());
        expect(timeoutStats.exp).toBe(0);
        expect(timeoutStats.level).toBe(1);
        expect(timeoutLedger).not.toEqual(pickLedger); // 收益**不同**（只可能来自拾取）

        // ③ 数字非 0（不是"两边都没结算"的假通过）
        expect(pickLedger.exp).toBe(6);
        expect(pickLedger.coins).toBe(7);
        expect(pickLedger.souls).toBe(3);
        expect(pickLedger.supers).toBe(2);
    });

    it('旧开关 `dropAutoCollectOnTimeout` 已从真源**删除**：寿命为负跑满 180 帧仍 Alive、不结算', () => {
        expect('dropAutoCollectOnTimeout' in GameTuning).toBe(false); // 连"打开隔空结算"的开关都不存在了
        expect(GameTuning.dropLifeTime).toBe(15); // 数值未动（只是不再决定生死）

        const drop = makeDrop(76, 300, 600);
        drop.life = DT;
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        const result = runDropFrames([drop], stats, ledger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 180, DELTA);
        expect(result.collected).toEqual([]);
        expect(result.fell).toEqual([]);
        expect(settleCalls).toBe(0);
        expect(ledger).toEqual(emptyLedger());
        expect(drop.life).toBeLessThan(0); // 寿命早就耗尽
        expect(drop.y).toBeCloseTo(600 - 180 * DELTA, 6); // 仍在场上、仍在向下
    });
});

/**
 * v1.10 修订：**撤销"绝不向上"夹取**（旧键 `dropNeverMovesUp` 已从 `GameTuning` **删除**）。
 *
 * 理由（线上 bug 的根因）：世界滚动**只把掉落物往下推**（② 的位移恒为非负）→ 去掉夹取后，
 * **唯一**能让掉落物向上移动的就是**磁吸** —— 这正是"玩家在掉落物**上方**时也能被吸走并吸收"所必需的。
 * 旧的单调夹取把磁吸的**纵向分量按回原地** → 掉落物只剩横向分量 → 永远追在玩家后面、
 * **进不了** `pickupRadius` → 现象正是"玩家在掉落物上方时只跟随、不吸收"。
 *
 * ⚠️ 本组第一条用例就是该 bug 的**复现用例**：在**旧代码**（夹取还在）上**必然失败**，修复后必然通过。
 */
describe('磁吸可向上（v1.10 修订：撤销"绝不向上"夹取 → 玩家在掉落物上方也能被吸收）', () => {
    it('玩家在掉落物**正上方** + 世界暂停：磁吸把它**向上**吸走 → 进 pickupRadius → Collected **恰好 1 次**（旧代码必失败）', () => {
        const playerY = 760; // 玩家在掉落物**上方** 160px
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius, playerX: 0, playerY, scrollDelta: 0 });
        const drop = makeDrop(81, 100, 600); // 距离 ≈ 188.7 ≤ 192 → 一进来就吸附
        const y0 = drop.y;
        let prevY = drop.y;
        let prevX = drop.x;
        let roseFrames = 0; // "y 变大"的帧数 —— 这正是旧口径**绝不允许**的事
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        let collectedAt = -1;
        for (let i = 0; i < 120; i++) {
            const outcome = stepDrop(drop, DT, world);
            if (outcome === DropOutcome.Collected) {
                collectLikeView(stats, ledger, drop); // ← 唯一结算入口（与 BattleView.collectDrop() 同口径）
                collectedAt = i;
                break;
            }
            expect(outcome).toBe(DropOutcome.Alive);
            expect(drop.y).toBeGreaterThan(prevY); // ① 逐帧 y **变大** = "单调不增"被打破（旧口径下这里是 y === y0）
            expect(drop.x).toBeLessThan(prevX); // ② 横向**同时**靠拢
            roseFrames++;
            prevY = drop.y;
            prevX = drop.x;
        }

        // ③ 确实**连续多帧向上**飞了（不是"没吸附"或"只动了一帧"的假通过）
        expect(roseFrames).toBeGreaterThan(2);
        expect(drop.y).toBeGreaterThan(y0); // 净上升
        expect(drop.magnetized).toBe(true);
        expect(drop.x).toBeLessThan(100); // x 也一路靠拢
        // ④ 最终**进了吸收范围** → 结算**恰好一次**：旧代码里 y 被钉在 y0 → 距离恒 ≥ 160 > 38 → 永远吸不到
        expect(collectedAt).toBeGreaterThan(0);
        expect(settleCalls).toBe(1);
        expect(ledger.exp).toBeGreaterThan(0); // 经验真的进账了
        expect(drop.collected).toBe(true);
        // ⑤ ⓪ 已结算闸门：吸收过的掉落物留在场上也不再被推进 / 不再结算
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        expect(settleCalls).toBe(1);
    });

    it('玩家在掉落物**斜上方**（既有上、又有横向偏移）：斜向上被吸走 → 最终吸收（边界）', () => {
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius, playerX: 140, playerY: 700, scrollDelta: 0 });
        const drop = makeDrop(87, 100, 600); // 玩家在**右上方**：dx = +40、dy = +100（距离 ≈ 107.7 ≤ 192）
        const y0 = drop.y;
        let prevY = drop.y;
        let prevX = drop.x;
        let roseFrames = 0;
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        let collectedAt = -1;
        for (let i = 0; i < 120; i++) {
            const outcome = stepDrop(drop, DT, world);
            if (outcome === DropOutcome.Collected) {
                collectLikeView(stats, ledger, drop); // ← 唯一结算入口
                collectedAt = i;
                break;
            }
            expect(outcome).toBe(DropOutcome.Alive);
            expect(drop.y).toBeGreaterThan(prevY); // ① 向上的分量照样生效（斜向上）
            expect(drop.x).toBeGreaterThan(prevX); // ② 横向朝玩家（右）靠拢
            roseFrames++;
            prevY = drop.y;
            prevX = drop.x;
        }

        expect(roseFrames).toBeGreaterThan(2);
        expect(drop.y).toBeGreaterThan(y0); // 净上升
        expect(drop.x).toBeGreaterThan(100); // 净右移
        expect(collectedAt).toBeGreaterThan(0);
        expect(settleCalls).toBe(1); // 结算恰好 1 次
        expect(drop.collected).toBe(true);
    });

    it('世界滚动本身**只向下**：关掉磁吸 → 逐帧 y **严格单调不增**、每帧位移恰为滚动量', () => {
        const worlds: DropWorld[] = [
            makeWorld({ magnetRadius: 0, playerX: 0, playerY: 760 }), // ① 直接把磁吸半径设为 0
            makeWorld({ magnetRadius: GameTuning.magnetRadius, playerX: 5000, playerY: 760 }), // ② 玩家极远（真源半径也吸不到）
        ];

        for (const world of worlds) {
            const drop = makeDrop(83, 100, 600);
            const y0 = drop.y;
            let prevY = drop.y;
            let frames = 0;

            for (let i = 0; i < 200; i++) {
                world.scrollDelta = DELTA;
                const outcome = stepDrop(drop, DT, world);
                expect([DropOutcome.Alive, DropOutcome.Fell]).toContain(outcome); // 既不结算也不消失
                expect(drop.y).toBeLessThanOrEqual(prevY); // ① **严格单调不增**：世界滚动只会往下推
                expect(prevY - drop.y).toBeCloseTo(DELTA, 9); // ② 每帧位移**恰为**滚动量（不额外加速）
                prevY = drop.y;
                frames++;
            }

            expect(drop.magnetized).toBe(false); // 磁吸确实关着（"只向下"不是因为磁吸恰好没生效）
            expect(drop.y).toBeCloseTo(y0 - frames * DELTA, 6); // 净位移 = 累积滚动量
        }
    });

    it('玩家在掉落物**下方**（向下磁吸）：位移仍 = 滚动 + 磁吸（新口径不改变"向下"这一侧）', () => {
        const MAGNET = GameTuning.magnetRadius;
        const d0 = 150; // 玩家在掉落物**正下方** 150px
        const magnetStep = GameTuning.magnetSpeed * DT;

        // ① 只有磁吸（世界暂停）：位移仍是完整的 magnetStep
        const a = makeDrop(84, 0, PLAYER_Y + d0);
        stepDrop(a, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: 0 }));
        expect(a.y - (PLAYER_Y + d0)).toBeCloseTo(-magnetStep, 9);
        expect(Math.abs(a.y - (PLAYER_Y + d0))).toBeGreaterThan(1); // 非 0（反证：磁吸确实生效了）

        // ② 滚动 + 磁吸：与"叠加"口径完全一致（方向口径对向下的位移是恒等变换）
        const c = makeDrop(85, 0, PLAYER_Y + d0);
        stepDrop(c, DT, makeWorld({ magnetRadius: MAGNET, scrollDelta: DELTA }));
        expect(c.y - (PLAYER_Y + d0)).toBeCloseTo(-(DELTA + magnetStep), 9);
        expect(c.y).toBeLessThan(a.y); // 比"只有磁吸"还低了一个滚动量
    });
});

describe('出屏消失：越过屏幕底边再往下 30 px 才移除，且**绝不结算**', () => {
    it('阈值 = 屏幕底边 − `dropDespawnBelowScreen`（独立复算）；屏幕底与 −30 之间**仍 Alive**（更晚消失）', () => {
        // 公式独立复算一遍（不只看 dropDespawnY() 自己）
        expect(dropDespawnY()).toBeCloseTo(BOTTOM - GameTuning.dropDespawnBelowScreen, 9);
        expect(GameTuning.dropDespawnBelowScreen).toBe(30); // 正值 = 越过屏幕底**再往下** 30px 才消失
        expect(BOTTOM - dropDespawnY()).toBeCloseTo(30, 9);
        expect(dropDespawnY()).toBeLessThan(BOTTOM);

        // 起点：正好在**屏幕底边**（刚出屏，离阈值还差 30px）
        const drop = makeDrop(91, 0, BOTTOM);
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        let fellAt = -1;
        let belowScreenAlive = 0;

        for (let i = 0; i < 200 && fellAt < 0; i++) {
            world.scrollDelta = delta;
            const outcome = stepDrop(drop, DT, world);
            if (outcome === DropOutcome.Fell) fellAt = i;
            else if (drop.y < BOTTOM) belowScreenAlive++; // 已在屏幕外却**还没**消失
        }

        // 30px ÷ 0.333px/帧 ≈ 90 帧才消失（旧口径"越俯冲线就收"早在 ~150px 之前就收走了）
        expect(fellAt).toBeGreaterThan(80);
        expect(fellAt).toBeLessThan(100);
        expect(belowScreenAlive).toBeGreaterThan(80); // "掉出屏幕仍活着"真的发生了 = 更晚消失
        expect(belowScreenAlive).toBeGreaterThanOrEqual(fellAt - 2);
        expect(drop.y).toBeLessThanOrEqual(dropDespawnY()); // 最终确实越过了阈值
    });

    it('恰好在越线那一帧 → Fell；差 1px 不消失（边界）', () => {
        const y = dropDespawnY();
        const still = (id: number, dy: number) =>
            stepDrop(makeDrop(id, 300, y + dy), DT, makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: 0 }));

        expect(still(92, 0)).toBe(DropOutcome.Fell); // 恰好贴线 → 消失
        expect(still(93, 1)).toBe(DropOutcome.Alive); // 高 1px → 不消失
        expect(still(94, -1)).toBe(DropOutcome.Fell); // 低 1px → 消失

        // 滚动把它推过线的**那一帧**（进入时还在线上方）→ 同样当帧 Fell（不吃上一帧的滞后）
        const over = makeDrop(95, 300, y + 0.1);
        expect(stepDrop(over, DT, makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: DELTA }))).toBe(DropOutcome.Fell);
        // 反证：再高一点点（+1px）这一帧就过不去
        const notYet = makeDrop(96, 300, y + 1);
        expect(stepDrop(notYet, DT, makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: DELTA }))).toBe(DropOutcome.Alive);
    });

    it('消失**绝不结算**：账本为空、settleCalls === 0、`collected` 为空、`fell` 命中', () => {
        const drops: Array<DropRuntime | null> = [
            makeDrop(101, 100, dropDespawnY() - 5, DropKind.Exp, 6),
            makeDrop(102, 0, dropDespawnY() - 5, DropKind.Coin, 7),
            makeDrop(103, -100, dropDespawnY() - 5, DropKind.Soul, 3),
            makeDrop(104, 200, BOTTOM + 1, DropKind.SuperCrystal, 2), // 已出屏但**没到**阈值 → 不消失
        ];
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        const result = runDropFrames(drops, stats, ledger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 1, 0);
        expect(result.fell).toEqual([101, 102, 103]); // 三颗过线：只移除
        expect(result.collected).toEqual([]); // 一颗都没结算
        expect(settleCalls).toBe(0); // 结算入口一次都没被调用
        expect(ledger).toEqual(emptyLedger()); // 经验 / 金币 / 魂晶 / 超级水晶**一分都没有**
        expect(drops[3]).not.toBeNull(); // 第 4 颗还在场上（"屏幕底 +1px 不算消失"）
        // `Fell` 与 `Collected` 是**两个不同的结果值** → 视图层不可能把"消失"当成"拾取"
        expect(DropOutcome.Fell).not.toBe(DropOutcome.Collected);
        expect(DropOutcome.Fell as string).toBe('fell');
    });

    it('同一帧内**多个**掉落物一起出屏：全部 Fell（一次循环处理完），账本仍为空', () => {
        const y = dropDespawnY();
        const drops: Array<DropRuntime | null> = [makeDrop(111, 100, y), makeDrop(112, 0, y - 100), makeDrop(113, -100, y - 1)];
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        const result = runDropFrames(drops, stats, ledger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 1, DELTA);
        expect(result.fell).toEqual([111, 112, 113]);
        expect(result.collected).toEqual([]);
        expect(settleCalls).toBe(0);
        expect(ledger).toEqual(emptyLedger());
        expect(drops.every(d => d === null)).toBe(true); // 全部从场上移除（节点也随之销毁）
    });

    it('`dropDespawnBelowScreen` 真的在起作用：= 0 时贴屏幕底就消失（更早）、调大时更晚', () => {
        const original = GameTuning.dropDespawnBelowScreen;
        const at = (id: number, y: number) =>
            stepDrop(makeDrop(id, 300, y), DT, makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: 0 }));
        try {
            GameTuning.dropDespawnBelowScreen = 0; // 贴屏幕底即消失
            expect(dropDespawnY()).toBeCloseTo(BOTTOM, 9);
            expect(at(121, BOTTOM)).toBe(DropOutcome.Fell);
            expect(at(122, BOTTOM + 1)).toBe(DropOutcome.Alive);

            GameTuning.dropDespawnBelowScreen = 200; // 更晚消失
            expect(dropDespawnY()).toBeCloseTo(BOTTOM - 200, 9);
            expect(at(123, BOTTOM - 100)).toBe(DropOutcome.Alive); // 在默认 30 下会消失的位置，现在仍活着
            expect(at(124, BOTTOM - 200)).toBe(DropOutcome.Fell);
        } finally {
            GameTuning.dropDespawnBelowScreen = original; // 必须还原，否则污染后续用例
        }
        expect(GameTuning.dropDespawnBelowScreen).toBe(30); // 已还原
    });
});

describe('只有进入吸收范围才结算（全生命周期 settleCalls === 0 的极端场景）', () => {
    it('玩家极远 + 磁吸关闭：从出生线一路滚到出屏消失 —— 全程 settleCalls === 0、账本为空、最终 Fell', () => {
        const drop = makeDrop(131, 300, GameTuning.spawnLineY - CELL); // 出生线处（屏幕上方）
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        settleCalls = 0;

        // 539 → −697：约 1236px ÷ 0.333 ≈ 3708 帧（给到 5000 帧）
        const result = runDropFrames([drop], stats, ledger, world, 5000, delta);
        expect(result.collected).toEqual([]); // 一趟下来**一次都没结算**
        expect(result.fell).toEqual([131]); // 唯一的结局：出屏消失
        expect(settleCalls).toBe(0); // 全程结算入口调用次数 = 0
        expect(ledger).toEqual(emptyLedger()); // 账本为空（经验 / 金币 / 魂晶 / 超级水晶全 0）
        expect(drop.life).toBeLessThan(0); // 路上寿命早就耗尽了 —— 也没能"隔空结算"
        expect(drop.y).toBeLessThanOrEqual(dropDespawnY());
    });

    it('同一颗掉落物：进吸收范围 → 结算；出屏 → 不结算（`Collected` / `Fell` 严格区分）', () => {
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        // ① 进吸收范围：玩家就在原点，一颗金币正好落在原点 → Collected → 进账
        const picked = runDropFrames(
            [makeDrop(141, 0, 0, DropKind.Coin, 7)],
            stats,
            ledger,
            makeWorld({ magnetRadius: 0, playerX: 0, playerY: 0, scrollDelta: 0 }),
            1,
            0
        );
        expect(picked.collected).toEqual([141]);
        expect(picked.fell).toEqual([]);
        expect(settleCalls).toBe(1);
        expect(ledger.coins).toBe(7);

        // ② 出屏：同样一颗金币（同 kind / 同 value），只是位置在阈值下方 → Fell → **一分不进账**
        const fell = runDropFrames(
            [makeDrop(142, 0, dropDespawnY(), DropKind.Coin, 7)],
            stats,
            ledger,
            makeWorld({ magnetRadius: 0, playerX: 0, playerY: 0, scrollDelta: 0 }),
            1,
            0
        );
        expect(fell.fell).toEqual([142]);
        expect(fell.collected).toEqual([]);
        expect(settleCalls).toBe(1); // 仍然只有 ① 那一次结算
        expect(ledger.coins).toBe(7); // 金币数**没有**变成 14
    });

    it('磁吸只是"把掉落物送进吸收范围"的手段：磁吸收进来的收益与"直接放在玩家身上"**一字不差**', () => {
        const kinds: Array<[DropKind, number]> = [
            [DropKind.Exp, 6],
            [DropKind.Coin, 7],
            [DropKind.Soul, 3],
            [DropKind.SuperCrystal, 2],
        ];

        // A 组：直接放在玩家脚下（第一帧就进 pickupRadius）
        const nearDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => makeDrop(400 + i, 0, PLAYER_Y, kind, value));
        const nearStats = createRunStats();
        const nearLedger = emptyLedger();
        settleCalls = 0;
        const near = runDropFrames(nearDrops, nearStats, nearLedger, makeWorld({ magnetRadius: 0 }), 1, 0);
        const nearSettle = settleCalls;

        // B 组：放在磁吸范围边缘（180 ≤ 192），靠磁吸一路飞进来才结算
        const farDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => makeDrop(500 + i, 0, PLAYER_Y + 180, kind, value));
        const farStats = createRunStats();
        const farLedger = emptyLedger();
        settleCalls = 0;
        const far = runDropFrames(farDrops, farStats, farLedger, makeWorld({ magnetRadius: GameTuning.magnetRadius }), 300, DELTA);
        const farSettle = settleCalls;

        expect(near.collected.length).toBe(4);
        expect(far.collected.length).toBe(4); // 磁吸确实把它们都送进了吸收范围
        expect(nearSettle).toBe(4);
        expect(farSettle).toBe(4); // 结算次数一样（磁吸不是"另一种结算"）
        expect(near.fell).toEqual([]);
        expect(far.fell).toEqual([]);
        // 账本**一字不差**：磁吸只是搬运工，收益口径与"直接走进去"完全相同
        expect(farLedger).toEqual(nearLedger);
        expect(farStats.exp).toBe(nearStats.exp);
        expect(farStats.level).toBe(nearStats.level);
        expect(nearLedger.exp).toBe(6);
        expect(nearLedger.coins).toBe(7);
        expect(nearLedger.souls).toBe(3);
        expect(nearLedger.supers).toBe(2);
    });
});

describe('编译期契约：两个仿真世界共用同一个必填的 scrollDelta', () => {
    it('DropWorld 与 EnemyWorld 都可赋值给 WorldScrollConsumer，且同帧写入**同一个** delta', () => {
        const dropWorld = makeWorld();
        const enemyWorld: EnemyWorld = { playerX: 0, playerY: PLAYER_Y, scrollDelta: 0 };
        // 两者都满足同一个契约（`scrollDelta` 必填 —— 少写这个字段编译期就过不去）
        const consumers: WorldScrollConsumer[] = [dropWorld, enemyWorld];
        expect(consumers.length).toBe(2);

        const step = advanceWorldScroll(0, waveScaling(4).fallSpeed, DT, false, H);
        consumers.forEach(c => {
            c.scrollDelta = step.delta; // 同一个值发给敌人与掉落物
        });

        const enemy = makeFallingEnemy(81);
        const drop = makeDrop(81, 300, 600);
        const enemyY0 = enemy.y;
        const dropY0 = drop.y;
        stepEnemy(enemy, DT, enemyWorld);
        expect(stepDrop(drop, DT, dropWorld)).toBe(DropOutcome.Alive);

        expect(enemyY0 - enemy.y).toBeCloseTo(step.delta, 9);
        expect(dropY0 - drop.y).toBeCloseTo(step.delta, 9);
        expect(enemyY0 - enemy.y).toBeCloseTo(dropY0 - drop.y, 12); // 一位不差
    });

    it('掉落实源：`dropDespawnBelowScreen` = 30；`dropNeverMovesUp` 与两个"自动收取"开关**都已删除**', () => {
        expect(GameTuning.dropDespawnBelowScreen).toBe(30);
        expect(typeof GameTuning.dropDespawnBelowScreen).toBe('number');
        // v1.10 修订：撤销"绝不向上"夹取（磁吸允许向上 → 玩家在上方也能吸收）→ 该键**整体删除**
        expect('dropNeverMovesUp' in GameTuning).toBe(false);
        expect('dropAutoCollectAtDiveLine' in GameTuning).toBe(false);
        expect('dropAutoCollectOnTimeout' in GameTuning).toBe(false);

        // 几何关系（决定了"能在更低处捡到"）：出屏线在俯冲线**之下** → 掉落物会**穿过**俯冲线继续往下
        expect(GameTuning.diveLineY).toBeGreaterThan(dropDespawnY());
        expect(GameTuning.diveLineY - dropDespawnY()).toBeCloseTo(190, 6); // -507 vs -697
        // 俯冲线在屏幕底边**之上**（越过它之后还有 190px 才消失）
        expect(GameTuning.diveLineY).toBeGreaterThan(BOTTOM);
        // 玩家出生点在俯冲线之上（掉落物滚到玩家高度时既没收也没消失，可以正常磁吸 / 拾取）
        expect(PLAYER_Y).toBeGreaterThan(GameTuning.diveLineY);
    });

    it('非法 dt 按 0 处理：不计时、不磁吸，但**世界滚动位移照旧**；越线处**不再**返回 Collected', () => {
        const onPlayer = makeDrop(151, 0, PLAYER_Y);
        expect(stepDrop(onPlayer, NaN, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }))).toBe(DropOutcome.Collected);

        // 越线处：**不再**结算（旧口径在这里返回 Collected）
        const onLine = makeDrop(152, 300, GameTuning.diveLineY - 1);
        expect(stepDrop(onLine, -1, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }))).toBe(DropOutcome.Alive);

        // 出屏线照常判：dt 非法也要在**同一帧**消失
        const belowLine = makeDrop(153, 300, dropDespawnY() + 0.1);
        expect(stepDrop(belowLine, NaN, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }))).toBe(DropOutcome.Fell);

        const far = makeDrop(154, 300, 600);
        far.life = 5;
        far.magnetized = true;
        const world = makeWorld({ magnetRadius: 0, scrollDelta: DELTA, playerX: 300, playerY: PLAYER_Y });
        expect(stepDrop(far, 0, world)).toBe(DropOutcome.Alive);
        expect(far.life).toBe(5); // 不计时
        expect(far.x).toBe(300); // 不磁吸（磁吸步长 = magnetSpeed × 0 = 0）
        expect(far.y).toBeCloseTo(600 - DELTA, 9); // 但世界滚动位移照旧
    });
});

describe('已结算闸门（v1.10 加固）：吸收过的掉落物**永不再产生收益** —— 即使调用方忘了把它移出场', () => {
    /**
     * 复现"**忘了把掉落物移出场**"的 view 层 bug：与上面的 `runDropFrames()` 是**同一套结算口径**
     * （`Collected` → `collectLikeView()` 是唯一入口），唯一区别是 —— `Collected` / `Fell` 之后
     * **都不**把 `drops[i]` 置 null：同一个对象留在场上，之后每帧继续被 `stepDrop()` 推进。
     * 这正是线上那个 bug 的形态（`BattleView.updateDrops()` 吸收后漏了 `removed.push(drop.id)`
     * → 掉落物留在 `m_Drops` 里 → 每帧重复结算 → 经验一直涨）。
     */
    function runDropFramesKeepingDrop(
        drops: DropRuntime[],
        stats: RunStats,
        ledger: Ledger,
        world: DropWorld,
        frames: number,
        deltaPerFrame: number
    ): { collected: number[]; fell: number[]; outcomes: DropOutcome[] } {
        const collected: number[] = [];
        const fell: number[] = [];
        const outcomes: DropOutcome[] = [];
        for (let f = 0; f < frames; f++) {
            world.scrollDelta = deltaPerFrame;
            for (const drop of drops) {
                const outcome = stepDrop(drop, DT, world);
                outcomes.push(outcome);
                if (outcome === DropOutcome.Collected) {
                    collectLikeView(stats, ledger, drop); // ← 唯一结算入口（**故意不**移出场）
                    collected.push(drop.id);
                    continue;
                }
                if (outcome === DropOutcome.Fell) {
                    fell.push(drop.id); // 只记一笔：**不移出场**、**一分收益都不加**
                }
            }
        }
        return { collected, fell, outcomes };
    }

    it('同一个掉落物连续 5 帧都在吸收范围内：第 1 帧 Collected、之后每帧都 Alive；结算计数 === 1、账本只加一次', () => {
        const drop = makeDrop(601, 0, PLAYER_Y, DropKind.Coin, 7); // 与玩家**完全重合** → 第 1 帧必进 pickupRadius
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        // 5 帧**世界照滚**（DELTA ≈ 0.33px/帧，5 帧才挪 1.7px，远在 pickupRadius(38) 里）→ 旧代码每帧都会结算
        const run = runDropFramesKeepingDrop([drop], stats, ledger, makeWorld({ magnetRadius: 0 }), 5, DELTA);

        expect(run.outcomes).toEqual([
            DropOutcome.Collected,
            DropOutcome.Alive,
            DropOutcome.Alive,
            DropOutcome.Alive,
            DropOutcome.Alive,
        ]);
        expect(run.collected).toEqual([601]); // 5 帧里**只有**第 1 帧结算
        expect(run.fell).toEqual([]);
        expect(settleCalls).toBe(1); // ← 结算入口**只被调用 1 次**（不是 5 次）
        expect(drop.collected).toBe(true); // 闸门已置位

        // 账本只加一次：金币 7（**不是** 35），其余三项与升级计数**全是 0**
        expect(ledger.coins).toBe(7);
        expect(ledger.exp).toBe(0);
        expect(ledger.souls).toBe(0);
        expect(ledger.supers).toBe(0);
        expect(ledger.levelUps).toBe(0);
        expect(ledger.level).toBe(1);

        // 已结算的掉落物是"惰性"的：停在置位那一帧的位置，寿命也不再扣（世界还在滚也不动）
        expect(drop.y).toBeCloseTo(PLAYER_Y - DELTA, 9);
        expect(drop.life).toBeCloseTo(GameTuning.dropLifeTime - DT, 9);
    });

    it('四类掉落物各一颗、连续 5 帧都在范围内：**每颗恰好结算 1 次**（共 4 次），账本逐项**不翻倍**', () => {
        const drops: DropRuntime[] = [
            makeDrop(611, 0, PLAYER_Y, DropKind.Exp, 6),
            makeDrop(612, 0, PLAYER_Y, DropKind.Coin, 7),
            makeDrop(613, 0, PLAYER_Y, DropKind.Soul, 3),
            makeDrop(614, 0, PLAYER_Y, DropKind.SuperCrystal, 2),
        ];
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        const run = runDropFramesKeepingDrop(drops, stats, ledger, makeWorld({ magnetRadius: 0 }), 5, 0);

        expect(run.collected).toEqual([611, 612, 613, 614]); // 4 颗都只结算了 1 次（不是 20 次）
        expect(settleCalls).toBe(4);
        expect(run.outcomes.filter(o => o === DropOutcome.Collected).length).toBe(4);
        expect(run.outcomes.filter(o => o === DropOutcome.Alive).length).toBe(16); // 4 颗 × 后 4 帧
        expect(run.fell).toEqual([]);
        drops.forEach(d => expect(d.collected).toBe(true));

        // 账本**逐项**：经验 / 金币 / 魂晶 / 超级水晶各加一次；6 点经验不够 1→2 级，也没升级
        expect(ledger.exp).toBe(6);
        expect(ledger.coins).toBe(7);
        expect(ledger.souls).toBe(3);
        expect(ledger.supers).toBe(2);
        expect(ledger.levelUps).toBe(0);
        expect(ledger.level).toBe(1);
        expect(stats.exp).toBe(6); // RunStats 也只进账一次
        expect(stats.level).toBe(1);
    });

    it('模拟"忘记移除"：故意不移出场、连跑 300 帧（期间它越过俯冲线与屏幕底 −30）——结算次数仍 === 1、账本不变', () => {
        // 起始：玩家与掉落物都在出生点 → 第 1 帧必被吸收
        const drop = makeDrop(621, 0, PLAYER_Y, DropKind.Coin, 7);
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0, scrollDelta: 0 });
        settleCalls = 0;

        // ① 第 1 帧：进吸收范围 → Collected → 走唯一结算入口（随后**故意不把它移出场**）
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Collected);
        collectLikeView(stats, ledger, drop);
        const settledLedger = { ...ledger };
        expect(settleCalls).toBe(1);
        expect(settledLedger.coins).toBe(7);

        // ② 再连跑 300 帧"世界照滚 + 忘了移除"：每帧都调一次 stepDrop，节点始终留在场上。
        //    ⚠️ 闸门在位移**之前**就返回 → 已结算的掉落物自己滚不动了；所以这里照"一个仍在按
        //    背景滚动摆放这个陈旧节点的 view"**手动**把它每帧往下摆 1px（300 帧 = 300px，足够从
        //    出生点越过俯冲线 -507 与出屏线 -697；真实滚动 ≈0.33px/帧 要 660+ 帧）—— 这正是要压的场景。
        const run: DropOutcome[] = [];
        let framesBelowDespawn = 0;
        for (let f = 0; f < 300; f++) {
            world.scrollDelta = DELTA;
            run.push(stepDrop(drop, DT, world)); // ← 已结算 → 只会是 Alive
            drop.y -= 1; // 视图层仍在滚动这个"已被遗忘"的节点
            if (drop.y <= dropDespawnY()) framesBelowDespawn++;
        }

        expect(run.every(o => o === DropOutcome.Alive)).toBe(true); // 300 帧里**没有**第二个 Collected
        expect(run.includes(DropOutcome.Collected)).toBe(false);
        expect(run.includes(DropOutcome.Fell)).toBe(false);
        expect(settleCalls).toBe(1); // ← 这条就是原来那个线上 bug：漏了移除也**只结算一次**
        expect(ledger).toEqual(settledLedger); // 账本一分没变（金币仍是 7，不是 7 × 301）
        expect(drop.y).toBeLessThan(GameTuning.diveLineY); // 确实越过了俯冲线
        expect(drop.y).toBeLessThanOrEqual(dropDespawnY()); // 也确实越过了"屏幕底 −30"
        expect(framesBelowDespawn).toBeGreaterThan(50); // 有 70+ 帧是在出屏线**下方**被反复 stepDrop 的
        expect(drop.collected).toBe(true);
    });

    it('已结算后不再有其它结果：越出屏线**不**返回 Fell（仍 Alive）、放回玩家身上也**不**再结算，账本无变化', () => {
        const settled = makeDrop(631, 0, PLAYER_Y, DropKind.Soul, 3);
        const stats = createRunStats();
        const ledger = emptyLedger();
        settleCalls = 0;

        // ① 正常吸收一次（魂晶 3）
        expect(stepDrop(settled, DT, makeWorld({ magnetRadius: 0, scrollDelta: 0 }))).toBe(DropOutcome.Collected);
        collectLikeView(stats, ledger, settled);
        const settledLedger = { ...ledger };
        expect(settleCalls).toBe(1);
        expect(settledLedger.souls).toBe(3);

        const world = makeWorld({ magnetRadius: 0, playerX: 0, playerY: PLAYER_Y });

        // ② 越过出屏线（屏幕底 −30 = -697）：**不许**返回 Fell（更不许返回 Collected）—— 只回 Alive
        settled.y = dropDespawnY() - 0.5;
        expect(stepDrop(settled, DT, world)).toBe(DropOutcome.Alive);
        settled.y = dropDespawnY() - 5000; // 掉到屏幕下方 5000px 也照样只回 Alive
        expect(stepDrop(settled, DT, world)).toBe(DropOutcome.Alive);

        // ③ 再把它"放回"玩家身上（闸门与位置无关）：仍然只回 Alive
        settled.x = 0;
        settled.y = PLAYER_Y;
        expect(stepDrop(settled, DT, world)).toBe(DropOutcome.Alive);

        expect(settleCalls).toBe(1); // 一路都还是那**一次**结算
        expect(ledger).toEqual(settledLedger); // 魂晶仍是 3（**没有**变成 6）
        expect(settled.collected).toBe(true);

        // 对照组（证明"不是判定坏了"）：**没结算过**的同类掉落物在同一个出屏位置 → 照常 Fell
        const fresh = makeDrop(632, 0, dropDespawnY() - 0.5, DropKind.Soul, 3);
        expect(stepDrop(fresh, DT, world)).toBe(DropOutcome.Fell);
        expect(fresh.collected).toBeUndefined(); // Fell **不**置闸门（它本来就不产生收益）
        expect(settleCalls).toBe(1); // 对照组也**没有**结算
        expect(ledger).toEqual(settledLedger);
    });
});