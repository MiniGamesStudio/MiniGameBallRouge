/**
 * L1 单测：子弹仿真（需求 1 的三条铁律）
 *
 * 这里测的全是纯逻辑，不依赖 cc，因此可以直接在 node 里跑。
 */
import {
    BulletState,
    EnemyRuntime,
    EnemyShape,
    EnemyState,
    EnemyType,
    Quality,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import {
    BulletWorld,
    createBullet,
    stepBullet,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BulletSim';
import {
    boxFromCells,
    circleHitsBox,
    screenBounds,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';
import { SeededRandom } from '../../assets/scripts/Game/CommonGame/gameplay/core/Rng';

const DT = 1 / 60;
const BOUNDS = screenBounds();

function makeEnemy(id: number, x: number, y: number, cols: number = 1, rows: number = 1): EnemyRuntime {
    return {
        id,
        defId: 'test_' + id,
        quality: Quality.White,
        type: EnemyType.Normal,
        shape: cols === 2 ? EnemyShape.DoubleH : EnemyShape.Single,
        cols,
        rows,
        x,
        y,
        hp: 100,
        maxHp: 100,
        speed: 0,
        state: EnemyState.Falling,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

interface TestWorld extends BulletWorld {
    hits: number[];
    caughtIds: number[];
    returns: number;
}

function makeWorld(enemies: EnemyRuntime[], playerX: number = 0, playerY: number = -547): TestWorld {
    const world = {
        playerX,
        playerY,
        catchRadius: GameTuning.catchRadius,
        hits: [] as number[],
        caughtIds: [] as number[],
        returns: 0,
        queryEnemies: (x: number, y: number, radius: number) =>
            enemies.filter(e => circleHitsBox(x, y, radius, boxFromCells(e.x, e.y, e.cols, e.rows))),
        onEnemyHit: (_bullet: any, enemy: EnemyRuntime) => { world.hits.push(enemy.id); },
        onReturn: () => { world.returns++; },
        onCaught: (bullet: any) => { world.caughtIds.push(bullet.id); },
    };
    return world as TestWorld;
}

describe('子弹：底墙回身（需求 1 铁律 2）', () => {
    it('撞到底墙转入回身，而不是反弹', () => {
        const world = makeWorld([], 0, -547);
        const bullet = createBullet(1, 0, -600, 0, -GameTuning.bulletSpeed, true);

        let returned = false;
        for (let i = 0; i < 60 && !returned; i++) {
            returned = stepBullet(bullet, DT, world).returned;
        }

        expect(returned).toBe(true);
        expect(bullet.state).toBe(BulletState.Returning);
        expect(bullet.vy).toBeGreaterThan(0); // 回身 = 朝玩家（上方）飞
    });

    it('回身中的子弹穿过敌人、不结算伤害、也不被挡下', () => {
        const enemy = makeEnemy(7, 0, -600, 3, 2); // 正好挡在回家路上
        const world = makeWorld([enemy], 0, -547);
        const bullet = createBullet(1, 0, BOUNDS.bottom + GameTuning.bulletRadius + 1, 0, -GameTuning.bulletSpeed, true);

        stepBullet(bullet, DT, world);
        expect(bullet.state).toBe(BulletState.Returning);

        let caught = false;
        for (let i = 0; i < 120 && !caught; i++) {
            caught = stepBullet(bullet, DT, world).caught;
        }

        expect(caught).toBe(true);
        expect(world.hits.length).toBe(0);
        expect(world.caughtIds).toEqual([1]);
    });
});

describe('子弹：不会永久卡死（需求 1 铁律 1）', () => {
    it('任意角度、任意玩家位置，子弹最终都会被接住', () => {
        const rng = new SeededRandom(20261003);

        for (let trial = 0; trial < 40; trial++) {
            const angle = rng.next() * Math.PI * 2;
            const playerX = (rng.next() - 0.5) * 600;
            const playerY = BOUNDS.bottom + 40 + rng.next() * 80;
            const world = makeWorld([], playerX, playerY);
            const bullet = createBullet(trial, playerX, playerY + 20,
                Math.cos(angle) * GameTuning.bulletSpeed,
                Math.sin(angle) * GameTuning.bulletSpeed, true);

            let caught = false;
            let outside = 0;
            for (let step = 0; step < 20 * 60 && !caught; step++) {
                caught = stepBullet(bullet, DT, world).caught;
                outside = Math.max(outside, Math.abs(bullet.x), Math.abs(bullet.y));
            }

            expect(caught).toBe(true);
            expect(outside).toBeLessThanOrEqual(BOUNDS.top + GameTuning.bulletRadius + 1);
        }
    });

    it('超时兜底：水平飞行、永远碰不到玩家的子弹，8 秒后强制回身', () => {
        const world = makeWorld([], 0, -647);
        const bullet = createBullet(1, -300, 0, GameTuning.bulletSpeed, 0, true);

        let returnedAt = -1;
        for (let i = 0; i < 9 * 60; i++) {
            if (stepBullet(bullet, DT, world).returned) { returnedAt = i; break; }
        }

        expect(returnedAt).toBeGreaterThan(7.5 * 60); // 是超时兜底，不是撞墙
        expect(bullet.state).toBe(BulletState.Returning);
    });
});

describe('子弹：顶/左/右墙只反弹（需求 1 铁律 2）', () => {
    it('顶墙：vy 翻转且不触发回身', () => {
        const world = makeWorld([], 0, -700);
        const bullet = createBullet(1, 0, 600, 0, GameTuning.bulletSpeed, true);

        let flipped = false;
        for (let i = 0; i < 60 && !flipped; i++) {
            stepBullet(bullet, DT, world);
            if (bullet.vy < 0) flipped = true;
        }

        expect(flipped).toBe(true);
        expect(bullet.y).toBeLessThanOrEqual(BOUNDS.top - GameTuning.bulletRadius + 0.5);
        expect(world.returns).toBe(0);
    });

    it('左墙 / 右墙：vx 翻转并留在屏幕内', () => {
        const world = makeWorld([], 0, -700);

        const left = createBullet(1, -300, 0, -GameTuning.bulletSpeed, 0, true);
        for (let i = 0; i < 10; i++) stepBullet(left, DT, world);
        expect(left.vx).toBeGreaterThan(0);
        expect(left.x).toBeGreaterThanOrEqual(BOUNDS.left + GameTuning.bulletRadius - 0.5);

        const right = createBullet(2, 300, 0, GameTuning.bulletSpeed, 0, true);
        for (let i = 0; i < 10; i++) stepBullet(right, DT, world);
        expect(right.vx).toBeLessThan(0);
        expect(right.x).toBeLessThanOrEqual(BOUNDS.right - GameTuning.bulletRadius + 0.5);
    });
});

describe('子弹：出膛保护与防穿模', () => {
    it('刚出膛的子弹不会被玩家立刻收回（armed 规则）', () => {
        const world = makeWorld([], 0, -547);
        const bullet = createBullet(1, 0, -547, 0, GameTuning.bulletSpeed, true);

        const first = stepBullet(bullet, DT, world);
        expect(first.caught).toBe(false);
        expect(bullet.armed).toBe(false);

        for (let i = 0; i < 30; i++) stepBullet(bullet, DT, world);
        expect(bullet.armed).toBe(true);
    });

    it('大步长（0.1s）也不会穿过单格敌人', () => {
        const enemy = makeEnemy(3, 0, 0, 1, 1);
        const world = makeWorld([enemy], 0, -547);
        const bullet = createBullet(1, 0, -300, 0, GameTuning.bulletSpeed, true);

        let hit = false;
        for (let i = 0; i < 12 && !hit; i++) {
            stepBullet(bullet, 0.1, world);
            hit = world.hits.length > 0;
        }

        expect(hit).toBe(true);
    });
});

describe('子弹：命中结算与去重', () => {
    it('贴着敌人连续多帧只结算一次，离开后再撞会再次结算', () => {
        const enemy = makeEnemy(5, 0, 0, 1, 1);
        const world = makeWorld([enemy], 0, -547);
        const bullet = createBullet(1, 0, -30, 0, 10, true);

        for (let i = 0; i < 10; i++) stepBullet(bullet, DT, world);
        expect(world.hits).toEqual([5]);

        bullet.vy = GameTuning.bulletSpeed; // 掉头再撞一次
        for (let i = 0; i < 20; i++) stepBullet(bullet, DT, world);
        expect(world.hits).toEqual([5, 5]);
    });

    it('一次穿过 2 格敌人只结算一次', () => {
        const enemy = makeEnemy(9, 0, 0, 2, 1);
        const world = makeWorld([enemy], 0, -547);
        const bullet = createBullet(1, 0, -300, 0, GameTuning.bulletSpeed, true);

        for (let i = 0; i < 30; i++) stepBullet(bullet, DT, world);
        expect(world.hits.length).toBe(1);
    });
});