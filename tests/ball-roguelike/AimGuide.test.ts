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
import { buildDashSegments, traceAimGuide } from '../../assets/scripts/Game/CommonGame/gameplay/core/AimGuide';
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
import {
    boxFromCells,
    circleHitsBox,
    screenBounds,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';
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
/**
 * 与真实子弹比对**撞敌人**的翻转位置时，法线方向额外放宽到 0.7px。
 * 原因：`BulletSim.applyBounce` 会把子弹沿法线推出敌人表面外 `depth(≤0.144) + 0.5` px
 * （防止卡在体内反复触发），而射线顶点严格落在**接触面**上；切向仍用与撞墙相同的 `TOL`(0.25)。
 */
const TOL_ENEMY = 0.7;
/** 单格边长（与 boxFromCells 同源） */
const CELL = GameTuning.cellSize;

/** 折线逐点比对（同一套几何应给出逐位相同的结果；1e-9 只为避开 -0/+0 这类表示差异） */
function expectVertsClose(a: { x: number; y: number }[], b: { x: number; y: number }[]): void {
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => {
        expect(v.x).toBeCloseTo(b[i].x, 9);
        expect(v.y).toBeCloseTo(b[i].y, 9);
    });
}

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

/**
 * 子弹世界：玩家放到极远，避免半路被回收 / 影响回身。
 *
 * `queryEnemies` **照抄** `BattleView.queryHittableEnemies` 的过滤（只用 `isHittable`）
 * 与判定形状（`circleHitsBox` + `boxFromCells`）—— 否则「射线与真实弹道一致」就是自欺欺人。
 */
function bulletWorld(enemies: EnemyRuntime[] = []): BulletWorld {
    return {
        playerX: 0,
        playerY: -1e6,
        catchRadius: GameTuning.catchRadius,
        queryEnemies: (x: number, y: number, radius: number) => {
            const out: EnemyRuntime[] = [];
            enemies.forEach(e => {
                if (!isHittable(e)) return;
                if (circleHitsBox(x, y, radius, boxFromCells(e.x, e.y, e.cols, e.rows))) out.push(e);
            });
            return out;
        },
    };
}

/** 只关心撞墙的子弹世界（等价于敌人列表为空） */
function wallOnlyWorld(): BulletWorld {
    return bulletWorld();
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

/**
 * 用真实仿真跑一发子弹，记录前 maxFlips 次方向翻转时的位置与速度
 * （**墙与敌人不分家**，按发生顺序记录；翻转轴由 flipX / flipY 指出）
 * @param enemies 敌人列表（默认空 = 只跟墙打交道），过滤与判定形状与 BattleView 给子弹的那份一致
 */
function runRealBullet(
    px: number,
    py: number,
    dx: number,
    dy: number,
    maxFlips: number,
    enemies: EnemyRuntime[] = []
): WallSlide {
    const dir = aimVelocity(px, py, px + dx, py + dy, GameTuning.bulletSpeed);
    const world = bulletWorld(enemies);
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

describe('瞄准辅助射线：遇敌反射的几何（入射角 = 反射角）', () => {
    /** 单格敌人的判定框沿 x / y 双向外扩子弹半径后的半宽半高 = 64 + 16 = 80 */
    const SPAN = CELL / 2 + R;

    it('下表面：从下方朝上打 → 在敌人下沿折返（vy 翻转、vx 不变），不到顶墙', () => {
        const enemy = makeEnemy(1, 0, 0);
        const verts = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(0, 6);
        expect(verts[1].y).toBeCloseTo(-SPAN, 6); // 敌人下沿 0 − 80，而不是顶墙 651
        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        expect(d1.x).toBeCloseTo(d0.x, 6);
        expect(d1.y).toBeCloseTo(-d0.y, 6);
        expect(verts[2].y).toBeCloseTo(B.bottom + R, 6); // 折返朝下 → 底墙收尾（底墙仍不反射）
    });

    it('上表面：从上方朝下打 → 在敌人上沿折返（vy 翻转、vx 不变）', () => {
        const enemy = makeEnemy(1, 0, 0);
        const verts = traceAimGuide(0, 547, 0, -1, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[1].y).toBeCloseTo(SPAN, 6); // 敌人上沿 0 + 80
        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        expect(d1.x).toBeCloseTo(d0.x, 6);
        expect(d1.y).toBeCloseTo(-d0.y, 6);
        expect(verts[2].y).toBeCloseTo(B.top - R, 6);
    });

    it('左表面：从左侧朝右打 → 在敌人左沿折返（vx 翻转、vy 不变）', () => {
        const enemy = makeEnemy(1, 200, 0);
        const verts = traceAimGuide(0, 0, 1, 0, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(200 - SPAN, 6); // 120
        expect(verts[1].y).toBeCloseTo(0, 6);
        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        expect(d1.x).toBeCloseTo(-d0.x, 6);
        expect(d1.y).toBeCloseTo(d0.y, 6);
        expect(verts[2].x).toBeCloseTo(B.left + R, 6); // 折返朝左 → 左墙
    });

    it('右表面：从右侧朝左打 → 在敌人右沿折返（vx 翻转、vy 不变）', () => {
        const enemy = makeEnemy(1, 200, 0);
        const verts = traceAimGuide(350, 0, -1, 0, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(200 + SPAN, 6); // 280
        expect(segmentDir(verts, 1).x).toBeCloseTo(1, 6);
        expect(verts[2].x).toBeCloseTo(B.right - R, 6); // 折返朝右 → 右墙
    });

    it('斜射左表面：(1,2) 方向入射 → 只有 vx 翻转（真正的镜面反射，不是正撞）', () => {
        const enemy = makeEnemy(1, 0, 0);
        // 起点 (-200,-300) 沿 (1,2)：先进入判定框左沿 x = −80，交点 y = −60（在框内）
        const verts = traceAimGuide(-200, -300, 1, 2, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[1].x).toBeCloseTo(-SPAN, 6); // −80
        expect(verts[1].y).toBeCloseTo(-60, 6);

        const d0 = segmentDir(verts, 0);
        const d1 = segmentDir(verts, 1);
        const s = Math.sqrt(1 + 4);
        expect(d0.x).toBeCloseTo(1 / s, 6);
        expect(d0.y).toBeCloseTo(2 / s, 6);
        expect(d1.x).toBeCloseTo(-1 / s, 6); // 左 / 右面：法线沿 x → 只翻 x 分量
        expect(d1.y).toBeCloseTo(2 / s, 6);
        expect(verts[2].x).toBeCloseTo(B.left + R, 6); // 反射后朝左上 → 左墙
    });

    it('敌人在墙之后（不可达）：仍按墙反射，结果与「没有敌人」逐点相同', () => {
        // 顶墙线 651 < 敌人判定框下沿 820：射线先撞顶墙（刚出生的敌人就在屏上方）
        const aboveScreen = makeEnemy(1, 0, 900);
        const withEnemy = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [aboveScreen]);
        const without = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, []);
        expect(withEnemy[1].y).toBeCloseTo(B.top - R, 6);
        expectVertsClose(withEnemy, without);

        // 右墙同理：敌人整体在右墙之外
        const rightOut = makeEnemy(2, 500, 0);
        const a = traceAimGuide(0, 0, 1, 0, 1, NO_CAP, R, [rightOut]);
        const b = traceAimGuide(0, 0, 1, 0, 1, NO_CAP, R, []);
        expectVertsClose(a, b);
    });

    it('多个敌人：取最近的那个交点（与数组顺序无关）', () => {
        const far = makeEnemy(1, 0, 400);
        const near = makeEnemy(2, 0, 200);
        const a = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [far, near]);
        const b = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [near, far]);

        expect(a[1].y).toBeCloseTo(200 - SPAN, 6); // 120：近敌下沿
        expectVertsClose(a, b);
    });

    it('敌人判定框越过顶墙时比墙更近：撞敌人（顺序与真实子弹一致）', () => {
        // 敌人中心 y = 700（刚出生、还没进屏）：判定框下沿 = 620 < 顶墙线 651
        const enemy = makeEnemy(1, 0, 700);
        const verts = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [enemy]);

        expect(verts[1].y).toBeCloseTo(700 - SPAN, 6); // 620
        expect(segmentDir(verts, 1).y).toBeCloseTo(-1, 6); // vy 翻转 → 折返朝下

        // 真实子弹同样在 620 折返（此时还没到顶墙线）
        const { flips } = runRealBullet(0, -547, 0, 1, 1, [enemy]);
        expect(flips.length).toBe(1);
        expect(flips[0].vy).toBeLessThan(0);
        expect(Math.abs(flips[0].y - (700 - SPAN))).toBeLessThanOrEqual(TOL_ENEMY);
    });
});

describe('瞄准辅助射线：与真实子弹逐点一致（含遇敌反弹）', () => {
    /** [起点 x, 起点 y, 方向 x, 方向 y, 敌人 x, 敌人 y]：每个用例都先撞敌人再撞墙 */
    const ENEMY_CASES: Array<[number, number, number, number, number, number]> = [
        [0, -547, 0, 1, 0, 0],        // 正上方：撞敌人下表面 → 折返撞底墙
        [0, 547, 0, -1, 0, 0],        // 正下方：撞敌人上表面 → 折返撞顶墙
        [0, 0, 1, 0, 200, 0],         // 正右：撞敌人左表面 → 折返撞左墙
        [-300, -547, 1, 2, 0, 0],     // 斜向：撞敌人下表面 → 折返撞底墙
    ];

    it('撞敌人的位置与射线顶点重合（切向 0.25 / 法向 0.7 = 子弹被推出表面的量）', () => {
        ENEMY_CASES.forEach(([px, py, dx, dy, ex, ey]) => {
            const enemy = makeEnemy(1, ex, ey);
            const { flips } = runRealBullet(px, py, dx, dy, 2, [enemy]);
            const verts = traceAimGuide(px, py, dx, dy, 2, NO_CAP, R, [enemy]);

            expect(flips.length).toBeGreaterThan(0);
            // 与撞墙用例同一条等式：顶点 = 起点 + 每个翻转点 + 一个收尾顶点
            expect(verts.length).toBe(flips.length + 2);

            flips.forEach((flip, i) => {
                const v = verts[i + 1];
                expect(v).toBeDefined();
                // 翻转轴 = 法线轴：允许 applyBounce 的 depth(≤0.144) + 0.5 推出量
                const dNormal = flip.flipX ? Math.abs(flip.x - v.x) : Math.abs(flip.y - v.y);
                // 另一轴 = 切向：与撞墙用同一把尺子
                const dTangent = flip.flipX ? Math.abs(flip.y - v.y) : Math.abs(flip.x - v.x);
                expect(dNormal).toBeLessThanOrEqual(TOL_ENEMY);
                expect(dTangent).toBeLessThanOrEqual(TOL);
            });
        });
    });

    it('反射后的方向与真实子弹完全一致（含遇敌反射）', () => {
        ENEMY_CASES.forEach(([px, py, dx, dy, ex, ey]) => {
            const enemy = makeEnemy(1, ex, ey);
            const { flips } = runRealBullet(px, py, dx, dy, 2, [enemy]);
            const verts = traceAimGuide(px, py, dx, dy, 2, NO_CAP, R, [enemy]);

            expect(flips.length).toBeGreaterThan(0);
            flips.forEach((flip, i) => {
                const dir = segmentDir(verts, i + 1);
                const speed = Math.sqrt(flip.vx * flip.vx + flip.vy * flip.vy);
                expect(dir.x).toBeCloseTo(flip.vx / speed, 6);
                expect(dir.y).toBeCloseTo(flip.vy / speed, 6);
            });
        });
    });

    it('连续弹跳不穿模：真实子弹撞敌人后不会卡在敌人内部（每次翻转都推到表面之外）', () => {
        ENEMY_CASES.forEach(([px, py, dx, dy, ex, ey]) => {
            const enemy = makeEnemy(1, ex, ey);
            const dir = aimVelocity(px, py, px + dx, py + dy, GameTuning.bulletSpeed);
            const world = bulletWorld([enemy]);
            const bullet = createBullet(1, px, py, dir.vx, dir.vy, true);

            let enteredEnemyBox = 0;
            for (let i = 0; i < 400000 && bullet.state === BulletState.Flying; i++) {
                stepBullet(bullet, FINE_DT, world);
                // 判定框内部（矩形两轴各外扩 bulletRadius）—— 子弹不该停在里面
                const inside =
                    Math.abs(bullet.x - enemy.x) < enemy.cols * CELL * 0.5 + R - TOL &&
                    Math.abs(bullet.y - enemy.y) < enemy.rows * CELL * 0.5 + R - TOL;
                if (inside) enteredEnemyBox++;
            }
            expect(bullet.state).toBe(BulletState.Returning); // 最终正常回身，没有卡死
            expect(enteredEnemyBox).toBe(0);
        });
    });
});

describe('瞄准辅助射线：遇敌的边界情形', () => {
    const SPAN = CELL / 2 + R;

    it('敌人正好贴在起点附近：立刻在敌人表面折返，不产生零长线段', () => {
        const enemy = makeEnemy(1, 0, 0);
        const verts = traceAimGuide(0, -SPAN - 0.5, 0, 1, 1, NO_CAP, R, [enemy]);

        expect(verts.length).toBe(3);
        expect(verts[0].y).toBeCloseTo(-SPAN - 0.5, 6);
        expect(verts[1].y).toBeCloseTo(-SPAN, 6); // 折返点 = 敌人下沿
        expect(segmentDir(verts, 1).y).toBeCloseTo(-1, 6);
    });

    it('起点已落在敌人判定框内：按最浅穿透轴立刻反射（与 circleBoxHit / 真实子弹第一子步一致）', () => {
        const enemy = makeEnemy(1, 0, 0);
        // 玩家在框内、中心上方 60px（|dy| = 60 < 80），朝下打 → 下表面更浅 → vy 翻成向上
        const verts = traceAimGuide(0, 60, 0, -1, 1, NO_CAP, R, [enemy]);
        expect(verts.length).toBe(2);
        expect(verts[0]).toEqual({ x: 0, y: 60 });
        expect(segmentDir(verts, 0).y).toBeCloseTo(1, 6); // 主射线就朝上（方向已被反射）
        expect(verts[1].y).toBeCloseTo(B.top - R, 6);

        // 真实子弹：同样在第一子步就翻成向上
        const { flips } = runRealBullet(0, 60, 0, -1, 1, [enemy]);
        expect(flips.length).toBe(1);
        expect(flips[0].vy).toBeGreaterThan(0);
    });

    it('敌人在 aimGuideBounceLength 截断之外：被忽略（截断点仍是长度上限）', () => {
        // 敌人放在玩家**身后**（判定框上沿 y = −550，正好在起点 −547 的下方 3px）：
        // 主射线朝上打不会碰到它，只有「撞顶墙后折返朝下」的反弹段才会遇到它
        const enemy = makeEnemy(1, 0, -630);
        const capped = traceAimGuide(0, -547, 0, 1, 1, 200, R, [enemy]);
        expect(capped.length).toBe(3);
        expect(capped[2].y).toBeCloseTo(B.top - R - 200, 6); // 451：被长度截断，没走到敌人（−550）

        // 预算够长时同一个敌人会被撞到（证明上面不是「敌人根本没参与求交」）
        const full = traceAimGuide(0, -547, 0, 1, 2, 2000, R, [enemy]);
        expect(full[2].y).toBeCloseTo(-630 + SPAN, 6); // −550：敌人判定框上沿
        expect(segmentDir(full, 2).y).toBeCloseTo(1, 6); // 撞上表面 → vy 翻回向上
    });

    it('不可命中的敌人（出生动画中 / 已死）不挡射线：与没有敌人时逐点相同', () => {
        const ignored = [
            makeEnemy(1, 0, -200, EnemyState.Spawning),
            makeEnemy(2, 0, -100, EnemyState.Dead),
        ];
        const withIgnored = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, ignored);
        const without = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, []);

        expect(withIgnored[1].y).toBeCloseTo(B.top - R, 6); // 仍然撞顶墙
        expectVertsClose(withIgnored, without);
    });

    it('不可命中的敌人不参与「取最近」：更近的已死敌人顶不掉可命中的敌人', () => {
        const dead = makeEnemy(1, 0, -200, EnemyState.Dead);
        const live = makeEnemy(2, 0, 200);
        const verts = traceAimGuide(0, -547, 0, 1, 1, NO_CAP, R, [dead, live]);

        expect(verts[1].y).toBeCloseTo(200 - SPAN, 6); // 120：可命中敌人的下沿
    });

    it('纯函数：不改敌人坐标、不改传入数组', () => {
        const a = makeEnemy(1, 0, 0);
        const b = makeEnemy(2, 0, 400, EnemyState.Dead);
        const list = [a, b];
        const before = JSON.stringify(list);

        traceAimGuide(0, -547, 0, 1, 2, NO_CAP, R, list);
        expect(JSON.stringify(list)).toBe(before);
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

describe('虚线切割：buildDashSegments（v1.9 虚线 + 描边）', () => {
    /** 小段端点 → 沿**整条折线**的累计弧长区间；`part` 已经是折线段序号，正好当基准长用 */
    function arcSpans(
        points: { x: number; y: number }[],
        segs: { x1: number; y1: number; x2: number; y2: number; part: number }[]
    ): { start: number; end: number; part: number }[] {
        const base: number[] = [0];
        for (let i = 1; i < points.length; i++) {
            base.push(base[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
        }
        return segs.map((s) => {
            const a = points[s.part];
            const off = base[s.part];
            return {
                start: off + Math.hypot(s.x1 - a.x, s.y1 - a.y),
                end: off + Math.hypot(s.x2 - a.x, s.y2 - a.y),
                part: s.part,
            };
        });
    }

    /** 逐字段核对一个小段（浮点比较，避免 0.6 × 50 这类表示误差） */
    function expectDash(
        seg: { x1: number; y1: number; x2: number; y2: number; part: number },
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        part: number
    ): void {
        expect(seg.part).toBe(part);
        expect(seg.x1).toBeCloseTo(x1, 9);
        expect(seg.y1).toBeCloseTo(y1, 9);
        expect(seg.x2).toBeCloseTo(x2, 9);
        expect(seg.y2).toBeCloseTo(y2, 9);
    }

    it('dash=10 / gap=10 切 100px 直线 → 5 段，段长 = dash、相邻小段间距 = gap', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
        const segs = buildDashSegments(pts, 10, 10);

        expect(segs.length).toBe(5); // 100 / (10 + 10) = 5
        expect(segs.every((s) => s.part === 0)).toBe(true); // 单段折线：全是主射线

        const spans = arcSpans(pts, segs);
        spans.forEach((sp, i) => {
            expect(sp.end - sp.start).toBeCloseTo(10, 9); // 每段长 = dash
            expect(sp.start).toBeCloseTo(i * 20, 9); // 周期 = dash + gap
        });
        for (let i = 1; i < spans.length; i++) {
            expect(spans[i].start - spans[i - 1].end).toBeCloseTo(10, 9); // 间距 = gap
        }
        expect(100 - spans[spans.length - 1].end).toBeCloseTo(10, 9); // 末段后的余量同样 = gap
    });

    it('跨顶点相位连续：拐点处不断缝、不重置（跨拐点的小段总长仍是 dash）', () => {
        // 首段 25px 刻意**不是**周期 20 的整数倍：相位必须带到第二段（25 % 20 = 5）
        const pts = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 60 }];
        const segs = buildDashSegments(pts, 10, 10);
        const main = segs.filter((s) => s.part === 0);
        const bounce = segs.filter((s) => s.part === 1);

        // 主射线：0~10、20~25（第二段被拐点截断成 5px）
        expect(main.length).toBe(2);
        expectDash(main[0], 0, 0, 10, 0, 0);
        expectDash(main[1], 20, 0, 25, 0, 0);

        // 反弹段紧接着从拐点起只画 5px —— 因为跨拐点的那一段还剩 5px 没画完
        expectDash(bounce[0], 25, 0, 25, 5, 1);
        expectDash(bounce[1], 25, 15, 25, 25, 1);

        // 跨拐点的小段总弧长 = dash（若在顶点重置相位，这里会变成 5 + 10 = 15）
        const spans = arcSpans(pts, segs);
        const lastMain = spans[1];
        const firstBounce = spans[2];
        expect(lastMain.end).toBeCloseTo(25, 9); // 主射线正好画到拐点
        expect(firstBounce.start).toBeCloseTo(25, 9); // 反弹段从拐点起，中间无缝
        expect(firstBounce.end - lastMain.start).toBeCloseTo(10, 9);
    });

    it('dash <= 0 或 gap < 0 → 退化为实线（1 段 = 整段，端点原样复制）', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

        [0, -1, -100].forEach((dash) => {
            expect(buildDashSegments(pts, dash, 10)).toEqual([
                { x1: 0, y1: 0, x2: 100, y2: 0, part: 0 },
            ]);
        });
        [-0.5, -1, -100].forEach((gap) => {
            expect(buildDashSegments(pts, 10, gap)).toEqual([
                { x1: 0, y1: 0, x2: 100, y2: 0, part: 0 },
            ]);
        });

        // 多段折线：每段各退化成「一整条」，part 仍是折线段序号
        expect(buildDashSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 0, 12)).toEqual([
            { x1: 0, y1: 0, x2: 100, y2: 0, part: 0 },
            { x1: 100, y1: 0, x2: 100, y2: 50, part: 1 },
        ]);
    });

    it('gap = 0 → 仍然按 dash 切段，但首尾相接（视觉上等效实线）', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
        const segs = buildDashSegments(pts, 10, 0);
        const spans = arcSpans(pts, segs);

        expect(segs.length).toBe(10); // 周期 = dash + 0
        spans.forEach((sp, i) => expect(sp.start).toBeCloseTo(i * 10, 9));
        for (let i = 1; i < spans.length; i++) {
            expect(spans[i].start - spans[i - 1].end).toBeCloseTo(0, 9); // 无缝
        }
    });

    it('折线段短于 dash → 整段一个小段（不超画到段外）', () => {
        expect(buildDashSegments([{ x: 0, y: 0 }, { x: 6, y: 0 }], 10, 10)).toEqual([
            { x1: 0, y1: 0, x2: 6, y2: 0, part: 0 },
        ]);
    });

    it('零长折线段被跳过；points 不足 2 个点 / 全零长 → 空数组', () => {
        expect(buildDashSegments([], 10, 10)).toEqual([]);
        expect(buildDashSegments([{ x: 5, y: 5 }], 10, 10)).toEqual([]);
        expect(buildDashSegments([{ x: 5, y: 5 }, { x: 5, y: 5 }], 10, 10)).toEqual([]);
        expect(buildDashSegments([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], 10, 10)).toEqual([]);

        // 零长段自己不产生小段，也不推进相位：后面 100px 那段照常切 5 段，part 是它的折线序号 1
        const segs = buildDashSegments([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }], 10, 10);
        expect(segs.length).toBe(5);
        expect(segs.every((s) => s.part === 1)).toBe(true);
        expect(segs.some((s) => !Number.isFinite(s.x1) || !Number.isFinite(s.y1))).toBe(false);
        expect(segs.some((s) => !Number.isFinite(s.x2) || !Number.isFinite(s.y2))).toBe(false);
    });

    it('part 标记正确：第二段折线上的小段 part = 1，顺序仍是折线顺序', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
        const segs = buildDashSegments(pts, 10, 10);
        const main = segs.filter((s) => s.part === 0);
        const bounce = segs.filter((s) => s.part === 1);

        expect(main.length).toBe(5);
        expect(bounce.length).toBe(5);
        // 主射线全在水平段上、反弹段全在竖直段上（两层各画各的，不会串层）
        expect(main.every((s) => s.y1 === 0 && s.y2 === 0)).toBe(true);
        expect(bounce.every((s) => s.x1 === 100 && s.x2 === 100)).toBe(true);
        expect(segs.map((s) => s.part)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    });

    it('斜线段按**累计弧长**切（3-4-5 方向），不是按坐标轴', () => {
        const pts = [{ x: 0, y: 0 }, { x: 30, y: 40 }]; // 长 50px
        const segs = buildDashSegments(pts, 10, 10);
        const spans = arcSpans(pts, segs);

        expect(segs.length).toBe(3); // 0~10 / 20~30 / 40~50
        spans.forEach((sp) => expect(sp.end - sp.start).toBeCloseTo(10, 9));
        expect(spans[0].start).toBeCloseTo(0, 9);
        expect(spans[1].start).toBeCloseTo(20, 9);
        expect(spans[2].end).toBeCloseTo(50, 9); // 末段正好画到顶点
        expectDash(segs[2], 24, 32, 30, 40, 0);
    });

    it('phase 参数：可从任意相位续接（负相位 / 超一个周期按周期取模）', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

        // phase = 5：这一相位的 dash 已经画了 5px，所以首段只剩 5px
        const a = buildDashSegments(pts, 10, 10, 5);
        expectDash(a[0], 0, 0, 5, 0, 0);
        expectDash(a[1], 15, 0, 25, 0, 0);

        // phase = -5 ≡ 15（mod 20）：首段从第 5px 起，到第 15px 止
        const b = buildDashSegments(pts, 10, 10, -5);
        expectDash(b[0], 5, 0, 15, 0, 0);

        // 相位 ≥ 一个周期 → 等价于取模后的相位
        expect(buildDashSegments(pts, 10, 10, 25)).toEqual(a);
    });

    it('纯函数：不改传入的顶点数组', () => {
        const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }];
        const before = JSON.stringify(pts);

        buildDashSegments(pts, 10, 10, 3);
        expect(JSON.stringify(pts)).toBe(before);
    });
});