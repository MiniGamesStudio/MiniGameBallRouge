import { _decorator, Button, Color, Label, Node, RichText, SpriteFrame, UITransform, view } from 'cc';
import { ResManager } from '../../../engine/ResManager';
import { UIBase } from '../../../engine/ui/UIBase';
import { UIManager } from '../../../engine/ui/UIManager';
import { CommonBundleName, CommonUIID } from '../CommonUIConfig';
import { CommonGameProgress } from '../CommonGameProgress';
import { BattleWorld } from '../gameplay/BattleWorld';
import { ALL_GAMEPLAY_ASSETS, DefaultTuning, GameTuning, toSpriteFramePath } from '../gameplay/GameConfig';
import { sanitizeTuning } from '../gameplay/TuningSanitizer';
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
 * 玩法实现在 gameplay/ 下，这里只负责：加载素材、驱动 BattleWorld、面板生命周期。
 *
 * ⚠️ 这里【故意】不再声明任何数值型 @property。
 * 历史坑：这些字段曾在 prefab 里存了另一套值并【静默覆盖】GameConfig.DefaultTuning，
 * 导致改 .ts 不生效、code review 也看不出差异（详见策划案 §14.0）。
 * 要调玩法数值请改 `GameConfig.DefaultTuning` —— 那是全项目唯一真源。
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

    // —— 以下 4 个是"面板自身"的配置，与玩法数值无关，保留在 prefab 里可调 ——
    @property({ tooltip: '默认打开的关卡，从 1 开始' })
    m_StartLevel: number = 1;
    @property({ tooltip: '游戏根节点设计宽度，用于按屏幕分辨率缩放' })
    m_DesignWidth: number = DESIGN_ROOT_WIDTH;
    @property({ tooltip: '游戏根节点设计高度，用于按屏幕分辨率缩放' })
    m_DesignHeight: number = DESIGN_ROOT_HEIGHT;
    @property({ tooltip: '游戏根节点最大缩放，1 表示不超过设计尺寸（保持清晰），可调大以在大屏铺满' })
    m_GameRootMaxScale: number = 1;

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

    /**
     * 取本局的数值。
     *
     * 现在只做两件事：读唯一真源 + 钳制合法性。不再从 prefab 读任何数值字段
     * （历史坑见类注释与策划案 §14.0）。
     *
     * 顺便打一行生效值日志：这个坑之所以能藏那么久，就是因为没有任何地方能看到
     * "当前生效的到底是哪一套数"。留一行日志，下次 divergence 会立刻暴露。
     */
    private buildTuning(): GameTuning {
        const tuning = sanitizeTuning(DefaultTuning);
        console.log('[GameConfig] 本局生效数值 =', JSON.stringify(tuning));
        return tuning;
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