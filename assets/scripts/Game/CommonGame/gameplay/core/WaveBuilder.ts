/**
 * 波次编排（纯逻辑层，不依赖 cc）
 *
 * 把「敌人一行行从顶部生成」的规则变成可直接执行的出生计划：
 *   - 1 行带：只放 1 格 / 2 格横 敌人
 *   - 2 行带：放 4/6/8 格大怪（它们必须占满两行，不允许骑在带边界上），空位用 1 格敌人填
 *   - **大怪优先装箱**：先摆大怪再填空，绝不把 8 格静默降级成小怪（策划案 §7.4）
 *
 * ⚠️ P0 说明：敌人 defId 是**合成**的（auto_q?_t?_s?），因为还没接 Enemy 配置表。
 * 接入配置表后，把 buildEnemySpec 里的 defId 换成表里抽到的敌人即可，装箱与排期逻辑不用改。
 */

import { EnemyRuntime, EnemyShape, EnemyState, EnemyType, Quality } from './GameTypes';
import { GameTuning } from './GameTuning';
import { IRandom, RandomUtil } from './Rng';
import { QUALITY_WEIGHTS, enemyMaxHp, waveScaling } from './MathModels';
import { columnCenterX } from './BoardMath';

/** 计划里的单个敌人（还没生成节点） */
export interface EnemySpawnSpec {
    defId: string;
    quality: Quality;
    type: EnemyType;
    shape: EnemyShape;
    /** 最左列（0 起） */
    col: number;
    /** 占格列数 */
    cols: number;
    /** 占格行数 */
    rows: number;
    /** 带内行偏移（0 = 带的第一行） */
    rowOffset: number;
}

/** 一条「带」：1 行或 2 行，带内敌人同时下落保持队形 */
export interface BandPlan {
    rows: number;
    /** 带内是否有大怪（决定带之间的间隔更宽松） */
    hasBigEnemy: boolean;
    enemies: EnemySpawnSpec[];
}

/** 一波的完整计划 */
export interface WavePlan {
    wave: number;
    bands: BandPlan[];
    /** 累计行数（2 行带算 2 行） */
    totalRows: number;
}

/** 出生事件：延迟 + 敌人（按时间排序，玩法层只需按序倒计时生成） */
export interface SpawnEvent {
    delay: number;
    spec: EnemySpawnSpec;
}

export interface WaveBuildOptions {
    /** 是否本关最后一波（最后一波固定来一个 BOSS） */
    isFinalWave?: boolean;
    /** 精英出现概率，默认 0.15 */
    eliteChance?: number;
    /** 小 BOSS 出现概率（用于非最后一波），默认 0.04 */
    miniBossChance?: number;
    /** 大怪体型权重（4/6/8 格），默认 [5, 3, 2] */
    bigShapeWeights?: readonly number[];
    /** 单格带里放 2 格横敌人的概率，默认 0.35 */
    doubleChance?: number;
    /** 留空列的概率（让阵型有缺口），默认 0.12 */
    gapChance?: number;
}

const DEFAULT_OPTIONS: Required<Omit<WaveBuildOptions, 'isFinalWave'>> = {
    eliteChance: 0.15,
    miniBossChance: 0.04,
    bigShapeWeights: [5, 3, 2],
    doubleChance: 0.35,
    gapChance: 0.12,
};

/** 生成一波的出生计划 */
export function buildWavePlan(wave: number, rng: IRandom, options: WaveBuildOptions = {}): WavePlan {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const scaling = waveScaling(wave);
    const targetRows = scaling.rows;

    const bands: BandPlan[] = [];
    let totalRows = 0;
    let bandIndex = 0;

    while (totalRows < targetRows) {
        const remainingRows = targetRows - totalRows;
        // 大怪带需要 2 行，剩余行数不足就只出单行带
        const wantBossBand = remainingRows >= 2 && shouldSpawnBigEnemy(wave, bandIndex, opts, options, rng);
        const band = wantBossBand
            ? buildBigBand(wave, rng, opts)
            : buildSingleRowBand(wave, rng, opts);

        bands.push(band);
        totalRows += band.rows;
        bandIndex++;
    }

    return { wave, bands, totalRows };
}

/** 是否在这一带出大怪（最后一波固定出 BOSS） */
function shouldSpawnBigEnemy(
    wave: number,
    bandIndex: number,
    opts: Required<Omit<WaveBuildOptions, 'isFinalWave'>>,
    raw: WaveBuildOptions,
    rng: IRandom
): boolean {
    // 最后一波固定来一个大怪
    if (raw.isFinalWave && bandIndex === 0) return true;
    // 开局第一带不出大怪，给玩家一点缓冲
    if (bandIndex === 0) return false;
    // 小 BOSS 概率随波次略微提升
    const chance = opts.miniBossChance * (1 + (wave - 1) * 0.1);
    return RandomUtil.chance(rng, chance);
}

/** 造一条大怪带：行数由大怪体型决定（2 / 3 / 4 行），大怪优先、空位补 1 格敌人 */
function buildBigBand(wave: number, rng: IRandom, opts: Required<Omit<WaveBuildOptions, 'isFinalWave'>>): BandPlan {
    // ① 先摆大怪：4/6/8 格，权重决定体型。
    //    **4/6/8 格都是竖版**（2×2 / 2×3 / 2×4）：列数恒为 2，行数按体型。
    //    带高由大怪决定，所以 6/8 格占 3~4 行（不再假设"带 = 2 行"）。
    const bigShapeIndex = RandomUtil.weightedIndex(rng, opts.bigShapeWeights);
    const bigShape = [EnemyShape.Quad, EnemyShape.Six, EnemyShape.Eight][bigShapeIndex] ?? EnemyShape.Quad;
    const bigCols = 2;
    const bigRows = bigShape === EnemyShape.Eight ? 4 : bigShape === EnemyShape.Six ? 3 : 2;
    const bandRows = bigRows;
    const occupied: boolean[][] = [];
    for (let r = 0; r < bandRows; r++) occupied.push(new Array(GameTuning.columns).fill(false));
    const enemies: EnemySpawnSpec[] = [];
    // BOSS 固定摆在棋盘**正中间**（不再随机列）：
    // 5 列棋盘放 2 列宽的竖版 BOSS 时居中是"半格"（(5−2)/2 = 1.5），
    // 取 ⌊…⌋ 落到偏左的那一组（占 1~2 列）；列数/体型变化时这条公式自动居中。
    const startCol = Math.floor((GameTuning.columns - bigCols) / 2);
    // 需求 2：4/6/8 格都算 BOSS —— 4 格是「小BOSS」，6/8 格是「大BOSS」
    const bigType = bigShape === EnemyShape.Quad ? EnemyType.MiniBoss : EnemyType.Boss;
    const bigQuality = pickQuality(rng, wave, true);

    for (let r = 0; r < bigRows; r++) {
        for (let c = startCol; c < startCol + bigCols; c++) occupied[r][c] = true;
    }
    enemies.push({
        defId: synthDefId(bigQuality, bigType, bigShape),
        quality: bigQuality,
        type: bigType,
        shape: bigShape,
        col: startCol,
        cols: bigCols,
        rows: bigRows,
        rowOffset: 0,
    });

    // ② 空位补 1 格敌人（不放大怪两侧、避免挤在一起时判定混乱）
    for (let r = 0; r < bandRows; r++) {
        for (let c = 0; c < GameTuning.columns; c++) {
            if (occupied[r][c]) continue;
            if (RandomUtil.chance(rng, opts.gapChance)) continue;
            const quality = pickQuality(rng, wave, false);
            const type = RandomUtil.chance(rng, opts.eliteChance) ? EnemyType.Elite : EnemyType.Normal;
            enemies.push({
                defId: synthDefId(quality, type, EnemyShape.Single),
                quality,
                type,
                shape: EnemyShape.Single,
                col: c,
                cols: 1,
                rows: 1,
                rowOffset: r,
            });
            occupied[r][c] = true;
        }
    }

    return { rows: bandRows, hasBigEnemy: true, enemies };
}

/** 造一条 1 行带：1 格与 2 格横混排 */
function buildSingleRowBand(wave: number, rng: IRandom, opts: Required<Omit<WaveBuildOptions, 'isFinalWave'>>): BandPlan {
    const enemies: EnemySpawnSpec[] = [];
    let col = 0;

    while (col < GameTuning.columns) {
        const free = GameTuning.columns - col;
        // 2 格横：剩余空间足够且命中概率
        if (free >= 2 && RandomUtil.chance(rng, opts.doubleChance)) {
            const quality = pickQuality(rng, wave, false);
            const type = RandomUtil.chance(rng, opts.eliteChance) ? EnemyType.Elite : EnemyType.Normal;
            enemies.push({
                defId: synthDefId(quality, type, EnemyShape.DoubleH),
                quality,
                type,
                shape: EnemyShape.DoubleH,
                col,
                cols: 2,
                rows: 1,
                rowOffset: 0,
            });
            col += 2;
            continue;
        }

        if (RandomUtil.chance(rng, opts.gapChance)) {
            col += 1;
            continue;
        }

        const quality = pickQuality(rng, wave, false);
        const type = RandomUtil.chance(rng, opts.eliteChance) ? EnemyType.Elite : EnemyType.Normal;
        enemies.push({
            defId: synthDefId(quality, type, EnemyShape.Single),
            quality,
            type,
            shape: EnemyShape.Single,
            col,
            cols: 1,
            rows: 1,
            rowOffset: 0,
        });
        col += 1;
    }

    // 保证每一行至少有一个敌人，否则这一带等于空放
    if (enemies.length === 0) {
        const quality = pickQuality(rng, wave, false);
        enemies.push({
            defId: synthDefId(quality, EnemyType.Normal, EnemyShape.Single),
            quality,
            type: EnemyType.Normal,
            shape: EnemyShape.Single,
            col: RandomUtil.int(rng, 0, GameTuning.columns - 1),
            cols: 1,
            rows: 1,
            rowOffset: 0,
        });
    }

    return { rows: 1, hasBigEnemy: false, enemies };
}

/**
 * 品质抽取：基础权重 × 波次偏移（越往后高品质越常见）
 * 正式实现应改为读 Wave 表的 qualityWeights（§7.2）
 */
function pickQuality(rng: IRandom, wave: number, forceHigh: boolean): Quality {
    const index = Math.max(1, Math.floor(wave)) - 1;
    const weights = QUALITY_WEIGHTS.map((w, i) => {
        // 高品质权重随波次线性抬升
        const waveBoost = 1 + index * 0.1 * i;
        // 大怪至少是蓝色品质，避免出现"8 格白怪"这种反直觉组合
        const floorBoost = forceHigh && i < Quality.Blue ? 0 : 1;
        return floorBoost === 0 ? 0 : w * waveBoost;
    });
    const weights2 = weights.some(w => w > 0) ? weights : QUALITY_WEIGHTS.slice();
    return RandomUtil.weightedIndex(rng, weights2) as Quality;
}

/** 合成 defId（接入 Enemy 配置表前的占位） */
export function synthDefId(quality: Quality, type: EnemyType, shape: EnemyShape): string {
    return `auto_q${quality}_t${type}_s${shape}`;
}

/**
 * 把一波计划展开成按时间排序的出生事件
 *
 * ⚠️ 行间隔必须和下落速度联动。如果行间隔写死（例如 0.5s），而第 1 波下落速度只有 25px/s，
 * 新的一行出生时上一行才往下走了 12.5px，而一行高 80px —— 两行会直接糊在一起（"敌人重叠"）。
 * 所以这里改成"本带要出生，先等已出生的内容下落 rows(本带) × rowGapCells 格"：
 *     行间隔时间 = rowGapCells × cellSize ÷ 当前波下落速度
 * 速度随波次变快时行间隔自动变短，屏幕上看到的行距始终恒定。
 */
export function buildSpawnSchedule(plan: WavePlan, options: WaveBuildOptions = {}): SpawnEvent[] {
    const events: SpawnEvent[] = [];
    const speed = Math.max(1, waveScaling(plan.wave).fallSpeed);
    const rowGap = (GameTuning.cellSize * GameTuning.rowGapCells) / speed;

    // 行时钟：每个带出生前，前面已出生的内容必须先下落完"本带行数"的时间
    let clock = 0;
    // 上一带末尾的错峰延迟：这些敌人还在"少落一段"的状态，跨带间距必须把它补回来
    let prevDelayBudget = 0;
    // 上一带的行数：跨带间距由"上一带有多高"决定（新带高度在几何上会被抵消掉；
    // 保留 max() 让新带更高时按新带留，和旧行为一致）
    let prevRows = 0;

    for (let b = 0; b < plan.bands.length; b++) {
        const band = plan.bands[b];
        // 带内按 (行偏移, 列) 排序，保证从左到右、从上到下依次弹出
        const ordered = band.enemies.slice().sort((a, c) => {
            if (a.rowOffset !== c.rowOffset) return a.rowOffset - c.rowOffset;
            return a.col - c.col;
        });

        // 带内出现过的列，按从左到右排名 —— 错峰按"列"而不是按"排内序号"分配
        const colRank = new Map<number, number>();
        ordered
            .map(s => s.col)
            .filter((c, i, arr) => arr.indexOf(c) === i)
            .sort((a, c) => a - c)
            .forEach((c, i) => colRank.set(c, i));
        const maxRank = Math.max(0, colRank.size - 1);

        // 两格大怪的盒子会从出生点往上顶半格，所以间距必须按"本带自己的行数"留，
        // 否则新带的盒子上沿会插进上一带里（实测重叠 22px 就是这么来的）。
        // 另外要把上一带的错峰延迟补进时钟，否则"少落一段"的敌人会和新带贴住
        // （竖版 BOSS 让带高变成 3~4 行后，实测 1 行带只剩 124px < 一格 128px）。
        if (b > 0) clock += Math.max(band.rows, prevRows) * rowGap + prevDelayBudget;
        const startTime = clock;
        const stagger =
            maxRank > 0
                ? Math.min(GameTuning.spawnStagger, (rowGap * GameTuning.spawnStaggerBudget) / maxRank)
                : 0;

        // ⚠️ 错峰只能按"列"给：同一列的所有敌人共享同一个延迟，列与列之间才错开。
        // 若按排内序号给，下面那排延迟更多 → 少落一段 → 两排之间精确的一格被吃掉（实测重叠 4px）；
        // 按列给则同列纵向间距恒为整格，同时保留从左到右依次弹出的观感。
        for (const spec of ordered) {
            const d = stagger * (colRank.get(spec.col) ?? 0);
            events.push({ delay: startTime + d, spec });
        }
        prevDelayBudget = stagger * maxRank;
        prevRows = band.rows;
    }

    return events;
}

/** 由出生计划创建敌人运行时数据 */
export function createEnemyRuntime(spec: EnemySpawnSpec, wave: number, id: number): EnemyRuntime {
    const scaling = waveScaling(wave);
    const halfW = (spec.cols * GameTuning.cellSize) * 0.5;
    const x = columnCenterX(spec.col) + halfW - GameTuning.cellSize * 0.5;
    // 出生带的顶边在 spawnLineY：第 rowOffset 排的顶边 = spawnLineY - rowOffset*cell，
    // 敌人中心再往下挪自身高度的一半 —— 这样"带"就是一个高 rows*cell 的整齐矩形，
    // 带与带之间的间距才能只靠时间算清楚（见 buildSpawnSchedule）。
    const y =
        GameTuning.spawnLineY -
        (spec.rowOffset + spec.rows * 0.5) * GameTuning.cellSize;

    return {
        id,
        defId: spec.defId,
        quality: spec.quality,
        type: spec.type,
        shape: spec.shape,
        cols: spec.cols,
        rows: spec.rows,
        x,
        y,
        hp: enemyMaxHp(spec.quality, spec.type, spec.shape, wave),
        maxHp: enemyMaxHp(spec.quality, spec.type, spec.shape, wave),
        speed: scaling.fallSpeed,
        state: EnemyState.Spawning,
        stateTime: 0,
        diveTargetX: x,
        diveTargetY: y,
    };
}