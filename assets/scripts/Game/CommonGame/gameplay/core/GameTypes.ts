/**
 * 玩法基础类型 — 纯逻辑层，**不依赖 cc**
 *
 * 枚举值与配置表（tools/excel-config/*.xlsx）保持一致，
 * 将来接 FlatBuffers 配置时不需要改这里的定义。
 */

/** 品质：白 / 绿 / 蓝 / 紫 / 金 / 红（需求 2） */
export enum Quality {
    White = 0,
    Green = 1,
    Blue = 2,
    Purple = 3,
    Gold = 4,
    Red = 5,
}

/** 敌人类型：普通 / 精英 / 小BOSS / 大BOSS（需求 2） */
export enum EnemyType {
    Normal = 0,
    Elite = 1,
    MiniBoss = 2,
    Boss = 3,
}

/** 体型（索引与配置表 shape 列一致，共 6 种） */
export enum EnemyShape {
    /** 1 格 128×128 */
    Single = 0,
    /** 2 格横 256×128 */
    DoubleH = 1,
    /** 2 格竖 128×256 */
    DoubleV = 2,
    /** 4 格 256×256（BOSS） */
    Quad = 3,
    /** 6 格 384×256（BOSS） */
    Six = 4,
    /** 8 格 512×256（BOSS） */
    Eight = 5,
}

/** 攻击手段（需求 2：射箭 / 发射子弹 / 激光 / 直线冲击） */
export enum AttackKind {
    None = 0,
    Arrow = 1,
    Shoot = 2,
    Laser = 3,
    Charge = 4,
}

/** 掉落物类型（需求 4） */
export enum DropKind {
    /** 经验水晶 */
    Exp = 0,
    /** 金币（刷新 / 购买技能） */
    Coin = 1,
    /** 魂晶（外围养成） */
    Soul = 2,
    /** 超级水晶（升级 / 进化 / 融合） */
    SuperCrystal = 3,
}

/** 敌人生成 → 下落 → 预警 → 俯冲 的状态机 */
export enum EnemyState {
    /** 出生缩放动画中，还不参与碰撞 */
    Spawning = 'spawning',
    /** 随波次缓慢下落 */
    Falling = 'falling',
    /** 越过俯冲线后的 1 s 判定等待（此时可被击杀） */
    Telegraph = 'telegraph',
    /** 放大后快速飞向玩家 */
    Diving = 'diving',
    /** 已死亡，等待回收 */
    Dead = 'dead',
}

/** 子弹状态（§6.3） */
export enum BulletState {
    /** 飞行 + 弹射 */
    Flying = 'flying',
    /** 回身：锁定玩家直飞、穿透敌人不结算伤害 */
    Returning = 'returning',
}

/** 二维向量 */
export interface Vec2 {
    x: number;
    y: number;
}

/** 轴对齐矩形（中心点 + 半宽半高），敌人与命中判定都用它 */
export interface Box {
    x: number;
    y: number;
    halfW: number;
    halfH: number;
}

/** 子弹运行时数据 */
export interface BulletRuntime {
    /** 池内实例 id，用于回收与去重 */
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    state: BulletState;
    /** 是否已离开玩家捕捉圈（未离开不允许被回收） */
    armed: boolean;
    /** 已存活时间，超过 maxBulletLife 强制回身 */
    life: number;
    /** 本次接触窗口内已命中的敌人，防止一次穿过扣多次血 */
    hitSet: Set<number>;
    /** 是否占用玩家弹匣（false = 僚机/分裂弹等免费弹） */
    fromMagazine: boolean;
}

/** 敌人运行时数据 */
export interface EnemyRuntime {
    /** 池内实例 id，同时是子弹去重键 */
    id: number;
    /** 配置表敌人 id（例如 e_slime_white） */
    defId: string;
    quality: Quality;
    type: EnemyType;
    shape: EnemyShape;
    /** 占格（列数 × 行数） */
    cols: number;
    rows: number;
    /** 中心点世界坐标 */
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    /** 下落速度 px/s（已含波次成长） */
    speed: number;
    state: EnemyState;
    /** 当前状态已持续时间 */
    stateTime: number;
    /** 俯冲目标（锁定玩家当前位置） */
    diveTargetX: number;
    diveTargetY: number;
}

/** 掉落物运行时数据 */
export interface DropRuntime {
    id: number;
    kind: DropKind;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** 价值：经验值 / 金币数 / 魂晶数 / 超级水晶个数 */
    value: number;
    /** 剩余存活时间 */
    life: number;
    /** 是否已被玩家吸附（吸附后不再减速） */
    magnetized: boolean;
}

/** 体型 → 占格。与策划案 §7.4 一致：4/6/8 格按 2×2、3×2、4×2 排布 */
export const SHAPE_SPAN: ReadonlyArray<Readonly<{ cols: number; rows: number }>> = [
    { cols: 1, rows: 1 },
    { cols: 2, rows: 1 },
    { cols: 1, rows: 2 },
    { cols: 2, rows: 2 },
    { cols: 3, rows: 2 },
    { cols: 4, rows: 2 },
];

/** 敌人占几格（= 列数 × 行数），用于俯冲伤害与血量基数计算 */
export function shapeCellCount(shape: EnemyShape): number {
    const span = SHAPE_SPAN[shape] || SHAPE_SPAN[0];
    return span.cols * span.rows;
}