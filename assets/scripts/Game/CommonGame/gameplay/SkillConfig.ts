/**
 * 技能数值与定义 —— 升级三选一
 *
 * 和 GameConfig 分工一样：这里只放数值和文案，逻辑在 SkillSystem / Wingman / ChainLightning。
 * 三个技能按 id 与 SkillPanel 的三张卡一一对应（Skill_1 / Skill_2 / Skill_3）。
 */

/** 技能 ID。取值刻意和 AdPanel 的 AdSkillIndex（1|2|3）对齐，两套入口能指向同一个技能 */
export enum SkillId {
    /** 重炮：子弹伤害 +20% / 级 */
    Cannon = 1,
    /** 连锁闪电：命中时劈中最近的若干敌人 */
    ChainLightning = 2,
    /** 僚机：环绕玩家，每 3 秒发射一颗子弹 */
    Wingman = 3,
}

export interface SkillDef {
    id: SkillId;
    /** 卡片标题 */
    name: string;
    /** 一句话说明。第一次出现时的效果，不含等级 */
    desc: string;
    /** 等级上限，Infinity = 可以一直叠 */
    maxLevel: number;
}

/** 重炮：每级子弹伤害 +20%。是从 1 开始乘，不是复利（1+0.2n，不是 1.2^n） */
export const CANNON_DAMAGE_PER_LEVEL = 0.2;

/** 连锁闪电：第 1 级劈 5 个，每级多劈 1 个 */
export const CHAIN_BASE_TARGETS = 5;
export const CHAIN_TARGETS_PER_LEVEL = 1;
/** 连锁闪电：雷击伤害 = 当前子弹伤害 × 这个比例（所以它会跟着重炮一起变强） */
export const CHAIN_DAMAGE_RATIO = 0.5;
/**
 * 连锁闪电的搜索半径（像素）。
 * 一格 80，200 = 2.5 格，足够在密集敌墙里凑够 5 个邻居；半径外的宁可不劈，
 * 免得"连锁"变成全屏点名。
 */
export const CHAIN_RADIUS = 200;

/** 闪电特效：存活时间（秒）、线宽、折线段数、折线抖动幅度 */
export const CHAIN_BOLT_DURATION = 0.15;
export const CHAIN_BOLT_WIDTH = 5;
export const CHAIN_BOLT_SEGMENTS = 5;
export const CHAIN_BOLT_JITTER = 12;

/** 僚机：最多几架 */
export const WINGMAN_MAX = 4;
/**
 * 僚机环绕半径（像素）。
 * 必须明显大于玩家的捕捉半径（40 + 子弹 15 = 55），
 * 否则僚机弹一出生就落在回收圈里，出膛即被吃掉。
 */
export const WINGMAN_ORBIT_RADIUS = 110;
/** 僚机环绕角速度（度/秒） */
export const WINGMAN_ORBIT_SPEED = 80;
/** 僚机显示尺寸（原图 game_player 是 80x80，缩到一半） */
export const WINGMAN_SIZE = 40;
/** 每架僚机的开火间隔（秒），多架之间按相位错峰 */
export const WINGMAN_FIRE_INTERVAL = 3;
/**
 * 每架僚机同时在场的最多子弹数。
 * 僚机弹不占玩家弹匣，没有这个上限的话，"近水平"的漏弹会永远回不来、
 * 无限堆积节点（弹匣弹至少还有 capacity 兜底）。
 */
export const WINGMAN_BULLETS_PER_UNIT = 2;

/** 三张卡的定义，顺序即 Skill_1 / Skill_2 / Skill_3 */
export const SKILL_DEFS: SkillDef[] = [
    {
        id: SkillId.Cannon,
        name: '重炮',
        desc: '子弹伤害 +20%',
        maxLevel: Number.POSITIVE_INFINITY,
    },
    {
        id: SkillId.ChainLightning,
        name: '连锁闪电',
        desc: `相邻 ${CHAIN_BASE_TARGETS} 个敌人被雷电击中`,
        maxLevel: Number.POSITIVE_INFINITY,
    },
    {
        id: SkillId.Wingman,
        name: '僚机',
        desc: `环绕一个僚机，每 ${WINGMAN_FIRE_INTERVAL} 秒发射一颗子弹`,
        maxLevel: WINGMAN_MAX,
    },
];

/** 按 id 取定义 */
export function getSkillDef(id: SkillId): SkillDef {
    return SKILL_DEFS.find(def => def.id === id) ?? SKILL_DEFS[0];
}