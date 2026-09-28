/**
 * 玩法数值与类型定义 — 弹球 Roguelike Demo
 *
 * 所有可调数值集中在这里；GamePanel 上的 @property 字段会覆盖 DefaultTuning。
 * 改数值优先改这里，不要散落到逻辑里。
 */

/** 敌人颜色，血量依次递增：green < blue < red */
export enum EnemyColor {
    Green = 0,
    Blue = 1,
    Red = 2,
}

/** 敌人形状：单格 / 横版双格 / 竖版双格（图片旋转 90°） */
export enum EnemyShape {
    Single = 0,
    DoubleH = 1,
    DoubleV = 2,
}

/** 每行格子数 */
export const GRID_COL_COUNT = 5;
/**
 * 格子边长。敌人图片就是按 80 像素一格画的（single 80x80、double 160x80），
 * 所以格子直接取素材原始尺寸，精灵一律按原图大小显示、不做任何缩放。
 * 5 格 = 400 像素，居中在设计宽度 750 里（棋盘左右各留 175）。
 */
export const CELL_SIZE = 80;
/** 设计分辨率，与 GamePanel.m_DesignWidth / m_DesignHeight 保持一致 */
export const DESIGN_WIDTH = 750;
export const DESIGN_HEIGHT = 1334;
/** 敌人底边越过这条线（距屏幕底部的距离）后转为俯冲玩家 */
export const BOTTOM_LINE_OFFSET = 100;
/** 玩家出生点距屏幕底部的距离 */
export const PLAYER_SPAWN_OFFSET = 120;
/** 玩家图片原始尺寸 80x80，直接按原图显示 */
export const PLAYER_SIZE = 80;
/** 敌人图片的圆角半径（8 张敌人图都是同一套圆角），受击闪白用 */
export const ENEMY_CORNER_RADIUS = 13;
/** 玩家图片是一个内切圆，半径 = 边长的一半，受击闪白用 */
export const PLAYER_RADIUS = PLAYER_SIZE * 0.5;
/** 墙上最多堆积的行数，超出后新行排队等待，避免离屏敌人无限累积 */
export const MAX_WALL_ROWS = 20;

/**
 * 颜色 -> 图片名。
 * 注意：绿色 double 的原图文件名拼写为 game_double_geen，这里按实际资源名引用。
 */
const AssetNameByColor: Record<EnemyColor, { single: string; double: string }> = {
    [EnemyColor.Green]: { single: 'game_single_green', double: 'game_double_geen' },
    [EnemyColor.Blue]: { single: 'game_single_blue', double: 'game_double_blue' },
    [EnemyColor.Red]: { single: 'game_single_red', double: 'game_double_red' },
};

export const PLAYER_ASSET = 'game_player';
export const BULLET_ASSET = 'game_bullet';

/** 敌人颜色 -> 图片名 */
export function getEnemyAssetName(color: EnemyColor, shape: EnemyShape): string {
    const names = AssetNameByColor[color];
    return shape === EnemyShape.Single ? names.single : names.double;
}

/** 图片名 -> game bundle 内的 SpriteFrame 路径（Cocos 导入的图片子资源需要 /spriteFrame 后缀） */
export function toSpriteFramePath(assetName: string): string {
    return `texture/${assetName}/spriteFrame`;
}

/** 需要预加载的全部图片名 */
export const ALL_GAMEPLAY_ASSETS: string[] = [
    PLAYER_ASSET,
    BULLET_ASSET,
    ...Object.keys(AssetNameByColor).reduce<string[]>((names, key) => {
        const entry = AssetNameByColor[key as unknown as EnemyColor];
        return names.concat(entry.single, entry.double);
    }, []),
];

/** 单格敌人血量 */
export const SingleHpByColor: Record<EnemyColor, number> = {
    [EnemyColor.Green]: 10,
    [EnemyColor.Blue]: 20,
    [EnemyColor.Red]: 40,
};

/** double 敌人的【每格】血量，均高于同色 single；总量为每格的两倍 */
export const DoubleHpPerCellByColor: Record<EnemyColor, number> = {
    [EnemyColor.Green]: 15,
    [EnemyColor.Blue]: 30,
    [EnemyColor.Red]: 60,
};

/** 敌人总血量：single 占一格，double 占两格 */
export function getEnemyMaxHp(color: EnemyColor, shape: EnemyShape): number {
    if (shape === EnemyShape.Single) return SingleHpByColor[color];
    return DoubleHpPerCellByColor[color] * 2;
}

/** 敌人占用的格子数：横版 double 占 2 列，竖版 double 占 2 行 */
export function getCellSpan(shape: EnemyShape): { colSpan: number; rowSpan: number } {
    if (shape === EnemyShape.DoubleH) return { colSpan: 2, rowSpan: 1 };
    if (shape === EnemyShape.DoubleV) return { colSpan: 1, rowSpan: 2 };
    return { colSpan: 1, rowSpan: 1 };
}

/** 颜色随机权重：绿最常见，红最稀有 */
export const ColorWeights: Record<EnemyColor, number> = {
    [EnemyColor.Green]: 6,
    [EnemyColor.Blue]: 3,
    [EnemyColor.Red]: 1,
};

/** 形状随机权重：单格最常见 */
export const ShapeWeights: Record<EnemyShape, number> = {
    [EnemyShape.Single]: 6,
    [EnemyShape.DoubleH]: 3,
    [EnemyShape.DoubleV]: 3,
};

/**
 * 玩法可调数值。GamePanel 会把编辑器里配好的值组装成这个结构传给 BattleWorld。
 */
export interface GameTuning {
    /** 每隔多少秒生成一波敌人（5~10 行） */
    waveInterval: number;
    /** 单波最少行数 */
    waveRowMin: number;
    /** 单波最多行数 */
    waveRowMax: number;
    /** 波内每行的入场间隔（秒） */
    rowSpawnInterval: number;
    /** 敌人墙下移速度（像素/秒） */
    enemyFallSpeed: number;
    /** 子弹速度（像素/秒） */
    bulletSpeed: number;
    /** 子弹伤害 */
    bulletDamage: number;
    /** 子弹发射间隔（秒），越小射速越快 */
    fireInterval: number;
    /**
     * 同时在场的子弹总数。子弹是循环使用的：撞敌人和撞屏幕四周都只反弹不消失，
     * 只有飞回玩家身上才回收，所以这个数就是玩家的"弹药上限"。
     */
    bulletCount: number;
    /** 敌人俯冲玩家的速度（像素/秒） */
    diveSpeed: number;
    /** 俯冲命中玩家扣的血量 */
    diveDamage: number;
    /** 俯冲命中判定半径 */
    diveHitRadius: number;
    /** 敌人主动攻击玩家的触发距离 */
    enemyAttackRange: number;
    /** 敌人攻击间隔（秒） */
    enemyAttackInterval: number;
    /** 敌人每次攻击扣的血量 */
    enemyAttackDamage: number;
    /** 玩家最大血量 */
    playerMaxHp: number;
}

export const DefaultTuning: GameTuning = {
    waveInterval: 30,
    waveRowMin: 5,
    waveRowMax: 10,
    rowSpawnInterval: 0.5,
    enemyFallSpeed: 27,
    bulletSpeed: 900,
    bulletDamage: 10,
    fireInterval: 0.35,
    bulletCount: 8,
    diveSpeed: 700,
    diveDamage: 20,
    diveHitRadius: 45,
    enemyAttackRange: 110,
    enemyAttackInterval: 1,
    enemyAttackDamage: 5,
    playerMaxHp: 100,
};

/** 按权重随机取一个枚举值 */
export function pickWeighted<T extends number>(weights: Record<number, number>, candidates: T[]): T {
    let total = 0;
    candidates.forEach(key => (total += weights[key] ?? 0));
    if (total <= 0) return candidates[0];

    let roll = Math.random() * total;
    for (const key of candidates) {
        roll -= weights[key] ?? 0;
        if (roll <= 0) return key;
    }
    return candidates[candidates.length - 1];
}