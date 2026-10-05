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
 */

import { _decorator, Button, Color, Component, EventTouch, Graphics, Input, Label, Node, SpriteFrame, UITransform, Vec3, input } from 'cc';
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
    circleHitsBox,
    clampCursorPosition,
    clampPlayerPosition,
    distance,
    screenBounds,
} from '../core/BoardMath';
import { BulletWorld, aimVelocity, createBullet, stepBullet } from '../core/BulletSim';
import { EnemyWorld, applyStopBlocking, enemyVisualScale, isDead, isHittable, killEnemy, pickAutoAimTarget, stepEnemy } from '../core/EnemySim';
import { buildDashSegments, traceAimGuide } from '../core/AimGuide';
import {
    catchRadiusWithBonus,
    enemyCoinValue,
    enemyExpValue,
    enemySoulValue,
    enemySuperCrystalCount,
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
    /** 失败回调 */
    onGameOver?: (result: BattleResult) => void;
    /** 过关回调 */
    onLevelClear?: (result: BattleResult) => void;
    /** 点「重新开始」 */
    onRestart?: () => void;
    /** 点「返回主页」 */
    onExit?: () => void;
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
        // 素材走 GameArt 内部的常驻缓存，这里不释放（避免释放路径写错导致贴图提前失效）
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

    /** 组装两个"世界"回调：core 只管算，这里只管改数据和节点 */
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
            onDiveHitPlayer: (_enemy: EnemyRuntime, damage: number) => this.onPlayerDamaged(damage),
            onDiveFinished: () => undefined,
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
        this.updateEnemies(d);
        // 瞄准（兜底自动瞄准 + 浮标贴外围圆 + 辅助射线）放在敌人之后：
        // 用的是本帧最新的敌人位置，射线与真实弹道才对得上
        this.updateAim(d);
        this.m_PlayerFeedback?.update(d, this.m_PlayerX, this.m_PlayerY);
        this.updateBullets(d);
        this.updateDrops(d);
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

    private updateEnemies(d: number): void {
        if (this.m_Enemies.length === 0) return;
        this.m_EnemyWorld.playerX = this.m_PlayerX;
        this.m_EnemyWorld.playerY = this.m_PlayerY;

        const dead: number[] = [];
        // 全场停止：只要有敌人停住不动（到底 / 被技能定住），所有敌人一律停止下落
        applyStopBlocking(this.m_Enemies);
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

    /** 击杀掉落：经验水晶必掉，金币/魂晶/超级水晶按品质与类型（需求 4） */
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
        // 在 0.2 格半径内随机方向散落（需求 4）
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

    /** 掉落物：磁吸 → 拾取 → 超时消失 */
    private updateDrops(d: number): void {
        if (this.m_Drops.length === 0) return;
        const magnetRadius = GameTuning.magnetRadius + this.m_Stats.magnetRadiusBonus;
        const collected: number[] = [];

        for (let i = 0; i < this.m_Drops.length; i++) {
            const drop = this.m_Drops[i];
            drop.life -= d;
            if (drop.life <= 0) {
                collected.push(drop.id); // 超时也走同一条移除路径
                continue;
            }

            const dist = distance(drop.x, drop.y, this.m_PlayerX, this.m_PlayerY);
            if (!drop.magnetized && dist <= magnetRadius) drop.magnetized = true;

            if (drop.magnetized && dist > GameTuning.pickupRadius) {
                const step = GameTuning.magnetSpeed * d;
                const ratio = Math.min(1, step / Math.max(dist, 0.001));
                drop.x += (this.m_PlayerX - drop.x) * ratio;
                drop.y += (this.m_PlayerY - drop.y) * ratio;
            }

            if (dist <= GameTuning.pickupRadius) {
                this.collectDrop(drop);
                collected.push(drop.id);
                continue;
            }

            const node = this.m_DropNodes.get(drop.id);
            if (node && node.isValid) setPos(node, drop.x, drop.y);
        }

        if (collected.length > 0) {
            const idSet = new Set(collected);
            this.m_Drops = this.m_Drops.filter(drop => !idSet.has(drop.id));
            collected.forEach(id => {
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
            this.m_DebugLabel.string = `${describeStats(stats)}　敌 ${this.m_Enemies.length}　弹 ${this.m_Bullets.length}　素材 ${gameArtCount(this.m_Art)}/${gameArtTotal()}`;
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
