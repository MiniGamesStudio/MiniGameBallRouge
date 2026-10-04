/**
 * 玩法数值真源（P0 阶段）
 *
 * 全部玩法数值只在这里定义，不要在 prefab 上挂 @property。
 * 历史坑：GamePanel 曾在 prefab 里存了另一套数值并静默覆盖代码默认值，
 * 导致改 .ts 不生效、code review 也看不出差异（策划案 §14.0）。
 *
 * 这里同时是「接入配置表」的预留插槽：将来 ConfigManager 能读 Tuning.bin 之后，
 * 由 applyTuningValues() 用表里的值覆盖本文件默认值即可，玩法代码不用改。
 * 每一项都对应配置表里的一个键（键名见策划案 §16.2 / 附录 A.10）。
 */

export const GameTuning = {
    // ─────────── 场地与度量（§5） ───────────
    /** 设计分辨率宽 */
    designWidth: 750,
    /** 设计分辨率高 */
    designHeight: 1334,
    /**
     * 格边长（px）。128×128 与品质底图素材（white/green/blue/purple/yellow/red）一比一。
     * ⚠️ 从 80 改成 128 时，所有「px 绝对值」类数值按 1.6 等比缩放以保持手感，
     * 以「格」或「秒」为单位的数值不动（rowGapCells / spawnStagger 等）。
     */
    cellSize: 128,
    /** 棋盘列数 */
    columns: 5,
    /** 棋盘底边 y */
    boardBottom: -667,
    /** 棋盘顶边 y */
    boardTop: 667,
    /** 敌人出生线 y（屏幕上方一格） */
    /**
     * 出生线。注意它是出生带的**顶边**，不是敌人中心：
     * 单格敌人的盒子 = [spawnLineY - cellSize, spawnLineY] = [667, 795]，
     * 正好整个在可视区上边界（+667）之外，下落后才进入画面。
     */
    spawnLineY: 795,
    /** 俯冲线 / 底线 y：敌人自身矩形底边越过它即进入判定 */
    diveLineY: -507,
    /** 玩家出生点距屏幕底部的高度 */
    playerSpawnBottomOffset: 192,

    // ─────────── 玩家（§8.6 / 附录 A.1） ───────────
    /** 玩家血量（占位默认值，正式值走 Player 表） */
    playerMaxHp: 100,
    /** 玩家受击判定半径：故意小于视觉半径（128/2=64），手感更好 */
    playerHitRadius: 45,

    // ─────────── 子弹（§6.6） ───────────
    /** 弹匣容量 */
    bulletCount: 5,
    /** 开火间隔（s） */
    fireInterval: 0.35,
    /** 子弹速度 px/s */
    bulletSpeed: 1440,
    /** 子弹伤害 */
    bulletDamage: 10,
    /** 子弹半径 px */
    bulletRadius: 16,
    /** 回收半径 = 判定半径 + 子弹半径 */
    catchRadius: 61,
    /** 最长存活（s）：超时强制回身，兜底防死锁 */
    maxBulletLife: 8,
    /** 回身速度倍率 */
    returnSpeedScale: 1.0,
    /** 免费弹（僚机 / 分裂弹）全局上限 */
    freeBulletMax: 8,
    /** 单帧子步最大位移（防穿模） */
    maxSubStepDistance: 13,
    /** 单帧子步上限 */
    maxSubStepCount: 16,

    // ─────────── 敌人（§7） ───────────
    /** 每格基础血量，按品质 白/绿/蓝/紫/金/红 */
    qualityHpPerCell: [12, 20, 35, 55, 90, 150],
    /** 类型血量倍率：普通 / 精英 / 小BOSS / 大BOSS */
    typeHpMul: [1, 2.5, 6, 15],
    /** 类型经验倍率 */
    typeExpMul: [1, 3, 8, 20],
    /** 品质经验：掉落经验水晶的经验值 */
    qualityExp: [1, 2, 4, 8, 16, 32],
    /** 品质金币 */
    qualityCoin: [1, 2, 3, 6, 12, 25],
    /** 类型魂晶（精英 / 小BOSS / 大BOSS 掉落） */
    typeSoul: [0, 1, 3, 10],
    /** 类型掉落超级水晶的概率 */
    superCrystalChance: [0, 0.15, 1, 1],
    /** 类型掉落超级水晶的个数 */
    superCrystalCount: [0, 1, 1, 2],
    /** 关卡行模板里单个敌人最多占的行数（大怪优先装箱的前提） */
    maxEnemyRowSpan: 4,

    // ─────────── 关卡生成与下落（§9） ───────────
    /** 每关波数（占位默认值，正式值走 Wave 表） */
    wavesPerLevel: 8,
    /** 第 1 波行数 */
    baseRowsPerWave: 3,
    /** 每波行数增量 */
    rowsPerWaveGrowth: 1,
    /** 同时在场的行数上限 */
    maxRows: 30,
    /** 同一行内相邻敌人的出生间隔（s） */
    spawnStagger: 0.08,
    /** 相邻两行的纵向间距（格）——行间隔时间 = 该值 × cellSize ÷ 当前波下落速度（见 buildSpawnSchedule） */
    rowGapCells: 1.2,
    /** 带内依次弹出允许占用的时间预算（占一个行间隔的比例），避免弹出顺序挤占下一带的位置 */
    spawnStaggerBudget: 0.5,
    /** 出生缩放动画：起始缩放 */
    spawnScaleFrom: 0.6,
    /** 出生缩放动画：时长（s） */
    spawnScaleTime: 0.25,
    /** 第 1 波下落速度 px/s */
    baseFallSpeed: 40,
    /** 每波下落速度成长 */
    fallSpeedGrowth: 0.08,
    /** 下落速度成长上限倍率 */
    fallSpeedCapMul: 2.5,
    /** 每波血量成长 */
    hpGrowth: 0.12,
    /** 血量成长上限倍率 */
    hpCapMul: 2.5,

    // ─────────── 俯冲（§9.4） ───────────
    /** 越线后的判定等待时间（s），此期间可被击杀 */
    diveTelegraph: 1.0,
    /** 俯冲速度 px/s */
    diveSpeed: 1120,
    /** 每格俯冲伤害 */
    diveDamagePerCell: 5,
    /** 单次俯冲伤害上限 */
    diveDamageMax: 40,
    /** 俯冲命中玩家的判定半径 */
    diveHitRadius: 72,
    /** 俯冲前放大到的倍数 */
    diveScaleUp: 1.35,
    /** 放大时长（s） */
    diveScaleUpTime: 0.4,
    /** 飞行途中缩小到的倍数 */
    diveScaleDown: 0.5,

    // ─────────── 掉落与成长（§11） ───────────
    /** 掉落物散落半径（0.2 格 = 25.6 px） */
    dropScatterRadius: 26,
    /** 磁吸半径（1.5 格 = 192 px），可被技能/加点提升 */
    magnetRadius: 192,
    /** 拾取半径 */
    pickupRadius: 38,
    /** 磁吸飞行速度 px/s */
    magnetSpeed: 1120,
    /** 掉落物存活时间（s），超时消失 */
    dropLifeTime: 15,
    /** 升级所需经验：need(n) = 8 + 6(n-1) + 1.5(n-1)^2 */
    expNeedBase: 8,
    expNeedLinear: 6,
    expNeedQuadratic: 1.5,
    /** 升级 / 开局天赋的候选数量 */
    choiceCount: 3,

    // ─────────── 美术适配 ───────────
    /**
     * 怪物 / 玩家图在占格内的占比（contain 适配的留白系数）。
     * 美术原始宽度是 80，而占格是 128 的整数倍：直接按占格缩放会拉变形，
     * 所以按美术自身长宽比算一个统一缩放，再乘这个系数留一点边。
     */
    artFitMargin: 0.92,

    // ─────────── 打击反馈（受击闪白 / 敌人震动） ───────────
    /** 受击闪白持续时间（s） */
    hitFlashTime: 0.12,
    /** 受击闪白起始不透明度（0~255） */
    hitFlashAlpha: 210,
    /** 敌人受击震动持续时间（s） */
    hitShakeTime: 0.16,
    /** 敌人受击震动幅度（px，左右上下随机抖动，随时间衰减） */
    hitShakeAmplitude: 5,
};

/** 数值键名类型，便于后续用配置表覆盖 */
export type GameTuningKey = keyof typeof GameTuning;

/**
 * 用配置表数值覆盖默认值（接入 FlatBuffers 配置后调用）
 * @param values 键 -> 值
 * @returns 实际被覆盖的键数量
 */
export function applyTuningValues(values: Record<string, number>): number {
    let applied = 0;
    Object.keys(values || {}).forEach(key => {
        const current = (GameTuning as Record<string, unknown>)[key];
        const next = values[key];
        if (typeof current === 'number' && Number.isFinite(next)) {
            (GameTuning as Record<string, unknown>)[key] = next;
            applied++;
        }
    });
    return applied;
}