/**
 * L1 单测：敌人持续状态（纯逻辑）
 *
 * 覆盖 core/StatusEffects.ts：灼烧（applyBurn / 跳数累加 / 到期）、冰冻（applyFreeze /
 * `frozen` 同步 / 到期解冻）、以及死亡与无状态两条边界。
 *
 * 三条最要紧的口径在这里钉死：
 *   ① **刷新取 max，不做叠加** —— 火球连打不该让伤害随命中次数指数爆炸；
 *   ② **计时按真实时间走，绝不随世界暂停而冻结** —— 冻结会把整个世界停住
 *      （frozen → isEnemyStopped → applyStopBlocking → 滚动 delta = 0），如果冻结计时也跟着停，
 *      就永远走不到 0、世界永久卡死。`stepStatus` 没有任何"暂停"入参，这一条在签名上就是成立的，
 *      下面的用例把它钉成显式断言；
 *   ③ **死亡必须清状态** —— `updateScroll` 跑在"移除死亡敌人"之前，一只"死了但还冻着"的敌人
 *      会一直让世界停住。
 */
import {
    EnemyRuntime,
    EnemyShape,
    EnemyState,
    EnemyType,
    Quality,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import {
    applyBurn,
    applyFreeze,
    clearStatus,
    isBurning,
    isFrozen,
    stepStatus,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/StatusEffects';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';

const DT = 1 / 60;

function makeEnemy(id: number = 1): EnemyRuntime {
    return {
        id,
        defId: 'test_' + id,
        quality: Quality.White,
        type: EnemyType.Normal,
        shape: EnemyShape.Single,
        cols: 1,
        rows: 1,
        x: 0,
        y: GameTuning.spawnLineY,
        hp: 100,
        maxHp: 100,
        speed: 0,
        state: EnemyState.Falling,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

/** 推进 n 帧 */
function stepFrames(enemy: EnemyRuntime, frames: number, dt: number = DT): number {
    let ticks = 0;
    for (let i = 0; i < frames; i++) ticks += stepStatus(enemy, dt).burnTicks;
    return ticks;
}

// ─────────── 灼烧 ───────────

describe('applyBurn：施加与刷新（取 max，不叠加）', () => {
    it('首次施加：记下时长、跳伤、间隔', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        expect(e.status).toBeDefined();
        expect(e.status!.burnTime).toBeCloseTo(3, 6);
        expect(e.status!.burnDamage).toBe(8);
        expect(e.status!.burnInterval).toBe(0.5);
        expect(isBurning(e)).toBe(true);
    });

    it('更强的火球刷新：时长与跳伤各自取 max', () => {
        const e = makeEnemy();
        applyBurn(e, 2, 8, 0.5);
        applyBurn(e, 5, 12, 0.5);
        expect(e.status!.burnTime).toBeCloseTo(5, 6); // 更长的盖住更短的
        expect(e.status!.burnDamage).toBe(12); // 更狠的盖住更弱的
    });

    it('更弱的火球打上去不削弱已有的灼烧（取 max，不是覆盖）', () => {
        const e = makeEnemy();
        applyBurn(e, 5, 12, 0.5);
        applyBurn(e, 2, 4, 0.5);
        expect(e.status!.burnTime).toBeCloseTo(5, 6);
        expect(e.status!.burnDamage).toBe(12);
    });

    it('刷新保留 burnAccum：连打两发不会把"下一次跳伤"重新推后一个间隔', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        stepStatus(e, 0.4);
        expect(e.status!.burnAccum).toBeCloseTo(0.4, 6);

        applyBurn(e, 3, 8, 0.5);
        expect(e.status!.burnAccum).toBeCloseTo(0.4, 6); // 没有被清零

        // 再走 0.1s 就该跳第一下（如果不是保留，这里会跳不出来）
        expect(stepStatus(e, 0.1).burnTicks).toBe(1);
    });

    it('非法 / 负数入参不产生脏值', () => {
        const e = makeEnemy();
        applyBurn(e, Number.NaN, Number.NaN, Number.NaN);
        expect(e.status!.burnTime).toBe(0);
        expect(e.status!.burnDamage).toBe(0);
        expect(Number.isFinite(e.status!.burnInterval)).toBe(true);
        expect(e.status!.burnInterval).toBeGreaterThan(0);
        expect(isBurning(e)).toBe(false);

        applyBurn(e, -5, -5, 0.5);
        expect(e.status!.burnTime).toBe(0);
        expect(e.status!.burnDamage).toBe(0);
    });
});

describe('stepStatus：灼烧跳数（伤害 = 跳数 × burnDamage）', () => {
    it('累计满一个间隔才跳一次，余数留到下一帧', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);

        expect(stepStatus(e, 0.2).burnTicks).toBe(0);
        expect(stepStatus(e, 0.2).burnTicks).toBe(0);
        expect(stepStatus(e, 0.1).burnTicks).toBe(1); // 0.2+0.2+0.1 = 0.5
        expect(e.status!.burnAccum).toBeCloseTo(0, 6);
        expect(stepStatus(e, 0.1).burnTicks).toBe(0); // 余数重新累计
    });

    it('大 dt 一次补多跳（不会漏伤）', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        expect(stepStatus(e, 1.1).burnTicks).toBe(2); // 2 × 0.5，余 0.1
        expect(e.status!.burnAccum).toBeCloseTo(0.1, 6);
        expect(stepStatus(e, 0.4).burnTicks).toBe(1); // 0.1 + 0.4 = 0.5
    });

    it('按帧走满整段灼烧：跳数 = floor(时长 / 间隔)', () => {
        const e = makeEnemy();
        const duration = 2.9; // 刻意不是间隔的整数倍，避开浮点边界
        const interval = 0.5;
        applyBurn(e, duration, 8, interval);
        const ticks = stepFrames(e, Math.round(duration / DT));
        expect(ticks).toBe(Math.floor(duration / interval));
    });

    it('burnDamage = 0 时只走计时、不跳伤（不会白送 0 伤害的飘字）', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 0, 0.5);
        expect(stepFrames(e, 60)).toBe(0);
        expect(e.status!.burnTime).toBeGreaterThan(0);
    });

    it('间隔非法时有退化保护：0 夹到正数（不下除零），NaN 当 1s', () => {
        const zero = makeEnemy();
        applyBurn(zero, 3, 8, 0);
        expect(zero.status!.burnInterval).toBeGreaterThan(0); // 不能是 0，否则 1/0
        expect(zero.status!.burnInterval).toBeCloseTo(0.01, 6);
        const fastTicks = stepStatus(zero, 1).burnTicks;
        expect(fastTicks).toBeGreaterThan(0); // 退化 = 几乎每帧一跳
        expect(Number.isFinite(fastTicks)).toBe(true); // 不是 Infinity / NaN

        const nan = makeEnemy();
        applyBurn(nan, 3, 8, Number.NaN);
        expect(nan.status!.burnInterval).toBe(1);
        expect(stepStatus(nan, 1).burnTicks).toBe(1);
        expect(Number.isFinite(stepStatus(nan, 5).burnTicks)).toBe(true);
    });

    it('到期：计时归 0、残余累计清零，且不再跳伤', () => {
        const e = makeEnemy();
        applyBurn(e, 0.4, 8, 0.5);
        // 只烧了 0.4s（不足一个间隔）就到期 → 一次都不该跳。
        // 这一条钉的是"到期帧只累计真正在烧的那一段"，而不是把整个 dt 都算进去
        expect(stepStatus(e, 0.5).burnTicks).toBe(0);
        expect(e.status!.burnTime).toBe(0);
        expect(e.status!.burnAccum).toBe(0);
        expect(isBurning(e)).toBe(false);

        expect(stepStatus(e, 10).burnTicks).toBe(0); // 到期后彻底安静
    });

    it('到期帧的余量不会被算进累计（大 dt 直接跨过整段灼烧时）', () => {
        const e = makeEnemy();
        applyBurn(e, 0.4, 8, 0.5);
        expect(stepStatus(e, 5).burnTicks).toBe(0); // 0.4s 的灼烧，最多只能跳 0 次
    });

    it('到期后重新中火球：从"立刻跳第一下"开始（累计已清）', () => {
        const e = makeEnemy();
        applyBurn(e, 0.4, 8, 0.5);
        stepStatus(e, 0.5);
        applyBurn(e, 3, 8, 0.5);
        expect(stepStatus(e, 0.5).burnTicks).toBe(1);
    });
});

// ─────────── 冰冻 ───────────

describe('applyFreeze / stepStatus：冻结与解冻', () => {
    it('施加后下一帧 `frozen` 为真（这是全场暂停的输入）', () => {
        const e = makeEnemy();
        expect(e.frozen).toBeFalsy();
        applyFreeze(e, 1.2);
        expect(isFrozen(e)).toBe(true);

        stepStatus(e, DT);
        expect(e.frozen).toBe(true);
    });

    it('到期的那一帧就解冻（同帧就能让世界恢复滚动，不掉帧）', () => {
        const e = makeEnemy();
        applyFreeze(e, 0.02);
        stepStatus(e, 0.02);
        expect(e.status!.freezeTime).toBe(0);
        expect(e.frozen).toBe(false);
        expect(isFrozen(e)).toBe(false);
    });

    it('按帧走满整段冻结：解冻耗时 ≈ 冻结时长（计时器按真实时间走）', () => {
        const e = makeEnemy();
        const duration = 1.2;
        applyFreeze(e, duration);

        let frames = 0;
        while (e.frozen && frames < 60 * 10) {
            stepStatus(e, DT);
            frames++;
        }
        expect(e.frozen).toBe(false);
        expect(frames * DT).toBeCloseTo(duration, 1); // ≈1.2s，不多不少
    });

    it('刷新取 max：冻结中再挨一发更短的冰冻不会提前解冻', () => {
        const e = makeEnemy();
        applyFreeze(e, 2);
        stepStatus(e, 0.5); // 剩 1.5
        applyFreeze(e, 1); // 更短 → 不该缩短
        expect(e.status!.freezeTime).toBeCloseTo(1.5, 6);

        applyFreeze(e, 4); // 更长 → 延长到 4
        expect(e.status!.freezeTime).toBeCloseTo(4, 6);
    });

    it('冻结时长不会走成负数；重复空转保持在 0', () => {
        const e = makeEnemy();
        applyFreeze(e, 0.1);
        stepStatus(e, 5);
        expect(e.status!.freezeTime).toBe(0);
        stepStatus(e, 1e9);
        expect(e.status!.freezeTime).toBe(0);
        expect(Number.isFinite(e.status!.freezeTime)).toBe(true);
    });

    it('非法 / 无效时长不产生状态、也不解冻已有状态', () => {
        const e = makeEnemy();
        applyFreeze(e, Number.NaN);
        applyFreeze(e, 0);
        applyFreeze(e, -3);
        expect(e.status).toBeUndefined(); // 压根没建状态对象

        applyFreeze(e, 2);
        applyFreeze(e, Number.NaN); // 不能把它清掉
        expect(e.status!.freezeTime).toBeCloseTo(2, 6);
    });

    it('灼烧与冰冻互不干扰：可以同时挂着', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        applyFreeze(e, 1.2);

        const ticks = stepStatus(e, 0.5).burnTicks;
        expect(ticks).toBe(1); // 冻着照样烧
        expect(e.frozen).toBe(true);
        expect(isBurning(e)).toBe(true);
        expect(isFrozen(e)).toBe(true);
    });

    it('★ 冻结计时不受"世界暂停"影响（否则会永久卡死）', () => {
        // stepStatus 的签名里根本没有"是否暂停"，这里用"连续帧推进"把结论钉成断言：
        // 就算这 1.2s 里世界一直是停的，计时也照样走完并解冻。
        const e = makeEnemy();
        applyFreeze(e, GameTuning.freezeDuration);
        const frames = Math.ceil(GameTuning.freezeDuration / DT) + 1; // +1 避开浮点边界
        stepFrames(e, frames);
        expect(e.frozen).toBe(false);
    });
});

// ─────────── 边界：死亡 / 无状态 ───────────

describe('边界情况', () => {
    it('已死亡：stepStatus 清掉状态、返回 0 跳、并解除冻结（不再拖住世界）', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        applyFreeze(e, 1.2);
        stepStatus(e, DT);
        expect(e.frozen).toBe(true);

        e.state = EnemyState.Dead;
        const r = stepStatus(e, DT);
        expect(r.burnTicks).toBe(0);
        expect(e.frozen).toBe(false); // ← 这一条修的是"死了但还冻着 ⇒ 世界永久停住"
        expect(e.status!.burnTime).toBe(0);
        expect(e.status!.freezeTime).toBe(0);
        expect(isBurning(e)).toBe(false);
        expect(isFrozen(e)).toBe(false);
    });

    it('clearStatus：状态清零 + 解冻（killEnemy 走的就是这条）', () => {
        const e = makeEnemy();
        applyBurn(e, 3, 8, 0.5);
        applyFreeze(e, 1.2);
        stepStatus(e, DT);

        clearStatus(e);
        expect(e.frozen).toBe(false);
        expect(e.status!.burnTime).toBe(0);
        expect(e.status!.burnDamage).toBe(0);
        expect(e.status!.burnAccum).toBe(0);
        expect(e.status!.freezeTime).toBe(0);
    });

    it('clearStatus 对没中过状态的敌人也安全（不建对象、不炸）', () => {
        const e = makeEnemy();
        expect(() => clearStatus(e)).not.toThrow();
        expect(e.frozen).toBe(false);
    });

    it('没有 status 的敌人（绝大多数）：stepStatus 什么都不做，且不碰 frozen', () => {
        const e = makeEnemy();
        const r = stepStatus(e, DT);
        expect(r.burnTicks).toBe(0);
        expect(e.status).toBeUndefined(); // 不因为路过一帧就建状态对象

        // `frozen` 是"被技能定住"的通用标志：将来别的定身技能直接置它、
        // 而没有 status 对象时，本函数不该替别人解冻
        e.frozen = true;
        stepStatus(e, DT);
        expect(e.frozen).toBe(true);
    });

    it('非法 dt 不推进计时（NaN / 负数都当 0）', () => {
        const e = makeEnemy();
        applyFreeze(e, 1.2);
        applyBurn(e, 3, 8, 0.5);
        stepStatus(e, Number.NaN);
        expect(e.status!.freezeTime).toBeCloseTo(1.2, 6);
        expect(e.status!.burnTime).toBeCloseTo(3, 6);
        stepStatus(e, -100);
        expect(e.status!.freezeTime).toBeCloseTo(1.2, 6);
        expect(e.status!.burnTime).toBeCloseTo(3, 6);
    });
});