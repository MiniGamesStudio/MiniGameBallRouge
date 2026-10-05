/**
 * L1 单测：瞄准辅助射线 + 兜底自动瞄准（附录 J / v1.9）
 *
 * 重点验证「辅助射线与真实子弹弹道一致」：
 * 射线顶点必须与 `BulletSim` **实际跑出来**的反弹点重合，而不是拿另一套近似公式自我循环论证。
 * 做法是把真实子弹用极细的步长（每步 0.144px，远小于 `maxSubStepDistance`，所以子步数 = 1）
 * 跑过第一次 / 第二次撞墙，再把两次翻转位置与 `traceAimGuide` 的顶点逐点比对。
 */
import {
    BulletState,
    EnemyRuntime,
    EnemyShape,
    EnemyState,
    EnemyType,
    Quality,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import { traceAimGuide } from '../../assets/scripts/Game/CommonGame/gameplay/core/AimGuide';
import {
    BulletWorld,
    aimVelocity,
    createBullet,
    stepBullet,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BulletSim';
import {
    isHittable,
    pickAutoAimTarget,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/EnemySim';
import { screenBounds } from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';

const B = screenBounds();
/** 与墙相交用的半径 = 子弹半径（射线与真实弹道同半径，反弹点才会重合） */
const R = GameTuning.bulletRadius;
/** 细步长：每步位移 1440 × 1e-4 = 0.144px << maxSubStepDistance，因此子步数恒为 1 */
const FINE_DT = 1e-4;
/** 与真实弹道的比对容差 = 子步离散化带来的最大偏差(0.144px) + 余量 */
const TOL = 0.25;
/** 比对多次反弹时用「不截断」的预算，避免 aimGuideBounceLength 干扰几何一致性 */
const NO_CAP = 1e9;

function makeEnemy(
    id: number,
    x: number,
    y: number,
    state: EnemyState = EnemyState.Falling,
    hp: number = 100
): EnemyRuntime {
    return {
        id,
        defId: 'test_' + id,
        quality: Quality.White,
        type: EnemyType.Normal,
        shape: EnemyShape.Single,
        cols: 1,
        rows: 1,
        x,
        y,
        hp,
        maxHp: 100,
        speed: 0,
        state,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

/** 只关心撞墙的子弹世界：玩家放到极远，避免半路被回收 / 影响回身 */
function wallOnlyWorld(): BulletWorld {
    return {
        playerX: 0,
        playerY: -1e6,
        catchRadius: GameTuning.catchRadius,
        queryEnemies: () => [] as EnemyRuntime[],
    };
}

interface WallFlip {
    x: number;
    y: number;
    vx: number;
    vy: number;
    flipX: boolean;
    flipY: boolean;
}

interface WallSlide {
    flips: WallFlip[];
    /** 是否在记录过程中撞到底墙转入回身（回身不是反弹，所以不算 flip） */
    returned: boolean;
}

/** 用真实仿真跑一发子弹，记录前 maxFlips 次「顶/左/右墙」翻转时的位置与速度 */
function runRealBullet(px: number, py: number, dx: number, dy: number, maxFlips: number): WallSlide {
    const dir = aimVelocity(px, py, px + dx, py + dy, GameTuning.bulletSpeed);
    const world = wallOnlyWorld();
    const bullet = createBullet(1, px, py, dir.vx, dir.vy, true);
    const flips: WallFlip[] = [];
    let returned = false;
    let prevVx = bullet.vx;
    let prevVy = bullet.vy;

    for (let i = 0; i < 400000 && flips.length < maxFlips && !returned; i++) {
        // 底墙会转入回身（不是反射），这时速度变化不代表反弹，必须剔除
        if (stepBullet(bullet, FINE_DT, world).returned || bullet.state !== BulletState.Flying) {
            returned = true;
            break;
        }

        const flipX = prevVx * bullet.vx < 0;
        const flipY = prevVy * bullet.vy < 0;
        if (flipX || flipY) {
            flips.push({ x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, flipX, flipY });
        }
        prevVx = bullet.vx;
        prevVy = bullet.vy;
    }
    return { flips, returned };
}

/** 折线第 i 段（i 从 0 起）的单位方向 */
function segmentDir(verts: { x: number; y: number }[], i: number): { x: number; y: number } {
    const dx = verts[i + 1].x - verts[i].x;
    const dy = verts[i + 1].y - verts[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    return { x: dx / len, y: dy / len };
}

describe('瞄准辅助射线：边界与反射（附录 J）', () => {
    it('垂直向上：主射线终点落在顶墙内缩一个子弹半径处', () => {
        const verts = traceAimGuide(0, -547, 0, 1, 0);

        expect(verts.length).toBe(2);
        expect(verts[0]).toEqual({ x: 0, y: -547 });
        expect(verts[1].x).toBeCloseTo(0, 6);
        expect(verts[1].y).toBeCloseTo(B.top - R, 6);
    });

    it('水平向右：主射线顶到右墙，首段反弹到左墙（vx 反向、vy 不变）', () => {
        const verts = traceAimGuide(-300, 0, 1, 0, 1);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(B.right - R, 6);
        expect(verts[1].y).toBeCloseTo(0, 6);
        // 第二次相交：右墙 → 左墙，距离 718px < aimGuideBounceLength，所以画满
        expect(verts[2].x).toBeCloseTo(B.left + R, 6);
        expect(verts[2].y).toBeCloseTo(0, 6);

        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        expect(d1.x).toBeCloseTo(-d0.x, 6); // 入射角 = 反射角（法线沿 x 轴 → 只有 x 分量翻转）
        expect(d1.y).toBeCloseTo(d0.y, 6);
    });

    it('水平向左：主射线顶到左墙、反弹回右墙（左墙反射方向正确）', () => {
        const verts = traceAimGuide(300, 0, -1, 0, 1);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(B.left + R, 6);
        expect(verts[2].x).toBeCloseTo(B.right - R, 6);
        expect(segmentDir(verts, 1).x).toBeCloseTo(1, 6);
    });

    it('斜向 (3,4)：先撞右墙再撞顶墙，两次都是标准镜面反射', () => {
        const verts = traceAimGuide(0, 0, 3, 4, 2, NO_CAP);
        const s = Math.sqrt(3 * 3 + 4 * 4);

        // 解析解：右墙 t = (right − R)/0.6，随后顶墙 t = (top − R − y)/0.8
        const tRight = (B.right - R) / (3 / s);
        expect(verts[1].x).toBeCloseTo(B.right - R, 6);
        expect(verts[1].y).toBeCloseTo((4 / s) * tRight, 6);
        expect(verts[2].y).toBeCloseTo(B.top - R, 6); // 第二段撞顶墙

        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        const d2 = segmentDir(verts, 2);
        expect(d1.x).toBeCloseTo(-d0.x, 6); // 右墙：vx 翻转
        expect(d1.y).toBeCloseTo(d0.y, 6);
        expect(d2.x).toBeCloseTo(d1.x, 6); // 顶墙：vy 翻转
        expect(d2.y).toBeCloseTo(-d1.y, 6);
    });

    it('底墙不反射：朝下打只画主射线，不产生反弹段', () => {
        const verts = traceAimGuide(0, 300, 0, -1, 1);

        expect(verts.length).toBe(2);
        expect(verts[1].y).toBeCloseTo(B.bottom + R, 6);
    });

    it('首段反弹与「第二次相交」取短者：长路径被 aimGuideBounceLength 截断', () => {
        // 从玩家位置朝上：先撞顶墙（1302px 外），反弹后到底墙还有 1302px
        const capped = traceAimGuide(0, -547, 0, 1, 1);
        expect(capped.length).toBe(3);
        expect(capped[2].y).toBeCloseTo(B.top - R - GameTuning.aimGuideBounceLength, 6);

        // 预算更小时按预算截断
        const tiny = traceAimGuide(0, -547, 0, 1, 1, 100);
        expect(tiny[2].y).toBeCloseTo(B.top - R - 100, 6);

        // 预算大于实际距离时按「第二次相交」截断（短者胜）
        const side = traceAimGuide(-300, 0, 1, 0, 1, 5000);
        expect(side[2].x).toBeCloseTo(B.left + R, 6);
    });

    it('maxBounce = 0 只画主射线；退化方向只返回起点（画不出线）', () => {
        expect(traceAimGuide(0, -547, 0, 1, 0).length).toBe(2);
        expect(traceAimGuide(0, -547, 5, 0, 0).length).toBe(2);

        const degenerate = traceAimGuide(0, -547, 0, 0, 1);
        expect(degenerate.length).toBe(1);
        expect(degenerate[0]).toEqual({ x: 0, y: -547 });
    });
});

describe('瞄准辅助射线与真实子弹弹道一致（与 BulletSim 同源）', () => {
    const CASES: Array<[number, number, number, number]> = [
        [0, -547, 0, 1],       // 正上方
        [-300, 0, 1, 0],       // 正右（会连续两次撞侧墙）
        [300, 0, -1, 0],       // 正左
        [0, 0, 3, 4],          // 斜向：右墙 → 顶墙
        [-120, -400, 2, 3],    // 斜向：顶墙 → 侧墙
        [180, 200, -3, 4],     // 斜向：顶墙 → 侧墙
    ];

    it('第一次、第二次反弹点与真实子弹的翻转位置逐点重合', () => {
        CASES.forEach(([px, py, dx, dy]) => {
            const { flips } = runRealBullet(px, py, dx, dy, 2);
            const verts = traceAimGuide(px, py, dx, dy, 2, NO_CAP);

            expect(flips.length).toBeGreaterThan(0);
            // 顶点 = 起点 + 每个「墙事件」一个；maxBounce = 2 时射线还会多画一个收尾顶点
            // （第 3 个墙事件，或到底墙就停），所以恒等于 flips.length + 2
            expect(verts.length).toBe(flips.length + 2);

            flips.forEach((flip, i) => {
                const vertex = verts[i + 1];
                expect(vertex).toBeDefined();
                expect(Math.abs(vertex.x - flip.x)).toBeLessThanOrEqual(TOL);
                expect(Math.abs(vertex.y - flip.y)).toBeLessThanOrEqual(TOL);
            });
        });
    });

    it('反射后的方向与真实子弹完全一致', () => {
        CASES.forEach(([px, py, dx, dy]) => {
            const { flips } = runRealBullet(px, py, dx, dy, 2);
            const verts = traceAimGuide(px, py, dx, dy, 2, NO_CAP);

            expect(flips.length).toBeGreaterThan(0);

            flips.forEach((flip, i) => {
                const dir = segmentDir(verts, i + 1);
                const speed = Math.sqrt(flip.vx * flip.vx + flip.vy * flip.vy);
                expect(dir.x).toBeCloseTo(flip.vx / speed, 6);
                expect(dir.y).toBeCloseTo(flip.vy / speed, 6);
            });
        });
    });

    it('撞角落：射线顶点 = 顶右角，两个分量一起翻转，真实子弹同样两轴都翻转', () => {
        // 方向精确指向「顶墙 ∩ 右墙」那个内缩角点
        const cornerX = B.right - R;
        const cornerY = B.top - R;
        const px = 0;
        const py = 0;
        const verts = traceAimGuide(px, py, cornerX - px, cornerY - py, 2, NO_CAP);

        expect(verts[1].x).toBeCloseTo(cornerX, 6);
        expect(verts[1].y).toBeCloseTo(cornerY, 6);

        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        expect(d1.x).toBeCloseTo(-d0.x, 6); // 角落：两条轴的法线都起作用
        expect(d1.y).toBeCloseTo(-d0.y, 6);

        // 真实子弹在角落附近会分两个子步翻 x 与 y，两次翻转位置都应贴在同一角点上
        const { flips } = runRealBullet(px, py, cornerX - px, cornerY - py, 2);
        expect(flips.length).toBeGreaterThan(0);
        flips.forEach(flip => {
            expect(Math.abs(flip.x - cornerX)).toBeLessThanOrEqual(TOL);
            expect(Math.abs(flip.y - cornerY)).toBeLessThanOrEqual(TOL);
        });
    });

    it('底墙一致：真实子弹在射线终点同一位置转入回身', () => {
        const world = wallOnlyWorld();
        const dir = aimVelocity(0, 400, 0, 0, GameTuning.bulletSpeed); // 朝下
        const bullet = createBullet(1, 0, 400, dir.vx, dir.vy, true);

        let returned = false;
        for (let i = 0; i < 400000 && !returned; i++) {
            returned = stepBullet(bullet, FINE_DT, world).returned;
        }

        const verts = traceAimGuide(0, 400, 0, -1, 1);
        expect(returned).toBe(true);
        expect(bullet.state).toBe(BulletState.Returning);
        expect(bullet.y).toBeCloseTo(B.bottom + R, 6);
        expect(verts.length).toBe(2); // 射线停在底墙，不假装它会弹回来
        expect(verts[1].y).toBeCloseTo(bullet.y, 6);
    });
});

describe('兜底自动瞄准：pickAutoAimTarget（附录 J）', () => {
    it('没有敌人 / 全部不可命中时返回 null（调用方保持最后方向）', () => {
        expect(pickAutoAimTarget(0, 0, [])).toBeNull();
        expect(pickAutoAimTarget(0, 0, [
            makeEnemy(1, 0, 0, EnemyState.Spawning),
            makeEnemy(2, 0, 10, EnemyState.Dead),
            makeEnemy(3, 0, 20, EnemyState.Falling, 0),
        ])).toBeNull();
    });

    it('选距离玩家最近的可命中敌人', () => {
        const far = makeEnemy(1, 0, 400);
        const near = makeEnemy(2, 100, 100);
        const mid = makeEnemy(3, -200, -200);

        expect(pickAutoAimTarget(0, 0, [far, near, mid])).toBe(near);
        expect(pickAutoAimTarget(0, 500, [far, near, mid])).toBe(far);
        expect(pickAutoAimTarget(0, 0, [mid])).toBe(mid);
    });

    it('跳过更近但不可命中的敌人（出生动画中 / 已死）', () => {
        const spawning = makeEnemy(1, 0, 5, EnemyState.Spawning);
        const dead = makeEnemy(2, 0, 8, EnemyState.Dead);
        const hittable = makeEnemy(3, 0, 300);

        expect(pickAutoAimTarget(0, 0, [spawning, dead, hittable])).toBe(hittable);
    });

    it('可命中的三种状态（下落 / 越线判定 / 俯冲）都能被锁定，与 isHittable 一致', () => {
        [EnemyState.Falling, EnemyState.Telegraph, EnemyState.Diving].forEach((state, i) => {
            const enemy = makeEnemy(i + 1, 0, 100);
            enemy.state = state;
            expect(isHittable(enemy)).toBe(true);
            expect(pickAutoAimTarget(0, 0, [enemy])).toBe(enemy);
        });
    });

    it('纯函数：不修改敌人数组与敌人状态', () => {
        const a = makeEnemy(1, 0, 50);
        const b = makeEnemy(2, 0, 500);
        const list = [a, b];
        const before = JSON.stringify(list);

        expect(pickAutoAimTarget(0, 0, list)).toBe(a);
        expect(JSON.stringify(list)).toBe(before);
    });
});