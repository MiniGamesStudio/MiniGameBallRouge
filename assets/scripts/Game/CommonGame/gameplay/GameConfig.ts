/**
 * 玩法数值与类型定义 — 弹球 Roguelike Demo
 *
 * ★★ 数值真源：下面的 DefaultTuning 是本项目【唯一】的数值来源。★★
 *
 * 历史坑（见策划案 §14.0）：GamePanel 上曾经挂着 22 个同名 @property，prefab 里
 * 存了另一套值并【静默覆盖】这里 —— 结果是"改 .ts 完全没反应，code review 也看
 * 不出差异，所有按代码默认值做的平衡推算全部作废"。
 *
 * 现已删除那些 @property：要调数值请直接改下面的 DefaultTuning。
 * Cocos 会热重载脚本，改完直接生效，不需要碰 prefab。
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
export const CURSOR_ASSET = 'game_cursor';

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
    CURSOR_ASSET,
    ...Object.keys(AssetNameByColor).reduce<string[]>((names, key) => {
        const entry = AssetNameByColor[key as unknown as EnemyColor];
        return names.concat(entry.single, entry.double);
    }, []),
];

/** 单格敌人血量 */
export const SingleHpByColor: Record<EnemyColor, number> = {
    [EnemyColor.Green]: 20,
    [EnemyColor.Blue]: 40,
    [EnemyColor.Red]: 60,
};

/** double 敌人的【每格】血量，均高于同色 single；总量为每格的两倍 */
export const DoubleHpPerCellByColor: Record<EnemyColor, number> = {
    [EnemyColor.Green]: 30,
    [EnemyColor.Blue]: 50,
    [EnemyColor.Red]: 80,
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
    /** 【难度】每过一波，单波行数的增量（0.5 = 每两波多一行） */
    difficultyRowPerWave: number;
    /**
     * 【难度】单波行数上限。
     * 必须 >= waveRowMax，否则难度曲线反而会把行数"压"到比配置的基准还少。
     */
    difficultyRowMax: number;
    /** 【难度】每过一波，敌人下落速度的增幅（0.08 = 每波 +8%） */
    difficultySpeedGrowth: number;
    /** 【难度】下落速度倍率上限 */
    difficultySpeedMax: number;
    /** 【难度】每过一波，敌人血量的增幅（0.12 = 每波 +12%） */
    difficultyHpGrowth: number;
    /** 【难度】血量倍率上限 */
    difficultyHpMax: number;
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
    bulletCount: 5,
    diveSpeed: 700,
    diveDamage: 20,
    diveHitRadius: 45,
    enemyAttackRange: 110,
    enemyAttackInterval: 1,
    enemyAttackDamage: 5,
    playerMaxHp: 100,
    difficultyRowPerWave: 1,
    difficultyRowMax: 30,
    difficultySpeedGrowth: 0.08,
    difficultySpeedMax: 2.5,
    difficultyHpGrowth: 0.12,
    difficultyHpMax: 2.5,
};

/**
 * 某一波的实际难度。第 1 波是基准（行数/速度/血量都用原始值），从第 2 波开始成长。
 */
export interface DifficultyLevel {
    /** 波次，从 1 开始 */
    wave: number;
    /** 本波行数区间 */
    rowMin: number;
    rowMax: number;
    /** 敌人墙下移速度（像素/秒），已含难度加成 */
    fallSpeed: number;
    /** 敌人血量倍率，1 = 原始血量 */
    hpScale: number;
}

/** 成长步数：第 1 波是基准，所以第 N 波已经走了 N-1 步 */
function difficultySteps(wave: number): number {
    const safeWave = Number.isFinite(wave) ? Math.floor(wave) : 1;
    return Math.max(0, safeWave - 1);
}

/**
 * 按波次算难度 —— 行数、下落速度、血量三条线一起涨，各自带自己的封顶。
 *
 * 都做成【线性 + 封顶】而不是指数：demo 里要的是"看得见的变难"，
 * 指数在第 10 波左右就会直接崩掉，而且不好反推某一波到底是多少。
 * 想改成长节奏只调 GameTuning 里的几个 difficulty* 数值，不用碰逻辑。
 */
export function getDifficulty(wave: number, tuning: GameTuning): DifficultyLevel {
    const steps = difficultySteps(wave);

    // 行数：增长率允许小数，先累乘再取整，这样 0.5/波 = 每两波多一行
    const rowBonus = Math.floor(Math.max(0, tuning.difficultyRowPerWave) * steps);
    const rowCap = Math.max(1, Math.floor(tuning.difficultyRowMax));
    const rowMin = Math.min(rowCap, Math.max(1, Math.floor(tuning.waveRowMin)) + rowBonus);
    const rowMax = Math.min(rowCap, Math.max(rowMin, Math.max(1, Math.floor(tuning.waveRowMax)) + rowBonus));

    const speedScale = Math.min(
        Math.max(1, tuning.difficultySpeedMax),
        1 + Math.max(0, tuning.difficultySpeedGrowth) * steps,
    );
    const hpScale = Math.min(
        Math.max(1, tuning.difficultyHpMax),
        1 + Math.max(0, tuning.difficultyHpGrowth) * steps,
    );

    return {
        wave: steps + 1,
        rowMin,
        rowMax,
        fallSpeed: Math.max(1, tuning.enemyFallSpeed) * speedScale,
        hpScale,
    };
}

/**
 * 敌人血量按难度加成。向上取整，并保证至少 1 ——
 * 取整是为了让数值和 HUD 显示是整数，"至少 1" 是为了不让某个倍率把杂兵抹成 0 血。
 */
export function scaleEnemyHp(baseHp: number, hpScale: number): number {
    return Math.max(1, Math.ceil(baseHp * hpScale));
}

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