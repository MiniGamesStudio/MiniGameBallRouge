/**
 * 滚动世界（纯逻辑层，不依赖 cc）—— v1.10 起 / §9.2
 *
 * 需求：敌人**生成后自身不动**，随背景一起向下移动；背景**连续无缝循环**。
 * 做法是引入**唯一滚动量**：每帧只算一个 delta，背景与敌人共用它 ——
 * 绝不允许出现两套速度，否则会出现「敌人停了背景还在滚」的穿帮。
 *
 * 三个不变量（都能单测，见 tests/ball-roguelike/ScrollWorld.test.ts）：
 *   ① **世界暂停**（任一敌人因 Telegraph 站住 / 被技能定住 `frozen`）→ delta = 0
 *      → 背景与敌人**同时**静止，恢复后一起继续；
 *   ② 背景回绕只改「取模后的偏移」，累计量按周期回绕存储（0..H）→ 长期运行不丢精度；
 *   ③ 回绕步长 = 一个背景周期的高度 H，而**背景内容本身以 H 为周期** → 回绕前后
 *      **逐像素相同**，所以**必然无缝**（不是"看起来还行"，是构造保证）。
 *
 * v1.10 之后背景有两条路径，各自满足不变量 ③ 的方式不同：
 *   · **真实美术（`m_GameBg` 节点 + 克隆块）**：H = 节点**实际显示高度**
 *     （`contentSize.height × scale`，见 `resolvePatternHeight`）。美术本身**不可平铺**
 *     （实测首尾接缝 6.27× 于相邻行平均差），所以把贴图**裁掉末尾 `backgroundSeamFadeRows` 行**，
 *     再在每块**顶部**用 alpha 渐变把"被裁掉的那些行"淡入（见 `seamFadeStrips`）——
 *     于是接缝处相邻的两行在原图里**本来就是相邻行**，接缝**按构造消失**；
 *   · **程序化网格（兜底）**：网格线间距 = `cellSize` 且 H 是 `cellSize` 的整数倍
 *     （`backgroundGridPatternHeight` = 768 = 6 × `cellSize`）→ 回绕前后逐像素相同。
 */

/** 一帧世界推进的结果 */
export interface WorldScrollStep {
    /** 本帧实际滚动位移 px（>= 0；世界暂停时为 0）—— **背景与敌人共用它** */
    delta: number;
    /** 推进后的累计滚动量 px，已按背景周期回绕到 [0, patternHeight) */
    scrollY: number;
}

/**
 * 背景回绕偏移：把累计滚动量映射到 [0, patternHeight)
 *
 * `patternHeight <= 0`、`NaN`、`±Infinity` 一律兜底返回 0（不抛异常、不返回负值），
 * 负的 scrollY 也能得到合法结果（`%` 在 JS 里对负数返回负值，必须再补一个周期）。
 *
 * @returns 恒在 [0, patternHeight) 内
 */
export function wrapBackgroundOffset(scrollY: number, patternHeight: number): number {
    if (!Number.isFinite(scrollY) || !Number.isFinite(patternHeight) || patternHeight <= 0) return 0;
    const wrapped = scrollY % patternHeight;
    const positive = wrapped < 0 ? wrapped + patternHeight : wrapped;
    // `-0 % H === -0`：数学上等于 0，但 `Object.is(-0, 0)` 为假，会污染调用方的比较 → 归一成 +0
    return positive === 0 ? 0 : positive;
}

/**
 * 本帧实际滚动位移：**世界暂停 → 0**，并兜住负值 / NaN / Infinity。
 *
 * 这是「世界暂停」语义的唯一落地点：`paused` 来自 `EnemySim.applyStopBlocking()`
 * （任一敌人被停住 → 全场停住），因此暂停时背景与敌人拿到的都是 0。
 */
export function effectiveScrollDelta(delta: number, paused: boolean): number {
    if (paused) return 0;
    return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

/**
 * **世界推进（唯一滚动源）**：`speed × dt` → 暂停裁决 → 累计 + 回绕。
 *
 * @param scrollY 上一帧的累计滚动量（已回绕，调用方原样存回即可）
 * @param speed 世界滚动速度 px/s —— 传**当前波次**的 `waveScaling(wave).fallSpeed`，
 *              它同时就是背景滚动速度（`rowGapCells × cellSize` 的行距不变量因此仍成立）
 * @param dt 帧间隔（s）
 * @param paused 世界是否暂停（`applyStopBlocking` 的返回值）
 * @param patternHeight 背景图案一个周期的高度 px
 */
export function advanceWorldScroll(
    scrollY: number,
    speed: number,
    dt: number,
    paused: boolean,
    patternHeight: number
): WorldScrollStep {
    const delta = effectiveScrollDelta(speed * dt, paused);
    const base = Number.isFinite(scrollY) ? scrollY : 0;
    return { delta, scrollY: wrapBackgroundOffset(base + delta, patternHeight) };
}

/**
 * 背景要几块拼接才能铺满可视区（含回绕余量）。
 *
 * 块 `k` 的底边 = `baseY - offset + k × H`，所以 N 块的并集刚好是
 * `[baseY - offset, baseY - offset + N × H]`；回绕偏移 `offset ∈ [0, H)`，
 * 于是最坏情况要覆盖「可视高度 + H」→ `N = ceil(可视高度 ÷ H) + 1`。
 *
 * ⚠️ 这个块数是「任意 offset 下都不出现空隙」的**充分条件**，不要凭手感取 2 ——
 * 背景周期 H 小于可视高度时两块是盖不满的（H = 768、可视高 1408 时需要 3 块）。
 *
 * @param viewHeight 需要覆盖的高度 px（含回绕余量，见 `gridAlignedBottom`）
 */
export function backgroundTileCount(viewHeight: number, patternHeight: number): number {
    if (!Number.isFinite(viewHeight) || !Number.isFinite(patternHeight)) return 1;
    if (viewHeight <= 0 || patternHeight <= 0) return 1;
    return Math.max(1, Math.ceil(viewHeight / patternHeight) + 1);
}

/**
 * 网格底部基准：≤ `bottom` 的最大「格子对齐」位置。
 *
 * 相位取**出生线**（`spawnLineY`）—— 敌人的占格线就是以出生线为相位的格点阵，
 * 所以背景网格线与敌人占格线**永远重合**，滚动时"世界在动"的观感才成立。
 */
export function gridAlignedBottom(alignY: number, bottom: number, cellSize: number): number {
    if (!Number.isFinite(alignY) || !Number.isFinite(bottom) || !Number.isFinite(cellSize) || cellSize <= 0) {
        return bottom;
    }
    return alignY - Math.ceil((alignY - bottom) / cellSize) * cellSize;
}

/**
 * 第 `index` 块背景的**底边** y（世界坐标，节点中心 = 该值 + patternHeight / 2）。
 *
 * 位置只依赖 `offset`（回绕后的累计量）→ 整组位置对 `offset` 以 `patternHeight` 为周期，
 * 所以回绕瞬间只是"整体下移了一个周期"，与图案周期完全一致 → 无接缝、无闪跳。
 */
export function backgroundTileBottomY(
    baseY: number,
    offset: number,
    patternHeight: number,
    index: number
): number {
    return baseY - offset + index * patternHeight;
}

/**
 * 其它取值都不可用时的背景周期兜底值：沿用 v1.10 的网格周期 768 = 6 × `cellSize`。
 *
 * ⚠️ 兜底必须返回**有限正数**而不是 0：0 会让 `backgroundTileCount()` 退化成 1 块
 * → 屏幕上立刻出现空隙。
 */
export const FALLBACK_PATTERN_HEIGHT = 768;

/**
 * **背景块周期（= 回绕周期）= 背景块自身的显示高度**（真实美术路径）。
 *
 * 取值顺序：
 *   ① `explicit > 0` → 用它（**显式覆盖优先**，保留旧行为可控）；
 *   ② 否则 → `nodeHeight × |scaleY|`，即 `m_GameBg` 的**实际显示高度**
 *      （`UITransform.contentSize.height × 节点纵向缩放`）；
 *   ③ 两者都不合法 → `FALLBACK_PATTERN_HEIGHT`。
 *
 * 兜底约定（都被单测覆盖）：
 *   · `explicit` 为 0 / 负数 / NaN / ±Infinity → 视为"自动"，走 ②；
 *   · `scaleY` 为 0 / NaN / ±Infinity → 视为 1（读不到缩放时按"没缩放"处理）；
 *   · `scaleY` 为负 → 取 `|scaleY|`：镜像翻转**不改变**显示高度，绝对值才是对的；
 *   · `nodeHeight` 为 0 / 负数 / NaN / ±Infinity → 落到 ③。
 *
 * @returns 恒为**有限正数**（绝不返回 0 / NaN / 负值）
 */
export function resolvePatternHeight(explicit: number, nodeHeight: number, scaleY: number): number {
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const height = Number.isFinite(nodeHeight) && nodeHeight > 0 ? nodeHeight : 0;
    if (height <= 0) return FALLBACK_PATTERN_HEIGHT;

    // 缩放读不到（0 / 非有限）→ 按 1 处理；负值（镜像）→ 取绝对值
    const scale = Number.isFinite(scaleY) && scaleY !== 0 ? Math.abs(scaleY) : 1;
    const display = height * scale;
    return Number.isFinite(display) && display > 0 ? display : FALLBACK_PATTERN_HEIGHT;
}

/**
 * **场空间 → 背景块空间 的视觉换算系数**。
 *
 * 敌人活在「场空间」（BattleView 节点：设计分辨率 750×1334，外层 `m_GameRoot` 会按
 * 屏幕做 contain 缩放），而 `m_GameBg` 与克隆块活在**面板空间**（不被 `m_GameRoot` 缩放）。
 * 两者纵向缩放不同时，同样的像素位移在屏幕上的视觉距离不同 →
 * 必须把滚动量按**世界缩放比**换算，否则窄高屏（fitHeight 下 `m_GameRoot` 被缩到 ~0.82）
 * 会出现「背景比敌人滚得快」的锁步穿帮。
 *
 * 兜底：任一侧取不到（0 / 负 / NaN / ±Infinity）→ 返回 1（等于不换算），
 * 并把结果夹到 `[1e-3, 1e3]`，避免极端缩放下周期变成 0 / Infinity。
 */
export function backgroundSpaceScale(fieldWorldScaleY: number, backgroundWorldScaleY: number): number {
    const field = Number.isFinite(fieldWorldScaleY) ? Math.abs(fieldWorldScaleY) : 0;
    const space = Number.isFinite(backgroundWorldScaleY) ? Math.abs(backgroundWorldScaleY) : 0;
    if (field <= 0 || space <= 0) return 1;
    const scale = field / space;
    if (!Number.isFinite(scale) || scale <= 0) return 1;
    return Math.min(1000, Math.max(0.001, scale));
}

/** 淡入淡出带最多切成几条（防止 `backgroundSeamFadeRows` 被调得很大时节点数爆炸） */
export const MAX_SEAM_FADE_STRIPS = 16;

/**
 * 接缝淡入淡出带要切成**几条**：每条显示高度尽量不超过 `maxStripPx` px。
 *
 * 为什么要切条而不是一整块：Cocos 的 Sprite 只能整体一个 alpha，做不出"从 1 线性降到 0"
 * 的渐变；把带子切成 K 条、每条一个常数 alpha，就是**离散化的线性渐变**。
 * 每条只要 ≤ 2px，肉眼就无法分辨台阶（实测 K 从 4 加到 16，接缝处最大行差
 * 只从 2.78× 变到 2.70×，说明台阶不是主要误差项 —— 见策划案 §24.8）。
 *
 * @param fadeRows 淡出带的行数（贴图像素行）
 * @param rowDisplayScale 每个贴图行在块节点里的显示高度（px/行）
 * @param maxStripPx 单条允许的最大显示高度 px
 * @returns 条数（1..`MAX_SEAM_FADE_STRIPS`；输入非法时 0 表示"不做淡出"）
 */
export function seamFadeStripCount(fadeRows: number, rowDisplayScale: number, maxStripPx: number): number {
    if (!Number.isFinite(fadeRows) || fadeRows <= 0) return 0;
    if (!Number.isFinite(rowDisplayScale) || rowDisplayScale <= 0) return 1;
    if (!Number.isFinite(maxStripPx) || maxStripPx <= 0) return 1;
    const bandPx = fadeRows * rowDisplayScale;
    if (!Number.isFinite(bandPx) || bandPx <= 0) return 1;
    return Math.min(MAX_SEAM_FADE_STRIPS, Math.max(1, Math.ceil(bandPx / maxStripPx)));
}

/** 一条淡入淡出条带：贴图取样区间 + 节点摆放 + alpha */
export interface SeamFadeStrip {
    /** 贴图**行**区间起点（从图片顶部数，0 = 第一行）—— 直接当 `SpriteFrame.rect.y` 用 */
    rectY: number;
    /** 贴图行区间高度 */
    rectHeight: number;
    /** 该条的 alpha（0..1，从 1 线性降到 0） */
    alpha: number;
    /** 该条在块节点里的显示高度（节点本地单位） */
    displayHeight: number;
    /** 该条**顶边**距块节点顶边的距离（>= 0，向下为正，节点本地单位） */
    offsetFromTop: number;
}

/**
 * 把"被裁掉的那 `fadeRows` 行"切成 `count` 条，给出每条**贴图取样区间 + 摆放 + alpha**。
 *
 * 交叉淡入淡出的构造（这就是"接缝按构造消失"的原因）：
 *   ① 主图裁掉**末尾** `fadeRows` 行 → 主图显示的是原图第 `0 .. H-fadeRows-1` 行；
 *   ② 每块**顶部** `fadeRows` 行的高度里，用 alpha 从 1 降到 0 把"被裁掉的那些行"叠上去；
 *   ③ 于是块与块的接缝处：上方那块的最后一行 = 原图第 `H-fadeRows-1` 行，
 *      下方那块的第一行（alpha=1 处）= 原图第 `H-fadeRows` 行 —— **本来就是相邻行** ✓
 *
 * 返回的 `rectY/rectHeight` 是**贴图坐标**（`rect.y` 的原点在图顶部，与引擎
 * `SpriteFrame.rect` 一致：`UNPACK_FLIP_Y_WEBGL=false` → v=0 是图片第一行）。
 *
 * 输入非法（含 `fadeRows >= textureHeight`、`tileLocalHeight <= 0`）→ 返回 `[]`，
 * 调用方据此退化成"不做淡出"（保持可用的普通平铺，而不是画错）。
 *
 * @param textureHeight 整张贴图高度（行）
 * @param fadeRows 淡出带行数
 * @param count 条数（`seamFadeStripCount()` 的结果）
 * @param tileLocalHeight 一块背景在**节点本地单位**里的高度（裁完后主图铺满该高度）
 */
export function seamFadeStrips(
    textureHeight: number,
    fadeRows: number,
    count: number,
    tileLocalHeight: number
): SeamFadeStrip[] {
    if (!Number.isFinite(textureHeight) || textureHeight <= 0) return [];
    if (!Number.isFinite(fadeRows) || fadeRows <= 0) return [];
    if (!Number.isFinite(count) || count < 1) return [];
    if (!Number.isFinite(tileLocalHeight) || tileLocalHeight <= 0) return [];

    const contentRows = textureHeight - fadeRows;
    if (contentRows <= 0) return [];

    const strips = Math.min(MAX_SEAM_FADE_STRIPS, Math.max(1, Math.floor(count)));
    // 主图被压进同一块高度 → 每行显示高度 = 块高 ÷ 主图行数（整体约放大 fadeRows/contentRows）
    const rowScale = tileLocalHeight / contentRows;
    const rowsPerStrip = fadeRows / strips;
    const stripPx = rowsPerStrip * rowScale;

    const out: SeamFadeStrip[] = [];
    for (let i = 0; i < strips; i++) {
        out.push({
            rectY: contentRows + i * rowsPerStrip,
            rectHeight: rowsPerStrip,
            alpha: 1 - (i + 0.5) / strips,
            displayHeight: stripPx,
            offsetFromTop: i * stripPx,
        });
    }
    return out;
}