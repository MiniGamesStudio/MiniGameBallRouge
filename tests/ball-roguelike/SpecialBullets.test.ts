/**
 * L1 单测：特殊子弹（纯逻辑）
 *
 * 覆盖 core/SpecialBullets.ts 的两块：等级 → 数值的派生（lightningSpec / fireballSpec /
 * iceSpec / specialSpec），以及**「一发一世界」的 CD 状态机**（createSpecialState /
 * setSpecialLevel / stepSpecial / readyToFire / markFired / markCaught）。
 *
 * CD 状态机那组是本需求的核心，逐字对应原话：
 *   「闪电子弹有自己的 CD，每次发射出去后就开始记录 CD 时间，当回收后如果 CD 时间未到，
 *     则等 CD 到了之后再发射，如果回收时 CD 已到则可以立刻发射出去」
 * 尤其是 **CD 在飞行途中就走完 → 回收即可再射** 那一条 —— 它成立的唯一前提是
 * `stepSpecial` 不因 `inFlight` 而暂停，所以单独一条用例钉死它。
 *
 * 回程速度那组测的是另一个真实踩过的坑：`aimAtPlayer` 曾经写死 `GameTuning.bulletSpeed`，
 * 于是"闪电快得多"只快出膛那一段、回家照样爬（见 BulletSim.aimAtPlayer 的注释）。
 */
import { BulletKind, BulletState } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import {
    BulletWorld,
    createBullet,
    stepBullet,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BulletSim';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';
import { SKILL_POOL, createRunStats } from '../../assets/scripts/Game/CommonGame/gameplay/core/PlayerStats';
import {
    createSpecialState,
    fireballSpec,
    iceSpec,
    lightningSpec,
    markCaught,
    markFired,
    readyToFire,
    setSpecialLevel,
    specialSpec,
    stepSpecial,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/SpecialBullets';
import { screenBounds } from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';

const DT = 1 / 60;
const BOUNDS = screenBounds();
const MAX_LEVEL = GameTuning.specialBulletMaxLevel;

// ─────────── 数值派生 ───────────

describe('lightningSpec：等级 → 数值', () => {
    it('1 级就是需求里的「目标数初始 3 个」', () => {
        const spec = lightningSpec(1);
        expect(spec.chainTargets).toBe(3);
        expect(spec.chainTargets).toBe(GameTuning.lightningChainTargets);
        expect(spec.bulletDamage).toBe(GameTuning.lightningBulletDamage);
        expect(spec.cooldown).toBeCloseTo(GameTuning.lightningBulletCd, 6);
        expect(spec.speedMul).toBe(GameTuning.lightningBulletSpeedMul);
    });

    it('升级后目标数增加（需求：升级后可以增加目标数）', () => {
        expect(lightningSpec(2).chainTargets).toBe(GameTuning.lightningChainTargets + 1);
        expect(lightningSpec(3).chainTargets).toBe(GameTuning.lightningChainTargets + 2);
        expect(lightningSpec(MAX_LEVEL).chainTargets).toBe(
            GameTuning.lightningChainTargets + (MAX_LEVEL - 1) * GameTuning.lightningChainTargetsPerLevel
        );
    });

    it('目标数逐级严格不减，且永远至少 1（下限保护）', () => {
        let last = 0;
        for (let lv = 1; lv <= MAX_LEVEL; lv++) {
            const n = lightningSpec(lv).chainTargets;
            expect(n).toBeGreaterThanOrEqual(last);
            expect(n).toBeGreaterThanOrEqual(1);
            last = n;
        }
    });

    it('本体伤害与连锁伤害都逐级线性增长', () => {
        expect(lightningSpec(3).bulletDamage).toBe(GameTuning.lightningBulletDamage + 2 * GameTuning.lightningBulletDamagePerLevel);
        expect(lightningSpec(3).chainDamage).toBe(GameTuning.lightningChainDamage + 2 * GameTuning.lightningChainDamagePerLevel);
        expect(lightningSpec(MAX_LEVEL).bulletDamage).toBeGreaterThan(lightningSpec(1).bulletDamage);
    });

    it('CD 逐级缩短，但贴不到 0（有下限）', () => {
        expect(lightningSpec(3).cooldown).toBeLessThan(lightningSpec(1).cooldown);
        for (let lv = 1; lv <= 50; lv++) {
            expect(lightningSpec(lv).cooldown).toBeGreaterThanOrEqual(GameTuning.lightningBulletMinCd);
        }
    });

    it('速度倍率不随等级变（快是这枚子弹的固有属性，不是成长项）', () => {
        expect(lightningSpec(1).speedMul).toBe(lightningSpec(MAX_LEVEL).speedMul);
        expect(lightningSpec(1).speedMul).toBeGreaterThan(1); // 需求：闪电要快很多
    });

    it('等级被夹到 [1, maxLevel]：0 / 负数 / 超上限 / NaN / 小数都不产生脏数值', () => {
        const maxed = lightningSpec(MAX_LEVEL);
        expect(lightningSpec(0)).toEqual(lightningSpec(1));
        expect(lightningSpec(-7)).toEqual(lightningSpec(1));
        expect(lightningSpec(999)).toEqual(maxed);
        expect(lightningSpec(Number.NaN)).toEqual(lightningSpec(1));
        expect(lightningSpec(2.9)).toEqual(lightningSpec(2));
    });
});

describe('fireballSpec / iceSpec：等级 → 数值', () => {
    it('火球 1 级取调参表基准值', () => {
        const spec = fireballSpec(1);
        expect(spec.bulletDamage).toBe(GameTuning.fireBulletDamage);
        expect(spec.cooldown).toBeCloseTo(GameTuning.fireBulletCd, 6);
        expect(spec.burnDuration).toBeCloseTo(GameTuning.burnDuration, 6);
        expect(spec.burnDamage).toBe(GameTuning.burnDamage);
        expect(spec.burnInterval).toBe(GameTuning.burnInterval);
        expect(spec.speedMul).toBe(GameTuning.fireBulletSpeedMul);
    });

    it('火球升级：本体伤害、灼烧时长、跳伤一起长', () => {
        const l1 = fireballSpec(1);
        const l3 = fireballSpec(3);
        expect(l3.bulletDamage).toBe(GameTuning.fireBulletDamage + 2 * GameTuning.fireBulletDamagePerLevel);
        expect(l3.burnDuration).toBeCloseTo(GameTuning.burnDuration + 2 * GameTuning.burnDurationPerLevel, 6);
        expect(l3.burnDamage).toBe(GameTuning.burnDamage + 2 * GameTuning.burnDamagePerLevel);
        expect(l3.burnDuration).toBeGreaterThan(l1.burnDuration);
        // 跳伤间隔是手感常数，不随等级变（变的是每跳多重，不是跳得多密）
        expect(l3.burnInterval).toBe(l1.burnInterval);
    });

    it('火球 CD 有下限', () => {
        for (let lv = 1; lv <= 50; lv++) {
            expect(fireballSpec(lv).cooldown).toBeGreaterThanOrEqual(GameTuning.fireBulletMinCd);
        }
    });

    it('冰冻 1 级取调参表基准值，升级只长冻结时长与伤害', () => {
        const l1 = iceSpec(1);
        expect(l1.bulletDamage).toBe(GameTuning.iceBulletDamage);
        expect(l1.freezeDuration).toBeCloseTo(GameTuning.freezeDuration, 6);
        expect(l1.cooldown).toBeCloseTo(GameTuning.iceBulletCd, 6);
        expect(l1.speedMul).toBe(GameTuning.iceBulletSpeedMul);

        const l3 = iceSpec(3);
        expect(l3.freezeDuration).toBeCloseTo(GameTuning.freezeDuration + 2 * GameTuning.freezeDurationPerLevel, 6);
        expect(l3.freezeDuration).toBeGreaterThan(l1.freezeDuration);
    });

    it('冰冻 CD 有下限，且基准 CD 长于冻结时长（不能靠冰冻把自己永久续上）', () => {
        for (let lv = 1; lv <= 50; lv++) {
            expect(iceSpec(lv).cooldown).toBeGreaterThanOrEqual(GameTuning.iceBulletMinCd);
        }
        expect(GameTuning.iceBulletCd).toBeGreaterThan(GameTuning.freezeDuration);
    });
});

describe('specialSpec：按种类取 spec', () => {
    it('三种特殊弹各自派发到自己的 spec', () => {
        expect(specialSpec(BulletKind.Lightning, 2)).toEqual(lightningSpec(2));
        expect(specialSpec(BulletKind.Fire, 2)).toEqual(fireballSpec(2));
        expect(specialSpec(BulletKind.Ice, 2)).toEqual(iceSpec(2));
    });

    it('只有「共有那几项」时也能直接用（CD / 速度倍率 / 本体伤害）', () => {
        for (const kind of [BulletKind.Lightning, BulletKind.Fire, BulletKind.Ice]) {
            const spec = specialSpec(kind, 1);
            expect(spec.cooldown).toBeGreaterThan(0);
            expect(spec.speedMul).toBeGreaterThan(0);
            expect(spec.bulletDamage).toBeGreaterThan(0);
        }
    });

    it('Magazine 不该走这条线，但真调到了也不炸（按闪电兜底）', () => {
        expect(specialSpec(BulletKind.Magazine, 1)).toEqual(lightningSpec(1));
    });
});

// ─────────── CD 状态机（本需求核心） ───────────

describe('CD 状态机：发射即计时、回收时 CD 未到就等、CD 已到就立刻再射', () => {
    const CD = 3;

    /** 学会闪电（level 1）的初始状态 */
    function learned(): ReturnType<typeof createSpecialState> {
        const st = createSpecialState();
        setSpecialLevel(st, 1);
        return st;
    }

    it('未学（level 0）永远不就绪 —— 就算 CD 走完、手上也没弹', () => {
        const st = createSpecialState();
        expect(st.level).toBe(0);
        expect(st.cooldown).toBe(0);
        expect(st.inFlight).toBe(false);
        expect(readyToFire(st)).toBe(false);

        stepSpecial(st, 100); // CD 早就走完了
        markCaught(st); // 也没有弹在飞
        expect(readyToFire(st)).toBe(false);
    });

    it('学会的当帧就可发射（不用等一个 CD）', () => {
        const st = createSpecialState();
        setSpecialLevel(st, 1);
        expect(readyToFire(st)).toBe(true);
    });

    it('发射 → CD 置为本次 CD、标记场上有我一发、立刻不再就绪', () => {
        const st = learned();
        markFired(st, CD);
        expect(st.cooldown).toBeCloseTo(CD, 6);
        expect(st.inFlight).toBe(true);
        expect(readyToFire(st)).toBe(false);
    });

    it('回收时 CD 未到 → 在手里等，等到 0 才就绪', () => {
        const st = learned();
        markFired(st, CD);

        stepSpecial(st, 1.0); // 只飞了 1s
        markCaught(st);
        expect(st.inFlight).toBe(false);
        expect(readyToFire(st)).toBe(false); // ← 需求：「如果 CD 时间未到，则等 CD 到了之后再发射」

        // 刻意用 1.5 / 0.6 这种不与 CD 相消的步长，避开浮点误差：
        // 1.0 + 1.9 + 0.1 之类的组合会在最后一步留下 8e-17 的正残渣，断言就假失败了
        stepSpecial(st, 1.5); // 累计 2.5s，还差 0.5s
        expect(st.cooldown).toBeCloseTo(0.5, 6);
        expect(readyToFire(st)).toBe(false);
        stepSpecial(st, 0.4); // 累计 2.9s，还差 0.1s
        expect(readyToFire(st)).toBe(false);
        stepSpecial(st, 0.2); // 累计 3.1s，CD 已过
        expect(readyToFire(st)).toBe(true); // ← 需求：「等 CD 到了之后再发射」
    });

    it('★ CD 在飞行途中已走完 → 回收那一刻即可发射（不需要再多等一帧）', () => {
        const st = learned();
        markFired(st, CD);

        // 子弹在场上待满整个 CD（含回程），期间什么都没回收
        stepSpecial(st, CD);
        expect(st.inFlight).toBe(true); // 还在飞
        expect(st.cooldown).toBe(0);

        markCaught(st);
        expect(readyToFire(st)).toBe(true); // ← 需求：「如果回收时 CD 已到则可以立刻发射出去」
    });

    it('CD 在飞行中照走（这才是上一条成立的原因）', () => {
        const st = learned();
        markFired(st, CD);
        stepSpecial(st, 1.2);
        expect(st.inFlight).toBe(true);
        expect(st.cooldown).toBeCloseTo(CD - 1.2, 6);
    });

    it('飞行中即使 CD 归零也不就绪（否则会变成同种子弹两发）', () => {
        const st = learned();
        markFired(st, CD);
        stepSpecial(st, 999);
        expect(st.cooldown).toBe(0);
        expect(readyToFire(st)).toBe(false); // inFlight 这一票否决
    });

    it('CD 夹到 0，不会走成负数（多次空转也保持 0）', () => {
        const st = learned();
        markFired(st, 0.5);
        for (let i = 0; i < 100; i++) stepSpecial(st, 0.1);
        expect(st.cooldown).toBe(0);
        stepSpecial(st, 1e9);
        expect(st.cooldown).toBe(0);
    });

    it('markCaught 幂等：重复调用（模拟器回调 + 移除兜底）不产生副作用', () => {
        const st = learned();
        markFired(st, CD);
        stepSpecial(st, 0.5);
        const cd = st.cooldown;

        markCaught(st);
        markCaught(st);
        markCaught(st);
        expect(st.inFlight).toBe(false);
        expect(st.cooldown).toBeCloseTo(cd, 6); // CD 既没被重置也没被加速
        expect(readyToFire(st)).toBe(false);
    });

    it('markFired 传非法 CD 时不产生 NaN 状态', () => {
        const st = learned();
        markFired(st, Number.NaN);
        expect(st.cooldown).toBe(0);
        expect(Number.isFinite(st.cooldown)).toBe(true);
        markFired(st, -5);
        expect(st.cooldown).toBe(0);
    });

    it('stepSpecial 遇 NaN / 负数 dt 不动 CD（不产生脏值）', () => {
        const st = learned();
        markFired(st, CD);
        stepSpecial(st, Number.NaN);
        expect(st.cooldown).toBeCloseTo(CD, 6);
        stepSpecial(st, -100);
        expect(st.cooldown).toBeCloseTo(CD, 6);
    });

    it('升级 / 降级（存档读回）当场生效：level 归 0 立刻锁上，回到 1 立刻放开', () => {
        const st = learned();
        setSpecialLevel(st, 0);
        expect(readyToFire(st)).toBe(false);
        setSpecialLevel(st, 1);
        expect(readyToFire(st)).toBe(true);
        setSpecialLevel(st, Number.NaN);
        expect(st.level).toBe(0);
    });

    it('完整循环：CD 长于一次往返时，连射周期就是 CD（「等 CD」这一层真的在起作用）', () => {
        const spec = lightningSpec(1);
        const st = createSpecialState();
        setSpecialLevel(st, 1);

        const flightTime = 1.0; // 一次典型往返：出膛 → 回身 → 回收
        expect(spec.cooldown).toBeGreaterThan(flightTime); // 前提：CD 长于往返

        const fireTimes: number[] = [];
        let t = 0;
        let caughtAt = -1; // 本次飞行的预计回收时刻（< 0 = 没有在飞的弹）
        for (let i = 0; i < 60 * 12; i++) {
            stepSpecial(st, DT);

            if (caughtAt >= 0 && t >= caughtAt) {
                markCaught(st); // 子弹回到手里
                caughtAt = -1;
            }

            if (readyToFire(st)) {
                fireTimes.push(t);
                markFired(st, spec.cooldown);
                caughtAt = t + flightTime;
            }

            t += DT;
        }

        expect(fireTimes.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < fireTimes.length; i++) {
            // 两发之间的间隔 = CD（而不是往返时间）—— 这正是"CD 在管节奏"
            expect(fireTimes[i] - fireTimes[i - 1]).toBeCloseTo(spec.cooldown, 1);
        }
    });
});

// ─────────── 子弹本体：缺省值 + 回程速度 ───────────

/**
 * 空世界：这里只关心子弹自己的速度，不关心它撞到什么。
 *
 * 玩家特意放在**屏幕外很远**的地方：子弹在底墙处转入回身，而回身第一帧就朝玩家飞，
 * 若玩家就在附近（回收半径 61），子弹会在同一帧被回收，`state` 就不再是 Returning 了 ——
 * 那样测的就不是"回程速度"，而是"回收"。放远了才能稳定读到回身的速度。
 */
function makeWorld(): BulletWorld {
    return {
        playerX: 0,
        playerY: BOUNDS.top + 10000,
        catchRadius: GameTuning.catchRadius,
        queryEnemies: () => [],
        onEnemyHit: () => undefined,
        onReturn: () => undefined,
        onCaught: () => undefined,
    } as BulletWorld;
}

describe('createBullet：kind 与名义速度', () => {
    it('缺省 kind = Magazine、缺省 speed = 初速的模长（老调用点行为不变）', () => {
        const b = createBullet(1, 0, 0, 3, 4, true);
        expect(b.kind).toBe(BulletKind.Magazine);
        expect(b.speed).toBeCloseTo(5, 9);
    });

    it('显式传入的特殊弹 kind 被保留', () => {
        for (const kind of [BulletKind.Lightning, BulletKind.Fire, BulletKind.Ice]) {
            const b = createBullet(1, 0, 0, 0, -GameTuning.bulletSpeed, false, kind);
            expect(b.kind).toBe(kind);
            expect(b.fromMagazine).toBe(false);
        }
    });

    it('speed 就是初速模长（斜射也算对）', () => {
        const b = createBullet(1, 0, 0, -300, -400, false, BulletKind.Ice);
        expect(b.speed).toBeCloseTo(500, 9);
    });
});

describe('回程速度 = 名义速度 × returnSpeedScale（坑：不能写死基准速度）', () => {
    /** 造一发在底墙外、朝下飞的子弹，推进到转回身，返回它的回程速率 */
    function returnSpeedOf(nominal: number, kind: BulletKind): number {
        const world = makeWorld();
        const b = createBullet(1, 0, BOUNDS.bottom + GameTuning.bulletRadius + 1, 0, -nominal, false, kind);
        b.speed = nominal; // 与 view 层 fireSpecialBullet 的写法一致
        stepBullet(b, DT, world);
        expect(b.state).toBe(BulletState.Returning); // 进了回身才谈得上"回程速度"
        return Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    }

    it('普通弹的回程速率仍是基准速度 × returnSpeedScale', () => {
        const nominal = GameTuning.bulletSpeed;
        expect(returnSpeedOf(nominal, BulletKind.Magazine)).toBeCloseTo(nominal * GameTuning.returnSpeedScale, 3);
    });

    it('闪电弹的回程明显更快（speedMul 1.6 全程生效，不只是出膛那一段）', () => {
        const nominal = GameTuning.bulletSpeed * GameTuning.lightningBulletSpeedMul;
        const back = returnSpeedOf(nominal, BulletKind.Lightning);
        expect(back).toBeCloseTo(nominal * GameTuning.returnSpeedScale, 3);
        expect(back).toBeGreaterThan(GameTuning.bulletSpeed * GameTuning.returnSpeedScale); // 确实比普通弹快
    });

    it('旧存档 / 手工构造的子弹没有 speed 时退回基准速度（不炸、不静止）', () => {
        const world = makeWorld();
        const b = createBullet(1, 0, BOUNDS.bottom + GameTuning.bulletRadius + 1, 0, -GameTuning.bulletSpeed, true);
        delete (b as { speed?: number }).speed; // 模拟老数据
        stepBullet(b, DT, world);
        const back = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        expect(back).toBeCloseTo(GameTuning.bulletSpeed * GameTuning.returnSpeedScale, 3);
    });

    it('speed 为 0 也走上面的兜底（不会算出 0 速度卡在原地）', () => {
        const world = makeWorld();
        const b = createBullet(1, 0, BOUNDS.bottom + GameTuning.bulletRadius + 1, 0, -GameTuning.bulletSpeed, true);
        b.speed = 0;
        stepBullet(b, DT, world);
        const back = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        expect(back).toBeCloseTo(GameTuning.bulletSpeed * GameTuning.returnSpeedScale, 3);
    });
});

// ─────────── 技能卡接线 ───────────

describe('技能卡与属性账本接线', () => {
    const CASES: Array<{ id: string; field: 'lightningLevel' | 'fireballLevel' | 'iceLevel' }> = [
        { id: 's_lightning', field: 'lightningLevel' },
        { id: 's_fireball', field: 'fireballLevel' },
        { id: 's_ice', field: 'iceLevel' },
    ];

    it('三个技能卡都在池子里，maxLevel 与 GameTuning 的上限一致（防止两处各写一个 5）', () => {
        for (const c of CASES) {
            const skill = SKILL_POOL.find(s => s.id === c.id);
            expect(skill).toBeDefined();
            expect(skill!.maxLevel).toBe(MAX_LEVEL);
        }
    });

    it('初始全为 0（0 = 未学，三枚子弹都不该出现）', () => {
        const stats = createRunStats();
        for (const c of CASES) expect(stats[c.field]).toBe(0);
    });

    it('应用技能卡各自记账，且数值确实随等级变化（不是只有等级数字在动）', () => {
        for (const c of CASES) {
            const stats = createRunStats();
            const skill = SKILL_POOL.find(s => s.id === c.id)!;

            skill.apply(stats);
            expect(stats[c.field]).toBe(1);
            skill.apply(stats);
            skill.apply(stats);
            expect(stats[c.field]).toBe(3);

            // 别的技能等级不受影响（三张卡互不串门）
            for (const other of CASES) {
                if (other.field !== c.field) expect(stats[other.field]).toBe(0);
            }
        }

        // 等级真的换来了数值：1 级 vs 3 级
        expect(fireballSpec(3).burnDuration).toBeGreaterThan(fireballSpec(1).burnDuration);
        expect(iceSpec(3).freezeDuration).toBeGreaterThan(iceSpec(1).freezeDuration);
        expect(lightningSpec(3).chainTargets).toBeGreaterThan(lightningSpec(1).chainTargets);
    });

    it('未学时对应的 specialSpec 不会糊出"能打"的假象（level 0 由 setSpecialLevel 关掉）', () => {
        const st = createSpecialState();
        setSpecialLevel(st, createRunStats().lightningLevel);
        expect(readyToFire(st)).toBe(false);
    });
});