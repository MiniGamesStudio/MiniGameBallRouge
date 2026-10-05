/**
 * 瞄准辅助射线（纯逻辑层，不依赖 cc）—— 附录 J 的「辅助射线 + 首段反弹射线」
 *
 * 画法：
 *   ① 主射线：从**玩家中心**沿当前瞄准方向画一条细线，直到与**最近的墙或敌人**相交；
 *   ② 首段反弹射线：在第一次相交点按**真实反射方向**续画第二段，
 *      到「第二次相交」或到调参上限 `aimGuideBounceLength`，**取短者**。
 *
 * ⚠️ 判定形状、边界与反射规则**不是**这里另写的一套近似，而是复用仿真那一套：
 *   · 顶 / 左 / 右墙的镜面反射 → `BulletSim.reflectOffWalls`（同一个函数，仿真也调它）；
 *   · 底墙「不反射」的判定 → `BulletSim.hitsBottomWall`（同样是仿真在用的那个）；
 *   · 边界值 → `BoardMath.screenBounds()`；相交半径 → `GameTuning.bulletRadius`（与子弹同半径）；
 *   · 敌人判定框 → `EnemySim.enemyBox()`（= `boxFromCells(x, y, cols, rows)`，多格占位的
 *     `boxW/boxH` 与中心点都取自这一处），并按 `bulletRadius` **双向外扩** ——
 *     这正是真实子弹 `BoardMath.circleBoxHit()` / `circleHitsBox()` 的判定区域（矩形两轴各外扩半径，
 *     不是圆角矩形，也不是另一套近似）；
 *   · 敌人的速度翻转 → `BulletSim.reflectOffEnemyBox`（`applyBounce` 用的同一个公式）。
 *   于是辅助射线的顶点与真实子弹的反弹点落在**同一个几何位置**上（单测里逐点核对）。
 *
 * 反射对象（口径必须永远一致）：
 *   · **遇墙反射**：顶 / 左 / 右墙按镜面反射；
 *   · **遇敌反射**：真实子弹撞敌人本来就**只反弹、不消失、不被吃掉**（§6.3 铁律 1），
 *     所以射线遇到敌人也按命中面反射；
 *   · **底墙不反射**：真实子弹撞到底墙会转入「回身」直飞玩家（§6.3 铁律 2），
 *     之后的方向由玩家位置决定、与瞄准方向无关，所以射线不假装它会镜面弹回来。
 *
 * 求交顺序：**所有墙 + 所有可命中敌人**放在一起比距离，取**最近**的那个交点
 * （两者完全重合时按墙处理 —— 真实仿真的每个子步都是「先判墙、再判敌人」，此处同序）。
 * 敌人每帧都在移动：本函数**不做任何缓存**，调用方每帧传当帧的敌人列表重算即可。
 */

import { EnemyRuntime, Vec2 } from './GameTypes';
import { GameTuning } from './GameTuning';
import { circleBoxHit, screenBounds } from './BoardMath';
import { hitsBottomWall, reflectOffEnemyBox, reflectOffWalls } from './BulletSim';
import { enemyBox, isHittable } from './EnemySim';

/** 兜底循环上限：正常 maxBounce ≤ 2，这里只防数值配错时死循环 */
const MAX_TRACE_STEPS = 64;
/** 「已经贴在墙上 / 长度已用尽」的浮点容差 */
const EPSILON = 1e-6;

/** 射线与某个敌人判定框的求交结果 */
interface EnemyRayHit {
    /** 命中处参数：方向已归一化，所以 t 的数值就等于「沿射线走过的距离 px」 */
    t: number;
    /** 命中面法线（指向射线起点所在的一侧），与 `BoxHit.normalX / normalY` 同语义 */
    normalX: number;
    normalY: number;
}

/**
 * 单轴 slab 求交：射线 `p + v·t` 与区间 `[-half, +half]` 的进出参数
 * @returns 无交集返回 null；`v ≈ 0` 且起点落在区间内时返回 `(-∞, +∞)`
 */
function slabSpan(p: number, v: number, half: number): { enter: number; exit: number } | null {
    if (Math.abs(v) <= EPSILON) {
        return Math.abs(p) <= half ? { enter: -Infinity, exit: Infinity } : null;
    }
    const t1 = (-half - p) / v;
    const t2 = (half - p) / v;
    return t1 <= t2 ? { enter: t1, exit: t2 } : { enter: t2, exit: t1 };
}

/**
 * 射线 vs 敌人判定框（**形状与真实子弹完全同源**）
 *
 * 判定区域 = `EnemySim.enemyBox(enemy)` 沿 x / y **双向外扩 `radius`**（子弹半径）。
 * 命中面 = 进入判定框时间更晚的那条轴（标准 slab 取 max），它与真实子弹
 * 「第一子步刚进入判定框时穿透更浅的那条轴」（`circleBoxHit` 的 `overlapX < overlapY`）等价；
 * 两轴完全相等时取 'y'，与 `circleBoxHit` 的 tie-break（`overlapX < overlapY ? 'x' : 'y'`）同序。
 *
 * @returns 不相交返回 null；`t = 0` 表示射线起点**已经在判定框内**（退化：敌人压到玩家身上），
 *          此时直接调 `circleBoxHit` 取最浅穿透轴 —— 与真实子弹第一子步的行为一致；
 *          若已经沿该法线朝外飞（本帧刚在这里反射过），返回 null 而不是反复反射
 */
function rayVsEnemy(
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    enemy: EnemyRuntime
): EnemyRayHit | null {
    const box = enemyBox(enemy);
    const ex = box.halfW + radius;
    const ey = box.halfH + radius;
    const rx = x - box.x;
    const ry = y - box.y;

    const spanX = slabSpan(rx, vx, ex);
    if (!spanX) return null;
    const spanY = slabSpan(ry, vy, ey);
    if (!spanY) return null;

    const enter = Math.max(spanX.enter, spanY.enter);
    const exit = Math.min(spanX.exit, spanY.exit);
    // 无重叠区间，或判定框整个在身后（`exit = 0`：刚在表面反射完）→ 不算命中，避免原地反复反射
    if (enter > exit || exit <= EPSILON) return null;

    if (enter <= EPSILON) {
        // 起点已在框内：与真实子弹第一子步用**同一个** circleBoxHit 取最浅穿透轴
        const hit = circleBoxHit(x, y, radius, box);
        if (!hit) return null;
        // 已经沿法线朝外飞（上一轮刚在这里反射过）→ 不算新命中，否则会在原地反复反射。
        // 真实子弹此刻已被 applyBounce 推到表面外，效果同样是「不再重复命中」。
        if (hit.normalX * vx + hit.normalY * vy >= 0) return null;
        return { t: 0, normalX: hit.normalX, normalY: hit.normalY };
    }

    // 从框外进入：命中面 = 进入更晚的那条轴（tie 取 'y'，与 circleBoxHit 同序）
    const alongX = spanX.enter > spanY.enter;
    return {
        t: enter,
        normalX: alongX ? (rx >= 0 ? 1 : -1) : 0,
        normalY: alongX ? 0 : ry >= 0 ? 1 : -1,
    };
}

/**
 * 在所有**可命中**敌人里取与射线**最近**的交点
 *
 * 过滤规则与真实子弹拿到的那份列表完全一致（`BattleView.queryHittableEnemies` 只用 `isHittable`）：
 * 出生动画中与已死的敌人不挡子弹，所以也不挡射线。
 * 注：`hp <= 0` 的敌人必然是 `Dead`（`killEnemy` 同时置 `state` 与 `hp`），已被 `isHittable` 覆盖；
 * 这里刻意**不**额外加 `hp > 0` —— 子弹会撞谁，射线就必须跟着撞谁。
 */
function nearestEnemyHit(
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    enemies: readonly EnemyRuntime[]
): EnemyRayHit | null {
    if (!enemies || enemies.length === 0) return null;
    let best: EnemyRayHit | null = null;
    for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        if (!enemy || !isHittable(enemy)) continue;
        const hit = rayVsEnemy(x, y, vx, vy, radius, enemy);
        if (!hit) continue;
        if (!best || hit.t < best.t) best = hit;
    }
    return best;
}

/**
 * 追踪瞄准辅助射线的折线顶点（含起点）
 *
 * @param playerX 起点 x（玩家中心）
 * @param playerY 起点 y（玩家中心）
 * @param dirX 瞄准方向 x（**不必**归一化；全 0 视为退化方向，只返回起点）
 * @param dirY 瞄准方向 y
 * @param maxBounce 最多反射几次：`1` = 只画首段反弹（当前用法，反射对象可能是墙、也可能是敌人），
 *                  `0` = 只画主射线
 * @param maxBounceLength 第一次相交之后允许继续走的**最大距离 px**（与第二次相交取短者）
 * @param radius 与墙 / 敌人相交用的半径（默认 = `GameTuning.bulletRadius`，与真实弹道一致）
 * @param enemies 当帧敌人列表（默认空 = 只跟墙求交）；**每帧传当帧最新位置**即可，
 *                函数内部不做任何缓存，敌人移动后重画即自动跟上
 * @returns 折线顶点数组，`[0]` 是起点；长度 < 2 表示画不出线
 */
export function traceAimGuide(
    playerX: number,
    playerY: number,
    dirX: number,
    dirY: number,
    maxBounce: number = 1,
    maxBounceLength: number = GameTuning.aimGuideBounceLength,
    radius: number = GameTuning.bulletRadius,
    enemies: readonly EnemyRuntime[] = []
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
    // 第一次相交之后还剩多少距离可走（只约束反弹段，主射线永远画满到交点）
    let budget = Math.max(0, maxBounceLength);

    for (let step = 0; step < MAX_TRACE_STEPS; step++) {
        // ① 四条墙面沿当前方向的可达距离（背离的墙记 Infinity）
        const tLeft = vx < 0 ? (bounds.left + r - x) / vx : Infinity;
        const tRight = vx > 0 ? (bounds.right - r - x) / vx : Infinity;
        const tTop = vy > 0 ? (bounds.top - r - y) / vy : Infinity;
        const tBottom = vy < 0 ? (bounds.bottom + r - y) / vy : Infinity;
        const tWall = Math.min(tLeft, tRight, tTop, tBottom);
        if (!Number.isFinite(tWall)) break;

        // ② 敌人也参与求交：与「最近的那面墙」比距离，取更近的那个交点
        const enemyHit = nearestEnemyHit(x, y, vx, vy, r, enemies);
        const tEnemy = enemyHit ? enemyHit.t : Infinity;
        // 完全重合时按墙处理：真实仿真的每个子步都是「先判墙、再判敌人」
        const hitEnemy = tEnemy < tWall;
        const tHit = hitEnemy ? tEnemy : tWall;
        if (!Number.isFinite(tHit)) break;

        // ③ 本段实际走多远：主射线走到交点为止，反弹段还要受 budget 限制
        const isBounceSegment = verts.length > 1;
        const t = isBounceSegment ? Math.min(tHit, budget) : tHit;
        const reachesHit = t >= tHit - EPSILON;

        // t = 0 只会出现在「起点恰好贴在墙/敌人判定框上」的退化输入：不生成零长线段，直接去反射
        if (t > EPSILON) {
            x += vx * t;
            y += vy * t;
            verts.push({ x, y });
        }

        // ④ 被 budget 截断（没走到交点）→ 收工
        if (!reachesHit) break;

        // ⑤ 撞到底墙：真实子弹在这里转入回身（不反射），射线到此为止
        if (!hitEnemy && hitsBottomWall(y, r, bounds)) break;

        // ⑥ 用掉一次反射；用完了就停
        if (bouncesLeft <= 0) break;
        bouncesLeft--;
        if (isBounceSegment) budget -= tHit;

        // ⑦ 反射：敌人按**命中面**翻对应轴（与真实子弹同一个 circleBoxHit / reflectOffEnemyBox），
        //    顶 / 左 / 右墙调 BulletSim 的同一个 reflectOffWalls —— 两边不会各写一套规则
        if (hitEnemy && enemyHit) {
            const next = reflectOffEnemyBox(vx, vy, enemyHit.normalX, enemyHit.normalY);
            vx = next.vx;
            vy = next.vy;
        } else {
            const next = reflectOffWalls(x, y, vx, vy, r, bounds);
            x = next.x;
            y = next.y;
            vx = next.vx;
            vy = next.vy;
        }

        if (budget <= EPSILON) break;
    }

    return verts;
}
/** 把折线切成虚线段：沿累计弧长推进 dash+gap 周期，**相位跨顶点连续**（拐点不断缝）
 *  dashLength<=0 或 gapLength<0 → 退化为实线；part = 该小段所属折线段序号（0=主射线，1=首段反弹） */
export function buildDashSegments(
    points: Vec2[],
    dashLength: number,
    gapLength: number,
    phase: number = 0
): { x1: number; y1: number; x2: number; y2: number; part: number }[] {
    const out: { x1: number; y1: number; x2: number; y2: number; part: number }[] = [];
    if (!points || points.length < 2) return out;
    const dash = dashLength > 0 ? dashLength : 0;
    const gap = gapLength > 0 ? gapLength : 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len <= 1e-6) continue;
        const ux = dx / len;
        const uy = dy / len;
        if (dash <= 0 || gapLength < 0) {
            out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, part: i });
            continue;
        }
        const period = dash + gap;
        let t = phase % period;
        if (t < 0) t += period;
        let s = -t;
        while (s < len) {
            const s0 = Math.max(0, s);
            const s1 = Math.min(len, s + dash);
            if (s1 > s0 + 1e-6) out.push({ x1: a.x + ux * s0, y1: a.y + uy * s0, x2: a.x + ux * s1, y2: a.y + uy * s1, part: i });
            s += period;
        }
        phase = (phase + len) % period;
    }
    return out;
}
