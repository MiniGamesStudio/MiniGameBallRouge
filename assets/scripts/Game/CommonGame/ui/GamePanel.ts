import { _decorator, Button, Node, RichText, SpriteFrame, view } from 'cc';
import { ResManager } from '../../../engine/ResManager';
import { UIBase } from '../../../engine/ui/UIBase';
import { UIManager } from '../../../engine/ui/UIManager';
import { CommonBundleName, CommonUIID } from '../CommonUIConfig';
import { CommonGameProgress } from '../CommonGameProgress';
import { BattleWorld } from '../gameplay/BattleWorld';
import { ALL_GAMEPLAY_ASSETS, DefaultTuning, GameTuning, toSpriteFramePath } from '../gameplay/GameConfig';
const { ccclass, property } = _decorator;

const DESIGN_ROOT_WIDTH = 750;
const DESIGN_ROOT_HEIGHT = 1334;

/**
 * 游戏主面板 — 弹球 Roguelike Demo
 *
 * 玩法实现在 gameplay/ 下，这里只负责：装配数值、加载素材、驱动 BattleWorld、面板生命周期。
 */
@ccclass('GamePanel')
export class GamePanel extends UIBase {
    @property(Node)
    m_GameRoot: Node = null;
    @property(Button)
    m_PauseBtn: Button = null;
    @property(Button)
    m_SkillOneBtn: Button = null;
    @property(Button)
    m_SkillTwoBtn: Button = null;
    @property(Button)
    m_SkillThreeBtn: Button = null;
    @property(RichText)
    m_LevelText: RichText = null;

    @property({ tooltip: '默认打开的关卡，从 1 开始' })
    m_StartLevel: number = 1;
    @property({ tooltip: '游戏根节点设计宽度，用于按屏幕分辨率缩放' })
    m_DesignWidth: number = DESIGN_ROOT_WIDTH;
    @property({ tooltip: '游戏根节点设计高度，用于按屏幕分辨率缩放' })
    m_DesignHeight: number = DESIGN_ROOT_HEIGHT;
    @property({ tooltip: '游戏根节点最大缩放，1 表示不超过设计尺寸（保持清晰），可调大以在大屏铺满' })
    m_GameRootMaxScale: number = 1;

    @property({ tooltip: '【波次】每隔多少秒生成一波敌人（5~10 行）' })
    m_WaveInterval: number = DefaultTuning.waveInterval;
    @property({ tooltip: '【波次】单波最少行数' })
    m_WaveRowMin: number = DefaultTuning.waveRowMin;
    @property({ tooltip: '【波次】单波最多行数' })
    m_WaveRowMax: number = DefaultTuning.waveRowMax;
    @property({ tooltip: '【波次】波内每行敌人入场的间隔（秒）' })
    m_RowSpawnInterval: number = DefaultTuning.rowSpawnInterval;
    @property({ tooltip: '【敌人】整面敌人墙的下移速度（像素/秒）' })
    m_EnemyFallSpeed: number = DefaultTuning.enemyFallSpeed;
    @property({ tooltip: '【子弹】子弹发射间隔（秒），越小射速越快' })
    m_FireInterval: number = DefaultTuning.fireInterval;
    @property({ tooltip: '【子弹】同时在场的子弹总数。子弹撞敌人/撞屏幕四周只反弹，飞回玩家身上才回收' })
    m_BulletCount: number = DefaultTuning.bulletCount;
    @property({ tooltip: '【子弹】子弹飞行速度（像素/秒）' })
    m_BulletSpeed: number = DefaultTuning.bulletSpeed;
    @property({ tooltip: '【子弹】击中敌人时的反弹偏转角（度），在反射方向上再偏这么多。0 = 标准镜面反射' })
    m_BulletBounceAngle: number = DefaultTuning.bulletBounceAngle;
    @property({ tooltip: '【子弹】最多反弹几次就被回收（撞墙和撞敌人都算）。0 = 不限次数，只能飞回玩家身上回收' })
    m_BulletMaxBounce: number = DefaultTuning.bulletMaxBounce;
    @property({ tooltip: '【子弹】单发子弹伤害' })
    m_BulletDamage: number = DefaultTuning.bulletDamage;
    @property({ tooltip: '【敌人】俯冲玩家的速度（像素/秒）' })
    m_DiveSpeed: number = DefaultTuning.diveSpeed;
    @property({ tooltip: '【敌人】俯冲命中玩家扣的血量' })
    m_DiveDamage: number = DefaultTuning.diveDamage;
    @property({ tooltip: '【敌人】俯冲命中判定半径' })
    m_DiveHitRadius: number = DefaultTuning.diveHitRadius;
    @property({ tooltip: '【敌人】主动攻击玩家的触发距离' })
    m_EnemyAttackRange: number = DefaultTuning.enemyAttackRange;
    @property({ tooltip: '【敌人】主动攻击的间隔（秒）' })
    m_EnemyAttackInterval: number = DefaultTuning.enemyAttackInterval;
    @property({ tooltip: '【敌人】每次攻击扣的血量' })
    m_EnemyAttackDamage: number = DefaultTuning.enemyAttackDamage;
    @property({ tooltip: '【玩家】最大血量' })
    m_PlayerMaxHp: number = DefaultTuning.playerMaxHp;

    private m_CurrentLevel: number = 1;
    private m_IsPaused: boolean = false;
    private m_Battle: BattleWorld = null;

    OnInit(): void {
        this.SetBtnEvent(this.m_PauseBtn, () => this.onPauseBtnClick());
        this.SetBtnEvent(this.m_SkillOneBtn, () => this.onSkillOneBtnClick());
        this.SetBtnEvent(this.m_SkillTwoBtn, () => this.onSkillTwoBtnClick());
        this.SetBtnEvent(this.m_SkillThreeBtn, () => this.onSkillThreeBtnClick());
        view.on('resize', this.adjustGameRootScale, this);
    }

    onDestroy(): void {
        view.off('resize', this.adjustGameRootScale, this);
        this.disposeBattle();
    }

    OnOpen(level: number = this.m_StartLevel): void {
        this.WaitOpenReady();
        this.m_IsPaused = false;
        this.updateLevel(level);
        this.adjustGameRootScale();
        this.startBattle();
    }

    OnClose(): void {
        super.OnClose();
        this.m_IsPaused = false;
        this.disposeBattle();

        if (this.m_GameRoot && this.m_GameRoot.isValid) {
            this.m_GameRoot.removeAllChildren();
        }
    }

    update(dt: number): void {
        if (this.m_IsPaused) return;
        this.m_Battle?.update(dt);
    }

    /** 装载素材并开一局。重开走同一条路径，先把上一局清干净 */
    private startBattle(): void {
        const root = this.m_GameRoot;
        if (!root || !root.isValid) {
            this.NotifyOpenReady();
            return;
        }

        this.disposeBattle();
        root.removeAllChildren();

        this.loadGameplayFrames()
            .then(frames => {
                if (!this.isValid || !root.isValid) {
                    this.NotifyOpenReady();
                    return;
                }

                this.m_Battle = new BattleWorld();
                this.m_Battle.start(root, this.buildTuning(), frames, {
                    onGameOver: () => this.onBattleGameOver(),
                    onRestart: () => this.restartCurrentLevel(),
                });
                this.NotifyOpenReady();
            })
            .catch(err => {
                console.warn('GamePanel: 玩法初始化失败', err);
                this.NotifyOpenReady();
            });
    }

    /** 加载玩法用到的全部图片；单张失败只告警，不阻断开局 */
    private async loadGameplayFrames(): Promise<Map<string, SpriteFrame>> {
        const frames = new Map<string, SpriteFrame>();
        const resManager = ResManager.getInstance();

        await Promise.all(
            ALL_GAMEPLAY_ASSETS.map(async assetName => {
                try {
                    const frame = await resManager.loadFromBundleAsync(
                        CommonBundleName.Game,
                        toSpriteFramePath(assetName),
                        SpriteFrame,
                    );
                    frames.set(assetName, frame);
                } catch (err) {
                    console.warn(`GamePanel: 加载玩法图片失败 [${assetName}]`, err);
                }
            }),
        );

        return frames;
    }

    private buildTuning(): GameTuning {
        return {
            waveInterval: Math.max(1, this.m_WaveInterval),
            waveRowMin: Math.max(1, Math.floor(this.m_WaveRowMin)),
            waveRowMax: Math.max(1, Math.floor(this.m_WaveRowMax)),
            rowSpawnInterval: Math.max(0.02, this.m_RowSpawnInterval),
            enemyFallSpeed: Math.max(1, this.m_EnemyFallSpeed),
            bulletSpeed: Math.max(1, this.m_BulletSpeed),
            bulletDamage: Math.max(1, this.m_BulletDamage),
            fireInterval: Math.max(0.02, this.m_FireInterval),
            bulletCount: Math.max(1, Math.floor(this.m_BulletCount)),
            // 上限 75 度和 BulletManager 里的 MAX_BOUNCE_TILT_DEG 一致：再大子弹会偏回刚撞的表面
            bulletBounceAngle: Math.max(0, Math.min(75, this.m_BulletBounceAngle)),
            // 0 保留为"不限次数"，所以只夹下界
            bulletMaxBounce: Math.max(0, Math.floor(this.m_BulletMaxBounce)),
            diveSpeed: Math.max(1, this.m_DiveSpeed),
            diveDamage: Math.max(0, this.m_DiveDamage),
            diveHitRadius: Math.max(1, this.m_DiveHitRadius),
            enemyAttackRange: Math.max(0, this.m_EnemyAttackRange),
            enemyAttackInterval: Math.max(0.05, this.m_EnemyAttackInterval),
            enemyAttackDamage: Math.max(0, this.m_EnemyAttackDamage),
            playerMaxHp: Math.max(1, this.m_PlayerMaxHp),
        };
    }

    private disposeBattle(): void {
        if (!this.m_Battle) return;

        this.m_Battle.dispose();
        this.m_Battle = null;
    }

    private onBattleGameOver(): void {
        // 结算浮层由 BattleWorld 的 HUD 负责，这里留作后续接排行/复活等流程
    }

    private updateLevel(level: number): void {
        const requestedLevel = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : this.m_StartLevel;
        this.m_CurrentLevel = requestedLevel;
        CommonGameProgress.setCurrentLevel(this.m_CurrentLevel);
        this.updateLevelText();
    }

    private updateLevelText(): void {
        if (!this.m_LevelText) return;
        this.m_LevelText.string = `关卡：${this.m_CurrentLevel}`;
    }

    /**
     * 按屏幕分辨率对游戏根节点做 contain 缩放：
     * 以设计尺寸为基准，取可见区域与设计尺寸比值的较小值，
     * 保证设计尺寸内的内容完整显示在屏幕内，
     * 避免部分分辨率（如窄屏 fitHeight 横向裁边）下边缘内容被切掉。
     */
    private adjustGameRootScale(): void {
        if (!this.m_GameRoot || !this.m_GameRoot.isValid) return;
        const designWidth = Math.max(1, this.m_DesignWidth);
        const designHeight = Math.max(1, this.m_DesignHeight);
        const visibleSize = view.getVisibleSize();
        const visibleWidth = visibleSize?.width || 0;
        const visibleHeight = visibleSize?.height || 0;
        if (visibleWidth <= 0 || visibleHeight <= 0) return;
        const maxScale = Math.max(0.01, this.m_GameRootMaxScale);
        const scale = Math.min(maxScale, visibleWidth / designWidth, visibleHeight / designHeight);
        this.m_GameRoot.setScale(scale, scale, 1);
    }

    private onPauseBtnClick(): void {
        if (this.m_IsPaused) return;

        this.m_IsPaused = true;
        UIManager.GetInstance().OpenPanel(CommonUIID.PausePanel, {
            onContinue: () => this.continueCurrentLevel(),
            onRestart: () => this.restartCurrentLevel(),
            onGoBack: () => this.goBackMainPanel(),
        });
    }

    private continueCurrentLevel(): void {
        this.m_IsPaused = false;
    }

    private restartCurrentLevel(): void {
        this.m_IsPaused = false;
        this.OnOpen(this.m_CurrentLevel);
    }

    private goBackMainPanel(): void {
        this.m_IsPaused = false;
        UIManager.GetInstance().OpenPanelWithCallback(CommonUIID.MainPanel, () => {
            UIManager.GetInstance().ClosePanel(CommonUIID.GamePanel);
        });
    }

    // 技能按钮：玩法重写时在此接入（可复用 CommonUIID.AdPanel 的广告解锁流程）
    private onSkillOneBtnClick(): void {
    }

    private onSkillTwoBtnClick(): void {
    }

    private onSkillThreeBtnClick(): void {
    }
}