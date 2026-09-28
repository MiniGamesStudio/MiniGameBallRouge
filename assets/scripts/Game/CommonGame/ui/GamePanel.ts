import { _decorator, Button, Color, Label, Node, RichText, SpriteFrame, UITransform, view } from 'cc';
import { ResManager } from '../../../engine/ResManager';
import { UIBase } from '../../../engine/ui/UIBase';
import { UIManager } from '../../../engine/ui/UIManager';
import { CommonBundleName, CommonUIID } from '../CommonUIConfig';
import { CommonGameProgress } from '../CommonGameProgress';
import { BattleWorld } from '../gameplay/BattleWorld';
import { ALL_GAMEPLAY_ASSETS, DefaultTuning, GameTuning, toSpriteFramePath } from '../gameplay/GameConfig';
import { SkillId, SKILL_DEFS } from '../gameplay/SkillConfig';
import { SkillLevels } from '../gameplay/SkillSystem';
const { ccclass, property } = _decorator;

const DESIGN_ROOT_WIDTH = 750;
const DESIGN_ROOT_HEIGHT = 1334;
/** 技能槽（ToolBtn 118x131）上等级文字的位置与尺寸 */
const SLOT_LABEL_Y = -60;
const SLOT_LABEL_WIDTH = 118;
const SLOT_LABEL_HEIGHT = 30;

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

    @property({ tooltip: '【难度】每过一波，单波行数的增量（0.5 = 每两波多一行），第 1 波是基准' })
    m_DifficultyRowPerWave: number = DefaultTuning.difficultyRowPerWave;
    @property({ tooltip: '【难度】单波行数上限。要 >= 单波最多行数，否则会把行数压到比基准还少' })
    m_DifficultyRowMax: number = DefaultTuning.difficultyRowMax;
    @property({ tooltip: '【难度】每过一波，敌人下落速度的增幅（0.08 = 每波 +8%）' })
    m_DifficultySpeedGrowth: number = DefaultTuning.difficultySpeedGrowth;
    @property({ tooltip: '【难度】下落速度倍率上限' })
    m_DifficultySpeedMax: number = DefaultTuning.difficultySpeedMax;
    @property({ tooltip: '【难度】每过一波，敌人血量的增幅（0.12 = 每波 +12%）' })
    m_DifficultyHpGrowth: number = DefaultTuning.difficultyHpGrowth;
    @property({ tooltip: '【难度】血量倍率上限' })
    m_DifficultyHpMax: number = DefaultTuning.difficultyHpMax;

    private m_CurrentLevel: number = 1;
    private m_IsPaused: boolean = false;
    private m_Battle: BattleWorld = null;

    OnInit(): void {
        this.SetBtnEvent(this.m_PauseBtn, () => this.onPauseBtnClick());
        // 三个技能槽只做展示，不绑点击：它们压在底部拖拽区正上方，
        // 留着可点就是一条拖不动的死区（详见 refreshSkillSlots）
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
        // 升级面板是本面板开出来的子流程。GamePanel 被关掉（返回主界面）时
        // 它必须一起收走，否则会孤零零悬在主面板上面
        UIManager.GetInstance().ClosePanel(CommonUIID.SkillPanel);

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
        // m_Battle 已经没了，这一步等于"全部收起"。必须在这里刷一次：
        // 技能等级活在被 dispose 掉的那个 BattleWorld 里，光靠下面 then 里的那次
        // 刷新的话，一旦加载失败就永远停在上一局的技能槽上
        this.refreshSkillSlots();

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
                    onLevelUp: levels => this.onBattleLevelUp(levels),
                });
                // 新的一局技能清零，把上一局点亮的槽位收回去
                this.refreshSkillSlots();
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
            diveSpeed: Math.max(1, this.m_DiveSpeed),
            diveDamage: Math.max(0, this.m_DiveDamage),
            diveHitRadius: Math.max(1, this.m_DiveHitRadius),
            enemyAttackRange: Math.max(0, this.m_EnemyAttackRange),
            enemyAttackInterval: Math.max(0.05, this.m_EnemyAttackInterval),
            enemyAttackDamage: Math.max(0, this.m_EnemyAttackDamage),
            playerMaxHp: Math.max(1, this.m_PlayerMaxHp),
            difficultyRowPerWave: Math.max(0, this.m_DifficultyRowPerWave),
            // 上限至少要跟得上基准行数，否则难度曲线会反过来削减行数
            difficultyRowMax: Math.max(
                Math.max(1, Math.floor(this.m_WaveRowMax)),
                Math.floor(this.m_DifficultyRowMax),
            ),
            difficultySpeedGrowth: Math.max(0, this.m_DifficultySpeedGrowth),
            // 倍率下限锁在 1：小于 1 会变成"越往后越简单"
            difficultySpeedMax: Math.max(1, this.m_DifficultySpeedMax),
            difficultyHpGrowth: Math.max(0, this.m_DifficultyHpGrowth),
            difficultyHpMax: Math.max(1, this.m_DifficultyHpMax),
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

    // ---------------------------------------------------------------- 升级选技能

    /**
     * 战斗侧升了一级，弹面板让玩家选技能。
     *
     * 冻结战斗是【这边】的责任，不是 BattleWorld 的：谁开面板谁负责停，
     * 面板关掉时再解冻，中间不会出现"面板没了但游戏还停着"的空档。
     */
    private onBattleLevelUp(levels: Readonly<SkillLevels>): void {
        // 已经停在别的地方（比如暂停面板开着）就别抢屏幕，等这次回来再说
        if (this.m_IsPaused) return;

        this.m_IsPaused = true;
        const opened = UIManager.GetInstance().OpenPanel(CommonUIID.SkillPanel, {
            levels,
            onPick: (skillId: SkillId) => this.pickSkill(skillId),
        });

        // 面板没开起来（没注册 / 找不到 UI ID）就立刻解冻，
        // 否则这一局就永远停在半空，连暂停按钮都救不回来（它也看 m_IsPaused）
        if (!opened) this.m_IsPaused = false;
    }

    private pickSkill(skillId: SkillId): void {
        this.m_IsPaused = false;
        this.m_Battle?.applySkillChoice(skillId);
        this.refreshSkillSlots();
    }

    /**
     * 刷新 HUD 上的三个技能槽（UIRoot/ToolBtn1~3，图标已在 prefab 里配好）。
     *
     * 槽位是纯展示：未学过 = 整个藏起来，学过 = 亮出来并在图标下沿写等级。
     * 按钮组件一律 enabled = false —— 这排槽位正好压在屏幕底部的拖拽区上，
     * 留着可点会在玩家出生点附近咬出三段拖不动的死区；而且 interactable = false
     * 挡不住这件事（Button 是先命中再检查 interactable 的），只有 enabled 才会
     * 把它从触摸分发里摘掉。
     */
    private refreshSkillSlots(): void {
        const levels = this.m_Battle?.skillLevels;
        const buttons = [this.m_SkillOneBtn, this.m_SkillTwoBtn, this.m_SkillThreeBtn];

        SKILL_DEFS.forEach((def, index) => {
            const button = buttons[index];
            if (!button || !button.node || !button.node.isValid) return;

            const level = (levels && levels[def.id]) || 0;

            button.enabled = false;
            button.interactable = false;
            button.node.active = level > 0;

            const label = this.ensureSlotLabel(button.node);
            if (label) label.string = `Lv.${level}`;
        });
    }

    /** 技能槽上的等级文字：第一次用时建出来，之后复用 */
    private ensureSlotLabel(slot: Node): Label | null {
        const existing = slot.getChildByName('LevelLabel');
        if (existing && existing.isValid) return existing.getComponent(Label);

        const node = new Node('LevelLabel');
        node.layer = slot.layer;
        slot.addChild(node);
        node.setPosition(0, SLOT_LABEL_Y, 0);

        const transform = node.addComponent(UITransform);
        transform.setContentSize(SLOT_LABEL_WIDTH, SLOT_LABEL_HEIGHT);

        const label = node.addComponent(Label);
        label.fontSize = 24;
        label.lineHeight = 26;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.color = new Color(255, 255, 255, 255);
        return label;
    }
}