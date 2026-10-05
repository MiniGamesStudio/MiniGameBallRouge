/**
 * L1 单测：掉落物接入**滚动世界**（v1.10）—— 锁步 / 暂停 / 磁吸叠加 / 越俯冲线自动收取
 *
 * 对应策划案 §11.1（散落）、§11.3（拾取与超时）、§24.5（数值）、§24.8 与**附录 K**。
 * 全部是纯逻辑（不依赖 cc），被测对象是 core/DropSim.ts + core/ScrollWorld.ts + core/EnemySim.ts。
 *
 * 刻意不做"看起来差不多"的断言，而是把四条口径写成**可证伪的不变量**：
 *   ① **锁步**：同一帧内 掉落物位移 === 敌人位移 === 背景块位移 === `scrollDelta`（**逐帧**断言）；
 *   ② **暂停**：暂停 N 帧 delta ≡ 0、掉落物 y **分毫未动**；恢复后第一帧位移**恰为** `fallSpeed × dt`
 *      （**不补**暂停期间累积的量）；
 *   ③ **磁吸叠加**：磁吸位移与滚动位移**相加**（顺序写死"先滚动、再磁吸"，谁也**不覆盖**谁），
 *      且**世界暂停时磁吸照常**（磁吸是玩家侧行为，与"俯冲不受世界暂停影响"同口径）；
 *   ④ **自动收取**：越过 `diveLineY` 的**那一帧**就被收取，且与正常拾取走**同一条结算路径**
 *      （两者返回同一个结果值 → 视图层只可能有一条结算分支；本文件直接断言两边账本一字不差）。
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
import { DropOutcome, DropWorld, hasDropCrossedDiveLine, stepDrop } from '../../assets/scripts/Game/CommonGame/gameplay/core/DropSim';
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
        autoCollectAtDiveLine: GameTuning.dropAutoCollectAtDiveLine,
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

/** 本局账本（只为"同一条结算路径"的相等性断言服务） */
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

/**
 * 与 `BattleView.collectDrop()` **同一套**结算（照抄那 4 个 case，连 `m_PendingLevelUps` 的
 * 累计口径都保留）—— 用来证明"自动收取"与"正常拾取"的账本**一字不差**。
 */
function collectLikeView(stats: RunStats, ledger: Ledger, drop: DropRuntime): void {
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
 * **结算只有一个入口**（`Collected` → `collectLikeView`），`Expired` 只移除不结算。
 */
function runDropFrames(
    drops: Array<DropRuntime | null>,
    stats: RunStats,
    ledger: Ledger,
    world: DropWorld,
    frames: number,
    deltaPerFrame: number
): { collected: number[]; expired: number[] } {
    const collected: number[] = [];
    const expired: number[] = [];
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
            if (outcome === DropOutcome.Expired) {
                expired.push(drop.id);
                drops[i] = null;
            }
        }
    }
    return { collected, expired };
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
        const frames = 600; // 10 s（< dropLifeTime 15 s，避免超时干扰锁步断言）

        for (let i = 0; i < frames; i++) {
            const step = advanceWorldScroll(scrollY, SPEED, DT, false, H);
            scrollY = step.scrollY;
            travelled += step.delta;

            const tileBefore = backgroundTileBottomY(BASE, wrapBackgroundOffset(scrollY - step.delta, H), H, 0);
            const tileAfter = backgroundTileBottomY(BASE, scrollY, H, 0);

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
    });

    it('长跑 5000 帧（跨多次背景回绕）不漂移：掉落物与敌人累计位移完全一致', () => {
        const enemy = makeFallingEnemy(2);
        // 故意把两者放到屏幕外**很高处**：整段长跑都不会越俯冲线
        // → 敌人全程 Falling、掉落物全程 Alive（本条测的是"位移锁步"，不是越线）
        enemy.y = 1300;
        const drop = makeDrop(2, 300, 1300);
        drop.life = 1e9; // 只为不让 15 s 超时干扰"长跑不漂移"这条性质

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

        expect(notAlive).toBe(0); // 整段都没被收走（配置确实"不会越线"）
        expect(enemy.state).toBe(EnemyState.Falling); // 敌人也整段保持 Falling
        expect(travelled).toBeGreaterThan(H * 2); // 跨了 2 个以上背景周期（回绕真的发生了）
        expect(drop.y).toBeCloseTo(1300 - travelled, 6);
        expect(enemy.y).toBeCloseTo(1300 - travelled, 6);
        expect(drop.y).toBeCloseTo(enemy.y, 9); // 起点相同 → 终点也必须一位不差
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

    it('世界暂停时**存活计时照走**（与 Telegraph 的 stateTime 同口径），磁吸也照常', () => {
        const drop = makeDrop(33, 0, PLAYER_Y + 150); // 玩家正上方 150px（磁吸范围内、拾取范围外）
        drop.life = 1.0;
        const world = makeWorld({ magnetRadius: GameTuning.magnetRadius, scrollDelta: 0 }); // 世界暂停

        const life0 = drop.life;
        const y0 = drop.y;
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        expect(drop.life).toBeCloseTo(life0 - DT, 9); // 计时照走
        expect(drop.magnetized).toBe(true); // 磁吸照常生效
        expect(y0 - drop.y).toBeGreaterThan(0); // 且确实朝玩家飞了
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

describe('越俯冲线自动收取（走**同一条**结算路径，掉落不丢）', () => {
    it('未越线时**不**收取；越线的**那一帧**被收取', () => {
        const drop = makeDrop(51, 300, GameTuning.diveLineY + 10); // 线上方 10px
        const world = makeWorld({ magnetRadius: 0 });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;
        world.scrollDelta = delta;

        // 只擦一下：还在线上方 → 必须 Alive（不能提前收）
        expect(stepDrop(drop, DT, world)).toBe(DropOutcome.Alive);
        expect(hasDropCrossedDiveLine(drop)).toBe(false);

        // 一直滚到越线
        let frames = 0;
        let outcome = DropOutcome.Alive;
        let aliveWhileCrossed = false;
        while (outcome === DropOutcome.Alive && frames < 200) {
            world.scrollDelta = delta;
            outcome = stepDrop(drop, DT, world);
            frames++;
            if (outcome === DropOutcome.Alive && hasDropCrossedDiveLine(drop)) aliveWhileCrossed = true;
        }

        expect(aliveWhileCrossed).toBe(false); // 越线后**当帧**就收（不会漏收、不会拖到下一帧）
        expect(outcome).toBe(DropOutcome.Collected);
        expect(drop.y).toBeLessThanOrEqual(GameTuning.diveLineY);
        // 越线**前**一帧确实还在线上方（即"恰好在越线那一帧"收取）
        expect(drop.y + world.scrollDelta).toBeGreaterThan(GameTuning.diveLineY);
        // 10px ÷ 0.333px/帧 ≈ 30 帧（不断言精确帧数：浮点除法不保证整商）
        expect(frames).toBeGreaterThan(25);
        expect(frames).toBeLessThan(40);
    });

    it('越线判定用**中心**：恰好等于 diveLineY 算越线，差 1e-9 就不算', () => {
        expect(hasDropCrossedDiveLine(makeDrop(52, 0, GameTuning.diveLineY))).toBe(true);
        expect(hasDropCrossedDiveLine(makeDrop(53, 0, GameTuning.diveLineY + 1e-9))).toBe(false);
        expect(hasDropCrossedDiveLine(makeDrop(54, 0, GameTuning.diveLineY - 1))).toBe(true);
    });

    it('玩家在**很远**处（磁吸关闭）也会被收取 —— 证明收取来自"越线"而不是"拾取"', () => {
        const drop = makeDrop(55, 0, GameTuning.diveLineY + 1);
        const world = makeWorld({ magnetRadius: 0, playerX: 5000, playerY: PLAYER_Y });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;

        let outcome = DropOutcome.Alive;
        for (let i = 0; i < 10 && outcome === DropOutcome.Alive; i++) {
            world.scrollDelta = delta;
            outcome = stepDrop(drop, DT, world);
        }
        expect(outcome).toBe(DropOutcome.Collected);
        expect(hasDropCrossedDiveLine(drop)).toBe(true);
        // 距离玩家仍极远 —— 绝不可能是"拾取"收的
        expect(Math.abs(drop.x - world.playerX)).toBeGreaterThan(1000);
    });

    it('关掉开关（`dropAutoCollectAtDiveLine = false`）就会掉出屏幕丢掉 —— 这就是默认 true 的理由', () => {
        const drop = makeDrop(56, 0, GameTuning.diveLineY + 1);
        const world = makeWorld({ magnetRadius: 0, playerX: 5000, autoCollectAtDiveLine: false });
        const delta = advanceWorldScroll(0, SPEED, DT, false, H).delta;

        let outcome = DropOutcome.Alive;
        let frames = 0;
        // 一直滚到"掉出屏幕底部"为止（约 483 帧 / 8 s，远早于 15 s 超时）
        while (outcome === DropOutcome.Alive && !(drop.y < screenBounds().bottom) && frames < 2000) {
            world.scrollDelta = delta;
            outcome = stepDrop(drop, DT, world);
            frames++;
        }
        expect(drop.y).toBeLessThan(screenBounds().bottom); // 已经掉到屏幕底下
        expect(outcome).toBe(DropOutcome.Alive); // 却**还没被收** → 掉落就这么没了
        expect(drop.life).toBeGreaterThan(0); // 不是超时丢的，是"滚出屏幕"丢的
    });

    it('同一帧内**多个**掉落物都被收取（一次循环处理完）', () => {
        const drops: Array<DropRuntime | null> = [
            makeDrop(61, 100, GameTuning.diveLineY - 13),
            makeDrop(62, 0, GameTuning.diveLineY - 100),
            makeDrop(63, -100, GameTuning.diveLineY - 7),
        ];
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0, playerX: 5000 });

        const result = runDropFrames(drops, stats, ledger, world, 1, DELTA);
        expect(result.collected).toEqual([61, 62, 63]);
        expect(result.expired).toEqual([]);
        // 三颗经验水晶（各 6 点）**全部**进了账：6 → 6 → 12（升级 → 4）→ 10
        // （exp 10 这个数只有在"三颗都结算了"时才成立 —— 顺手证明没有漏收）
        expect(ledger.exp).toBeCloseTo(10, 9);
        expect(ledger.level).toBe(2);
        expect(ledger.levelUps).toBe(1);
    });

    it('自动收取与正常拾取**走同一条结算路径**：结果值相同、账本一字不差', () => {
        const kinds: Array<[DropKind, number]> = [
            [DropKind.Exp, 6],
            [DropKind.Coin, 7],
            [DropKind.Soul, 3],
            [DropKind.SuperCrystal, 2],
        ];

        // A 组：正常拾取（掉落物就落在玩家脚下 → 第一帧进 pickupRadius）
        const pickDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) => makeDrop(100 + i, 0, PLAYER_Y, kind, value));
        const pickStats = createRunStats();
        const pickLedger = emptyLedger();
        const pick = runDropFrames(pickDrops, pickStats, pickLedger, makeWorld({ magnetRadius: 0 }), 1, 0);

        // B 组：越俯冲线自动收取（玩家在极远处、磁吸关闭 → **只可能**是越线规则收的）
        const autoDrops: Array<DropRuntime | null> = kinds.map(([kind, value], i) =>
            makeDrop(200 + i, 0, GameTuning.diveLineY + 10, kind, value)
        );
        const autoStats = createRunStats();
        const autoLedger = emptyLedger();
        const auto = runDropFrames(autoDrops, autoStats, autoLedger, makeWorld({ magnetRadius: 0, playerX: 5000 }), 40, DELTA);

        // ① 两边都被收了（B 组不是"没收上"的假通过）
        expect(pick.collected.length).toBe(4);
        expect(auto.collected.length).toBe(4);
        expect(auto.expired).toEqual([]);
        // ② 触发方式不同的两条路径，返回的却是**同一个**结果值 → 视图层只可能有一条结算分支
        const pickupOutcome = stepDrop(makeDrop(300, 0, PLAYER_Y), DT, makeWorld({ magnetRadius: 0, scrollDelta: 0 }));
        const autoOutcome = stepDrop(
            makeDrop(301, 300, GameTuning.diveLineY - 1),
            DT,
            makeWorld({ magnetRadius: 0, playerX: 5000, scrollDelta: 0 })
        );
        expect(pickupOutcome).toBe(DropOutcome.Collected); // 正常拾取
        expect(autoOutcome).toBe(DropOutcome.Collected); // 越俯冲线自动收取
        expect(pickupOutcome).toBe(autoOutcome); // 两者不可区分 → 结算路径必然是同一条
        // ③ 账本完全一致：同样的钱、同样的魂晶、同样的超级水晶、同样的经验与等级
        expect(autoLedger).toEqual(pickLedger);
        expect(autoStats.level).toBe(pickStats.level);
        expect(autoStats.exp).toBe(pickStats.exp);
        expect(autoLedger.coins).toBe(7);
        expect(autoLedger.souls).toBe(3);
        expect(autoLedger.supers).toBe(2);
    });
});

describe('超时：移除但**不结算**（§11.3 既有口径，未改动）', () => {
    it('存活时间耗尽 → Expired（不是 Collected），且不产生任何收益', () => {
        const drop = makeDrop(71, 300, 600);
        drop.life = DT; // 只剩一帧
        const stats = createRunStats();
        const ledger = emptyLedger();
        const world = makeWorld({ magnetRadius: 0 });

        const result = runDropFrames([drop], stats, ledger, world, 2, DELTA);
        expect(result.expired).toEqual([71]);
        expect(result.collected).toEqual([]);
        expect(ledger).toEqual(emptyLedger()); // 一分钱经验都没有
        expect(ledger.levelUps).toBe(0);
    });

    it('超时**优先于**拾取（与既有实现一致：先扣 life、超时即移除）', () => {
        const drop = makeDrop(72, 0, PLAYER_Y); // 已经贴在玩家身上
        drop.life = DT; // 但这一帧恰好超时
        expect(stepDrop(drop, DT, makeWorld({ magnetRadius: 0 }))).toBe(DropOutcome.Expired);
    });

    it('生存时长耗尽后即使越线也不结算（超时优先，保持既有边界）', () => {
        const drop = makeDrop(73, 300, GameTuning.diveLineY - 50);
        drop.life = DT;
        expect(stepDrop(drop, DT, makeWorld({ magnetRadius: 0 }))).toBe(DropOutcome.Expired);
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

    it('掉落实真源：自动收取开关默认**开**（关掉就会掉出屏幕丢掉落）', () => {
        expect(GameTuning.dropAutoCollectAtDiveLine).toBe(true);
        expect(typeof GameTuning.dropAutoCollectAtDiveLine).toBe('boolean');
        // 俯冲线在屏幕底边**之上**（所以"越线即收"一定发生在掉出屏幕之前）
        expect(GameTuning.diveLineY).toBeGreaterThan(screenBounds().bottom);
        // 玩家出生点在俯冲线之上（掉落物滚到玩家高度时仍未被收，可以正常磁吸/拾取）
        expect(PLAYER_Y).toBeGreaterThan(GameTuning.diveLineY);
    });

    it('非法 dt 按 0 处理：不计时、不磁吸，但**世界滚动位移照旧**（位移已含 dt，与敌人同口径）', () => {
        const onPlayer = makeDrop(91, 0, PLAYER_Y);
        expect(stepDrop(onPlayer, NaN, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }))).toBe(DropOutcome.Collected);
        const onLine = makeDrop(92, 300, GameTuning.diveLineY - 1);
        expect(stepDrop(onLine, -1, makeWorld({ magnetRadius: 0, scrollDelta: DELTA }))).toBe(DropOutcome.Collected);

        const far = makeDrop(93, 300, 600);
        far.life = 5;
        far.magnetized = true;
        const world = makeWorld({ magnetRadius: 0, scrollDelta: DELTA, playerX: 300, playerY: PLAYER_Y });
        expect(stepDrop(far, 0, world)).toBe(DropOutcome.Alive);
        expect(far.life).toBe(5); // 不计时
        expect(far.x).toBe(300); // 不磁吸（磁吸步长 = magnetSpeed × 0 = 0）
        expect(far.y).toBeCloseTo(600 - DELTA, 9); // 但世界滚动位移照旧
    });
});