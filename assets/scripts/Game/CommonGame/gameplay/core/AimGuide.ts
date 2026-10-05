/**
 * 瞄准辅助射线（纯逻辑层，不依赖 cc）—— 附录 J 的「辅助射线 + 首段反弹射线」
 *
 * 画法：
 *   ① 主射线：从**玩家中心**沿当前瞄准方向画一条细线，直到与场地边界相交；
 *   ② 首段反弹射线：在第一次相交点按**真实反射方向**续画第二段，
 *      到「第二次相交」或到调参上限 `aimGuideBounceLength`，**取短者**。
 *
 * ⚠️ 边界与反射规则**不是**这里另写的一套近似，而是复用仿真那一套：
 *   · 顶 / 左 / 右墙的镜面反射 → `BulletSim.reflectOffWalls`（同一个函数，仿真也调它）；
 *   · 底墙「不反射」的判定 → `BulletSim.hitsBottomWall`（同样是仿真在用的那个）；
 *   · 边界值 → `BoardMath.screenBounds()`；相交半径 → `GameTuning.bulletRadius`（与子弹同半径）。
 *   于是辅助射线的顶点与真实子弹的反弹点落在**同一个几何位置**上（单测里逐点核对）。
 *
 * 为什么画到底墙就停：真实子弹撞到底墙会转入「回身」直飞玩家（§6.3 铁律 2），
 * 之后的方向由玩家位置决定、与瞄准方向无关，所以射线不假装它会镜面弹回来。
 */

import { Vec2 } from './GameTypes';
import { GameTuning } from './GameTuning';
import { screenBounds } from './BoardMath';
import { hitsBottomWall, reflectOffWalls } from './BulletSim';

/** 兜底循环上限：正常 maxBounce ≤ 2，这里只防数值配错时死循环 */
const MAX_TRACE_STEPS = 64;
/** 「已经贴在墙上 / 长度已用尽」的浮点容差 */
const EPSILON = 1e-6;

/**
 * 追踪瞄准辅助射线的折线顶点（含起点）
 *
 * @param playerX 起点 x（玩家中心）
 * @param playerY 起点 y（玩家中心）
 * @param dirX 瞄准方向 x（**不必**归一化；全 0 视为退化方向，只返回起点）
 * @param dirY 瞄准方向 y
 * @param maxBounce 最多反射几次：`1` = 只画首段反弹（当前用法），`0` = 只画主射线
 * @param maxBounceLength 第一次相交之后允许继续走的**最大距离 px**（与第二次相交取短者）
 * @param radius 与墙相交用的半径（默认 = `GameTuning.bulletRadius`，与真实弹道一致）
 * @returns 折线顶点数组，`[0]` 是起点；长度 < 2 表示画不出线
 */
export function traceAimGuide(
    playerX: number,
    playerY: number,
    dirX: number,
    dirY: number,
    maxBounce: number = 1,
    maxBounceLength: number = GameTuning.aimGuideBounceLength,
    radius: number = GameTuning.bulletRadius
): Vec2[] {
    const verts: Vec2[] = [{ x: playerX, y: playerY }];

    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    // 退化方向（瞄准点与玩家重合）：与 aimVelocity 的兜底一致，这里选择「不画线」
    if (!(len > EPSILON)) return verts;

    const bounds = screenBounds();
    const r = Math.max(0, radius);
    let x = playerX;
    let y = playerY;
    // 单位方向 → 「时间」的数值就等于「距离」，下面的 t 可以直接当 px 用
    let vx = dirX / len;
    let vy = dirY / len;
    let bouncesLeft = Math.max(0, Math.floor(maxBounce));
    // 第一次相交之后还剩多少距离可走（只约束反弹段，主射线永远画满到墙）
    let budget = Math.max(0, maxBounceLength);

    for (let step = 0; step < MAX_TRACE_STEPS; step++) {
        // ① 四条墙面沿当前方向的可达距离（背离的墙记 Infinity）
        const tLeft = vx < 0 ? (bounds.left + r - x) / vx : Infinity;
        const tRight = vx > 0 ? (bounds.right - r - x) / vx : Infinity;
        const tTop = vy > 0 ? (bounds.top - r - y) / vy : Infinity;
        const tBottom = vy < 0 ? (bounds.bottom + r - y) / vy : Infinity;
        const tWall = Math.min(tLeft, tRight, tTop, tBottom);
        if (!Number.isFinite(tWall)) break;

        // ② 本段实际走多远：主射线走到墙为止，反弹段还要受 budget 限制
        const isBounceSegment = verts.length > 1;
        const t = isBounceSegment ? Math.min(tWall, budget) : tWall;
        const reachesWall = t >= tWall - EPSILON;

        // t = 0 只会出现在「起点恰好贴在墙上」的退化输入：不生成零长线段，直接去反射
        if (t > EPSILON) {
            x += vx * t;
            y += vy * t;
            verts.push({ x, y });
        }

        // ③ 被 budget 截断（没走到墙）→ 收工
        if (!reachesWall) break;

        // ④ 撞到底墙：真实子弹在这里转入回身（不反射），射线到此为止
        if (hitsBottomWall(y, r, bounds)) break;

        // ⑤ 用掉一次反射；用完了就停
        if (bouncesLeft <= 0) break;
        bouncesLeft--;
        if (isBounceSegment) budget -= tWall;

        // ⑥ 顶 / 左 / 右墙镜面反射 —— 调 BulletSim 的同一个实现，保证与真实弹道同源
        const next = reflectOffWalls(x, y, vx, vy, r, bounds);
        x = next.x;
        y = next.y;
        vx = next.vx;
        vy = next.vy;

        if (budget <= EPSILON) break;
    }

    return verts;
}