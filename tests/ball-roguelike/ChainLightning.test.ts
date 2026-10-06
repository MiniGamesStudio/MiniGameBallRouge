/**
 * L1 单测：闪电链（纯逻辑）
 *
 * 覆盖 core/ChainLightning.ts 的两块：目标选取（pickNearestChainTargets）、
 * 折线几何与推进（buildBoltPath / truncatePath / reachedTargetCount）。
 * 数值派生（lightningSpec）搬去了 SpecialBullets.test.ts —— 那是它现在的家。
 *
 * 这里刻意**不测**表现层（view/ChainLightningFx.ts 依赖 cc，跑不进 node）——
 * 但"0.35s 内播完""在第 k 个目标处结算"这类可出错的判断，全部落在这些纯函数上，
 * 表现层只剩"把点连起来画"这一件事。
 */
import { SeededRandom, ScriptedRandom } from '../../assets/scripts/Game/CommonGame/gameplay/core/Rng';
import {
    ChainCandidate,
    Point,
    buildBoltPath,
    pathLength,
    pickNearestChainTargets,
    reachedTargetCount,
    truncatePath,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/ChainLightning';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';

/** 直线距离 */
function dist(a: Point, b: Point): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** 点到直线 ab 的垂直距离 */
function perpDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** 造一条「N 个目标、每跳 segs 段」的折线（与 view 层的拼接方式一致） */
function makeChain(targets: Point[], segs: number, jitter = GameTuning.chainLightningJitter, rng = new SeededRandom(3)): Point[] {
    const path: Point[] = [{ x: targets[0].x, y: targets[0].y }];
    for (let i = 1; i < targets.length; i++) {
        const hop = buildBoltPath(rng, targets[i - 1], targets[i], segs, jitter);
        for (let k = 1; k < hop.length; k++) path.push(hop[k]);
    }
    return path;
}

/** 造一个候选（id + 坐标） */
function cand(id: number, x: number, y: number): ChainCandidate {
    return { id, x, y };
}

const LINE_TARGETS: Point[] = [0, 1, 2, 3, 4].map(i => ({ x: i * 200, y: 0 }));

describe('pickNearestChainTargets：从命中点连最近的 N 个', () => {
    const origin: Point = { x: 0, y: 0 };

    it('按距离从近到远取，取满且互不重复', () => {
        const cs = [cand(1, 300, 0), cand(2, 100, 0), cand(3, 200, 0), cand(4, 400, 0)];
        const picked = pickNearestChainTargets(origin, cs, 3);
        expect(picked.map(c => c.id)).toEqual([2, 3, 1]);
        expect(new Set(picked.map(c => c.id)).size).toBe(3);
    });

    it('逐跳贪心：第 2 个选的是「离第 1 个最近」的，而不是「离起点第二近」的', () => {
        // P 最近（100）。剩下两个里，B 离起点更近（102 < 105），但 A 紧挨着 P（5）。
        // 贪心应当选 A —— 闪电是"跳"过去的，不是"从起点辐射"。
        const P = cand(1, 100, 0);
        const B = cand(2, 0, 102);
        const A = cand(3, 105, 0);
        expect(dist(origin, B)).toBeLessThan(dist(origin, A)); // 前提：B 确实离起点更近
        const picked = pickNearestChainTargets(origin, [P, B, A], 2);
        expect(picked.map(c => c.id)).toEqual([1, 3]);
    });

    it('等距时按 id 升序做确定性 tie-break（不依赖数组顺序）', () => {
        const left = cand(3, -100, 0);
        const right = cand(7, 100, 0);
        expect(pickNearestChainTargets(origin, [right, left], 1)[0].id).toBe(3);
        expect(pickNearestChainTargets(origin, [left, right], 1)[0].id).toBe(3);
    });

    it('excludeId 排除锚点自身（哪怕是最近的）', () => {
        const anchor = cand(9, 1, 0); // 距离 1，若不排除必然第一个被选中
        const other = cand(4, 50, 0);
        const picked = pickNearestChainTargets(origin, [anchor, other], 2, 9);
        expect(picked.map(c => c.id)).toEqual([4]);
    });

    it('候选不足时全取（不报错、不重复取同一个）', () => {
        const cs = [cand(1, 10, 0), cand(2, 20, 0)];
        expect(pickNearestChainTargets(origin, cs, 5)).toHaveLength(2);
        expect(pickNearestChainTargets(origin, [], 5)).toEqual([]);
    });

    it('count <= 0 返回空（不传负数是调用方的责任，但也不能崩）', () => {
        const cs = [cand(1, 10, 0), cand(2, 20, 0)];
        expect(pickNearestChainTargets(origin, cs, 0)).toEqual([]);
        expect(pickNearestChainTargets(origin, cs, -2)).toEqual([]);
    });

    it('乱序输入得到同一结果（确定性：闪电链不吃随机、可复现）', () => {
        const cs = [cand(1, 300, 0), cand(2, 100, 0), cand(3, 200, 0), cand(4, 150, 0)];
        const shuffled = [cs[3], cs[0], cs[2], cs[1]];
        expect(pickNearestChainTargets(origin, shuffled, 4).map(c => c.id)).toEqual(
            pickNearestChainTargets(origin, cs, 4).map(c => c.id)
        );
    });

    it('绝不重复取同一个候选（贪心从已选集合出发也不会自环）', () => {
        const cs = [cand(1, 10, 0), cand(2, 10, 0), cand(3, 10, 0)]; // 三个完全重合
        const picked = pickNearestChainTargets(origin, cs, 3);
        expect(picked.map(c => c.id)).toEqual([1, 2, 3]);
        expect(new Set(picked.map(c => c.id)).size).toBe(3);
    });

    it('需求里的默认档：闪电链 3 个目标 = 锚点 1 + 连锁 2', () => {
        const cs = Array.from({ length: 8 }, (_, i) => cand(i + 1, (i + 1) * 40, 0));
        const linked = pickNearestChainTargets(origin, cs, GameTuning.lightningChainTargets - 1);
        expect(linked).toHaveLength(2);
    });
});

describe('buildBoltPath：一跳的折线', () => {
    const from: Point = { x: -300, y: 120 };
    const to: Point = { x: 260, y: -80 };

    it('首尾严格落在两端目标上（闪电必须咬住目标）', () => {
        const path = buildBoltPath(new SeededRandom(5), from, to, 7, 26);
        expect(path[0]).toEqual(from);
        expect(path[path.length - 1]).toEqual(to);
        expect(path).toHaveLength(8); // segments + 1
    });

    it('抖动幅度不超过 jitter，且两端振幅为 0（sin(πt) 收窄）', () => {
        const jitter = 26;
        for (let seed = 1; seed <= 20; seed++) {
            const path = buildBoltPath(new SeededRandom(seed), from, to, 6, jitter);
            // 端点：与直线的垂距为 0
            expect(perpDistance(path[0], from, to)).toBeCloseTo(0, 6);
            expect(perpDistance(path[path.length - 1], from, to)).toBeCloseTo(0, 6);
            // 中间点：不超过 jitter
            for (let i = 1; i < path.length - 1; i++) {
                expect(perpDistance(path[i], from, to)).toBeLessThanOrEqual(jitter + 1e-6);
            }
        }
    });

    it('segs = 1 时退化成两点直线（不产生 NaN）', () => {
        const path = buildBoltPath(new ScriptedRandom([0.5]), from, to, 1, 26);
        expect(path).toHaveLength(2);
        expect(path[0]).toEqual(from);
        expect(path[1]).toEqual(to);
    });

    it('同种子完全可复现', () => {
        const a = buildBoltPath(new SeededRandom(77), from, to, 5, 26);
        const b = buildBoltPath(new SeededRandom(77), from, to, 5, 26);
        expect(a).toEqual(b);
    });

    it('竖直排列的两个目标也要有明显抖动（抖动取法线，不是 x/y 各自随机）', () => {
        const up: Point = { x: 0, y: 500 };
        const down: Point = { x: 0, y: -500 };
        const path = buildBoltPath(new SeededRandom(9), up, down, 6, 26);
        const maxX = Math.max(...path.slice(1, -1).map(p => Math.abs(p.x)));
        expect(maxX).toBeGreaterThan(5);
    });
});

describe('truncatePath：按进度截断', () => {
    const path = makeChain(LINE_TARGETS, 4);

    it('progress <= 0 什么都不画；>= 1 画满整条', () => {
        expect(truncatePath(path, 0)).toEqual([]);
        expect(truncatePath(path, -1)).toEqual([]);
        expect(truncatePath(path, 1)).toHaveLength(path.length);
        expect(truncatePath(path, 2)).toHaveLength(path.length);
    });

    it('progress = 0.5 时长度约为总长的一半（头部平滑推进）', () => {
        const total = pathLength(path);
        const half = pathLength(truncatePath(path, 0.5));
        expect(half).toBeCloseTo(total * 0.5, 6);
    });

    it('截断结果始终从起点出发', () => {
        for (const p of [0.05, 0.2, 0.6, 0.99]) {
            const cut = truncatePath(path, p);
            expect(cut[0].x).toBeCloseTo(path[0].x, 9);
            expect(cut[0].y).toBeCloseTo(path[0].y, 9);
        }
    });

    it('长度随进度单调不减', () => {
        let last = 0;
        for (let p = 0; p <= 1.0001; p += 0.05) {
            const len = pathLength(truncatePath(path, p));
            expect(len).toBeGreaterThanOrEqual(last - 1e-6);
            last = len;
        }
    });
});

describe('reachedTargetCount：劈到第几个目标（伤害按它结算）', () => {
    // 抖动设为 0 → 折线是精确的直线，长度与目标位置严格成比例，可以断言精确值
    const straight = makeChain(LINE_TARGETS, 4, 0);

    it('progress 0 只算咬住第 1 个目标，progress 1 全部命中', () => {
        expect(reachedTargetCount(straight, 5, 0)).toBe(1);
        expect(reachedTargetCount(straight, 5, 1)).toBe(5);
    });

    it('5 个等距目标：进度 1/4、1/2 分别劈到第 2、第 3 个', () => {
        expect(reachedTargetCount(straight, 5, 0.25)).toBe(2);
        expect(reachedTargetCount(straight, 5, 0.5)).toBe(3);
        expect(reachedTargetCount(straight, 5, 0.99)).toBe(4);
    });

    it('抖动后的真实折线：单调不减，且永不超过目标数', () => {
        const jittered = makeChain(LINE_TARGETS, 4);
        let last = 0;
        for (let p = 0; p <= 1.0001; p += 0.02) {
            const n = reachedTargetCount(jittered, 5, p);
            expect(n).toBeGreaterThanOrEqual(last);
            expect(n).toBeLessThanOrEqual(5);
            expect(n).toBeGreaterThanOrEqual(1);
            last = n;
        }
        expect(reachedTargetCount(jittered, 5, 1)).toBe(5);
    });

    it('单个目标 / 空目标不产生 NaN 或越界', () => {
        expect(reachedTargetCount(straight, 1, 0)).toBe(1);
        expect(reachedTargetCount(straight, 1, 1)).toBe(1);
        expect(reachedTargetCount(straight, 0, 0.5)).toBe(0);
    });

    it('目标点全部重合（折线长度 0）时不炸，且只有进度到 1 才算全中', () => {
        const same: Point[] = Array.from({ length: 5 }, () => ({ x: 10, y: 10 }));
        const degenerate = makeChain(same, 3);
        expect(pathLength(degenerate)).toBe(0);
        expect(reachedTargetCount(degenerate, 5, 0.3)).toBe(1);
        expect(reachedTargetCount(degenerate, 5, 1)).toBe(5);
    });
});

describe('特效时长：改快之后仍然「播完即全中」', () => {
    it('revealRatio < 1，保证最后一跳在播完前就已经结算', () => {
        expect(GameTuning.chainLightningRevealRatio).toBeGreaterThan(0);
        expect(GameTuning.chainLightningRevealRatio).toBeLessThanOrEqual(1);
    });

    it('比改造前的 1.0s 明显更快（需求：闪电速度要快很多）', () => {
        expect(GameTuning.chainLightningDuration).toBeLessThan(0.6);
    });

    it('目标标记的尺寸参数是正数（爆点要画得出来）', () => {
        expect(GameTuning.chainLightningMarkRadius).toBeGreaterThan(0);
        expect(GameTuning.chainLightningMarkGlowScale).toBeGreaterThan(1);
    });
});