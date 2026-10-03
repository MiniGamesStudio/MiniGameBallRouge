/**
 * 派生数值公式（纯逻辑层，不依赖 cc，全部可单测）
 *
 * 这些公式的推导与平衡校验见策划案 §25；数值常量统一取自 GameTuning。
 */

import { EnemyShape, EnemyType, Quality, shapeCellCount } from './GameTypes';
import { GameTuning } from './GameTuning';

export interface WaveScaling {
    /** 本波下落速度 px/s */
    fallSpeed: number;
    /** 本波血量倍率 */
    hpMul: number;
    /** 本波行数 */
    rows: number;
}

/** 波次成长（§9.2）：速度 +8%/波、血量 +12%/波，各自封顶 2.5 倍；行数逐波 +1，封顶 30 */
export function waveScaling(wave: number): WaveScaling {
    const index = Math.max(1, Math.floor(wave)) - 1;
    const speedMul = Math.min(1 + GameTuning.fallSpeedGrowth * index, GameTuning.fallSpeedCapMul);
    const hpMul = Math.min(1 + GameTuning.hpGrowth * index, GameTuning.hpCapMul);
    const rows = Math.min(
        GameTuning.baseRowsPerWave + GameTuning.rowsPerWaveGrowth * index,
        GameTuning.maxRows
    );
    return {
        fallSpeed: GameTuning.baseFallSpeed * speedMul,
        hpMul,
        rows,
    };
}

/** 品质权重（§7.2）：越靠后的品质越稀有 */
export const QUALITY_WEIGHTS: readonly number[] = [30, 25, 20, 13, 8, 4];

/** 敌人血量：品质每格血量 × 占格数 × 类型倍率 × 波次成长 */
export function enemyMaxHp(quality: Quality, type: EnemyType, shape: EnemyShape, wave: number): number {
    const perCell = GameTuning.qualityHpPerCell[quality] ?? GameTuning.qualityHpPerCell[0];
    const typeMul = GameTuning.typeHpMul[type] ?? 1;
    const cells = shapeCellCount(shape);
    const hp = perCell * cells * typeMul * waveScaling(wave).hpMul;
    return Math.max(1, Math.round(hp));
}

/** 击杀经验（掉落经验水晶的经验值）：品质经验 × 类型倍率 */
export function enemyExpValue(quality: Quality, type: EnemyType): number {
    const base = GameTuning.qualityExp[quality] ?? 1;
    const mul = GameTuning.typeExpMul[type] ?? 1;
    return Math.max(1, Math.round(base * mul));
}

/** 击杀金币 */
export function enemyCoinValue(quality: Quality, type: EnemyType): number {
    const base = GameTuning.qualityCoin[quality] ?? 1;
    // 精英及以上额外按类型倍率加成（BOSS 给得多）
    const bonus = type === EnemyType.Normal ? 1 : Math.max(1, (GameTuning.typeExpMul[type] ?? 1) * 0.5);
    return Math.max(1, Math.round(base * bonus));
}

/** 击杀魂晶：只有精英 / 小BOSS / 大BOSS 掉 */
export function enemySoulValue(type: EnemyType): number {
    return GameTuning.typeSoul[type] ?? 0;
}

/** 超级水晶掉落个数（0 表示不掉） */
export function enemySuperCrystalCount(type: EnemyType, roll: number): number {
    const chance = GameTuning.superCrystalChance[type] ?? 0;
    if (roll >= chance) return 0;
    return GameTuning.superCrystalCount[type] ?? 0;
}

/** 俯冲伤害（§9.4）：每格 5 点，按占格数计算，单次封顶 40 */
export function diveDamage(shape: EnemyShape): number {
    const raw = GameTuning.diveDamagePerCell * shapeCellCount(shape);
    return Math.min(raw, GameTuning.diveDamageMax);
}

/** 玩家等级 n 升到 n+1 所需经验：8 + 6(n−1) + 1.5(n−1)² */
export function expNeed(level: number): number {
    const n = Math.max(1, Math.floor(level)) - 1;
    return Math.round(GameTuning.expNeedBase + GameTuning.expNeedLinear * n + GameTuning.expNeedQuadratic * n * n);
}

/** 从 1 级升到 level 级所需的累计经验 */
export function expTotalToLevel(level: number): number {
    const target = Math.max(1, Math.floor(level));
    let total = 0;
    for (let lv = 1; lv < target; lv++) total += expNeed(lv);
    return total;
}

/**
 * 结算本次获得的经验能升几级
 * @returns 新的等级、剩余经验、升了几级
 */
export function applyExp(level: number, exp: number, gained: number): { level: number; exp: number; levels: number } {
    let newLevel = Math.max(1, Math.floor(level));
    let pool = Math.max(0, exp) + Math.max(0, gained);
    let levels = 0;
    // 上限保护：避免异常数值导致死循环
    while (levels < 1000) {
        const need = expNeed(newLevel);
        if (pool < need) break;
        pool -= need;
        newLevel++;
        levels++;
    }
    return { level: newLevel, exp: pool, levels };
}

/**
 * 释放半径 = 释放距离 × 格子边长（需求 4 的「0.2 格半径」）
 */
export function cellsToPixels(cells: number): number {
    return cells * GameTuning.cellSize;
}

/**
 * 子弹回收半径（§6.3）：玩家判定半径 + 子弹半径
 * 技能若提升 catchRadius，应通过 catchRadiusBonus 传进来，而不是改这个函数
 */
export function catchRadiusWithBonus(bonus: number = 0): number {
    return GameTuning.playerHitRadius + GameTuning.bulletRadius + Math.max(0, bonus);
}

/** 一行敌人占用的带高（两行带 = 2 格） */
export function bandHeight(rows: number): number {
    return Math.max(1, rows) * GameTuning.cellSize;
}