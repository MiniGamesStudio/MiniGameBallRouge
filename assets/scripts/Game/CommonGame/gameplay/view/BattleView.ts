/**
 * BattleView —— 玩法编排层（唯一把「纯逻辑」和「Cocos 节点」粘起来的地方）
 *
 * 职责：
 *   输入（操作方案 A：按住玩家 = 走位 / 其它任意处 = 瞄准，双指可同时）→ 开火与弹匣账本
 *   → 子弹仿真 → 敌人状态机 → 掉落物与经验 → 升级/天赋三选一 → 波次推进 → HUD 与结算
 *
 * 设计约束：
 *   1. 所有数值来自 core/GameTuning（**不要**在这里挂 @property，见策划案 §14.0）；
 *   2. 玩法规则都在 core/ 里（纯逻辑、可 L1 单测），这里只做"读状态 + 摆节点"；
 *   3. 素材全部来自 bundle `game`（占位美术，见 view/GameArt.ts）。
 *
 * v1.10 滚动世界（需求：敌人"生成后不动"、随背景一起向下移动、背景连续循环；
 * **掉落物同样随背景一起移动**）：
 *   世界运动只有**一个来源** —— `updateScroll()` 里的 `m_ScrollDelta` / `m_ScrollY`
 *   （由 core/ScrollWorld.ts 的纯函数算出）。**三个消费者**都只消费它，谁都不许自己算速度：
 *   敌人（`m_EnemyWorld.scrollDelta`）、背景（`updateBackground()`）、
 *   掉落物（`m_DropWorld.scrollDelta`，见 `updateDrops()`）。世界暂停（任一敌人被停住）
 *   时它等于 0，于是背景、敌人、掉落物**一起**停；而**磁吸是玩家侧行为、照常**
 *   （core/DropSim.ts 里"先滚动、再磁吸"，两者叠加）。详见这三个方法的注释。
 */

import { _decorator, Button, Color, Component, EventTouch, Graphics, Input, Label, Node, Rect, Size, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, Widget, input, instantiate } from 'cc';
import { GameTuning } from '../core/GameTuning';
import {
    BulletRuntime,
    DropKind,
    DropRuntime,
    EnemyRuntime,
    EnemyType,
    Vec2,
} from '../core/GameTypes';
import { IRandom, RandomUtil, SeededRandom } from '../core/Rng';
import {
    boxFromCells,
    boardLeftX,
    circleHitsBox,
    clamp,
    clampCursorPosition,
    clampPlayerPosition,
    distance,
    screenBounds,
} from '../core/BoardMath';
import { BulletWorld, aimVelocity, createBullet, stepBullet } from '../core/BulletSim';
import { EnemyWorld, applyStopBlocking, enemyVisualScale, isDead, isHittable, killEnemy, pickAutoAimTarget, stepEnemy } from '../core/EnemySim';
import { DropOutcome, DropWorld, stepDrop } from '../core/DropSim';
import {
    FALLBACK_PATTERN_HEIGHT,
    SeamFadeStrip,
    advanceWorldScroll,
    backgroundSpaceScale,
    backgroundTileBottomY,
    backgroundTileCount,
    gridAlignedBottom,
    resolvePatternHeight,
    seamFadeStripCount,
    seamFadeStrips,
    wrapBackgroundOffset,
} from '../core/ScrollWorld';
import { buildDashSegments, traceAimGuide } from '../core/AimGuide';
import {
    catchRadiusWithBonus,
    enemyCoinValue,
    enemyExpValue,
    enemySoulValue,
    enemySuperCrystalCount,
    waveScaling,
} from '../core/MathModels';
import { EnemySpawnSpec, SpawnEvent, buildSpawnSchedule, buildWavePlan, createEnemyRuntime } from '../core/WaveBuilder';
import {
    RunStats,
    SkillDef,
    createRunStats,
    damagePlayer,
    describeStats,
    expToNextLevel,
    grantExp,
    markSkillLearned,
    pickSkillChoices,
    skillLevelText,
} from '../core/PlayerStats';
import {
    ArtCache,
    GameArtPath,
    applyCellSize,
    applyContainFit,
    applyNineSlice,
    createLabel,
    createSprite,
    enemyArtPaths,
    faceVelocity,
    getArt,
    makeNode,
    gameArtCount,
    gameArtTotal,
    preloadGameArt,
    setPos,
    setScale,
} from './GameArt';
import { HitFeedback } from './HitFeedback';
import { OverlayHandle, showChoiceOverlay, showMessageOverlay } from './ChoiceOverlay';

const { ccclass } = _decorator;

/** 游标位置夹取半径（浮标外接圆）：把瞄准点夹在屏幕内，浮标才不会跑出屏 */
const CURSOR_CLAMP_RADIUS = 45;
/** 瞄准辅助射线默认反射次数：1 = 主射线 + 首段反弹射线（与真实弹道一致；反射对象可能是墙、也可能是敌人） */
const AIM_GUIDE_BOUNCE = 1;
/** 辅助射线描边色（深色，与伤害飘字描边同色系）：alpha 由 `aimGuideOutlineAlpha` 覆盖（见 strokeDashes） */
const AIM_GUIDE_OUTLINE = new Color(255, 255, 255, 255);
/** `buildDashSegments()` 返回的单段虚线：part = 所属折线段序号（0 = 主射线，>= 1 = 首段反弹） */
type DashSegment = ReturnType<typeof buildDashSegments>[number];
/** 浮标贴屏幕边缘时保留的余量 px（≈半个浮标高度）：保证浮标整体不出屏、随时可见 */
const CURSOR_FLOAT_EDGE_MARGIN = 48;
/** 伤害飘字颜色：敌人·普通 / 敌人·暴击 / 玩家·普通 / 玩家·暴击 */
const DMG_ENEMY = new Color(255, 232, 120, 255);
const DMG_ENEMY_CRIT = new Color(255, 120, 40, 255);
const DMG_PLAYER = new Color(255, 92, 92, 255);
const DMG_PLAYER_CRIT = new Color(255, 60, 200, 255);
/** 飘字描边色（需求：描边 + 加粗） */
const DMG_OUTLINE = new Color(20, 12, 0, 255);
/** 波次之间的喘息时间 */
const WAVE_INTERVAL = 1.2;
/** 调试 HUD（显示本局生效数值，方便对着策划案核数值） */
const SHOW_DEBUG_HUD = true;

/**
 * 背景底色（模块常量，按需求不放进 `GameTuning`）：深蓝黑，低对比度，
 * 让半透明的网格线看得见，同时不与敌人底图 / 瞄准射线抢视觉。
 */
const BG_BASE_COLOR = new Color(14, 18, 28, 255);
/** 背景网格线颜色（alpha 由 `GameTuning.backgroundGridAlpha` 覆盖，默认 26 = 很低对比度） */
const BG_GRID_COLOR = new Color(130, 180, 235, 255);
/** 背景网格线宽 px（很细，只做"格子在动"的参照） */
const BG_GRID_WIDTH = 2;

/** 结算数据 */
export interface BattleResult {
    level: number;
    wave: number;
    kills: number;
    timeSec: number;
    coins: number;
    souls: number;
    superCrystals: number;
}

export interface BattleOptions {
    /** 关卡号（从 1 开始） */
    level: number;
    /** 随机种子（不传则用时间戳），同种子关卡完全一致 */
    seed?: number;
    /**
     * **滚动背景用的真实背景节点**（面板的 `m_GameBg`，v1.10 起）。
     *
     * 由 GamePanel **显式注入**：BattleView 绝不做 `getChildByName('m_GameBg')` 之类的
     * 字符串查找（改名/换层级就静默失效，脆弱），也不在开局后再"换背景"
     * （那会导致第一帧跳位 + 二次重建）。
     * 不传 / 传 null / 该节点上没有可用的 Sprite 贴图 → 退回程序化网格兜底（见 createBackground）。
     */
    backgroundNode?: Node;
    /** 失败回调 */
    onGameOver?: (result: BattleResult) => void;
    /** 过关回调 */
    onLevelClear?: (result: BattleResult) => void;
    /** 点「重新开始」 */
    onRestart?: () => void;
    /** 点「返回主页」 */
    onExit?: () => void;
}

/**
 * 背景块的贴图帧（**所有块共用同一批**，只在开局造一次）：
 * 主图 `main` + 淡入淡出条带 `strips`（`strips.length === 0` 表示不做淡出 → 直接用原始帧）。
 */
interface BackgroundFrames {
    main: SpriteFrame;
    strips: SeamFadeStrip[];
    stripFrames: SpriteFrame[];
}

/** 掉落物外观（没有水晶素材，用 Graphics 画圆代替） */
const DROP_STYLE: Record<DropKind, { radius: number; color: Color }> = {
    [DropKind.Exp]: { radius: 10, color: new Color(90, 200, 255, 255) },
    [DropKind.Coin]: { radius: 10, color: new Color(255, 205, 60, 255) },
    [DropKind.Soul]: { radius: 12, color: new Color(190, 120, 255, 255) },
    [DropKind.SuperCrystal]: { radius: 16, color: new Color(255, 120, 200, 255) },
};

/** 掉落物美术与基准尺寸（cellSize 的倍数）：经验水晶按经验值放大、魂晶按品质放大 */
const DROP_ART: Record<DropKind, { path: string; size: number }> = {
    [DropKind.Exp]: { path: GameArtPath.dropExp, size: 0.30 },
    [DropKind.Coin]: { path: GameArtPath.dropCoin, size: 0.20 },
    [DropKind.Soul]: { path: GameArtPath.dropSoul, size: 0.26 },
    [DropKind.SuperCrystal]: { path: GameArtPath.dropSuper, size: 0.34 },
};

/** 金币掉落枚数：按品质 0~8 枚（白怪 0 枚，红怪 8 枚） */
const COIN_COUNT_BY_QUALITY: readonly number[] = [0, 1, 3, 5, 6, 8];

@ccclass('BattleView')
export class BattleView extends Component {
    /** 异步创建：先加载占位素材，再挂组件并开局 */
    static async create(parent: Node, options: BattleOptions): Promise<BattleView> {
        const art = await preloadGameArt();
        const node = makeNode(parent, 'BattleView');
        const view = node.addComponent(BattleView);
        view.setup(art, options);
        return view;
    }

    // ─────────── 运行时状态 ───────────
    private m_Art: ArtCache = new Map();
    private m_Options: BattleOptions = null;
    private m_Rng: IRandom = new SeededRandom(1);
    private m_Stats: RunStats = createRunStats();
    private m_SkillLevels: Map<string, number> = new Map();

    private m_FieldRoot: Node = null;
    private m_HudRoot: Node = null;
    private m_PlayerNode: Node = null;
    private m_CursorNode: Node = null;

    // ─────────── 滚动世界（v1.10）：唯一滚动源 ───────────
    /** **网格兜底**路径的背景层（`m_FieldRoot` 的**第一个**子节点 = 最底层）；真实美术路径为 null */
    private m_BackgroundRoot: Node = null;
    /**
     * 拼接的背景块（每块的**底边**随 `m_ScrollY` 一起摆位）。
     * 真实美术路径下第 0 块就是 `m_GameBg` **本体**（不复制它的数据，只把它当第 0 块用）。
     */
    private m_BackgroundTiles: Node[] = [];
    /**
     * 第 0 块背景的**底边** y，开局算一次就固定：
     * · 网格路径：格子对齐（相位 = 出生线，见 `gridAlignedBottom`），单位 = 场空间；
     * · 真实美术路径：`m_GameBg` **原位置的底边**（于是第一帧它一动不动），单位 = 面板空间。
     */
    private m_BackgroundBottomY: number = 0;

    // ─── 真实美术路径（v1.10 起）───
    /** 注入的真实背景节点（`m_GameBg`）；未注入 / 不可用时为 null */
    private m_BackgroundNode: Node = null;
    /** 真实背景节点所在的**面板空间**父节点（摆位与空间换算都用它） */
    private m_BackgroundParent: Node = null;
    /** 是否走真实美术路径（决定 `updateBackground()` 用哪套坐标/摆位） */
    private m_BackgroundUsesNode: boolean = false;
    /** 第 0 块（= `m_GameBg`）的纵向锚点，用来把"底边"换算成节点 position */
    private m_BackgroundTileAnchorY: number = 0.5;
    /** 一块背景在**节点本地单位**里的高度（= `m_GameBg.contentSize.height`，淡入淡出条带按它布局） */
    private m_BackgroundTileLocalHeight: number = 0;
    /** 一块背景在**面板空间**里的显示高度（= 本地高度 × |scale|；把底边换算成 position 用） */
    private m_BackgroundTileDisplayHeight: number = 0;
    /** 相邻块的底边间距（面板空间单位）——**自动时就等于显示高度**，块与块正好接上 */
    private m_BackgroundTileSpacing: number = 0;
    /** 第 0 块上的淡入淡出条带节点（它本体不销毁，收尾时要显式清掉） */
    private m_BackgroundFadeNodes: Node[] = [];
    /** 原始贴图帧 / 原始尺寸 / 原始位置 / 原始 Widget —— 收尾时把 `m_GameBg` 还原成初始状态 */
    private m_BackgroundSourceFrame: SpriteFrame = null;
    private m_BackgroundSourceWidth: number = 0;
    private m_BackgroundSourceHeight: number = 0;
    private m_BackgroundSourcePos: Vec3 = null;
    private m_BackgroundSourceWidget: Widget = null;
    private m_BackgroundSourceWidgetEnabled: boolean = true;
    /** 网格兜底路径是否把注入的真实背景节点藏起来了，以及它原来的 `active` */
    private m_BackgroundNodeHidden: boolean = false;
    private m_BackgroundSourceActive: boolean = true;

    /**
     * **本帧世界滚动位移** px（>= 0；世界暂停时为 0）。
     * 背景与敌人**共用这一个值** —— 绝不允许任何一方另算速度。
     */
    private m_ScrollDelta: number = 0;
    /**
     * **累计滚动量** px（**场空间**单位）。只在这里累计、且按背景周期回绕：
     * 它同时就是"背景拼接偏移"的来源，长期运行（几小时）也不会出现浮点精度漂移。
     */
    private m_ScrollY: number = 0;
    /** 瞄准浮标外围圆半径 = 玩家图显示半径 + cursorOrbitGap（开局创建玩家时算出） */
    private m_OrbitRadius = 0;
    /** 伤害飘字（需求：敌人/玩家、普通/暴击颜色不同） */
    private m_DamageTexts: { node: Node; x0: number; y0: number; life: number }[] = [];

    private m_PlayerX: number = 0;
    private m_PlayerY: number = 0;
    private m_CursorX: number = 0;
    private m_CursorY: number = 0;

    private m_Bullets: BulletRuntime[] = [];
    private m_BulletNodes: Map<number, Node> = new Map();
    private m_Enemies: EnemyRuntime[] = [];
    /** 开火解锁：第一行敌人出生并下移后才允许发射 */
    private m_FireUnlocked = false;
    private m_EnemyNodes: Map<number, Node> = new Map();
    /** 敌人受击表现（闪白 + 震动） */
    /**
     * 敌人的受击表现。一格 / 两格怪是「一格一张怪物图」，所以一个敌人可能挂多条
     * （两格怪两格都要闪白 / 震动）；4/6/8 格是一张放大图，只有一条。
     * bx / by 是节点未被震动时的基准坐标（震动直接改节点位置，必须记住基准才能精确归位）。
     */
    private m_EnemyFeedback: Map<number, Array<{ fb: HitFeedback; bx: number; by: number }>> = new Map();
    /** 玩家受击表现（只有闪白，不震） */
    private m_PlayerFeedback: HitFeedback | null = null;
    private m_Drops: DropRuntime[] = [];
    private m_DropNodes: Map<number, Node> = new Map();
    /**
     * 掉落物仿真世界（core/DropSim.ts 的纯函数用）。
     *
     * `scrollDelta` 每帧由 `updateDrops()` 写入**同一个** `m_ScrollDelta`
     * （与敌人、背景同源）→ 掉落物 = "世界里的静止物体"，与敌人 / 背景**严格锁步**：
     * 生成时散落一次之后就静止，屏幕位移全部来自世界滚动。
     */
    private m_DropWorld: DropWorld = null;
    private m_NextId: number = 1;
    private m_MagazineOut: number = 0;
    private m_FreeBulletsOut: number = 0;
    private m_FireTimer: number = 0;

    private m_Wave: number = 1;
    private m_SpawnEvents: SpawnEvent[] = [];
    private m_SpawnIndex: number = 0;
    private m_SpawnTimer: number = 0;
    private m_WaveClearTimer: number = 0;
    private m_PendingLevelUps: number = 0;

    private m_Kills: number = 0;
    private m_Coins: number = 0;
    private m_Souls: number = 0;
    private m_SuperCrystals: number = 0;
    private m_Elapsed: number = 0;

    private m_OverlayPaused: boolean = false;
    private m_ExternalPaused: boolean = false;
    private m_Finished: boolean = false;
    private m_Overlay: OverlayHandle | null = null;

    private m_PlayerTouchId: number = -1;
    /** 瞄准触摸 id（与 m_PlayerTouchId 相互独立，两根手指可同时生效） */
    private m_AimTouchId: number = -1;
    private m_PlayerGrabOffset: Vec2 = { x: 0, y: 0 };
    /**
     * 瞄准空闲计时（s）：**只**由瞄准触摸的按下/移动清零（= 手动接管）；
     * 拖动玩家不清零，所以走位不会打断兜底自动瞄准（附录 J）。
     */
    private m_AimIdle: number = 0;

    /** 瞄准辅助射线：主射线（半透明白）与首段反弹段（更淡）；都建在敌人之下（§附录 J） */
    private m_AimRay: Graphics = null;
    private m_AimBounceRay: Graphics = null;

    private m_HpLabel: Label = null;
    private m_MagazineLabel: Label = null;
    private m_WaveLabel: Label = null;
    private m_ExpLabel: Label = null;
    private m_DebugLabel: Label = null;
    private m_ExpBar: Graphics = null;
    private m_LastExpRatio: number = -1;

    private m_BulletWorld: BulletWorld = null;
    private m_EnemyWorld: EnemyWorld = null;

    // ─────────── 生命周期 ───────────

    onDestroy(): void {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        this.m_Overlay?.close();
        this.m_Overlay = null;
        this.m_EnemyFeedback.clear();
        this.m_PlayerFeedback = null;
        // 真实美术背景的克隆块挂在**面板**上（不在本节点子树里），必须显式收尾
        this.releaseNodeBackground();
        // 素材走 GameArt 内部的常驻缓存，这里不释放（避免释放路径写错导致贴图提前失效）
        // 同理：背景块的裁剪帧共用原贴图，也不 destroy（只丢弃引用，让 GC 处理）
    }

    /**
     * 背景**收尾**：销毁克隆块 / 条带，并把 `m_GameBg` **还原成开局前的样子**。
     *
     * 为什么必须做（否则重开关卡会叠加或串味）：
     *   ① 克隆块是 `m_GameBg` 的**兄弟节点**（挂在面板上，不在 BattleView 子树里）
     *      → BattleView 销毁时它们**不会**跟着消失，必须显式 `destroy()`；
     *   ② 面板本身不重建（`GamePanel.restartCurrentLevel()` 只是销毁 BattleView 再重开），
     *      `m_GameBg` 会留在面板上 → 被我们改过的贴图帧 / 尺寸 / 位置 / Widget 开关 / 隐藏状态
     *      都要还原，下一次开局才是干净的初始状态。
     *
     * 网格兜底路径下没有克隆块，但仍然要还原"被藏起来的真实背景节点"（见 createGridBackground）。
     */
    private releaseNodeBackground(): void {
        const source = this.m_BackgroundNode;

        // ① 销毁克隆块（真实美术路径才有；它们是面板的子节点，不随本节点一起销毁）
        if (this.m_BackgroundUsesNode) {
            for (let i = 0; i < this.m_BackgroundTiles.length; i++) {
                const tile = this.m_BackgroundTiles[i];
                if (tile && tile.isValid && tile !== source) tile.destroy();
            }
        }
        // ② 本体的淡入淡出条带（本体不销毁，得显式清掉）
        for (let i = 0; i < this.m_BackgroundFadeNodes.length; i++) {
            const fade = this.m_BackgroundFadeNodes[i];
            if (fade && fade.isValid) fade.destroy();
        }

        // ③ 还原注入节点：网格路径下只是"重新显示出来"，真实美术路径还要还原被改过的贴图/尺寸/位置/Widget
        if (source && source.isValid) {
            const sprite = source.getComponent(Sprite);
            if (sprite && this.m_BackgroundSourceFrame) sprite.spriteFrame = this.m_BackgroundSourceFrame;
            const transform = source.getComponent(UITransform);
            if (transform && this.m_BackgroundSourceWidth > 0 && this.m_BackgroundSourceHeight > 0) {
                transform.setContentSize(this.m_BackgroundSourceWidth, this.m_BackgroundSourceHeight);
            }
            if (this.m_BackgroundSourcePos) source.setPosition(this.m_BackgroundSourcePos);
            if (this.m_BackgroundSourceWidget && this.m_BackgroundSourceWidget.isValid) {
                this.m_BackgroundSourceWidget.enabled = this.m_BackgroundSourceWidgetEnabled;
            }
            if (this.m_BackgroundNodeHidden) source.active = this.m_BackgroundSourceActive;
        }

        this.m_BackgroundTiles = [];
        this.m_BackgroundFadeNodes = [];
        this.m_BackgroundUsesNode = false;
        this.m_BackgroundNodeHidden = false;
        this.m_BackgroundSourceFrame = null;
        this.m_BackgroundSourcePos = null;
        this.m_BackgroundSourceWidget = null;
        this.m_BackgroundSourceWidth = 0;
        this.m_BackgroundSourceHeight = 0;
    }

    /** 外部暂停（面板打开暂停菜单时调用） */
    setPaused(paused: boolean): void {
        this.m_ExternalPaused = paused;
    }

    get isFinished(): boolean {
        return this.m_Finished;
    }

    /** 开局：建节点树、摆玩家与游标、开始第 1 波及开局天赋三选一 */
    private setup(art: ArtCache, options: BattleOptions): void {
        this.m_Art = art;
        this.m_Options = options;
        this.m_Rng = new SeededRandom(options.seed ?? (Date.now() & 0x7fffffff));
        this.m_Stats = createRunStats();

        // 根节点要有 UITransform，触摸坐标换算与尺寸都依赖它
        const rootTransform = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);
        rootTransform.setContentSize(GameTuning.designWidth, GameTuning.designHeight);

        this.m_FieldRoot = makeNode(this.node, 'Field');
        this.m_HudRoot = makeNode(this.node, 'Hud');

        // 真实背景节点由 GamePanel 显式注入（不做字符串查找）；null / 空 → 走网格兜底
        this.m_BackgroundNode =
            options.backgroundNode && options.backgroundNode.isValid ? options.backgroundNode : null;

        // 背景必须**最先**建：兄弟序 = 渲染序，第一个子节点才在最底层。
        // 于是层级恒为「背景 < 瞄准射线 < 敌人 < 子弹/掉落/飘字 < 玩家（每帧被提到最上）」，
        // 而 HUD 在 m_HudRoot（Field 的后一个兄弟节点）→ 背景永远盖不到 HUD。
        // 真实美术路径的块是 m_GameBg 的**兄弟**（挂在面板上），仍是面板第一个子节点起的那一组
        // → 同样在所有战斗元素与 HUD 之下（见 createNodeBackground 的层级说明）。
        this.createBackground();
        this.createPlayerAndCursor();
        this.createHud();
        this.createWorlds();

        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);

        console.log(`[BattleView] 开局 关卡=${options.level} 种子=${options.seed ?? 'time'} ${describeStats(this.m_Stats)}`);

        this.startWave(1);
        this.showTalentChoice();
    }

    /**
     * 建**滚动世界**的背景层（最底层）：铺满可视区、随世界滚动向下移动、无缝循环。
     *
     * 两条路径，**绝不同时出现**：
     *   ① **真实美术（默认）**：以面板上的 `m_GameBg` 为第 0 块、克隆出足够块数（`createNodeBackground`），
     *      程序化网格**完全不创建**；
     *   ② **程序化网格（兜底）**：`backgroundUseNodeSprite=false` / 没注入节点 / 节点上没有可用的
     *      Sprite 贴图时使用（`createGridBackground`，v1.10 的原始实现）。
     *
     * `backgroundScrollEnabled=false` → **不创建任何背景层**（保持 v1.10 语义：世界滚动照常驱动敌人与
     * 波次推进，只是画面上少了"滚动参照物"；它**不是**"背景不滚"——那会变成两套速度，正是要消灭的东西）。
     */
    private createBackground(): void {
        if (!GameTuning.backgroundScrollEnabled) return;

        const node = this.m_BackgroundNode;
        if (GameTuning.backgroundUseNodeSprite && node) {
            try {
                if (this.createNodeBackground(node)) return;
            } catch (error) {
                // 真实美术初始化意外失败也不能让整局开不起来：退回网格兜底。
                // 此时节点可能已被改到一半 → 网格路径会把它整个藏起来（见 createGridBackground）。
                console.warn('[BattleView] 真实美术背景初始化失败，退回程序化网格', error);
            }
        }

        this.createGridBackground();
    }

    /**
     * **真实美术路径**：以 `m_GameBg` 为**第 0 块**（不复制它的数据），克隆出足够块数，
     * 整体随 `m_ScrollY` 下移并按周期回绕。
     *
     * 关键决策（写在这里，避免以后被"简化"掉）：
     *   · **周期 = 节点实际显示高度**（`contentSize.height × |scale|`，见 `resolvePatternHeight`；
     *     `backgroundPatternHeight` 非 0 时可显式覆盖）——块与块正好接上，不需要人工维护常数；
     *   · **块数由 `backgroundTileCount()` 推**（可视高 ÷ 周期 + 1，那 +1 是回绕余量），
     *     **不凭手感取 2**：本配置（周期 = 可视高 1334、基准 -667）算出 **2 块**，
     *     且这 2 块在任意 offset ∈ [0, 周期) 下并集都盖满 [-667, 667]
     *     （offset → 周期 时并集 = [-2001, 667]，正好还压住屏幕顶边）；
     *   · **基准位置 = `m_GameBg` 原位置**：第 0 块就摆在它原来的地方 → **第一帧不跳位**；
     *   · **同父同级 + 最底层**：克隆块插在 `m_GameBg` 之后（它本来就是面板的第一个子节点）
     *     → 渲染顺序仍在所有战斗元素与 HUD 之下；
     *   · **空间换算**：块活在面板空间（不被 `m_GameRoot` 缩放），滚动量要乘
     *     `backgroundSpaceScale()`，否则窄高屏（fitHeight 下 `m_GameRoot` 被 contain 缩到 ~0.82）
     *     会出现「背景比敌人滚得快」的锁步穿帮；
     *   · **接缝**：贴图不可平铺（实测 6.27×），所以裁掉末尾若干行 + 顶部 alpha 渐变叠回
     *     （见 `buildBackgroundFrames`），让接缝两边在原图里**本来就是相邻行**。
     *
     * @returns 是否成功接管（false = 调用方退回程序化网格兜底）
     */
    private createNodeBackground(node: Node): boolean {
        const transform = node.getComponent(UITransform);
        const sprite = node.getComponent(Sprite);
        const frame = sprite ? sprite.spriteFrame : null;
        const parent = node.parent;
        if (!transform || !sprite || !frame || !frame.texture || !parent) return false;

        const parentTransform = parent.getComponent(UITransform);
        // 尺寸：等价于 Widget 的"铺满父节点"。**显式设一次**，不再依赖 Widget 的执行时机
        const width = parentTransform && parentTransform.width > 0 ? parentTransform.width : transform.width;
        const height = parentTransform && parentTransform.height > 0 ? parentTransform.height : transform.height;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

        // 先记录"原状"，收尾时要还原（面板不重建，重开关卡会再走一遍开局）
        this.m_BackgroundSourceFrame = frame;
        this.m_BackgroundSourceWidth = transform.width;
        this.m_BackgroundSourceHeight = transform.height;
        this.m_BackgroundSourcePos = node.position.clone();
        this.m_BackgroundSourceWidget = node.getComponent(Widget);
        this.m_BackgroundSourceWidgetEnabled = this.m_BackgroundSourceWidget
            ? this.m_BackgroundSourceWidget.enabled
            : false;

        // Widget 的 alignMode = ALWAYS 会**每帧**把 y 拽回对齐位置，与滚动直接冲突 → 关掉。
        // 尺寸上面已经显式设好了，所以关掉它不会丢失"铺满"的效果。
        this.disableWidgetAlign(node);
        transform.setContentSize(width, height);

        const anchorY = Number.isFinite(transform.anchorY) ? transform.anchorY : 0.5;
        const scaleY = Number.isFinite(node.scale.y) && node.scale.y !== 0 ? Math.abs(node.scale.y) : 1;
        const displayHeight = height * scaleY;
        // 相邻块底边间距：自动 = 块的显示高度（块正好接上）；显式覆盖时按调参值（可能出现重叠/空隙，由调参者负责）
        const spacing = resolvePatternHeight(GameTuning.backgroundPatternHeight, height, node.scale.y);
        this.m_BackgroundParent = parent;
        this.m_BackgroundUsesNode = true;
        this.m_BackgroundTileAnchorY = anchorY;
        this.m_BackgroundTileLocalHeight = height;
        this.m_BackgroundTileDisplayHeight = displayHeight;
        this.m_BackgroundTileSpacing = spacing;
        this.m_BackgroundTiles = [node];
        this.m_BackgroundFadeNodes = [];
        this.m_ScrollY = 0;

        // 贴图帧（主图 + 淡入淡出条带；所有块共用，只造一次）
        const frames = this.buildBackgroundFrames(frame, width);
        if (frames) {
            sprite.trim = true;
            sprite.spriteFrame = frames.main;
            // ⚠️ 本体的淡入淡出条带**必须等克隆完再加**（见下面的克隆循环）：
            // `instantiate(node)` 会把子节点一起复制，先加就会让每个克隆块多出一套重复条带。
        }

        // 第 0 块的底边 = 它原位置的底边 → 第一帧一动不动
        this.m_BackgroundBottomY = this.m_BackgroundSourcePos.y - anchorY * displayHeight;

        // 块数：可视高 ÷ 周期 + 1（`backgroundTileCount` 的一般式，含回绕余量）
        const viewHeight = parentTransform && parentTransform.height > 0 ? parentTransform.height : GameTuning.designHeight;
        const parentAnchorY = parentTransform && Number.isFinite(parentTransform.anchorY) ? parentTransform.anchorY : 0.5;
        const viewTop = (1 - parentAnchorY) * viewHeight;
        const count = backgroundTileCount(viewTop - this.m_BackgroundBottomY, spacing);

        // 克隆块：同父、紧跟第 0 块（保持最底层），共用同一批贴图帧
        const baseIndex = node.getSiblingIndex();
        for (let i = 1; i < count; i++) {
            const clone = instantiate(node);
            clone.name = `BgTile_${i}`;
            this.disableWidgetAlign(clone);
            const cloneTransform = clone.getComponent(UITransform);
            if (cloneTransform) cloneTransform.setContentSize(width, height);
            const cloneSprite = clone.getComponent(Sprite);
            if (cloneSprite && frames) {
                cloneSprite.trim = true;
                cloneSprite.spriteFrame = frames.main;
            }
            if (frames) this.addSeamFadeStrips(clone, frames, width, false);
            parent.addChild(clone);
            clone.setSiblingIndex(baseIndex + i);
            this.m_BackgroundTiles.push(clone);
        }

        // 克隆完再给**本体**补条带（顺序见上面注释：先加会被克隆复制成双份）
        if (frames) this.addSeamFadeStrips(node, frames, width, true);

        this.updateBackground();
        // 裁掉末尾 fadeRows 行后，同一块高度里的内容变少 → 纵向被拉伸这么多次（很小，但要如实打出来）
        const stretch = frames ? frame.rect.height / (frame.rect.height - GameTuning.backgroundSeamFadeRows) : 1;
        console.log(
            `[BattleView] 背景=真实美术 m_GameBg 块数=${count} 周期=${spacing.toFixed(2)} 拉伸=${stretch.toFixed(4)}× ` +
                `贴图=${frame.rect.width}x${frame.rect.height} 淡出=${frames ? GameTuning.backgroundSeamFadeRows + '行×' + frames.strips.length + '条' : '关'}`
        );
        return true;
    }

    /** 关掉节点上的 Widget 对齐（`alignMode=ALWAYS` 会每帧改 y，与滚动冲突）；没有 Widget 就什么都不做 */
    private disableWidgetAlign(node: Node): void {
        const widget = node.getComponent(Widget);
        if (widget) widget.enabled = false;
    }

    /**
     * 造背景块的贴图帧：**主图**（裁掉末尾若干行）+ **淡入淡出条带**。
     *
     * ── 为什么必须裁帧，不能整图直接平铺 ──
     * `background/game_bg` 是整屏插画、首尾不相接（实测接缝行差 = 相邻行平均差的 **6.27×**）。
     * 交叉淡入淡出要求"接缝两边在原图里本来就是相邻行"，所以：主图只显示原图第 `0 .. H-fadeRows-1` 行，
     * 每块**顶部**再用 alpha 从 1 降到 0 把被裁掉的那些行叠回来 → 块与块的接缝正好落在
     * 「原图第 H-fadeRows-1 行 / 第 H-fadeRows 行」这一对**相邻行**上（实测 0.78×，比普通相邻行还小）。
     *
     * ── 坐标系（容易搞反，写清楚）──
     * `SpriteFrame.rect.y` 的原点在图片**顶部**：引擎上传贴图时 `UNPACK_FLIP_Y_WEBGL=false`
     * → v=0 就是图片第一行，而 `_calculateUV()` 把"较大的 v"分给节点的**下边**
     * （`simple.ts` 里 `dataList[0]` = 左下角）。所以 `rect.y` 就是"从顶部数第几行"，
     * 裁掉末尾 = 主图 `rect.y` 不变、高度变小；条带 `rect.y` = 主图行数 + 条带偏移。
     *
     * 任何一步不成立（开关关掉 / 贴图太小 / 帧造不出来）→ 返回 null，调用方退化成"整图平铺"（有接缝）。
     */
    private buildBackgroundFrames(frame: SpriteFrame, tileWidth: number): BackgroundFrames | null {
        if (!GameTuning.backgroundSeamFade) return null;

        const rect = frame.rect;
        const textureHeight = rect.height;
        const fadeRows = GameTuning.backgroundSeamFadeRows;
        const contentRows = textureHeight - fadeRows;
        if (!Number.isFinite(textureHeight) || textureHeight <= 0 || contentRows <= 0) return null;

        // 主图铺满整块 → 每行显示高度；条带按"每条尽量 ≤ backgroundSeamFadeMaxStripPx"切分
        const rowScale = this.m_BackgroundTileLocalHeight / contentRows;
        const strips = seamFadeStrips(
            textureHeight,
            fadeRows,
            seamFadeStripCount(fadeRows, rowScale, GameTuning.backgroundSeamFadeMaxStripPx),
            this.m_BackgroundTileLocalHeight
        );
        if (strips.length === 0) return null;

        try {
            const main = this.makeCroppedFrame(frame, 0, contentRows);
            const stripFrames: SpriteFrame[] = [];
            for (let i = 0; i < strips.length; i++) {
                stripFrames.push(this.makeCroppedFrame(frame, strips[i].rectY, strips[i].rectHeight));
            }
            return { main, strips, stripFrames };
        } catch (error) {
            // 造帧失败不能让背景整个消失：退回整图平铺（有接缝，但一定能看）
            console.warn('[BattleView] 背景淡入淡出造帧失败，退回整图平铺', error);
            return null;
        }
    }

    /**
     * 造一张**裁剪过的**贴图帧副本（只改显示内容，不动原帧 —— 原帧还挂在 `m_GameBg` 上，收尾要还原）。
     *
     * `originalSize` 设成裁剪后尺寸 + `offset` 归零 ⇒ 引擎算出的 `trimmedBorder` = 0
     * ⇒ 无论 `Sprite.trim` 走哪条分支，几何都是"节点整块"（裁剪只影响 UV），不会画歪。
     */
    private makeCroppedFrame(source: SpriteFrame, rowOffset: number, rowHeight: number): SpriteFrame {
        const rect = source.rect;
        const copy = source.clone();
        // ⚠️ 这里**故意**不 import cc 的 `Vec2`：本文件已经有一个 `Vec2`（core/GameTypes 的
        // `{x,y}` 轻量类型），再 import 会撞名。就地 `set` 即可（getter 返回的是内部实例）。
        copy.offset.set(0, 0);
        copy.originalSize = new Size(rect.width, rowHeight);
        // rect.y 的原点是图片顶部（见 buildBackgroundFrames 的说明）
        copy.rect = new Rect(rect.x, rect.y + rowOffset, rect.width, rowHeight);
        return copy;
    }

    /**
     * 给一块背景补上**顶部淡入淡出条带**（每条一个常数 alpha，离散化线性渐变）。
     *
     * 条带是块的子节点 → 自动跟随块的位移与缩放；摆放以块的**顶边**为基准：
     * 第 i 条的顶边距块顶边 `strip.offsetFromTop`，所以中心 y = 顶边 − offset − 高度/2。
     * 主图本来就画着"原图第 0 行起"的内容，条带以 alpha 叠上去 ⇒
     * 合成结果 = `(1-w)·主图行 + w·被裁掉的行`（w 从 1 线性降到 0）—— 正是交叉淡入淡出。
     *
     * @param isSource 是否是 `m_GameBg` 本体（它的条带要记下来，收尾时显式销毁）
     */
    private addSeamFadeStrips(tile: Node, frames: BackgroundFrames, tileWidth: number, isSource: boolean): void {
        const topY = (1 - this.m_BackgroundTileAnchorY) * this.m_BackgroundTileLocalHeight;
        for (let i = 0; i < frames.strips.length; i++) {
            const strip = frames.strips[i];
            const node = makeNode(tile, `SeamFade_${i}`);
            const transform = node.addComponent(UITransform);
            transform.setContentSize(tileWidth, strip.displayHeight);
            const sprite = node.addComponent(Sprite);
            sprite.spriteFrame = frames.stripFrames[i];
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            sprite.trim = true;
            const opacity = node.addComponent(UIOpacity);
            opacity.opacity = Math.round(clamp(strip.alpha, 0, 1) * 255);
            setPos(node, 0, topY - strip.offsetFromTop - strip.displayHeight * 0.5);
            if (isSource) this.m_BackgroundFadeNodes.push(node);
        }
    }

    /**
     * **网格兜底**路径（v1.10 原始实现）：`Graphics` 画深色底 + 与格子对齐的网格线。
     *
     * 为什么网格能保证无缝：网格线间距 = `cellSize`，周期 `backgroundGridPatternHeight` = 768 = 6 格
     * → 图案以 H 为周期是**构造保证**的，回绕前后逐像素相同（见 core/ScrollWorld.ts 的不变量 ③）。
     *
     * 块数：块 k 的底边 = `m_BackgroundBottomY - offset + k × H`，块数由 `backgroundTileCount()`
     * 按「可视高度 + 一个周期」推出（本配置 = **3 块**），不是凭手感取 2：H(768) < 可视高(1408) 时
     * 两块盖不满，会出现空隙。
     */
    private createGridBackground(): void {
        const patternHeight = GameTuning.backgroundGridPatternHeight;
        const bounds = screenBounds();

        // 「绝不同时出现两份背景」：注入进来的真实背景节点在网格路径下要**藏起来**
        // （否则面板上还挂着那张美术图，网格叠在它上面 = 两份背景）。
        // 藏的是整个节点（active=false）而不是只关 Sprite：万一美术以后给它加了子节点也一起藏。
        if (this.m_BackgroundNode && this.m_BackgroundNode.isValid) {
            this.m_BackgroundSourceActive = this.m_BackgroundNode.active;
            this.m_BackgroundNodeHidden = true;
            this.m_BackgroundNode.active = false;
        }
        // 网格相位取出生线：背景网格线与敌人占格线永远重合（看得到"世界在动"）
        this.m_BackgroundBottomY = gridAlignedBottom(GameTuning.spawnLineY, bounds.bottom, GameTuning.cellSize);
        this.m_ScrollY = 0;

        this.m_BackgroundRoot = makeNode(this.m_FieldRoot, 'Background');
        const count = backgroundTileCount(bounds.top - this.m_BackgroundBottomY, patternHeight);

        for (let i = 0; i < count; i++) {
            const tile = makeNode(this.m_BackgroundRoot, `BgTile_${i}`);
            const transform = tile.addComponent(UITransform);
            transform.setContentSize(GameTuning.designWidth, patternHeight);
            // 底与线各用一个 Graphics 节点：同一个 Graphics 上"先 fill 再 stroke"会踩
            // 路径残留的坑（描边可能把底矩形也描一遍 → 块边界多出一条更暗的线 = 假接缝），
            // 拆成两个节点就完全不用赌引擎的路径清理行为。
            this.paintBackgroundBase(tile);
            this.paintBackgroundGrid(tile);
            this.m_BackgroundTiles.push(tile);
        }

        this.updateBackground();
    }

    /** 画一块背景的**深色底**（铺满该块的整个周期矩形） */
    private paintBackgroundBase(tile: Node): void {
        const node = makeNode(tile, 'Base');
        node.addComponent(UITransform).setContentSize(GameTuning.designWidth, GameTuning.backgroundGridPatternHeight);
        const g = node.addComponent(Graphics);
        const w = GameTuning.designWidth;
        const h = GameTuning.backgroundGridPatternHeight;
        g.fillColor = BG_BASE_COLOR;
        g.rect(-w * 0.5, -h * 0.5, w, h);
        g.fill();
    }

    /**
     * 画一块背景的**网格线**：横线间距 = `cellSize`（与格子对齐、跨块连续），竖线 = 棋盘列线。
     *
     * ⚠️ 横线只画「底边 + 内部」这 `h / cellSize` 条，**顶边留给上一块的底边**：
     * 每条线在整个世界里只被画一次。若图省事把上下边都画上，两条半透明线会精确重叠，
     * 每 H px 就出现一道更暗的横带 —— 那就是"接缝"，正是要避免的东西。
     */
    private paintBackgroundGrid(tile: Node): void {
        const node = makeNode(tile, 'Grid');
        node.addComponent(UITransform).setContentSize(GameTuning.designWidth, GameTuning.backgroundGridPatternHeight);
        const g = node.addComponent(Graphics);

        const w = GameTuning.designWidth;
        const h = GameTuning.backgroundGridPatternHeight;
        const halfW = w * 0.5;
        const halfH = h * 0.5;
        // 用 round 兜住 H 不是 cellSize 整数倍的情况：线照样等分该块，跨块仍然连续
        const lines = Math.max(1, Math.round(h / GameTuning.cellSize));
        const step = h / lines;

        g.lineWidth = BG_GRID_WIDTH;
        g.strokeColor = new Color(
            BG_GRID_COLOR.r,
            BG_GRID_COLOR.g,
            BG_GRID_COLOR.b,
            GameTuning.backgroundGridAlpha
        );

        // ① 横线：底边 + 内部（不含顶边，见上面注释）
        for (let i = 0; i < lines; i++) {
            const y = -halfH + i * step;
            g.moveTo(-halfW, y);
            g.lineTo(halfW, y);
        }

        // ② 竖线：与棋盘列线同一条格点阵（x 与滚动无关，所以永远与敌人列对齐）
        const left = boardLeftX();
        const startK = Math.ceil((-halfW - left) / GameTuning.cellSize);
        const endK = Math.floor((halfW - left) / GameTuning.cellSize);
        for (let k = startK; k <= endK; k++) {
            const x = left + k * GameTuning.cellSize;
            g.moveTo(x, -halfH);
            g.lineTo(x, halfH);
        }

        g.stroke();
    }

    private createPlayerAndCursor(): void {
        const bounds = screenBounds();
        this.m_PlayerX = 0;
        this.m_PlayerY = bounds.bottom + GameTuning.playerSpawnBottomOffset;
        const playerFrame = getArt(this.m_Art, GameArtPath.player);
        this.m_PlayerNode = createSprite(
            this.m_FieldRoot,
            'Player',
            playerFrame,
            GameTuning.cellSize,
            GameTuning.cellSize
        );
        // 玩家图原始 80×76：contain 适配到一格内，视觉上与一格敌人同量级
        const playerFit = applyContainFit(
            this.m_PlayerNode,
            playerFrame,
            GameTuning.cellSize,
            GameTuning.cellSize,
            GameTuning.artFitMargin
        );
        // 外围圆半径 = 玩家图（那只球）显示半径 + 5
        this.m_OrbitRadius =
            (playerFit ? Math.max(playerFit.width, playerFit.height) : GameTuning.cellSize) / 2 +
            GameTuning.cursorOrbitGap;
        setPos(this.m_PlayerNode, this.m_PlayerX, this.m_PlayerY);
        this.m_PlayerFeedback = HitFeedback.attach(
            this.m_PlayerNode,
            playerFrame,
            playerFit ? playerFit.width : GameTuning.cellSize,
            playerFit ? playerFit.height : GameTuning.cellSize,
            false
        );

        // 瞄准游标开局在屏幕正中（开场默认朝正上方打，§4）
        this.m_CursorX = 0;
        this.m_CursorY = 0;
        this.m_CursorNode = createSprite(
            this.m_PlayerNode,
            'Cursor',
            getArt(this.m_Art, GameArtPath.cursor),
            GameTuning.cellSize * 0.5,
            GameTuning.cellSize * 0.7
        );
        const orbitLocal = this.cursorOrbitLocal();
        setPos(this.m_CursorNode, orbitLocal.x, orbitLocal.y);

        // 瞄准辅助射线：必须在**任何敌人之前**建好，兄弟序才会是「背景 < 射线 < 敌人 < 飘字」
        this.createAimGuide();
    }

    /**
     * 建瞄准辅助射线的两个绘制层（主射线 / 首段反弹段）。
     *
     * 层级：作为 `m_FieldRoot` 的**最早**子节点创建，于是渲染顺序 = 射线 → 敌人 → 子弹/掉落/飘字，
     * 即**在敌人之下、背景之上**，不会遮挡敌人与飘字（玩家每帧被提到最上也仍然在射线之上）。
     * 分成两个节点是为了让两段用各自的不透明度 `aimGuideAlpha` / `aimGuideBounceAlpha`。
     */
    private createAimGuide(): void {
        this.m_AimRay = this.makeAimGuideLayer('AimRay');
        this.m_AimBounceRay = this.makeAimGuideLayer('AimBounceRay');
    }

    private makeAimGuideLayer(name: string): Graphics {
        const node = makeNode(this.m_FieldRoot, name);
        node.addComponent(UITransform);
        return node.addComponent(Graphics);
    }

    private createHud(): void {
        const top = GameTuning.designHeight / 2;
        this.m_HpLabel = createLabel(this.m_HudRoot, 'Hp', 'HP', 26, new Color(255, 170, 170, 255));
        this.m_HpLabel.node.setPosition(new Vec3(-230, top - 50, 0));

        this.m_MagazineLabel = createLabel(this.m_HudRoot, 'Magazine', '弹匣', 26, new Color(180, 230, 255, 255));
        this.m_MagazineLabel.node.setPosition(new Vec3(230, top - 50, 0));

        this.m_WaveLabel = createLabel(this.m_HudRoot, 'Wave', '波次', 24, Color.WHITE);
        this.m_WaveLabel.node.setPosition(new Vec3(0, top - 50, 0));

        this.m_ExpLabel = createLabel(this.m_HudRoot, 'Exp', '经验', 20, new Color(200, 210, 230, 255));
        this.m_ExpLabel.node.setPosition(new Vec3(-230, top - 92, 0));

        // 经验条（Graphics 自绘，不依赖素材）
        const barNode = makeNode(this.m_HudRoot, 'ExpBar');
        barNode.setPosition(new Vec3(-160, top - 96, 0));
        const barTransform = barNode.addComponent(UITransform);
        barTransform.setContentSize(240, 10);
        this.m_ExpBar = barNode.addComponent(Graphics);

        if (SHOW_DEBUG_HUD) {
            this.m_DebugLabel = createLabel(this.m_HudRoot, 'Debug', '', 18, new Color(150, 255, 190, 255));
            this.m_DebugLabel.node.setPosition(new Vec3(0, -GameTuning.designHeight / 2 + 30, 0));
        }

        // 素材没加载全时，屏幕顶部直接给一条红字（不用去翻控制台；缺图的精灵还会画洋红方块）
        if (gameArtCount(this.m_Art) < gameArtTotal()) {
            const warn = createLabel(
                this.m_HudRoot,
                'ArtWarn',
                `素材 ${gameArtCount(this.m_Art)}/${gameArtTotal()} 未全部加载，请看控制台 [GameArt] 日志`,
                22,
                new Color(255, 120, 120, 255)
            );
            warn.node.setPosition(new Vec3(0, top - 130, 0));
        }
        this.updateHud(true);
    }

    /** 组装各"仿真世界"：core 只管算，这里只管改数据和节点 */
    private createWorlds(): void {
        this.m_BulletWorld = {
            playerX: this.m_PlayerX,
            playerY: this.m_PlayerY,
            catchRadius: catchRadiusWithBonus(this.m_Stats.catchRadiusBonus),
            queryEnemies: (x: number, y: number, radius: number) => this.queryHittableEnemies(x, y, radius),
            onEnemyHit: (bullet: BulletRuntime, enemy: EnemyRuntime) => this.onBulletHitEnemy(bullet, enemy),
            onCaught: (bullet: BulletRuntime) => this.onBulletCaught(bullet),
        };
        this.m_EnemyWorld = {
            playerX: this.m_PlayerX,
            playerY: this.m_PlayerY,
            // 每帧由 updateScroll() 写入唯一滚动源的值（这里只是给个合法初值）
            scrollDelta: 0,
            onDiveHitPlayer: (_enemy: EnemyRuntime, damage: number) => this.onPlayerDamaged(damage),
            onDiveFinished: () => undefined,
        };
        this.m_DropWorld = {
            playerX: this.m_PlayerX,
            playerY: this.m_PlayerY,
            // 同上：每帧由 updateDrops() 写入**同一个** m_ScrollDelta（与敌人、背景同源）
            scrollDelta: 0,
            // 磁吸半径每帧现算（含技能 / 加点加成）；其余三项是静态数值
            magnetRadius: GameTuning.magnetRadius,
            pickupRadius: GameTuning.pickupRadius,
            magnetSpeed: GameTuning.magnetSpeed,
            autoCollectAtDiveLine: GameTuning.dropAutoCollectAtDiveLine,
        };
    }

    // ─────────── 主循环 ───────────

    update(dt: number): void {
        if (this.isPaused() || this.m_Finished) return;
        // 后台切回来会有长帧，夹一下避免一帧穿模 / 一波敌人瞬移到底
        const d = Math.min(Math.max(dt, 0), 0.05);
        this.m_Elapsed += d;

        this.updateFiring(d);
        this.updateSpawning(d);
        // 单一滚动源：**先**算本帧世界滚动位移（含世界暂停裁决），
        // **再**让三个消费者分别消费它 —— 顺序即"锁步"的可见形式：
        // 敌人（updateEnemies）→ 背景（updateBackground）→ 掉落物（updateDrops）
        this.updateScroll(d);
        this.updateEnemies(d);
        this.updateBackground();
        this.updateDrops(d);
        // 瞄准（兜底自动瞄准 + 浮标贴外围圆 + 辅助射线）放在敌人之后：
        // 用的是本帧最新的敌人位置，射线与真实弹道才对得上
        this.updateAim(d);
        this.m_PlayerFeedback?.update(d, this.m_PlayerX, this.m_PlayerY);
        this.updateBullets(d);
        this.updateWaveFlow(d);
        this.updateHud(false);
        this.updateDamageTexts(d);
        this.keepPlayerOnTop();
    }

    private isPaused(): boolean {
        return this.m_OverlayPaused || this.m_ExternalPaused;
    }

    /**
     * 浮标在玩家外围圆上的**局部**偏移：方向 = 玩家 → 瞄准点，半径固定。
     *
     * 浮标已**降级为纯方向标识**（不可拖动，操作方案 A），所以这里只负责"贴在玩家外围圆上"
     * 与"玩家贴近屏幕边缘时压回屏内"两件事，不再参与任何抓取判定。
     */
    private cursorOrbitLocal(): { x: number; y: number } {
        const dx = this.m_CursorX - this.m_PlayerX;
        const dy = this.m_CursorY - this.m_PlayerY;
        const len = Math.sqrt(dx * dx + dy * dy);
        const r = this.m_OrbitRadius > 0 ? this.m_OrbitRadius : GameTuning.cellSize;
        let ox = 0;
        let oy = r;
        if (len > 1e-4) {
            ox = (dx / len) * r;
            oy = (dy / len) * r;
        }
        // 玩家贴近屏幕边缘时把浮标压回屏幕内：保证任何位置都看得见（需求）
        const bounds = screenBounds();
        const m = CURSOR_FLOAT_EDGE_MARGIN;
        const wx = Math.min(Math.max(this.m_PlayerX + ox, bounds.left + m), bounds.right - m);
        const wy = Math.min(Math.max(this.m_PlayerY + oy, bounds.bottom + m), bounds.top - m);
        return { x: wx - this.m_PlayerX, y: wy - this.m_PlayerY };
    }

    /** 浮标贴到玩家外围圆上（浮标是玩家子节点，给局部坐标即可） */
    private syncCursorNode(): void {
        if (!this.m_CursorNode || !this.m_CursorNode.isValid) return;
        const orbit = this.cursorOrbitLocal();
        setPos(this.m_CursorNode, orbit.x, orbit.y);
    }

    /**
     * 设置瞄准点并**手动接管**：夹进屏幕内、立即生效，并把自动瞄准空闲计时清零。
     * 只有瞄准触摸（按下 / 移动）会走这里 —— 拖动玩家不走，所以走位不打断自动瞄准。
     */
    private setAimTarget(x: number, y: number): void {
        const next = clampCursorPosition(x, y, CURSOR_CLAMP_RADIUS);
        this.m_CursorX = next.x;
        this.m_CursorY = next.y;
        this.m_AimIdle = 0;
        this.syncCursorNode();
    }

    /**
     * 每帧的瞄准更新：兜底自动瞄准 → 浮标贴圆 → 画辅助射线。
     *
     * 兜底自动瞄准（附录 J）：空闲计时只被瞄准触摸清零，累加到 `autoAimDelay` 秒后
     * 每帧把瞄准点设为 `pickAutoAimTarget` 选出的**最近可命中敌人**；
     * 没有可命中敌人时**保持上一次方向**（不重置、也不清屏）。
     */
    private updateAim(d: number): void {
        this.m_AimIdle += d;

        const delay = GameTuning.autoAimDelay;
        if (delay > 0 && this.m_AimIdle >= delay) {
            const target = pickAutoAimTarget(this.m_PlayerX, this.m_PlayerY, this.m_Enemies);
            if (target) {
                const next = clampCursorPosition(target.x, target.y, CURSOR_CLAMP_RADIUS);
                this.m_CursorX = next.x;
                this.m_CursorY = next.y;
            }
        }

        this.syncCursorNode();
        this.drawAimGuide();
    }

    /**
     * 画瞄准辅助射线：主射线（玩家中心 → 第一次与**墙或敌人**相交）+ 首段反弹段（真实反射方向续画）。
     *
     * 顶点全部来自 core 纯函数 `traceAimGuide`，它与 `BulletSim` 共用同一套边界、判定形状与反射实现：
     * 顶/左/右墙镜面反射、遇敌按命中面反射（真实子弹撞敌人本来就只反弹不消失），
     * 底墙不反射（子弹在那里转入回身，射线到此为止）。
     * 传入当帧的 `m_Enemies`（本函数在 `updateEnemies` 之后调用）→ 敌人移动后射线每帧自动重算。
     *
     * v1.9 补丁：折线不再画实线，先沿**累计弧长**切成虚线（`buildDashSegments()`：段长
     * `aimGuideDashLength` / 间隔 `aimGuideDashGap`，相位跨顶点连续 → 拐点处不断缝、也不重置相位），
     * 再按 `part` 把虚线分到两层：`part = 0`（主射线）进 `AimRay`，`part >= 1`（首段反弹，与旧实现
     * 「从第 2 个顶点起全部按更淡的画」同口径）进 `AimBounceRay` —— 两段因此各自保留
     * `aimGuideAlpha` / `aimGuideBounceAlpha`。每段小线**画两遍**实现描边，见 `strokeDashes()`。
     */
    private drawAimGuide(): void {
        const ray = this.m_AimRay;
        const bounce = this.m_AimBounceRay;
        if (!ray || !ray.isValid || !bounce || !bounce.isValid) return;

        // 每帧重画前先清空：关掉总开关时同样要清（否则上一帧的射线会留在画布上不消失）
        ray.clear();
        bounce.clear();
        if (!GameTuning.aimGuideEnabled) return;

        const verts = traceAimGuide(
            this.m_PlayerX,
            this.m_PlayerY,
            this.m_CursorX - this.m_PlayerX,
            this.m_CursorY - this.m_PlayerY,
            AIM_GUIDE_BOUNCE,
            GameTuning.aimGuideBounceLength,
            GameTuning.bulletRadius,
            this.m_Enemies
        );
        if (verts.length < 2) return; // 退化方向（瞄准点与玩家重合）：不画

        // phase 固定 0：虚线相位每帧都从玩家中心起算，所以不会随帧抖动
        const dashes = buildDashSegments(
            verts,
            GameTuning.aimGuideDashLength,
            GameTuning.aimGuideDashGap,
            0
        );
        if (dashes.length === 0) return; // 全是零长段（退化输入）：两层保持空

        this.strokeDashes(ray, dashes, true, GameTuning.aimGuideAlpha);
        this.strokeDashes(bounce, dashes, false, GameTuning.aimGuideBounceAlpha);
    }

    /**
     * 把虚线画到某一层：**每段小线画两遍** = 粗深色描边 + 正常宽度亮线（描边效果）。
     *
     * ① 描边遍：`lineWidth = aimGuideWidth + 2 * aimGuideOutline`（`aimGuideOutline` 是**单边**宽度），
     *    颜色 = 模块常量 `AIM_GUIDE_OUTLINE` 的 RGB + `aimGuideOutlineAlpha`；
     * ② 亮线遍：宽度恢复 `aimGuideWidth`，颜色为半透明白（alpha 由调用方按「主射线 / 反弹段」给）。
     *
     * 两遍都是「先 moveTo/lineTo 攒齐本层所有小段、再 stroke() 一次」：粗深色先落进渲染数据，
     * 亮线再压在上面 → 亮线盖住描边中心，两侧各留 `aimGuideOutline` px 的深色边。
     *
     * @param wantMain true = 只画主射线段（`part = 0`）；false = 只画反弹段（`part >= 1`）
     */
    private strokeDashes(layer: Graphics, dashes: DashSegment[], wantMain: boolean, alpha: number): void {
        const width = GameTuning.aimGuideWidth;
        const outline = GameTuning.aimGuideOutline;

        /** 攒齐本层所有小段后 stroke 一次（两遍共用：只有 lineWidth / strokeColor 不同） */
        const strokePath = (): void => {
            for (let i = 0; i < dashes.length; i++) {
                const s = dashes[i];
                if ((s.part === 0) !== wantMain) continue;
                layer.moveTo(s.x1, s.y1);
                layer.lineTo(s.x2, s.y2);
            }
            layer.stroke();
        };

        // ① 描边遍：更粗的深色线（比亮线单边宽 outline px）
        layer.lineWidth = width + 2 * outline;
        layer.strokeColor = new Color(
            AIM_GUIDE_OUTLINE.r,
            AIM_GUIDE_OUTLINE.g,
            AIM_GUIDE_OUTLINE.b,
            GameTuning.aimGuideOutlineAlpha
        );
        strokePath();

        // ② 亮线遍：正常宽度的半透明白，压在描边中心上
        layer.lineWidth = width;
        layer.strokeColor = new Color(255, 255, 255, alpha);
        strokePath();
    }

    /** 玩家（含子节点瞄准浮标）恒在最上层：敌人 / 子弹 / 掉落都是后生成的，兄弟序会盖住玩家 */
    private keepPlayerOnTop(): void {
        if (!this.m_PlayerNode || !this.m_PlayerNode.isValid) return;
        const parent = this.m_PlayerNode.parent;
        if (!parent) return;
        const last = parent.children.length - 1;
        if (this.m_PlayerNode.getSiblingIndex() !== last) this.m_PlayerNode.setSiblingIndex(last);
    }

    /** 自动开火：每 fireInterval 一发，弹匣空了就等回收（§6.1） */
    private updateFiring(d: number): void {
        // 第一行怪出生并开始下移之前不许发射
        if (!this.m_FireUnlocked) {
            if (!this.m_Enemies.some(isHittable)) return;
            this.m_FireUnlocked = true;
        }
        this.m_FireTimer += d;
        const magazineFree = this.m_Stats.bulletCount - this.m_MagazineOut;
        if (this.m_FireTimer < this.m_Stats.fireInterval || magazineFree <= 0) return;

        this.m_FireTimer = 0;
        this.fireFromMagazine();
    }

    private fireFromMagazine(): void {
        const dir = aimVelocity(this.m_PlayerX, this.m_PlayerY, this.m_CursorX, this.m_CursorY, this.m_Stats.bulletSpeed);
        const bullet = createBullet(this.m_NextId++, this.m_PlayerX, this.m_PlayerY, dir.vx, dir.vy, true);
        this.m_Bullets.push(bullet);
        this.m_MagazineOut++;

        const node = createSprite(
            this.m_FieldRoot,
            `Bullet_${bullet.id}`,
            getArt(this.m_Art, GameArtPath.bullet),
            GameTuning.cellSize * 0.25,
            GameTuning.cellSize * 0.375
        );
        faceVelocity(node, bullet.vx, bullet.vy);
        setPos(node, bullet.x, bullet.y);
        this.m_BulletNodes.set(bullet.id, node);
    }

    private updateBullets(d: number): void {
        if (this.m_Bullets.length === 0) return;

        // 把玩家位置与回收半径同步给仿真（回身子弹每帧锁定玩家）
        this.m_BulletWorld.playerX = this.m_PlayerX;
        this.m_BulletWorld.playerY = this.m_PlayerY;
        this.m_BulletWorld.catchRadius = catchRadiusWithBonus(this.m_Stats.catchRadiusBonus);

        const caught: number[] = [];
        for (let i = 0; i < this.m_Bullets.length; i++) {
            const bullet = this.m_Bullets[i];
            const result = stepBullet(bullet, d, this.m_BulletWorld);
            if (result.caught) caught.push(bullet.id);

            const node = this.m_BulletNodes.get(bullet.id);
            if (node && node.isValid) {
                setPos(node, bullet.x, bullet.y);
                faceVelocity(node, bullet.vx, bullet.vy);
            }
        }

        if (caught.length > 0) this.removeBullets(caught);
    }

    /** 回收：返还弹匣账本并销毁节点 */
    private onBulletCaught(bullet: BulletRuntime): void {
        if (bullet.fromMagazine) {
            this.m_MagazineOut = Math.max(0, this.m_MagazineOut - 1);
        } else {
            this.m_FreeBulletsOut = Math.max(0, this.m_FreeBulletsOut - 1);
        }
    }

    private removeBullets(ids: number[]): void {
        const idSet = new Set(ids);
        this.m_Bullets = this.m_Bullets.filter(b => !idSet.has(b.id));
        ids.forEach(id => {
            const node = this.m_BulletNodes.get(id);
            if (node && node.isValid) node.destroy();
            this.m_BulletNodes.delete(id);
        });
    }

    /** 按出生计划生成敌人 */
    private updateSpawning(d: number): void {
        if (this.m_SpawnIndex >= this.m_SpawnEvents.length) return;
        this.m_SpawnTimer += d;
        while (this.m_SpawnIndex < this.m_SpawnEvents.length) {
            const event = this.m_SpawnEvents[this.m_SpawnIndex];
            if (event.delay > this.m_SpawnTimer) break;
            this.spawnEnemy(event.spec);
            this.m_SpawnIndex++;
        }
    }

    private spawnEnemy(spec: EnemySpawnSpec): void {
        const enemy = createEnemyRuntime(spec, this.m_Wave, this.m_NextId++);
        this.m_Enemies.push(enemy);

        const cell = GameTuning.cellSize;
        const boxW = enemy.cols * cell;
        const boxH = enemy.rows * cell;

        // 敌人根节点只负责定位 / 缩放 / 受击表现，自身不画东西
        const node = makeNode(this.m_FieldRoot, `Enemy_${enemy.id}`);
        if (!node.getComponent(UITransform)) node.addComponent(UITransform);
        applyCellSize(node, enemy.cols, enemy.rows);

        // ① 品质底图：**整只敌人一张**，拉伸铺满整个占格（用户拍板：接受横向拉长变形）
        const paths = enemyArtPaths(enemy.defId, enemy.shape, enemy.quality);
        const tileFrame = getArt(this.m_Art, paths.base);
        const tile = createSprite(node, 'Base', tileFrame, boxW, boxH);
        setPos(tile, 0, 0);
        // 九宫格：底图拉伸铺满占格时只拉伸中间，保住四角与描边（否则大怪底图会糊）
        applyNineSlice(tile, tileFrame, GameTuning.baseSliceInset);

        // ② 怪物图：
        //    一格 / 两格 → **一格一张**（两格怪两格各一张，把占格铺满）
        //    4 / 6 / 8 格 → **一张放大图**铺在占格中间（走 Boss_001-003）
        const monsterFrame = getArt(this.m_Art, paths.monster);
        const perCellArt = enemy.cols * enemy.rows <= 2;
        const feedbackList: Array<{ fb: HitFeedback; bx: number; by: number }> = [];

        if (perCellArt) {
            for (let r = 0; r < enemy.rows; r++) {
                for (let c = 0; c < enemy.cols; c++) {
                    const cx = (c - (enemy.cols - 1) * 0.5) * cell;
                    const cy = ((enemy.rows - 1) * 0.5 - r) * cell;
                    const art = createSprite(node, `Monster_${r}_${c}`, monsterFrame);
                    const fit = applyContainFit(art, monsterFrame, cell, cell, GameTuning.artFitMargin);
                    setPos(art, cx, cy);
                    // 闪白挂在这一格上：模板尺寸用该格怪物图的实际尺寸（用占格尺寸会与轮廓错位）
                    feedbackList.push({
                        fb: HitFeedback.attach(art, monsterFrame, fit ? fit.width : cell, fit ? fit.height : cell, true),
                        bx: cx,
                        by: cy,
                    });
                }
            }
        } else {
            const art = createSprite(node, 'Monster', monsterFrame);
            // 一张放大图：contain 到整个占格（margin 给 1，尽量占满且不拉变形）
            const fit = applyContainFit(art, monsterFrame, boxW, boxH, 1);
            feedbackList.push({
                fb: HitFeedback.attach(art, monsterFrame, fit ? fit.width : boxW, fit ? fit.height : boxH, true),
                bx: 0,
                by: 0,
            });
        }

        setPos(node, enemy.x, enemy.y);
        setScale(node, enemyVisualScale(enemy));
        this.m_EnemyNodes.set(enemy.id, node);
        this.m_EnemyFeedback.set(enemy.id, feedbackList);
    }

    /**
     * **单一滚动源**：每帧只在这里算一次世界滚动位移，背景与敌人共用（绝无第二套速度）。
     *
     * ① 速度 = 当前波的 `waveScaling(wave).fallSpeed` —— 语义与 v1.9 完全一致
     *    （第 1 波 20 px/s、每波 +8%、上限 ×2.5），只是它现在**同时**就是背景滚动速度；
     * ② 世界暂停：`applyStopBlocking()` 在「任一敌人停住（到底 Telegraph / 被技能定住 frozen）」
     *    时返回 true → `effectiveScrollDelta()` 令 `delta = 0`
     *    → **背景与敌人一起静止**，恢复后一起继续（v1.5「全场停止」的设计意图保持不变，
     *    同时消灭了「敌人停了背景还在滚」的穿帮）；
     * ③ 累计量按背景周期回绕存储，长期运行不丢精度（对外表现连续）。
     */
    private updateScroll(d: number): void {
        // 全场停止：只要有敌人停住不动（到底 / 被技能定住），整个世界一起停
        const worldPaused = applyStopBlocking(this.m_Enemies);
        const step = advanceWorldScroll(
            this.m_ScrollY,
            waveScaling(this.m_Wave).fallSpeed,
            d,
            worldPaused,
            this.backgroundFieldPeriod()
        );
        this.m_ScrollDelta = step.delta;
        this.m_ScrollY = step.scrollY;
    }

    /** 当前「场空间 → 背景块空间」的视觉换算系数（**每帧现算**：旋屏/缩放变化也不会错位） */
    private backgroundSpaceScaleNow(): number {
        const parentScale =
            this.m_BackgroundParent && this.m_BackgroundParent.isValid ? this.m_BackgroundParent.worldScale.y : 1;
        return backgroundSpaceScale(this.node.worldScale.y, parentScale);
    }

    /**
     * 背景**回绕周期**（场空间单位）——`advanceWorldScroll()` 用它把累计量取模。
     *
     * · 网格路径：`backgroundGridPatternHeight`（显式值，必须整除 `cellSize`）；
     * · 真实美术路径：块间距 ÷ 空间换算系数（自动时块间距 = 块的显示高度，于是周期的
     *   **视觉**长度恰好等于一块 ⇒ 回绕瞬间整组块只是"整体下移一块"，画面逐像素不变）。
     */
    private backgroundFieldPeriod(): number {
        if (!this.m_BackgroundUsesNode) return GameTuning.backgroundGridPatternHeight;
        const period = this.m_BackgroundTileSpacing / this.backgroundSpaceScaleNow();
        return Number.isFinite(period) && period > 0 ? period : FALLBACK_PATTERN_HEIGHT;
    }

    /**
     * 背景随世界滚动：**只读** `m_ScrollDelta` / `m_ScrollY`，自己不算任何速度。
     *
     * 真实美术路径（块活在面板空间）：
     *   · 摆位只用现成的 `wrapBackgroundOffset()` / `backgroundTileBottomY()`，**没有第二套滚动数学**；
     *   · 唯一多出来的一步是**空间换算**：`offset(面板) = m_ScrollY(场) × 空间系数`，
     *     于是背景与敌人在屏幕上的位移**严格相等**（窄高屏上 `m_GameRoot` 有 contain 缩放）；
     *   · 世界暂停时 `m_ScrollY` 不变 → offset 不变 → 背景与敌人**一起**停（验证见单测）。
     *
     * 网格路径：与 v1.10 完全一致（场空间、格子对齐基准）。
     */
    private updateBackground(): void {
        if (this.m_BackgroundTiles.length === 0) return;

        if (this.m_BackgroundUsesNode) {
            const spacing = this.m_BackgroundTileSpacing;
            const offset = wrapBackgroundOffset(this.m_ScrollY * this.backgroundSpaceScaleNow(), spacing);
            for (let i = 0; i < this.m_BackgroundTiles.length; i++) {
                const tile = this.m_BackgroundTiles[i];
                if (!tile || !tile.isValid) continue;
                const bottom = backgroundTileBottomY(this.m_BackgroundBottomY, offset, spacing, i);
                // 底边 → 节点 position：锚点默认 0.5，所以 + 半个**显示**高度
                setPos(tile, tile.position.x, bottom + this.m_BackgroundTileAnchorY * this.m_BackgroundTileDisplayHeight);
            }
            return;
        }

        const patternHeight = GameTuning.backgroundGridPatternHeight;
        const offset = this.m_ScrollY;
        for (let i = 0; i < this.m_BackgroundTiles.length; i++) {
            const bottomY = backgroundTileBottomY(this.m_BackgroundBottomY, offset, patternHeight, i);
            setPos(this.m_BackgroundTiles[i], 0, bottomY + patternHeight * 0.5);
        }
    }

    private updateEnemies(d: number): void {
        if (this.m_Enemies.length === 0) return;
        this.m_EnemyWorld.playerX = this.m_PlayerX;
        this.m_EnemyWorld.playerY = this.m_PlayerY;
        // 敌人只消费本帧的世界滚动位移（**与背景同一个值**）：
        // 全场停止的裁决已经在 updateScroll() 里做完，并已体现为 m_ScrollDelta = 0
        this.m_EnemyWorld.scrollDelta = this.m_ScrollDelta;

        const dead: number[] = [];
        for (let i = 0; i < this.m_Enemies.length; i++) {
            const enemy = this.m_Enemies[i];
            stepEnemy(enemy, d, this.m_EnemyWorld);

            const node = this.m_EnemyNodes.get(enemy.id);
            if (node && node.isValid) {
                setPos(node, enemy.x, enemy.y);
                setScale(node, enemyVisualScale(enemy));
                // 震动改的是节点位置，所以必须在本帧基准位置定好之后再更新
                const feedbackList = this.m_EnemyFeedback.get(enemy.id);
                for (let f = 0; feedbackList && f < feedbackList.length; f++) {
                    feedbackList[f].fb.update(d, feedbackList[f].bx, feedbackList[f].by);
                }
            }
            if (isDead(enemy)) dead.push(enemy.id);
        }
        if (dead.length > 0) this.removeEnemies(dead);
    }

    private removeEnemies(ids: number[]): void {
        const idSet = new Set(ids);
        this.m_Enemies = this.m_Enemies.filter(e => !idSet.has(e.id));
        ids.forEach(id => {
            const node = this.m_EnemyNodes.get(id);
            if (node && node.isValid) node.destroy();
            this.m_EnemyNodes.delete(id);
            this.m_EnemyFeedback.delete(id);
        });
    }

    /** 子弹命中敌人：扣血 → 可能死亡 → 掉落 */
    private onBulletHitEnemy(_bullet: BulletRuntime, enemy: EnemyRuntime): void {
        if (!isHittable(enemy) || enemy.hp <= 0) return;
        // 暴击判定：读玩家属性（可被天赋/词条提升）；普通/暴击飘字颜色不同
        const crit = this.m_Rng.next() < this.m_Stats.critChance;
        const dmg = Math.max(1, Math.round(this.m_Stats.bulletDamage * (crit ? this.m_Stats.critMul : 1)));
        enemy.hp -= dmg;
        this.spawnDamageText(enemy.x, enemy.y, dmg, crit, false);

        // 命中即闪白 + 震动（致死那一下也闪，观感上"打中了"更明确）
        const feedbackList = this.m_EnemyFeedback.get(enemy.id);
        for (let i = 0; feedbackList && i < feedbackList.length; i++) feedbackList[i].fb.trigger();
        if (enemy.hp > 0) return;

        killEnemy(enemy);
        this.m_Kills++;
        this.spawnDrops(enemy);
    }

    /** 飘伤害数字：敌人（普通/暴击）与玩家（普通/暴击）四种颜色（需求） */
    private spawnDamageText(x: number, y: number, value: number, crit: boolean, isPlayer: boolean): void {
        const color = isPlayer ? (crit ? DMG_PLAYER_CRIT : DMG_PLAYER) : (crit ? DMG_ENEMY_CRIT : DMG_ENEMY);
        const size = Math.round(GameTuning.cellSize * (crit ? 0.34 : 0.26));
        const label = createLabel(this.m_FieldRoot, `Dmg_${value}`, crit ? `${value}!` : `${value}`, size, color);
        // 描边 + 加粗（需求 6）
        label.isBold = true;
        label.enableOutline = true;
        label.outlineColor = DMG_OUTLINE;
        label.outlineWidth = GameTuning.damageTextOutline;
        // 出生点：圆形内均匀随机（√u × 半径），避免连击时数字叠在同一位置（需求）
        const sc = GameTuning.damageTextScatter;
        const an = this.m_Rng.next() * Math.PI * 2;
        const rd = Math.sqrt(this.m_Rng.next()) * sc;
        const px = x + Math.cos(an) * rd;
        const py = y + Math.sin(an) * rd;
        setPos(label.node, px, py);
        // 从 0 放大（需求 6）
        label.node.setScale(0, 0, 1);
        this.m_DamageTexts.push({ node: label.node, x0: px, y0: py, life: GameTuning.damageTextLife });
    }

    /** 伤害飘字：上浮 + 缩小 + 到期销毁 */
    private updateDamageTexts(d: number): void {
        if (this.m_DamageTexts.length === 0) return;
        for (let i = this.m_DamageTexts.length - 1; i >= 0; i--) {
            const t = this.m_DamageTexts[i];
            t.life -= d;
            if (t.life <= 0 || !t.node.isValid) {
                if (t.node.isValid) t.node.destroy();
                this.m_DamageTexts.splice(i, 1);
                continue;
            }
            const life = GameTuning.damageTextLife;
            const passed = life - t.life;
            const pop = GameTuning.damageTextPop;
            const peak = GameTuning.damageTextPopScale;
            // ① 弹出：0 → peak　② 回稳：peak → 1　③ 尾段缩到 0.85
            let sc: number;
            if (passed < pop) sc = peak * (passed / pop);
            else if (passed < pop * 2) sc = peak - (peak - 1) * ((passed - pop) / pop);
            else sc = 1 - 0.15 * ((passed - pop * 2) / Math.max(1e-4, life - pop * 2));
            t.node.setScale(sc, sc, 1);
            // 向上飘：缓出（先快后慢）
            const rk = 1 - (1 - passed / life) * (1 - passed / life);
            t.node.setPosition(t.x0, t.y0 + GameTuning.damageTextRise * rk, 0);
        }
    }

    /**
     * 击杀掉落：经验水晶必掉，金币/魂晶/超级水晶按品质与类型（需求 4）。
     *
     * v1.10：掉落物生成后**自身不动**（世界里静止），随世界滚动一起下移（core/DropSim.ts）。
     */
    private spawnDrops(enemy: EnemyRuntime): void {
        const rng = this.m_Rng;
        const scatter = GameTuning.dropScatterRadius;

        // 经验水晶：每次击杀必掉 1 枚（经验值由品质 × 类型决定）
        this.addDrop(DropKind.Exp, enemyExpValue(enemy.quality, enemy.type), enemy.x, enemy.y, scatter);

        // 金币：数量按品质 0~8 枚（普通怪 35% 概率，精英及以上必掉）；总值仍按配置表，拆成多枚
        const coinChance = enemy.type === EnemyType.Normal ? 0.35 : 1;
        if (RandomUtil.chance(rng, coinChance)) {
            const coins = COIN_COUNT_BY_QUALITY[enemy.quality] ?? 0;
            if (coins > 0) {
                const unit = Math.max(1, Math.round(enemyCoinValue(enemy.quality, enemy.type) / coins));
                for (let i = 0; i < coins; i++) this.addDrop(DropKind.Coin, unit, enemy.x, enemy.y, scatter);
            }
        }

        // 魂晶：击杀 BOSS / 精英掉落，品质越高越大（value）× 越多（枚数）（需求 4）
        if (enemySoulValue(enemy.type) > 0) {
            const tier = Math.floor(enemy.quality / 2);
            const unit = Math.max(1, tier + 1);
            const count = Math.max(1, tier);
            for (let i = 0; i < count; i++) this.addDrop(DropKind.Soul, unit, enemy.x, enemy.y, scatter);
        }

        // 超级水晶：概率掉落
        const superCount = enemySuperCrystalCount(enemy.type, rng.next());
        if (superCount > 0) this.addDrop(DropKind.SuperCrystal, superCount, enemy.x, enemy.y, scatter);
    }

    private addDrop(kind: DropKind, value: number, x: number, y: number, scatter: number): void {
        // 在 0.2 格半径内随机方向散落（需求 4）：**只在这里算一次**，直接烘进 `drop.x / drop.y`
        // → 之后每帧**不再重算**（不会抖动）；它是"世界内偏移"，所以随世界滚动一起走
        const angle = this.m_Rng.next() * Math.PI * 2;
        const radius = Math.sqrt(this.m_Rng.next()) * scatter;
        const drop: DropRuntime = {
            id: this.m_NextId++,
            kind,
            x: x + Math.cos(angle) * radius,
            y: y + Math.sin(angle) * radius,
            vx: 0,
            vy: 0,
            value,
            life: GameTuning.dropLifeTime,
            magnetized: false,
        };
        this.m_Drops.push(drop);

        // 外观：经验水晶 / 金币 / 魂晶 / 超级水晶用各自的图；
        // 经验水晶按经验值放大、魂晶按品质放大（需求 4）
        const art = DROP_ART[kind];
        const cell = GameTuning.cellSize;
        const valueScale = kind === DropKind.Exp
            ? Math.min(GameTuning.dropExpMaxScale, 1 + (value - 1) * GameTuning.dropExpScalePerValue)
            : kind === DropKind.Soul
                ? Math.min(GameTuning.dropSoulMaxScale, 1 + (value - 1) * GameTuning.dropSoulScalePerValue)
                : 1;
        const size = cell * art.size * valueScale;
        const node = makeNode(this.m_FieldRoot, `Drop_${drop.id}`);
        const frame = getArt(this.m_Art, art.path);
        if (frame) {
            const sprite = createSprite(node, 'Art', frame, size, size);
            setPos(sprite, 0, 0);
        } else {
            // 素材缺失兜底（正常不会走到）
            const style = DROP_STYLE[kind];
            const transform = node.addComponent(UITransform);
            transform.setContentSize(style.radius * 2, style.radius * 2);
            const graphics = node.addComponent(Graphics);
            graphics.fillColor = style.color;
            graphics.circle(0, 0, style.radius);
            graphics.fill();
        }

        setPos(node, drop.x, drop.y);
        this.m_DropNodes.set(drop.id, node);
    }

    /**
     * 掉落物：**随世界滚动下移** → 磁吸 → 拾取 / 越俯冲线自动收取 → 超时消失。
     *
     * v1.10：掉落物是「**世界里的静止物体**」—— 散落偏移在生成时（`addDrop()`）算一次并
     * 烘进 `drop.x / drop.y`，之后**不再重算**（所以不会每帧抖动）；每帧的屏幕位移**全部**
     * 来自 `core/DropSim.ts` 的 `stepDrop()`，而它消费的 `m_DropWorld.scrollDelta` 就是
     * 敌人 / 背景用的**同一个** `m_ScrollDelta` → 三者**严格锁步**。
     *
     * 世界暂停（任一敌人停住）时 `m_ScrollDelta = 0` → 掉落物**一起停**（恢复后不跳位）；
     * 而**磁吸照常**：磁吸是**玩家侧**行为、不是世界滚动（与"俯冲不受世界暂停影响"同口径，
     * 见策划案附录 K-3），在 `stepDrop()` 里它**叠加**在滚动位移之上。
     *
     * 结算只有**一条**路径：`stepDrop()` 返回 `Collected`（正常拾取 **或** 越俯冲线自动收取，
     * 两者共用同一个结果值）→ 一律走既有的 `collectDrop()`；`Expired` 只移除、不结算（§11.3）。
     */
    private updateDrops(d: number): void {
        // 与 updateEnemies() 完全对称：每帧把最新的玩家位置与**同一个**世界滚动位移写进仿真世界
        this.m_DropWorld.playerX = this.m_PlayerX;
        this.m_DropWorld.playerY = this.m_PlayerY;
        // 磁吸半径含技能 / 外围加点加成 → 每帧现算
        this.m_DropWorld.magnetRadius = GameTuning.magnetRadius + this.m_Stats.magnetRadiusBonus;
        this.m_DropWorld.scrollDelta = this.m_ScrollDelta;

        if (this.m_Drops.length === 0) return;
        const removed: number[] = [];

        for (let i = 0; i < this.m_Drops.length; i++) {
            const drop = this.m_Drops[i];
            const outcome = stepDrop(drop, d, this.m_DropWorld);

            if (outcome === DropOutcome.Collected) {
                this.collectDrop(drop); // ← 唯一结算入口：拾取与"越俯冲线自动收取"共用它
                removed.push(drop.id);
                continue;
            }
            if (outcome === DropOutcome.Expired) {
                removed.push(drop.id); // 超时也走同一条移除路径（移除但**不**结算）
                continue;
            }

            const node = this.m_DropNodes.get(drop.id);
            if (node && node.isValid) setPos(node, drop.x, drop.y);
        }

        if (removed.length > 0) {
            const idSet = new Set(removed);
            this.m_Drops = this.m_Drops.filter(drop => !idSet.has(drop.id));
            removed.forEach(id => {
                const node = this.m_DropNodes.get(id);
                if (node && node.isValid) node.destroy();
                this.m_DropNodes.delete(id);
            });
        }
    }

    private collectDrop(drop: DropRuntime): void {
        switch (drop.kind) {
            case DropKind.Exp: {
                const levels = grantExp(this.m_Stats, drop.value);
                if (levels > 0) this.m_PendingLevelUps += levels;
                break;
            }
            case DropKind.Coin:
                this.m_Coins += drop.value;
                break;
            case DropKind.Soul:
                this.m_Souls += drop.value;
                break;
            case DropKind.SuperCrystal:
                this.m_SuperCrystals += drop.value;
                break;
            default:
                break;
        }
    }

    /** 一波打完 → 下一波；全部波次打完 → 过关 */
    private updateWaveFlow(d: number): void {
        const spawnedAll = this.m_SpawnIndex >= this.m_SpawnEvents.length;
        if (!spawnedAll || this.m_Enemies.length > 0) {
            this.m_WaveClearTimer = 0;
            return;
        }

        this.m_WaveClearTimer += d;
        if (this.m_WaveClearTimer < WAVE_INTERVAL) return;
        this.m_WaveClearTimer = 0;

        if (this.m_Wave >= GameTuning.wavesPerLevel) {
            this.finishLevel();
            return;
        }
        this.startWave(this.m_Wave + 1);
    }

    private startWave(wave: number): void {
        this.m_Wave = wave;
        const isFinalWave = wave >= GameTuning.wavesPerLevel;
        const plan = buildWavePlan(wave, this.m_Rng, { isFinalWave });
        this.m_SpawnEvents = buildSpawnSchedule(plan);
        this.m_SpawnIndex = 0;
        this.m_SpawnTimer = 0;
        this.m_WaveClearTimer = 0;
        console.log(`[BattleView] 第 ${wave} 波：${plan.bands.length} 带 / ${plan.totalRows} 行 / ${this.m_SpawnEvents.length} 个敌人`);
        this.updateHud(true);
    }

    // ─────────── 三选一与结算 ───────────

    /** 开局天赋三选一：抽 3 个可用技能，选完才开始跑 */
    private showTalentChoice(): void {
        const choices = pickSkillChoices(this.m_Rng, this.m_SkillLevels);
        if (choices.length === 0) return;

        this.m_OverlayPaused = true;
        this.m_Overlay = showChoiceOverlay(
            this.m_HudRoot,
            '开局天赋 · 三选一',
            this.toOverlayOptions(choices),
            index => {
                this.applySkill(choices[index]);
                this.m_Overlay = null;
                this.m_OverlayPaused = false;
            }
        );
    }

    /** 升级三选一：满级技能不出现；连升多级会连续弹 */
    private showLevelUpChoice(): void {
        if (this.m_PendingLevelUps <= 0 || this.m_Finished) return;
        const choices = pickSkillChoices(this.m_Rng, this.m_SkillLevels);
        if (choices.length === 0) {
            this.m_PendingLevelUps = 0;
            return;
        }
        this.m_PendingLevelUps--;

        this.m_OverlayPaused = true;
        this.m_Overlay = showChoiceOverlay(
            this.m_HudRoot,
            `升级！Lv${this.m_Stats.level} · 选择强化`,
            this.toOverlayOptions(choices),
            index => {
                this.applySkill(choices[index]);
                this.m_Overlay = null;
                this.m_OverlayPaused = false;
                this.showLevelUpChoice();
            }
        );
    }

    private toOverlayOptions(choices: readonly SkillDef[]): { title: string; desc: string }[] {
        return choices.map(skill => ({
            title: skill.name,
            desc: `${skill.desc}（${skillLevelText(this.m_SkillLevels, skill)}）`,
        }));
    }

    private applySkill(skill: SkillDef): void {
        skill.apply(this.m_Stats);
        markSkillLearned(this.m_SkillLevels, skill.id);
        console.log(`[BattleView] 技能 ${skill.name} → Lv${this.m_SkillLevels.get(skill.id)} ${describeStats(this.m_Stats)}`);
        this.updateHud(true);
    }

    private buildResult(): BattleResult {
        return {
            level: this.m_Options?.level ?? 1,
            wave: this.m_Wave,
            kills: this.m_Kills,
            timeSec: Math.round(this.m_Elapsed),
            coins: this.m_Coins,
            souls: this.m_Souls,
            superCrystals: this.m_SuperCrystals,
        };
    }

    private onPlayerDamaged(damage: number): void {
        if (this.m_Finished) return;
        this.m_PlayerFeedback?.trigger();
        // 敌人攻击也会暴击（需求：不同伤害类型不同颜色）
        const pCrit = this.m_Rng.next() < this.m_Stats.critChance;
        const pDmg = pCrit ? Math.max(1, Math.round(damage * this.m_Stats.critMul)) : damage;
        const dead = damagePlayer(this.m_Stats, pDmg);
        this.spawnDamageText(this.m_PlayerX, this.m_PlayerY, pDmg, pCrit, true);
        if (dead) this.finishGameOver();
    }

    private finishGameOver(): void {
        if (this.m_Finished) return;
        this.m_Finished = true;
        this.m_OverlayPaused = true;

        const result = this.buildResult();
        this.m_Overlay = showMessageOverlay(
            this.m_HudRoot,
            '游戏结束',
            `关卡 ${result.level}　第 ${result.wave} 波　击杀 ${result.kills}`,
            ['重新开始', '返回主页'],
            index => {
                this.m_Overlay = null;
                if (index === 0) this.m_Options?.onRestart?.();
                else this.m_Options?.onExit?.();
            }
        );
        this.m_Options?.onGameOver?.(result);
    }

    private finishLevel(): void {
        if (this.m_Finished) return;
        this.m_Finished = true;
        this.m_OverlayPaused = true;

        const result = this.buildResult();
        this.m_Overlay = showMessageOverlay(
            this.m_HudRoot,
            `第 ${result.level} 关 完成`,
            `击杀 ${result.kills}　用时 ${result.timeSec}s　金币 ${result.coins}　魂晶 ${result.souls}`,
            ['下一关', '返回主页'],
            index => {
                this.m_Overlay = null;
                if (index === 0) this.m_Options?.onRestart?.();
                else this.m_Options?.onExit?.();
            }
        );
        this.m_Options?.onLevelClear?.(result);
    }

    // ─────────── 输入 ───────────

    /**
     * 操作方案 A（附录 J）：按下点到**玩家中心**的距离 `d` 决定这根手指干什么 ——
     *
     * · `d <= playerGrabRadius` → **移动玩家**（沿用相对偏移手感：`offset = 玩家位置 − 按下点`，
     *   移动时 `clampPlayerPosition(触摸点 + offset)`，点哪里都不会瞬移），**且不动瞄准方向**；
     * · 否则 → **瞄准**：立即把瞄准点设为按下点（点一下即调方向）并清零自动瞄准空闲计时。
     *
     * 两根手指用**独立 id**，互不抢占：玩家触摸只走移动分支、瞄准触摸只走瞄准分支，
     * 于是「一手按住玩家走位、一手在任意处调角度」可以同时生效。
     * 目标已被同类手指占用时**忽略**这根新手指（不降级成另一种操作）——
     * 否则「已经有一根手指在走位时，第二根手指按在玩家身上」会变成改瞄准方向，违反方案 A。
     */
    private onTouchStart(event: EventTouch): void {
        if (this.isPaused() || this.m_Finished) return;
        const local = this.toLocal(event);
        const touchId = event.getID();
        const onPlayer = distance(local.x, local.y, this.m_PlayerX, this.m_PlayerY) <= GameTuning.playerGrabRadius;

        if (onPlayer) {
            if (this.m_PlayerTouchId >= 0) return;
            this.m_PlayerTouchId = touchId;
            this.m_PlayerGrabOffset = { x: this.m_PlayerX - local.x, y: this.m_PlayerY - local.y };
            return;
        }

        if (this.m_AimTouchId >= 0) return;
        this.m_AimTouchId = touchId;
        this.setAimTarget(local.x, local.y);
    }

    private onTouchMove(event: EventTouch): void {
        if (this.isPaused() || this.m_Finished) return;
        const touchId = event.getID();
        const local = this.toLocal(event);

        // 玩家触摸：只移动，绝不碰瞄准点（拖动玩家不取消自动瞄准）
        if (touchId === this.m_PlayerTouchId) {
            const next = clampPlayerPosition(
                local.x + this.m_PlayerGrabOffset.x,
                local.y + this.m_PlayerGrabOffset.y,
                GameTuning.playerHitRadius
            );
            this.m_PlayerX = next.x;
            this.m_PlayerY = next.y;
            setPos(this.m_PlayerNode, this.m_PlayerX, this.m_PlayerY);
            return;
        }

        // 瞄准触摸：改方向 + 重新计时（手动接管）
        if (touchId === this.m_AimTouchId) this.setAimTarget(local.x, local.y);
    }

    /** 抬手：各自只清自己的 id，另一根手指完全不受影响（未登记的手指到这里自然什么都不做） */
    private onTouchEnd(event: EventTouch): void {
        const touchId = event.getID();
        if (touchId === this.m_PlayerTouchId) this.m_PlayerTouchId = -1;
        if (touchId === this.m_AimTouchId) this.m_AimTouchId = -1;
    }

    /** 屏幕坐标 → 本节点局部坐标（自动处理面板根节点的缩放） */
    private toLocal(event: EventTouch): Vec2 {
        const ui = event.getUILocation();
        const transform = this.node.getComponent(UITransform);
        if (!transform) return { x: ui.x - GameTuning.designWidth / 2, y: ui.y - GameTuning.designHeight / 2 };
        const local = transform.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
        return { x: local.x, y: local.y };
    }

    // ─────────── 查询与 HUD ───────────

    /** 子弹的敌人查询：只返回可命中的（出生动画中 / 已死的不参与） */
    private queryHittableEnemies(x: number, y: number, radius: number): EnemyRuntime[] {
        const result: EnemyRuntime[] = [];
        for (let i = 0; i < this.m_Enemies.length; i++) {
            const enemy = this.m_Enemies[i];
            if (!isHittable(enemy)) continue;
            if (circleHitsBox(x, y, radius, boxFromCells(enemy.x, enemy.y, enemy.cols, enemy.rows))) {
                result.push(enemy);
            }
        }
        return result;
    }

    private updateHud(force: boolean): void {
        const stats = this.m_Stats;
        if (this.m_HpLabel) this.m_HpLabel.string = `HP ${Math.ceil(stats.hp)}/${stats.maxHp}`;
        if (this.m_MagazineLabel) {
            const free = stats.bulletCount - this.m_MagazineOut;
            this.m_MagazineLabel.string = `弹匣 ${free}/${stats.bulletCount}`;
        }
        if (this.m_WaveLabel) this.m_WaveLabel.string = `关卡 ${this.m_Options?.level ?? 1}　波次 ${this.m_Wave}/${GameTuning.wavesPerLevel}`;

        const need = expToNextLevel(stats);
        if (this.m_ExpLabel) this.m_ExpLabel.string = `Lv${stats.level}　经验 ${Math.floor(stats.exp)}/${need}`;

        const ratio = need > 0 ? Math.min(1, stats.exp / need) : 0;
        if (force || Math.abs(ratio - this.m_LastExpRatio) > 0.001) {
            this.m_LastExpRatio = ratio;
            this.drawExpBar(ratio);
        }

        if (this.m_DebugLabel) {
            const bg = this.m_BackgroundUsesNode
                ? `真实美术 ${this.m_BackgroundTiles.length}块 周期${this.m_BackgroundTileSpacing.toFixed(0)} 系数${this.backgroundSpaceScaleNow().toFixed(2)}`
                : `网格 ${this.m_BackgroundTiles.length}块`;
            this.m_DebugLabel.string = `${describeStats(stats)}　敌 ${this.m_Enemies.length}　弹 ${this.m_Bullets.length}　掉 ${this.m_Drops.length}　素材 ${gameArtCount(this.m_Art)}/${gameArtTotal()}` +
                `　背景 ${bg}　滚 ${this.m_ScrollY.toFixed(0)}/${this.backgroundFieldPeriod().toFixed(0)}　d ${this.m_ScrollDelta.toFixed(2)}`;
        }
        if (this.m_PendingLevelUps > 0 && !this.m_OverlayPaused && !this.m_Finished) {
            this.showLevelUpChoice();
        }
    }

    private drawExpBar(ratio: number): void {
        if (!this.m_ExpBar || !this.m_ExpBar.isValid) return;
        const width = 240;
        const height = 10;
        this.m_ExpBar.clear();
        this.m_ExpBar.fillColor = new Color(40, 48, 64, 220);
        this.m_ExpBar.rect(-width / 2, -height / 2, width, height);
        this.m_ExpBar.fill();
        if (ratio > 0) {
            this.m_ExpBar.fillColor = new Color(120, 220, 255, 255);
            this.m_ExpBar.rect(-width / 2, -height / 2, width * ratio, height);
            this.m_ExpBar.fill();
        }
    }
}
