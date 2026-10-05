/**
 * 局内成长：属性账本 + 技能池（纯逻辑层，不依赖 cc）
 *
 * 技能与天赋共用一套数据（策划案 §12：天赋也是技能的一种），
 * 差别只在「什么时候抽」：开局抽天赋、升级抽技能。
 *
 * ⚠️ P0 说明：这里的技能池是**可玩性最小集**，每个技能都有真实生效的数值改动；
 * 正式技能表（15 条 + 进化 + 融合）落地后，把 SKILL_POOL 换成读 Skill 配置表即可，
 * 抽取/满级过滤/上锁的逻辑不用改。
 */

import { IRandom, RandomUtil } from './Rng';
import { GameTuning } from './GameTuning';
import { applyExp, expNeed } from './MathModels';

/** 一局内会变的玩家属性（技能的施加对象） */
export interface RunStats {
    hp: number;
    maxHp: number;
    /** 弹匣容量 */
    bulletCount: number;
    /** 开火间隔（s） */
    fireInterval: number;
    bulletDamage: number;
    /** 暴击概率（0~1）：基础值取自 GameTuning，可被天赋/词条提升 */
    critChance: number;
    /** 暴击伤害倍率（≥1）：基础值取自 GameTuning，可被天赋/词条提升 */
    critMul: number;
    bulletSpeed: number;
    /** 回收半径加成 */
    catchRadiusBonus: number;
    /** 磁吸半径加成 */
    magnetRadiusBonus: number;
    /** 经验获取倍率 */
    expMul: number;
    /** 当前等级与经验 */
    level: number;
    exp: number;
}

/** 开局属性（全部来自 GameTuning，便于后续被配置表覆盖） */
export function createRunStats(): RunStats {
    return {
        hp: GameTuning.playerMaxHp,
        maxHp: GameTuning.playerMaxHp,
        bulletCount: GameTuning.bulletCount,
        fireInterval: GameTuning.fireInterval,
        bulletDamage: GameTuning.bulletDamage,
        critChance: GameTuning.critChance,
        critMul: GameTuning.critMul,
        bulletSpeed: GameTuning.bulletSpeed,
        catchRadiusBonus: 0,
        magnetRadiusBonus: 0,
        expMul: 1,
        level: 1,
        exp: 0,
    };
}

/** 技能定义 */
export interface SkillDef {
    id: string;
    name: string;
    desc: string;
    /** 最大等级，达到后不再出现在候选里 */
    maxLevel: number;
    apply(stats: RunStats): void;
}

/** 技能池（P0 最小集） */
export const SKILL_POOL: readonly SkillDef[] = [
    {
        id: 's_magazine',
        name: '弹匣扩容',
        desc: '弹匣 +1',
        maxLevel: 5,
        apply: stats => {
            stats.bulletCount += 1;
        },
    },
    {
        id: 's_power',
        name: '攻击强化',
        desc: '子弹伤害 +3',
        maxLevel: 5,
        apply: stats => {
            stats.bulletDamage += 3;
        },
    },
    {
        id: 's_rapid',
        name: '快速射击',
        desc: '开火间隔 −10%',
        maxLevel: 5,
        apply: stats => {
            stats.fireInterval = Math.max(0.12, stats.fireInterval * 0.9);
        },
    },
    {
        id: 's_velocity',
        name: '弹速提升',
        desc: '子弹速度 +10%',
        maxLevel: 5,
        apply: stats => {
            stats.bulletSpeed *= 1.1;
        },
    },
    {
        id: 's_catch',
        name: '磁力回收',
        desc: '回收半径 +6',
        maxLevel: 3,
        apply: stats => {
            stats.catchRadiusBonus += 6;
        },
    },
    {
        id: 's_magnet',
        name: '拾取范围',
        desc: '经验磁吸半径 +40',
        maxLevel: 3,
        apply: stats => {
            stats.magnetRadiusBonus += 40;
        },
    },
    {
        id: 's_vitality',
        name: '生命强化',
        desc: '生命上限 +20 并回复 20',
        maxLevel: 5,
        apply: stats => {
            stats.maxHp += 20;
            stats.hp = Math.min(stats.maxHp, stats.hp + 20);
        },
    },
    {
        id: 's_crit_rate',
        name: '暴击率提升',
        desc: '暴击率 +8%',
        maxLevel: 5,
        apply: stats => {
            // 上限保护：概率不超过 1；累加，与 s_greed 同类写法
            stats.critChance = Math.min(1, stats.critChance + 0.08);
        },
    },
    {
        id: 's_crit_damage',
        name: '暴击伤害提升',
        desc: '暴击伤害 +30%',
        maxLevel: 5,
        apply: stats => {
            // 上限保护：倍率不超过 4；累加（装满 5 级为 1.6 + 1.5 = 3.1）
            stats.critMul = Math.min(4, stats.critMul + 0.3);
        },
    },
    {
        id: 's_greed',
        name: '贪婪',
        desc: '经验获取 +20%',
        maxLevel: 3,
        apply: stats => {
            stats.expMul += 0.2;
        },
    },
];

/**
 * 抽取候选技能：已满级的不出现
 * @param levels 技能 id → 已学等级
 */
export function pickSkillChoices(
    rng: IRandom,
    levels: Map<string, number>,
    count: number = GameTuning.choiceCount,
    pool: readonly SkillDef[] = SKILL_POOL
): SkillDef[] {
    const available = pool.filter(skill => (levels.get(skill.id) ?? 0) < skill.maxLevel);
    return RandomUtil.sample(rng, available, count);
}

/**
 * 记录一次技能被选中（返回新等级）
 *
 * 等级会被夹到技能池里的 maxLevel：正常流程下 pickSkillChoices 不会给出满级技能，
 * 但外部（存档、调试、未来的融合系统）绕过抽取直接调用时必须保证上限不被突破，
 * 否则 skillLevelText 会显示出 8/5 这种脏数据。
 */
export function markSkillLearned(levels: Map<string, number>, skillId: string): number {
    const def = SKILL_POOL.find(skill => skill.id === skillId);
    const cap = def ? def.maxLevel : Number.MAX_SAFE_INTEGER;
    const next = Math.min(cap, (levels.get(skillId) ?? 0) + 1);
    levels.set(skillId, next);
    return next;
}

/** 技能当前等级文案（1/3 表示 1 级、上限 3 级） */
export function skillLevelText(levels: Map<string, number>, skill: SkillDef): string {
    const current = levels.get(skill.id) ?? 0;
    if (current <= 0) return '新技能';
    return `升级 ${current}/${skill.maxLevel}`;
}

/**
 * 结算经验并升级
 * @returns 本次升了几级（0 = 没升级）
 */
export function grantExp(stats: RunStats, gained: number): number {
    const result = applyExp(stats.level, stats.exp, gained * stats.expMul);
    stats.level = result.level;
    stats.exp = result.exp;
    return result.levels;
}

/** 距离下一级还差多少经验 */
export function expToNextLevel(stats: RunStats): number {
    return expNeed(stats.level);
}

/** 受伤（返回是否死亡） */
export function damagePlayer(stats: RunStats, damage: number): boolean {
    stats.hp = Math.max(0, stats.hp - Math.max(0, damage));
    return stats.hp <= 0;
}

/** 调试用：一行打印本局生效数值（策划案 §16.3 要求关键值可打印） */
export function describeStats(stats: RunStats): string {
    return [
        `Lv${stats.level}`,
        `HP ${Math.ceil(stats.hp)}/${stats.maxHp}`,
        `弹匣 ${stats.bulletCount}`,
        `伤害 ${stats.bulletDamage}`,
        `暴击 ${Math.round(stats.critChance * 100)}%/${stats.critMul.toFixed(2)}×`,
        `间隔 ${stats.fireInterval.toFixed(3)}s`,
        `弹速 ${Math.round(stats.bulletSpeed)}`,
        `回收+${stats.catchRadiusBonus}`,
        `磁吸+${stats.magnetRadiusBonus}`,
        `经验×${stats.expMul.toFixed(2)}`,
    ].join(' | ');
}/** 面板 HUD 数值快照（纯函数，口径与 BattleView.updateHud() 的世界内 HUD 逐字一致） */
export interface HudSnapshot {
    /** `关卡 1　波次 3/5` */
    levelText: string;
    /** 经验条比例，已钳到 [0,1] */
    expRatio: number;
    /** 血条比例，已钳到 [0,1] */
    hpRatio: number;
    /** `弹匣 3/6` */
    magazineText: string;
}
/** 进度比例：永远返回 [0,1] 内的有限数；max<=0、负值、NaN、Infinity 一律 0 */
export function barRatio(value: number, max: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
    const r = value / max;
    if (!Number.isFinite(r)) return 0;
    return Math.min(1, Math.max(0, r));
}
/** 弹匣里还剩几发（下限 0） */
export function magazineFree(stats: RunStats, magazineOut: number): number {
    const out = Number.isFinite(magazineOut) ? magazineOut : 0;
    return Math.max(0, Math.floor(stats.bulletCount - out));
}
/** 组装面板 HUD 快照；文案与 BattleView.updateHud() 逐字一致 */
export function buildHudSnapshot(level: number, wave: number, stats: RunStats, magazineOut: number): HudSnapshot {
    const lv = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
    const wv = Number.isFinite(wave) ? Math.max(1, Math.floor(wave)) : 1;
    const per = Math.max(1, GameTuning.wavesPerLevel);
    const need = expToNextLevel(stats);
    return {
        levelText: '关卡 ' + lv + '　波次 ' + wv + '/' + per,
        expRatio: barRatio(stats.exp, need),
        hpRatio: barRatio(stats.hp, stats.maxHp),
        magazineText: '弹匣 ' + magazineFree(stats, magazineOut) + '/' + stats.bulletCount,
    };
}
