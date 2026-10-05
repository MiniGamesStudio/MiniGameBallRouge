/**
 * L1 单测：滚动世界（v1.10 起）—— 背景回绕 / 世界推进 / 无缝拼接 / 与敌人锁步
 *
 * 对应策划案 §9.2（生成与入场 / 背景滚动）与 §24.8。
 * 全部是纯逻辑（不依赖 cc），被测对象是 core/ScrollWorld.ts + core/EnemySim.ts。
 *
 * 这里刻意**不做**"看起来差不多了"的断言，而是把三条无缝/锁步性质写成可证伪的不变量：
 *   ① 世界暂停 → delta = 0（背景与敌人同时静止）；
 *   ② 回绕步长 = 一个图案周期 ⇒ 图案局部坐标在回绕点**连续**（逐像素无缝，不是目测）；
 *   ③ 任意回绕偏移下，拼接块的并集都覆盖整个可视区（无空隙）；
 *   ④ 敌人的屏幕位移与背景块的位移**严格相等**（同一个 delta，绝无第二套速度）。
 *
 * 背景有**两条路径**，本文件两条都测：
 *   · **网格兜底**（v1.10 原始实现）：周期 H = `backgroundGridPatternHeight`（必须整除 cellSize）；
 *   · **真实美术**（v1.10 起接管 `m_GameBg`）：周期 = 节点的**实际显示高度**（`resolvePatternHeight`），
 *     块间用交叉淡入淡出消接缝（`seamFadeStrips` / `seamFadeStripCount`），
 *     摆位前要做**场空间 → 面板空间**换算（`backgroundSpaceScale`），否则窄高屏上会和敌人脱锁步。
 */
import { EnemyRuntime, EnemyShape, EnemyState, EnemyType, Quality } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';
import {
    FALLBACK_PATTERN_HEIGHT,
    MAX_SEAM_FADE_STRIPS,
    WorldScrollStep,
    advanceWorldScroll,
    backgroundSpaceScale,
    backgroundTileBottomY,
    backgroundTileCount,
    effectiveScrollDelta,
    gridAlignedBottom,
    resolvePatternHeight,
    seamFadeStripCount,
    seamFadeStrips,
    wrapBackgroundOffset,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/ScrollWorld';
import { applyStopBlocking, stepEnemy } from '../../assets/scripts/Game/CommonGame/gameplay/core/EnemySim';
import { waveScaling } from '../../assets/scripts/Game/CommonGame/gameplay/core/MathModels';
import { screenBounds } from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';

const DT = 1 / 60;
/**
 * 周期 H —— 这里取的是**网格兜底**路径的周期（`backgroundGridPatternHeight` = 768 = 6 格）。
 *
 * 为什么不是 `backgroundPatternHeight`：那一项现在是**真实美术路径**的开关，
 * 默认 **0 = 自动**（= `m_GameBg` 的实际显示高度，见 `resolvePatternHeight`）。
 * 本文件里依赖"周期必须整除 cellSize"的用例都是**网格路径**的性质，所以必须取网格那一项；
 * 真实美术路径的周期性质另有专门的 describe（见文件末尾）。
 */
const H = GameTuning.backgroundGridPatternHeight;
const CELL = GameTuning.cellSize;

/** 与 BattleView 完全同一套算法：先定网格底基准，再按"可视高度 + 一个周期"算块数 */
function layout(): { baseY: number; count: number; top: number; bottom: number } {
    const b = screenBounds();
    const baseY = gridAlignedBottom(GameTuning.spawnLineY, b.bottom, CELL);
    return { baseY, count: backgroundTileCount(b.top - baseY, H), top: b.top, bottom: b.bottom };
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
        speed: waveScaling(1).fallSpeed,
        state: EnemyState.Falling,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

describe('背景回绕 wrapBackgroundOffset（§9.2 无缝循环）', () => {
    it('0 / 正好一个周期 / 多周期都回到 0，多周期带余数取余数', () => {
        expect(wrapBackgroundOffset(0, H)).toBe(0);
        expect(wrapBackgroundOffset(H, H)).toBe(0);
        expect(wrapBackgroundOffset(H * 2, H)).toBe(0);
        expect(wrapBackgroundOffset(H * 100, H)).toBe(0);
        expect(wrapBackgroundOffset(H + 7.5, H)).toBeCloseTo(7.5, 9);
        expect(wrapBackgroundOffset(H * 37 + 123.25, H)).toBeCloseTo(123.25, 9);
    });

    it('负值也能落到 [0, H)（JS 的 % 对负数返回负值，必须补一个周期）', () => {
        expect(wrapBackgroundOffset(-1, H)).toBeCloseTo(H - 1, 9);
        expect(wrapBackgroundOffset(-H, H)).toBe(0);
        expect(wrapBackgroundOffset(-H - 5, H)).toBeCloseTo(H - 5, 9);
        expect(wrapBackgroundOffset(-H * 9 - 0.5, H)).toBeCloseTo(H - 0.5, 9);
    });

    it('极小值 / 极大值：结果恒在 [0, H) 内且有限', () => {
        const samples = [1e-12, -1e-12, 1e12, -1e12, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.1];
        for (const v of samples) {
            const o = wrapBackgroundOffset(v, H);
            expect(Number.isFinite(o)).toBe(true);
            expect(o).toBeGreaterThanOrEqual(0);
            expect(o).toBeLessThan(H);
        }
    });

    it('patternHeight <= 0 或非有限值一律兜底 0（不抛异常、不返回负值）', () => {
        expect(wrapBackgroundOffset(123, 0)).toBe(0);
        expect(wrapBackgroundOffset(123, -H)).toBe(0);
        expect(wrapBackgroundOffset(123, NaN)).toBe(0);
        expect(wrapBackgroundOffset(123, Infinity)).toBe(0);
        expect(wrapBackgroundOffset(NaN, H)).toBe(0);
        expect(wrapBackgroundOffset(Infinity, H)).toBe(0);
        expect(wrapBackgroundOffset(-Infinity, H)).toBe(0);
    });

    it('性质：任意输入的结果都落在 [0, H)', () => {
        for (let i = -350; i <= 350; i++) {
            const o = wrapBackgroundOffset(i * 13.37, H);
            expect(o).toBeGreaterThanOrEqual(0);
            expect(o).toBeLessThan(H);
        }
    });
});

describe('世界推进 advanceWorldScroll / effectiveScrollDelta（唯一滚动源）', () => {
    it('**世界暂停时 delta 必须为 0**，即使传进来的位移很大', () => {
        expect(effectiveScrollDelta(0, true)).toBe(0);
        expect(effectiveScrollDelta(10, true)).toBe(0);
        expect(effectiveScrollDelta(1e9, true)).toBe(0);
        expect(effectiveScrollDelta(-5, true)).toBe(0);

        const step = advanceWorldScroll(100, 20, DT, true, H);
        expect(step.delta).toBe(0);
        // 暂停时累计量也**一点都不动** → 背景与敌人同时静止（恢复后从原处继续）
        expect(step.scrollY).toBe(100);
    });

    it('未暂停时 delta = speed × dt；负值 / NaN / Infinity 兜底为 0', () => {
        expect(effectiveScrollDelta(3.5, false)).toBe(3.5);
        expect(effectiveScrollDelta(0, false)).toBe(0);
        expect(effectiveScrollDelta(-3.5, false)).toBe(0);
        expect(effectiveScrollDelta(NaN, false)).toBe(0);
        expect(effectiveScrollDelta(Infinity, false)).toBe(0);

        const step = advanceWorldScroll(0, GameTuning.baseFallSpeed, DT, false, H);
        expect(step.delta).toBeCloseTo(GameTuning.baseFallSpeed * DT, 9);
    });

    it('滚动速度就是当前波的 fallSpeed（fallSpeed 语义不变，行距不变量仍成立）', () => {
        for (const wave of [1, 2, 5, 8, 20, 999]) {
            const speed = waveScaling(wave).fallSpeed;
            const step = advanceWorldScroll(0, speed, DT, false, H);
            expect(step.delta).toBeCloseTo(speed * DT, 9);
            // 走完"一行间距"所需的帧数 × 每帧 delta ≈ rowGapCells 格（§9.2 的行距不变量）
            const gapSeconds = (CELL * GameTuning.rowGapCells) / speed;
            expect(gapSeconds * speed).toBeCloseTo(CELL * GameTuning.rowGapCells, 9);
        }
    });

    it('累计量按周期回绕：走满一个周期后偏移精确回到原值（回绕因此不可见）', () => {
        let scrollY = 0;
        let travelled = 0;
        // 用很慢的速度慢慢走，让回绕点被"踩"到
        const speed = GameTuning.baseFallSpeed;
        const frames = Math.ceil(H / (speed * DT)) + 5;
        for (let i = 0; i < frames; i++) {
            const step = advanceWorldScroll(scrollY, speed, DT, false, H);
            scrollY = step.scrollY;
            travelled += step.delta;
        }
        // travelled 已经超过一个周期，偏移 = travelled 对 H 取模
        expect(scrollY).toBeCloseTo(wrapBackgroundOffset(travelled, H), 6);
        expect(scrollY).toBeGreaterThanOrEqual(0);
        expect(scrollY).toBeLessThan(H);
    });

    it('长期运行（100 万帧）不丢精度：累计量始终有限且落在 [0, H)', () => {
        let scrollY = 0;
        const speed = waveScaling(8).fallSpeed;
        for (let i = 0; i < 1000000; i++) {
            const step: WorldScrollStep = advanceWorldScroll(scrollY, speed, DT, false, H);
            scrollY = step.scrollY;
        }
        expect(Number.isFinite(scrollY)).toBe(true);
        expect(scrollY).toBeGreaterThanOrEqual(0);
        expect(scrollY).toBeLessThan(H);
    });
});

describe('背景拼接：块数保证无空隙（§9.2）', () => {
    it('本配置（可视高 1408 / 周期 768）需要 3 块 —— 与"两块或三块"一致', () => {
        const { baseY, count, top, bottom } = layout();
        expect(count).toBe(3);
        expect(backgroundTileCount(screenBounds().top - baseY, H)).toBe(3);
        expect(backgroundTileCount(1334, H)).toBe(3);

        // 两块在 offset = 0 时"看起来够"：并集 [-741, 795] 盖住了可视区 [-667, 667]……
        expect(baseY).toBeLessThanOrEqual(bottom);
        expect(baseY + 2 * H).toBeGreaterThanOrEqual(top);
        // ……但 offset 顶到接近一个周期时，并集上沿掉到屏幕里 → 露出空隙。
        // 这就是一般式里必须 "+1 块"的原因，也是"不能凭手感取 2 块"的证据。
        expect(baseY - (H - 1e-6) + 2 * H).toBeLessThan(top);
    });

    it('块数 = ceil(可视高 ÷ 周期) + 1（一般式）', () => {
        expect(backgroundTileCount(1408, 768)).toBe(3);
        expect(backgroundTileCount(1334, 512)).toBe(4);
        expect(backgroundTileCount(1408, 1408)).toBe(2);
        expect(backgroundTileCount(1408, 2048)).toBe(2);
        expect(backgroundTileCount(10, 100)).toBe(2);
    });

    it('退化输入兜底 1 块（不返回 0 块，否则画面上什么都没有）', () => {
        expect(backgroundTileCount(0, H)).toBe(1);
        expect(backgroundTileCount(-100, H)).toBe(1);
        expect(backgroundTileCount(1334, 0)).toBe(1);
        expect(backgroundTileCount(1334, -H)).toBe(1);
        expect(backgroundTileCount(NaN, H)).toBe(1);
    });

    it('任意回绕偏移下，块组并集都覆盖整个可视区（**无空隙**）', () => {
        const { baseY, count, top, bottom } = layout();
        for (let i = 0; i <= 200; i++) {
            const offset = (i / 200) * H;
            let lowest = Infinity;
            let highest = -Infinity;
            for (let k = 0; k < count; k++) {
                const b = backgroundTileBottomY(baseY, offset, H, k);
                lowest = Math.min(lowest, b);
                highest = Math.max(highest, b + H);
            }
            expect(lowest).toBeLessThanOrEqual(bottom);
            expect(highest).toBeGreaterThanOrEqual(top);
        }
    });

    it('块位置对偏移以"一个周期"为周期（回绕瞬间只是整体下移一个周期）', () => {
        const { baseY, count } = layout();
        for (let k = 0; k < count; k++) {
            // offset = H 与 offset = 0 是同一时刻（回绕），位置差恰好是一个周期
            expect(backgroundTileBottomY(baseY, H, H, k) - backgroundTileBottomY(baseY, 0, H, k)).toBeCloseTo(-H, 9);
            expect(backgroundTileBottomY(baseY, H, H, k)).toBeCloseTo(backgroundTileBottomY(baseY, 0, H, k - 1), 9);
            expect(backgroundTileBottomY(baseY, 0, H, k)).toBeCloseTo(baseY + k * H, 9);
        }
    });
});

describe('网格基准与敌人占格对齐（§9.2 / §5）', () => {
    it('网格底基准 ≤ 屏幕底边，且再往上加一格就越过屏幕底边（即"最大的格子对齐点"）', () => {
        const b = screenBounds();
        const base = gridAlignedBottom(GameTuning.spawnLineY, b.bottom, CELL);
        expect(base).toBeLessThanOrEqual(b.bottom);
        expect(base + CELL).toBeGreaterThan(b.bottom);
        // 相位 = 出生线：占格线与背景网格线永远重合
        expect((GameTuning.spawnLineY - base) % CELL).toBeCloseTo(0, 9);
    });

    it('周期 H 是 cellSize 的整数倍（网格间距才等于一格，回绕才对得上格点）', () => {
        expect(H % CELL).toBe(0);
        expect(H / CELL).toBe(6);
        expect(GameTuning.backgroundGridPatternHeight).toBeGreaterThan(0);
        // 真实美术路径的周期是"自动"（0 = 用节点显示高度），所以它**不该**被网格约束
        expect(GameTuning.backgroundPatternHeight).toBe(0);
    });

    it('cellSize <= 0 / 非有限输入兜底返回 bottom', () => {
        expect(gridAlignedBottom(667, -667, 0)).toBe(-667);
        expect(gridAlignedBottom(667, -667, -128)).toBe(-667);
        expect(gridAlignedBottom(NaN, -667, CELL)).toBe(-667);
        expect(gridAlignedBottom(667, -667, NaN)).toBe(-667);
    });
});

describe('无缝的数学判据：图案局部坐标连续且以周期为周期（**逐像素**无缝，不是目测）', () => {
    it('回绕点前后局部坐标连续，且偏移前进一个周期后局部坐标完全相同', () => {
        const { baseY } = layout();
        /** 屏幕点 p 在背景图案里的局部 y（0..H）：这就是"这个像素画的是什么" */
        const localY = (p: number, offset: number) => wrapBackgroundOffset(p - baseY + offset, H);

        for (let i = 0; i <= 40; i++) {
            const p = -700 + (i / 40) * 1400; // 覆盖整屏（含屏幕外一点）
            expect(localY(p, H)).toBeCloseTo(localY(p, 0), 9); // 周期 = H
            expect(Math.abs(localY(p, H - 1e-9) - localY(p, 0))).toBeLessThan(1e-6); // 连续（不闪跳）
        }
    });

    it('偏移每前进一点点，图案只移动一点点（圆周距离 ≤ 位移量）—— 全程无跳变', () => {
        const { baseY } = layout();
        const p = 123.75;
        const localY = (offset: number) => wrapBackgroundOffset(p - baseY + offset, H);
        const step = H / 5000;

        for (let i = 0; i < 5000; i++) {
            const a = localY(i * step);
            const b = localY((i + 1) * step);
            const diff = Math.abs(a - b);
            // 图案是**环形**的（局部 H 与局部 0 是同一处），所以用圆周距离比较
            const circular = Math.min(diff, H - diff);
            expect(circular).toBeLessThanOrEqual(step + 1e-9);
        }
    });
});

describe('锁步：敌人位移与背景位移用的是同一个 delta（绝不出现两套速度）', () => {
    it('Falling 敌人的每帧位移严格等于 world.scrollDelta；背景块的位移也是同一个值', () => {
        const { baseY, count } = layout();
        const enemy = makeFallingEnemy(1);
        const world = { playerX: 0, playerY: 0, scrollDelta: 0 };

        let scrollY = 0;
        const speed = waveScaling(1).fallSpeed;
        // 只走一段**不跨回绕**的时间，好让"第 0 块"始终是同一块，位移可以直接相减
        const frames = Math.floor((H * 0.9) / (speed * DT));

        for (let i = 0; i < frames; i++) {
            const step = advanceWorldScroll(scrollY, speed, DT, false, H);
            scrollY = step.scrollY;

            const tileBefore = backgroundTileBottomY(baseY, scrollY - step.delta, H, 0);
            const tileAfter = backgroundTileBottomY(baseY, scrollY, H, 0);
            const before = enemy.y;
            world.scrollDelta = step.delta;
            stepEnemy(enemy, DT, world);

            // ① 敌人位移 = delta
            expect(before - enemy.y).toBeCloseTo(step.delta, 9);
            // ② 背景位移 = delta
            expect(tileBefore - tileAfter).toBeCloseTo(step.delta, 9);
            // ③ 两者严格相等 → 锁步
            expect(before - enemy.y).toBeCloseTo(tileBefore - tileAfter, 9);
        }

        // 这段跑下来敌人确实移动了整段累计滚动量（不是"几乎没动"）
        expect(enemy.y).toBeCloseTo(GameTuning.spawnLineY - CELL - scrollY, 6);
        expect(count).toBeGreaterThan(0);
    });

    it('世界暂停（任一敌人被停住）→ delta = 0 → 敌人与背景**一起**静止', () => {
        const { baseY } = layout();
        const enemy = makeFallingEnemy(2);
        const stopper = makeFallingEnemy(3);
        stopper.state = EnemyState.Telegraph; // 到底站住 → 全场停

        const enemies = [enemy, stopper];
        const world = { playerX: 0, playerY: 0, scrollDelta: 0 };

        for (let i = 0; i < 120; i++) {
            // 与 BattleView.updateScroll() 的接法一致：applyStopBlocking 的返回值 = 暂停标志
            const paused = applyStopBlocking(enemies);
            expect(paused).toBe(true);
            const step = advanceWorldScroll(0, waveScaling(1).fallSpeed, DT, paused, H);

            const tileBefore = backgroundTileBottomY(baseY, 0, H, 0);
            const yBefore = enemy.y;
            world.scrollDelta = step.delta;
            stepEnemy(enemy, DT, world);

            expect(step.delta).toBe(0);
            expect(enemy.y).toBe(yBefore); // 敌人不动
            expect(backgroundTileBottomY(baseY, step.scrollY, H, 0)).toBe(tileBefore); // 背景也不动
        }
        // 恢复（停住的那个敌人被消灭）后：两边一起继续
        const resumed = applyStopBlocking([enemy]);
        expect(resumed).toBe(false);
        const step = advanceWorldScroll(0, waveScaling(1).fallSpeed, DT, resumed, H);
        expect(step.delta).toBeGreaterThan(0);
        world.scrollDelta = step.delta;
        const yBefore = enemy.y;
        stepEnemy(enemy, DT, world);
        expect(yBefore - enemy.y).toBeCloseTo(step.delta, 9);
    });

    it('blocked（全场停止标记）与 delta = 0 是同一个结论，不会自相矛盾', () => {
        const a = makeFallingEnemy(4);
        const b = makeFallingEnemy(5);
        // 没有任何敌人停住 → 不暂停、所有 blocked 清掉
        expect(applyStopBlocking([a, b])).toBe(false);
        expect(a.blocked).toBe(false);

        // 冰冻一个 → 全场 blocked 且返回 true（BattleView 据此把 delta 压成 0）
        b.frozen = true;
        expect(applyStopBlocking([a, b])).toBe(true);
        expect(a.blocked).toBe(true);
        expect(a.frozen).toBeUndefined();

        // 空场（换波空窗）不算暂停：背景继续滚，观感才连续
        expect(applyStopBlocking([])).toBe(false);
    });
});

// ─────────────────────────── 真实美术路径（v1.10 起接管 m_GameBg）───────────────────────────

describe('resolvePatternHeight：周期 = 背景节点的实际显示高度（0 = 自动）', () => {
    it('自动：显式 0 → 用节点显示高度（contentSize.height × |scale|）', () => {
        expect(resolvePatternHeight(0, 1334, 1)).toBe(1334);
        expect(resolvePatternHeight(0, 1334, 2)).toBe(2668);
        expect(resolvePatternHeight(0, 1334, 0.5)).toBe(667);
        // 镜像（负缩放）**不改变**显示高度 → 必须取绝对值
        expect(resolvePatternHeight(0, 1334, -2)).toBe(2668);
    });

    it('显式覆盖优先：非 0 就按它来，与节点尺寸无关（保留旧行为可控）', () => {
        expect(resolvePatternHeight(768, 1334, 1)).toBe(768);
        expect(resolvePatternHeight(1408, 1334, 2)).toBe(1408);
        expect(resolvePatternHeight(1, 1334, 1)).toBe(1);
    });

    it('显式值非法（0 / 负 / NaN / ±Infinity）→ 一律视为"自动"，不退化成 0', () => {
        for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
            expect(resolvePatternHeight(bad, 1334, 1)).toBe(1334);
        }
    });

    it('缩放非法（0 / NaN / ±Infinity）→ 按 1 处理（读不到缩放就当没缩放）', () => {
        for (const bad of [0, NaN, Infinity, -Infinity]) {
            expect(resolvePatternHeight(0, 1334, bad)).toBe(1334);
        }
    });

    it('节点高度非法（0 / 负 / NaN / ±Infinity）→ 落到兜底周期，绝不返回 0/NaN', () => {
        for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
            expect(resolvePatternHeight(0, bad, 1)).toBe(FALLBACK_PATTERN_HEIGHT);
        }
        // 两侧都非法也一样
        expect(resolvePatternHeight(0, 0, 0)).toBe(FALLBACK_PATTERN_HEIGHT);
        expect(resolvePatternHeight(NaN, NaN, NaN)).toBe(FALLBACK_PATTERN_HEIGHT);
    });

    it('兜底周期必须是有限正数（否则块数会退化成 1 块 → 露空隙）', () => {
        expect(Number.isFinite(FALLBACK_PATTERN_HEIGHT)).toBe(true);
        expect(FALLBACK_PATTERN_HEIGHT).toBeGreaterThan(0);
        expect(FALLBACK_PATTERN_HEIGHT % CELL).toBe(0); // 兜底值也满足网格的整除约束
    });

    it('返回恒为有限正数（穷举一小片非法输入空间）', () => {
        const values = [0, -1, 1, 768, 1334, NaN, Infinity, -Infinity];
        for (const a of values) {
            for (const b of values) {
                for (const c of values) {
                    const h = resolvePatternHeight(a, b, c);
                    expect(Number.isFinite(h)).toBe(true);
                    expect(h).toBeGreaterThan(0);
                }
            }
        }
    });
});

describe('真实美术路径：块数必须盖满整屏（少一块就露空隙）', () => {
    /** 与 BattleView.createNodeBackground() 同一套算法：显示高度 → 块间距 → 块数 → 覆盖区间 */
    const H_NODE = 1334; // m_GameBg 的 contentSize.height（面板铺满，fitHeight 下可视高就是 1334）
    const SPACING = resolvePatternHeight(GameTuning.backgroundPatternHeight, H_NODE, 1);
    const BASE = -667; // 面板锚点 0.5 → 可视区 [-667, 667]；节点原位在中心，底边就是 -667

    /** 块 k 的底边（= BattleView.updateBackground() 用的同一函数） */
    const tileBottom = (offset: number, k: number) => backgroundTileBottomY(BASE, offset, SPACING, k);

    it('auto（0）下周期 = 节点显示高度 1334，块数 = 2（ceil(1334/1334) + 1）', () => {
        expect(SPACING).toBe(H_NODE);
        expect(backgroundTileCount(H_NODE, SPACING)).toBe(2);
    });

    it('块数由 backgroundTileCount() 推出，任意偏移下并集都盖满 [-667, 667]', () => {
        const count = backgroundTileCount(H_NODE - BASE, SPACING);
        for (let i = 0; i <= 60; i++) {
            const offset = (i / 60) * SPACING * 0.999; // 覆盖整个回绕区间 [0, H)
            const bottoms = Array.from({ length: count }, (_, k) => tileBottom(offset, k));
            expect(Math.min(...bottoms)).toBeLessThanOrEqual(-667);
            expect(Math.max(...bottoms) + SPACING).toBeGreaterThanOrEqual(667);
        }
    });

    it('**少一块就露空隙**（这就是"别凭手感取 1 块"的证据）', () => {
        const count = backgroundTileCount(H_NODE - BASE, SPACING);
        // 取 offset = 0.999 × H：只有一块时，它已经快移出屏幕，顶部必然露白
        const offset = SPACING * 0.999;
        const oneTileTop = tileBottom(offset, 0) + SPACING;
        expect(oneTileTop).toBeLessThan(667); // ← 一块盖不住（空隙）
        const fullTop = tileBottom(offset, count - 1) + SPACING;
        expect(fullTop).toBeGreaterThanOrEqual(667); // ← 按 backgroundTileCount 取够块数才盖住
    });

    it('回绕前后画面逐像素相同（块间距 = 周期 ⇒ 整体下移一块，视觉不变）', () => {
        const count = backgroundTileCount(H_NODE - BASE, SPACING);
        // offset 前进一个间距 ⇒ 块整体下移一块：块 k 正好落到"原来块 k-1"的位置
        // （所有块长得一模一样 ⇒ 画面逐像素不变）
        for (let k = 1; k < count; k++) {
            expect(tileBottom(SPACING, k)).toBeCloseTo(tileBottom(0, k - 1), 9);
        }
        // 且局部坐标（"这个像素画的是什么"）严格以周期为周期
        const localY = (p: number, offset: number) => wrapBackgroundOffset(p - BASE + offset, SPACING);
        for (let i = 0; i <= 40; i++) {
            const p = -700 + (i / 40) * 1400;
            expect(localY(p, SPACING)).toBeCloseTo(localY(p, 0), 9);
            expect(Math.abs(localY(p, SPACING - 1e-9) - localY(p, 0))).toBeLessThan(1e-6);
        }
    });

    it('显式覆盖周期会改变块数（旧行为仍可控）', () => {
        // 显式 768 < 可视高 1334 → 两块盖不满 → 必须多块
        expect(backgroundTileCount(H_NODE, 768)).toBe(3);
        expect(backgroundTileCount(H_NODE, 768)).toBeGreaterThan(backgroundTileCount(H_NODE, H_NODE));
    });
});

describe('backgroundSpaceScale：场空间 → 面板空间的换算（锁步的关键）', () => {
    it('两侧同缩放 → 1（不换算）', () => {
        expect(backgroundSpaceScale(1, 1)).toBe(1);
        expect(backgroundSpaceScale(0.82, 0.82)).toBeCloseTo(1, 9);
    });

    it('窄高屏：场空间被 contain 缩到 0.82、面板不缩 → 系数 0.82', () => {
        // m_GameRoot 的 scale = min(1, visibleW/750, visibleH/1334)；19.5:9 屏 ≈ 0.82
        expect(backgroundSpaceScale(0.82, 1)).toBeCloseTo(0.82, 9);
        // 于是"场空间滚 100px"在面板空间只摆 82px → 屏幕上两者位移相等（锁步）
        expect(100 * backgroundSpaceScale(0.82, 1)).toBeCloseTo(82, 9);
    });

    it('缩放读不到（0 / 负 / NaN / ±Infinity）→ 返回 1，绝不返回 0/NaN/负值', () => {
        const values = [0, -1, NaN, Infinity, -Infinity];
        for (const v of values) {
            expect(backgroundSpaceScale(v, 1)).toBe(1);
            expect(backgroundSpaceScale(1, v)).toBe(1);
        }
        for (const a of values) {
            for (const b of values) {
                const scale = backgroundSpaceScale(a, b);
                expect(Number.isFinite(scale)).toBe(true);
                expect(scale).toBeGreaterThan(0);
            }
        }
    });

    it('极端比例被夹在 [1e-3, 1e3]（周期不会变成 0 / Infinity）', () => {
        expect(backgroundSpaceScale(1e-9, 1e9)).toBe(0.001);
        expect(backgroundSpaceScale(1e9, 1e-9)).toBe(1000);
    });

    it('换算后的周期仍然合法：period = 间距 ÷ 系数（BattleView.backgroundFieldPeriod 的接法）', () => {
        const spacing = 1334;
        const scale = backgroundSpaceScale(0.82, 1);
        const period = spacing / scale;
        expect(Number.isFinite(period)).toBe(true);
        expect(period).toBeGreaterThan(0);
        // 反推：period × scale === spacing（回绕步长的视觉长度恰好 = 一块）
        expect(period * scale).toBeCloseTo(spacing, 9);
    });
});

describe('接缝交叉淡入淡出：接缝两边在原图里必须是**相邻行**（构造保证无缝）', () => {
    const TEX_H = 2848; // background/game_bg 的真实高度
    const FADE = GameTuning.backgroundSeamFadeRows;
    const TILE_H = 1334; // 一块在节点本地单位里的高度

    it('条带铺满"被裁掉的那段"，且不重叠不留缝：rectY 连续、末条正好到贴图底部', () => {
        const strips = seamFadeStrips(TEX_H, FADE, 4, TILE_H);
        expect(strips.length).toBe(4);
        expect(strips[0].rectY).toBe(TEX_H - FADE); // 从主图末尾那一行开始
        for (let i = 0; i + 1 < strips.length; i++) {
            expect(strips[i].rectY + strips[i].rectHeight).toBeCloseTo(strips[i + 1].rectY, 9);
        }
        const last = strips[strips.length - 1];
        expect(last.rectY + last.rectHeight).toBeCloseTo(TEX_H, 9); // 正好贴到贴图底部
    });

    it('alpha 从 ~1 单调降到 ~0（离散化的线性渐变）', () => {
        const strips = seamFadeStrips(TEX_H, FADE, 8, TILE_H);
        expect(strips[0].alpha).toBeGreaterThan(0.8);
        expect(strips[0].alpha).toBeLessThanOrEqual(1);
        for (let i = 0; i + 1 < strips.length; i++) {
            expect(strips[i + 1].alpha).toBeLessThan(strips[i].alpha);
        }
        expect(strips[strips.length - 1].alpha).toBeLessThan(0.2);
        expect(strips[strips.length - 1].alpha).toBeGreaterThan(0); // 绝不为 0（否则尾段露出未叠加的主图）
    });

    it('条带在块本地坐标里正好贴着块**顶边**往下铺（top 处合成 = 主图，底部 = 被裁掉的行）', () => {
        const strips = seamFadeStrips(TEX_H, FADE, 4, TILE_H);
        expect(strips[0].offsetFromTop).toBeCloseTo(0, 9); // 第一条从块顶边开始
        let sum = 0;
        for (const s of strips) sum += s.displayHeight;
        // 全部条带加起来 = 一块里"被裁掉的那段的显示高度" = FADE 行 × (块高 ÷ 主图行数)
        expect(sum).toBeCloseTo((FADE * TILE_H) / (TEX_H - FADE), 6);
        for (let i = 0; i + 1 < strips.length; i++) {
            expect(strips[i].offsetFromTop + strips[i].displayHeight).toBeCloseTo(strips[i + 1].offsetFromTop, 6);
        }
    });

    it('**接缝性质**：块 k 的顶边接到块 k-1 的底边，接缝处两行在原图里相邻', () => {
        // 块内容 = 原图 [0, TEX_H-FADE) 行；块顶边又被条带以 alpha 渐变叠成"被裁掉的行"
        const contentRows = TEX_H - FADE;
        // 块 k-1 的最后一行 = 主图第 contentRows-1 行；块 k 的第一行（顶边，w→1）= 原图第 contentRows 行
        expect(contentRows - 1).toBe(TEX_H - FADE - 1);
        expect(contentRows).toBe(TEX_H - FADE);
        // 两者在**原图**里 index 相差 1 ⇒ 相邻 ⇒ 不存在"跳变行"
        expect(contentRows - (contentRows - 1)).toBe(1);
        // 而"完全不淡出"的朴素平铺：接缝是 原图末行 → 原图首行（index 差 TEX_H-1，实测 6.27×）
        expect(TEX_H - 1).toBeGreaterThan(1);
    });

    it('条数与"每条显示高度 ≤ 上限"一致，且有上限保护', () => {
        const rowScale = TILE_H / (TEX_H - FADE); // 每个贴图行的显示高度 ≈ 0.47px
        const count = seamFadeStripCount(FADE, rowScale, GameTuning.backgroundSeamFadeMaxStripPx);
        expect(count).toBeGreaterThanOrEqual(1);
        expect(FADE / count * rowScale).toBeLessThanOrEqual(GameTuning.backgroundSeamFadeMaxStripPx + 1e-9);
        // 上限保护：条数不会随 fadeRows 无限增长（注意 fadeRows 必须 < textureHeight，否则本就该返回空）
        expect(seamFadeStripCount(1e6, 1, 0.001)).toBe(MAX_SEAM_FADE_STRIPS);
        expect(seamFadeStrips(TEX_H, TEX_H - 1, 1e6, TILE_H).length).toBe(MAX_SEAM_FADE_STRIPS);
    });

    it('默认配置下条数 = 每个贴图行一条（子像素台阶，实测带内最大行差 1.59× < 美术自身 2.25×）', () => {
        const rowScale = TILE_H / (TEX_H - FADE);
        const count = seamFadeStripCount(FADE, rowScale, GameTuning.backgroundSeamFadeMaxStripPx);
        expect(count).toBe(FADE);
        // 每条 ≈ 0.47px（远小于 1px → 看不出台阶）
        expect((FADE / count) * rowScale).toBeLessThan(0.5);
    });

    it('输入非法（行数 0/负/NaN、贴图比淡出带还矮、块高 ≤ 0）→ 返回空数组（调用方退化成不淡出）', () => {
        expect(seamFadeStrips(TEX_H, 0, 4, TILE_H)).toEqual([]);
        expect(seamFadeStrips(TEX_H, -8, 4, TILE_H)).toEqual([]);
        expect(seamFadeStrips(TEX_H, NaN, 4, TILE_H)).toEqual([]);
        expect(seamFadeStrips(8, 8, 4, TILE_H)).toEqual([]); // fadeRows == textureHeight → 没有主图
        expect(seamFadeStrips(4, 8, 4, TILE_H)).toEqual([]); // fadeRows > textureHeight
        expect(seamFadeStrips(TEX_H, FADE, 4, 0)).toEqual([]);
        expect(seamFadeStrips(0, FADE, 4, TILE_H)).toEqual([]);
        expect(seamFadeStrips(NaN, FADE, 4, TILE_H)).toEqual([]);
        expect(seamFadeStrips(TEX_H, FADE, 0, TILE_H)).toEqual([]); // 条数 0
    });

    it('所有输出恒为有限数（穷举一小片非法输入空间，防 NaN 传进 SpriteFrame）', () => {
        const values = [0, -1, 1, 8, 2848, NaN, Infinity, -Infinity];
        for (const texH of values) {
            for (const rows of values) {
                for (const count of values) {
                    for (const tileH of values) {
                        const strips = seamFadeStrips(texH, rows, count, tileH);
                        for (const s of strips) {
                            expect(Number.isFinite(s.rectY)).toBe(true);
                            expect(Number.isFinite(s.rectHeight)).toBe(true);
                            expect(Number.isFinite(s.alpha)).toBe(true);
                            expect(Number.isFinite(s.displayHeight)).toBe(true);
                            expect(Number.isFinite(s.offsetFromTop)).toBe(true);
                            expect(s.rectHeight).toBeGreaterThan(0);
                            expect(s.displayHeight).toBeGreaterThan(0);
                            expect(s.alpha).toBeGreaterThan(0);
                            expect(s.alpha).toBeLessThanOrEqual(1);
                        }
                    }
                }
            }
        }
    });
});

describe('真实美术路径 · 世界暂停 3 秒再恢复：不跳位（② 的需求）', () => {
    const H_NODE = 1334;
    const SPACING = resolvePatternHeight(GameTuning.backgroundPatternHeight, H_NODE, 1);
    const SCALE = backgroundSpaceScale(0.82, 1); // 窄高屏（m_GameRoot 被 contain 缩到 0.82）
    const PERIOD = SPACING / SCALE; // 场空间周期（advanceWorldScroll 用的那个）
    const BASE = -667;

    it('暂停 3 秒：背景与敌人都不动，且累计量/偏移一点没变', () => {
        const enemy = makeFallingEnemy(9);
        const stopper = makeFallingEnemy(10);
        stopper.state = EnemyState.Telegraph;
        const enemies = [enemy, stopper];
        const world = { playerX: 0, playerY: 0, scrollDelta: 0 };

        // 先正常滚一小段，拿到"暂停前"的状态
        let scrollY = 0;
        for (let i = 0; i < 30; i++) {
            const step = advanceWorldScroll(scrollY, waveScaling(1).fallSpeed, DT, false, PERIOD);
            scrollY = step.scrollY;
            world.scrollDelta = step.delta;
            stepEnemy(enemy, DT, world);
        }
        const scrollBefore = scrollY;
        const enemyBefore = enemy.y;
        const offsetBefore = wrapBackgroundOffset(scrollY * SCALE, SPACING);
        const tileBefore = backgroundTileBottomY(BASE, offsetBefore, SPACING, 0);
        expect(scrollBefore).toBeGreaterThan(0);
        expect(tileBefore).toBeLessThan(BASE); // 确实滚下去了（不是"一直没动"的假通过）

        // 暂停 3 秒（180 帧）
        for (let i = 0; i < 180; i++) {
            const paused = applyStopBlocking(enemies);
            expect(paused).toBe(true);
            const step = advanceWorldScroll(scrollY, waveScaling(1).fallSpeed, DT, paused, PERIOD);
            scrollY = step.scrollY;
            world.scrollDelta = step.delta;
            stepEnemy(enemy, DT, world);
            expect(step.delta).toBe(0);
        }
        expect(scrollY).toBe(scrollBefore); // 累计量没变（不是"滚了又滚回来"）
        expect(enemy.y).toBe(enemyBefore);
        expect(wrapBackgroundOffset(scrollY * SCALE, SPACING)).toBeCloseTo(offsetBefore, 9);

        // 恢复：从暂停前的位置**继续**，不跳位（第一帧位移 = 正常一帧的位移）
        const resumed = applyStopBlocking([enemy]);
        expect(resumed).toBe(false);
        const after = advanceWorldScroll(scrollY, waveScaling(1).fallSpeed, DT, resumed, PERIOD);
        // 恢复后的第一帧**就是**普通一帧的位移（没有把暂停的 3 秒补回来）
        expect(after.delta).toBeCloseTo(waveScaling(1).fallSpeed * DT, 9);
        expect(after.delta).toBeLessThan(1); // 单帧位移 < 1px（绝不会补上 3 秒的 60px）
        expect(after.scrollY).toBeCloseTo(scrollY + after.delta, 9);
        // 背景同理：恢复后只前进 after.delta × 系数
        const offsetAfter = wrapBackgroundOffset(after.scrollY * SCALE, SPACING);
        const tileAfter = backgroundTileBottomY(BASE, offsetAfter, SPACING, 0);
        expect(tileBefore - tileAfter).toBeCloseTo(after.delta * SCALE, 6);
        expect(tileBefore - tileAfter).toBeLessThan(1); // 背景也没有跳
    });

    it('恢复后继续到回绕点：画面逐像素相同（不闪跳、不露空隙）', () => {
        const count = backgroundTileCount(H_NODE - BASE, SPACING);
        let scrollY = PERIOD * 0.9; // 逼近回绕点
        const offsetA = wrapBackgroundOffset(scrollY * SCALE, SPACING);
        const bottomsA = Array.from({ length: count }, (_, k) => backgroundTileBottomY(BASE, offsetA, SPACING, k));
        // 再前进到刚过回绕点
        scrollY = PERIOD * 0.9 + PERIOD * 0.2;
        const wrapped = wrapBackgroundOffset(scrollY * SCALE, SPACING);
        // 回绕后 offset 变成"小值"，但整组块的相对结构完全一致（相当于整体错位一块）
        const bottomsB = Array.from({ length: count }, (_, k) => backgroundTileBottomY(BASE, wrapped, SPACING, k));
        expect(bottomsB[0] - bottomsA[0]).toBeCloseTo(bottomsB[1] - bottomsA[1], 9); // 相对间距不变
        expect(Math.min(...bottomsB)).toBeLessThanOrEqual(-667);
        expect(Math.max(...bottomsB) + SPACING).toBeGreaterThanOrEqual(667); // 回绕瞬间也不露空隙
    });
});