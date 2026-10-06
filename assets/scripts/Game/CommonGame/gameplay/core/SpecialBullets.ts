/**
 * 特殊子弹：数值派生 + 「一发一世界」的 CD 状态机（纯逻辑层，不依赖 cc）
 *
 * 三种技能（闪电 / 火球 / 冰冻）共用**同一个形态**：学会即获得一枚专属子弹，
 * 不占弹匣、不占免费弹上限，按自己的 CD 循环。需求原文：
 *
 *   「闪电子弹有自己的 CD，每次发射出去后就开始记录 CD 时间，当回收后如果 CD 时间未到，
 *     则等 CD 到了之后再发射，如果回收时 CD 已到则可以立刻发射出去」
 *
 * 这句话逐字对应下面四个函数（`stepSpecial` / `readyToFire` / `markFired` / `markCaught`）：
 *   · `markFired`   → 发射瞬间 `cooldown = CD`、`inFlight = true`（开始记录 CD）；
 *   · `stepSpecial` → CD **一直**递减（**不因 inFlight 而暂停**，否则"回收时 CD 已到"这一半永远不成立）；
 *   · `markCaught`  → 只把 `inFlight` 置回 false，CD 照走（所以回收后可能还要在手里等一会）；
 *   · `readyToFire` → `level > 0 && !inFlight && cooldown <= 0`，三者同时成立才放。
 *
 * ⚠️ CD 必须**长于一次典型往返**（见 GameTuning 里的各项注释），否则每次回收 CD 都已走完，
 * 「等 CD」这一层就形同虚设、子弹退化成"一直连发"。
 *
 * 这里只算数值与状态流转：子弹怎么飞（BulletSim）、命中怎么结算（BattleView）、
 * 特效怎么画（ChainLightningFx / EnemyStatusFx）都不在本文件。
 */

import { BulletKind } from './GameTypes';
import { GameTuning } from './GameTuning';

/** 等级 → 数值时的公共夹取：非法值当 1 级、上限 = specialBulletMaxLevel */
function clampLevel(level: number): number {
    const raw = Number.isFinite(level) ? Math.floor(level) : 1;
    return Math.min(Math.max(1, raw), GameTuning.specialBulletMaxLevel);
}

/** 每级 ×decay 的间隔衰减，带下限（防止高等级贴到 0 变成无限连发） */
function decayedCooldown(base: number, decay: number, min: number, lv: number): number {
    return Math.max(min, base * Math.pow(decay, lv - 1));
}

// ─────────── 数值派生：等级 → 本次发射 / 命中的数值 ───────────

/**
 * 三种 spec 共有的部分 —— 也就是「发射这一下」要用的全部信息：
 * 打谁、按什么 CD 循环、子弹多快、本体伤害多少。
 * 各自特有的结算（连锁 / 灼烧 / 冻结）留在各自的 spec 类型里。
 */
export interface SpecialSpecBase {
    level: number;
    /** 子弹本体伤害（命中那个敌人直接吃这一下） */
    bulletDamage: number;
    /** 发射间隔（s） */
    cooldown: number;
    /** 速度倍率（基准 = 玩家 bulletSpeed；出膛与回程都吃它） */
    speedMul: number;
}

/** 闪电弹一次命中的完整数值 */
export interface LightningSpec extends SpecialSpecBase {
    /** 连锁目标数（**含**锚点） */
    chainTargets: number;
    /** 单跳连锁伤害（锚点不重复吃这一下） */
    chainDamage: number;
}

/**
 * 闪电：等级 → 数值。
 *
 * 成长轴有三条：连锁目标数（3 → 满级 7，需求「目标数初始 3 个，升级后增加」）、
 * 本体与连锁伤害线性增长、间隔逐级缩短（有下限）。
 */
export function lightningSpec(level: number): LightningSpec {
    const lv = clampLevel(level);
    return {
        level: lv,
        bulletDamage: GameTuning.lightningBulletDamage + (lv - 1) * GameTuning.lightningBulletDamagePerLevel,
        cooldown: decayedCooldown(
            GameTuning.lightningBulletCd,
            GameTuning.lightningBulletCdDecay,
            GameTuning.lightningBulletMinCd,
            lv
        ),
        speedMul: GameTuning.lightningBulletSpeedMul,
        chainTargets: Math.max(
            1,
            Math.floor(GameTuning.lightningChainTargets + (lv - 1) * GameTuning.lightningChainTargetsPerLevel)
        ),
        chainDamage: GameTuning.lightningChainDamage + (lv - 1) * GameTuning.lightningChainDamagePerLevel,
    };
}

/** 火球一次命中的完整数值 */
export interface FireballSpec extends SpecialSpecBase {
    /** 灼烧持续（s） */
    burnDuration: number;
    /** 每次跳伤（不含暴击） */
    burnDamage: number;
    /** 跳伤间隔（s） */
    burnInterval: number;
}

/** 火球：等级 → 数值（本体伤害 + 灼烧时长 + 跳伤一起长） */
export function fireballSpec(level: number): FireballSpec {
    const lv = clampLevel(level);
    return {
        level: lv,
        bulletDamage: GameTuning.fireBulletDamage + (lv - 1) * GameTuning.fireBulletDamagePerLevel,
        cooldown: decayedCooldown(
            GameTuning.fireBulletCd,
            GameTuning.fireBulletCdDecay,
            GameTuning.fireBulletMinCd,
            lv
        ),
        speedMul: GameTuning.fireBulletSpeedMul,
        burnDuration: GameTuning.burnDuration + (lv - 1) * GameTuning.burnDurationPerLevel,
        burnDamage: GameTuning.burnDamage + (lv - 1) * GameTuning.burnDamagePerLevel,
        burnInterval: GameTuning.burnInterval,
    };
}

/** 冰冻一次命中的完整数值 */
export interface IceSpec extends SpecialSpecBase {
    /** 冻结持续（s）= 全场时停的时长 */
    freezeDuration: number;
}

/** 冰冻：等级 → 数值 */
export function iceSpec(level: number): IceSpec {
    const lv = clampLevel(level);
    return {
        level: lv,
        bulletDamage: GameTuning.iceBulletDamage + (lv - 1) * GameTuning.iceBulletDamagePerLevel,
        cooldown: decayedCooldown(GameTuning.iceBulletCd, GameTuning.iceBulletCdDecay, GameTuning.iceBulletMinCd, lv),
        speedMul: GameTuning.iceBulletSpeedMul,
        freezeDuration: GameTuning.freezeDuration + (lv - 1) * GameTuning.freezeDurationPerLevel,
    };
}

/**
 * 按种类取 spec（只给三种特殊弹用）。
 *
 * 只需要「共有那几项」（CD / 速度倍率 / 本体伤害）的地方走这个入口，
 * 需要各自特有结算（连锁目标数 / 灼烧 / 冻结）的地方**按 kind 分支再取具体类型**，
 * 这样类型收窄交给编译器，不用在调用点做断言。
 * `Magazine` 不走这条线（编不出合理 spec），按闪电兜底 —— 真调到了也不会炸。
 */
export function specialSpec(kind: BulletKind, level: number): SpecialSpecBase {
    switch (kind) {
        case BulletKind.Fire:
            return fireballSpec(level);
        case BulletKind.Ice:
            return iceSpec(level);
        case BulletKind.Lightning:
        default:
            return lightningSpec(level);
    }
}

/** 三种 spec 的并集：view 层做 kind 分支时的类型 */
export type SpecialSpec = LightningSpec | FireballSpec | IceSpec;

// ─────────── 「一发一世界」CD 状态机 ───────────

/**
 * 一种特殊子弹的运行时状态。
 *
 * **一种子弹同时只存在一发** —— 所以状态里不需要"在飞的子弹 id"，
 * 一个 `inFlight` 布尔就够；CD 与"手里有没有弹"是两件独立的事：
 * 子弹在飞时 CD 照走，于是"回收时 CD 已到 → 立刻再射"才成立。
 */
export interface SpecialBulletState {
    /** 当前技能等级（0 = 未学）。由 view 每帧从 RunStats 同步，见 setSpecialLevel */
    level: number;
    /** 剩余 CD（s），0 = 已就绪 */
    cooldown: number;
    /** 是否正有一发在场上（含回身途中；**只有被回收才置回 false**） */
    inFlight: boolean;
}

/** 未学技能的初始状态（level 0 → readyToFire 恒为 false） */
export function createSpecialState(): SpecialBulletState {
    return { level: 0, cooldown: 0, inFlight: false };
}

/** 把技能等级同步进来（升级当场生效：下一帧的 readyToFire 就能放） */
export function setSpecialLevel(state: SpecialBulletState, level: number): void {
    state.level = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

/**
 * 推进 CD。
 *
 * ⚠️ **不看 `inFlight`**：CD 从发射那一刻起就一直走。如果子弹在飞时把 CD 冻结，
 * 那么"CD 在飞行途中已经走完 → 回收即可再射"就永远发生不了，需求的后半句会失效。
 */
export function stepSpecial(state: SpecialBulletState, dt: number): void {
    const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    state.cooldown = Math.max(0, state.cooldown - d);
}

/** 是否该发射：学会了 + 手上没有在飞的 + CD 已走完 */
export function readyToFire(state: SpecialBulletState): boolean {
    return state.level > 0 && !state.inFlight && state.cooldown <= 0;
}

/** 发射：开始记录 CD，并标记"场上有我一发" */
export function markFired(state: SpecialBulletState, cooldown: number): void {
    state.cooldown = Number.isFinite(cooldown) ? Math.max(0, cooldown) : 0;
    state.inFlight = true;
}

/**
 * 回收：只是"回到手里"，**CD 不重置也不暂停** ——
 * CD 还有剩余就在手里等，已经走完则下一次 readyToFire 立刻为真。
 * 幂等：重复调用（模拟器回调 + 移除兜底各一次）不会产生副作用。
 */
export function markCaught(state: SpecialBulletState): void {
    state.inFlight = false;
}