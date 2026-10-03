import { GameTuning } from './GameConfig';

/**
 * 把一局生效的数值钳制到合法区间。
 *
 * 存在的意义：数值真源统一到 DefaultTuning 之后（见策划案 §14.0），
 * 策划可能会手改某个值到离谱的范围（比如 waveRowMin 比 waveRowMax 还大、
 * 或者把间隔填成 0 导致每帧生成一波）。这里统一兜住，避免运行时出现
 * 除零、死循环、无限生成这类难查的问题。
 *
 * 纯函数、不依赖 cc，方便无头测试覆盖。
 */
export function sanitizeTuning(tuning: GameTuning): GameTuning {
    const rowMin = Math.max(1, Math.floor(tuning.waveRowMin));
    const rowMax = Math.max(rowMin, Math.floor(tuning.waveRowMax));

    return {
        waveInterval: Math.max(0.5, tuning.waveInterval),
        waveRowMin: rowMin,
        waveRowMax: rowMax,
        rowSpawnInterval: Math.max(0.01, tuning.rowSpawnInterval),
        enemyFallSpeed: Math.max(0, tuning.enemyFallSpeed),

        bulletSpeed: Math.max(1, tuning.bulletSpeed),
        bulletDamage: Math.max(1, Math.floor(tuning.bulletDamage)),
        fireInterval: Math.max(0.01, tuning.fireInterval),
        bulletCount: Math.max(1, Math.floor(tuning.bulletCount)),

        diveSpeed: Math.max(1, tuning.diveSpeed),
        diveDamage: Math.max(0, Math.floor(tuning.diveDamage)),
        diveHitRadius: Math.max(0, tuning.diveHitRadius),

        enemyAttackRange: Math.max(0, tuning.enemyAttackRange),
        enemyAttackInterval: Math.max(0.01, tuning.enemyAttackInterval),
        enemyAttackDamage: Math.max(0, Math.floor(tuning.enemyAttackDamage)),

        playerMaxHp: Math.max(1, Math.floor(tuning.playerMaxHp)),

        difficultyRowPerWave: Math.max(1, Math.floor(tuning.difficultyRowPerWave)),
        // 难度行数上限不能低于单波最大行数，否则难度曲线一开始就被压平
        difficultyRowMax: Math.max(rowMax, Math.floor(tuning.difficultyRowMax)),
        difficultySpeedGrowth: Math.max(0, tuning.difficultySpeedGrowth),
        difficultySpeedMax: Math.max(1, tuning.difficultySpeedMax),
        difficultyHpGrowth: Math.max(0, tuning.difficultyHpGrowth),
        difficultyHpMax: Math.max(1, tuning.difficultyHpMax),
    };
}