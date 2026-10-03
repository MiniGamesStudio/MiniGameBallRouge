import { GameTuning } from './GameConfig';

/**
 * 把任意来源的 tuning 钳制成合法值。
 *
 * 为什么单独一个文件：GameConfig.ts 只声明"数值"，这里只声明"校验"，
 * 两者职责分离；而且本文件是纯函数、不依赖 cc，可以直接被无头测试覆盖
 * （见策划案附录 A）。
 *
 * 集中在一处做的好处：
 *  1. 逻辑里不再散落 Math.max / Math.floor；
 *  2. 将来若把数值外置成 JSON 配置资产，可以复用同一套校验；
 *  3. 无头可测 —— 数值 bug 不必靠肉眼试玩发现。
 */
export function sanitizeTuning(tuning: GameTuning): GameTuning {
    return {
        waveInterval: Math.max(1, tuning.waveInterval),
        waveRowMin: Math.max(1, Math.floor(tuning.waveRowMin)),
        waveRowMax: Math.max(1, Math.floor(tuning.waveRowMax)),
        rowSpawnInterval: Math.max(0.02, tuning.rowSpawnInterval),
        enemyFallSpeed: Math.max(1, tuning.enemyFallSpeed),
        bulletSpeed: Math.max(1, tuning.bulletSpeed),
        bulletDamage: Math.max(1, tuning.bulletDamage),
        fireInterval: Math.max(0.02, tuning.fireInterval),
        bulletCount: Math.max(1, Math.floor(tuning.bulletCount)),
        diveSpeed: Math.max(1, tuning.diveSpeed),
        diveDamage: Math.max(0, tuning.diveDamage),
        diveHitRadius: Math.max(1, tuning.diveHitRadius),
        enemyAttackRange: Math.max(0, tuning.enemyAttackRange),
        enemyAttackInterval: Math.max(0.05, tuning.enemyAttackInterval),
        enemyAttackDamage: Math.max(0, tuning.enemyAttackDamage),
        playerMaxHp: Math.max(1, tuning.playerMaxHp),
        difficultyRowPerWave: Math.max(0, tuning.difficultyRowPerWave),
        // 上限至少要跟得上基准行数，否则难度曲线会反过来削减行数
        difficultyRowMax: Math.max(
            Math.max(1, Math.floor(tuning.waveRowMax)),
            Math.floor(tuning.difficultyRowMax),
        ),
        // 倍率下限锁在 1：小于 1 会变成"越往后越简单"
        difficultySpeedGrowth: Math.max(0, tuning.difficultySpeedGrowth),
        difficultySpeedMax: Math.max(1, tuning.difficultySpeedMax),
        difficultyHpGrowth: Math.max(0, tuning.difficultyHpGrowth),
        difficultyHpMax: Math.max(1, tuning.difficultyHpMax),
    };
}