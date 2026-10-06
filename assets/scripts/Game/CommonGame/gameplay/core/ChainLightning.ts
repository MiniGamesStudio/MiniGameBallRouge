/**
 * 闪电链（纯逻辑层，不依赖 cc）
 *
 * 只负责「**打谁**」与「**长什么样**」两件事，全部是可断言的纯函数：
 *   ① 打谁：从候选敌人里挑**最近的 N 个**（`pickNearestChainTargets`）——
 *      v1.12 起闪电链由**闪电子弹命中**触发，所以起点是"被子弹打中的那个敌人"（锚点），
 *      之后一跳一跳连最近的（用户拍板：命中点开始，最近目标；原先的"随机 5 个"已废弃）；
 *   ② 长什么样：把「目标点序列」变成一条带抖动的折线（`buildBoltPath`），
 *      以及按播放进度把它截断（`truncatePath`）—— 后者就是"闪电一路劈过去"的显现。
 *
 * 数值派生（等级 → 目标数 / 伤害 / CD）在 core/SpecialBullets.ts 的 `lightningSpec`，
 * 那边是三种特殊子弹共用的入口，这里不再重复一份。
 *
 * ⚠️ 这里只算几何，不碰引擎：渲染在 view/ChainLightningFx.ts，伤害结算在 BattleView。
 * 和 WaveBuilder / BulletSim 一样，纯逻辑与表现分离，才能在 node 里跑 L1 单测。
 */

import { IRandom } from './Rng';
import { distance } from './BoardMath';

export interface Point {
    x: number;
    y: number;
}

/** 可被连锁的候选目标：需要 id（去重 / tie-break）与中心坐标（算距离） */
export interface ChainCandidate {
    id: number;
    x: number;
    y: number;
}

/**
 * 取从 `origin` 出发**最近的 count 个**候选（贪心逐跳取最近）。
 *
 * 三个约定：
 *   ① 贪心是**逐跳**的：第 2 个目标取的是"离第 1 个目标最近的"，而不是"离起点第二近的"——
 *      闪电是一跳一跳劈过去的，逐跳最近才符合"顺着电光往前炸"的观感；
 *   ② `excludeId` 排除锚点自己（闪电不该连回起点）；
 *   ③ 距离相同时按 **id 升序**决定，保证同一局面永远选出同一串目标（可复现、可单测）。
 *
 * 候选不足 count 时全取（有几个连几个，不报错）。
 *
 * @returns 按连锁顺序排列的目标（长度 ≤ count）
 */
export function pickNearestChainTargets<T extends ChainCandidate>(
    origin: Point,
    candidates: readonly T[],
    count: number,
    excludeId?: number
): T[] {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n <= 0 || !candidates || candidates.length === 0) return [];

    const pool = candidates.filter(c => c && c.id !== excludeId);
    const picked: T[] = [];
    let cursor: Point = { x: origin.x, y: origin.y };
    const used = new Set<number>();

    while (picked.length < n && used.size < pool.length) {
        let best: T | null = null;
        let bestDist = Infinity;
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i];
            if (used.has(c.id)) continue;
            const d = distance(cursor.x, cursor.y, c.x, c.y);
            // 更近的胜出；距离相同看 id 小的（确定性 tie-break）
            if (d < bestDist || (d === bestDist && best && c.id < best.id)) {
                bestDist = d;
                best = c;
            }
        }
        if (!best) break;
        used.add(best.id);
        picked.push(best);
        cursor = { x: best.x, y: best.y };
    }

    return picked;
}

/**
 * 生成「一跳」的折线闪电：**首尾严格落在两个目标点上**，中间点沿垂线抖动。
 *
 * 两个细节：
 *   ① 抖动幅度按 `sin(πt)` 收窄 —— 两端振幅为 0，闪电牢牢咬住目标，中间最"碎"；
 *   ② 抖动方向取连线**法线**（而不是 x/y 各自随机）：目标水平或垂直排列时，
 *      折线才会明显"炸开"，否则竖直排列的敌人之间会画成一条几乎笔直的线。
 *
 * @returns 长度为 segments + 1 的点列（含首尾）
 */
export function buildBoltPath(
    rng: IRandom,
    from: Point,
    to: Point,
    segments: number,
    jitter: number
): Point[] {
    const segs = Number.isFinite(segments) ? Math.max(1, Math.floor(segments)) : 1;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const amp = Number.isFinite(jitter) ? Math.max(0, jitter) : 0;

    const points: Point[] = [{ x: from.x, y: from.y }];
    for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const taper = Math.sin(Math.PI * t);
        const offset = (rng.next() * 2 - 1) * amp * taper;
        points.push({ x: from.x + dx * t + nx * offset, y: from.y + dy * t + ny * offset });
    }
    points.push({ x: to.x, y: to.y });
    return points;
}

/** 折线总长度 */
export function pathLength(points: readonly Point[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
}

/**
 * 按播放进度截断折线：返回从起点起、长度为 `总长 × progress` 的一段。
 *
 * progress ≤ 0 返回空数组（什么都还没劈出来）；≥ 1 返回整条（含末点）；
 * 中间值会在最后一段上**插值**出一个精确的端点，所以闪电的"头部"是平滑推进的。
 */
export function truncatePath(points: readonly Point[], progress: number): Point[] {
    if (!points || points.length === 0) return [];
    const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    if (p <= 0) return [];
    if (p >= 1) return points.map(pt => ({ x: pt.x, y: pt.y }));

    const target = pathLength(points) * p;
    const out: Point[] = [{ x: points[0].x, y: points[0].y }];
    let walked = 0;
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        const seg = Math.sqrt(dx * dx + dy * dy);
        if (walked + seg >= target) {
            const t = seg > 0 ? (target - walked) / seg : 0;
            out.push({ x: points[i - 1].x + dx * t, y: points[i - 1].y + dy * t });
            return out;
        }
        out.push({ x: points[i].x, y: points[i].y });
        walked += seg;
    }
    return out;
}

/**
 * 播放进度 → 已经"劈到"第几个目标（1 起，最大 = 目标数）。
 *
 * 玩法层靠它按到达顺序结算伤害：闪电每咬住一个目标才扣那一下血，
 * 而不是一次性把 5 个目标全扣完（那样"跳动"就只是层皮）。
 */
export function reachedTargetCount(
    points: readonly Point[],
    targetCount: number,
    progress: number
): number {
    const count = Math.max(0, Math.floor(targetCount));
    if (count <= 0) return 0;
    if (count === 1) return 1;
    const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;

    const total = pathLength(points);
    if (total <= 0) return p >= 1 ? count : 1;   // 目标重合：进度到 1 才算全中
    const revealed = total * p;

    // 每个目标点（除首点）在折线上的累计长度位置
    const marks = spaceTargetMarks(points, count);
    let reached = 1;
    for (let i = 1; i < count; i++) {
        if (marks[i] <= revealed) reached = i + 1;
    }
    return reached;
}

/**
 * 把「N 个目标」映射到折线上的 N 个累计长度位置（[0] 恒为 0）。
 *
 * 折线由 N-1 跳首尾相接而成，所以第 i 个目标的位置 = 前 i-1 跳的长度之和。
 * 传入点数与目标数不匹配（例如目标在播放中被销毁）时退化为按总长均分。
 */
function spaceTargetMarks(points: readonly Point[], targetCount: number): number[] {
    const marks: number[] = [0];
    const hops = targetCount - 1;
    if (hops <= 0) return marks;

    // 折线的顶点序列：每跳 segments+1 个点，相邻跳共享一个端点 → 顶点数 = hops*segments + 1
    const vertexCount = points.length;
    const perHop = vertexCount > 1 ? (vertexCount - 1) / hops : 0;
    if (!Number.isFinite(perHop) || perHop < 1) {
        const total = pathLength(points);
        for (let i = 1; i <= hops; i++) marks.push((total * i) / hops);
        return marks;
    }

    const total = pathLength(points);
    for (let i = 1; i <= hops; i++) {
        const idx = Math.min(points.length - 1, Math.round(perHop * i));
        marks.push(vertexLength(points, idx, total));
    }
    return marks;
}

/** 顶点 index 处的累计长度 */
function vertexLength(points: readonly Point[], index: number, total: number): number {
    if (index <= 0) return 0;
    if (index >= points.length - 1) return total;
    let walked = 0;
    for (let i = 1; i <= index; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        walked += Math.sqrt(dx * dx + dy * dy);
    }
    return walked;
}