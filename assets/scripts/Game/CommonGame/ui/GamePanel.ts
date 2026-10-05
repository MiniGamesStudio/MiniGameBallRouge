import { _decorator, Button, Node, RichText, view } from 'cc';
import { UIBase } from '../../../engine/ui/UIBase';
import { UIManager } from '../../../engine/ui/UIManager';
import { CommonUIID } from '../CommonUIConfig';
import { CommonGameProgress } from '../CommonGameProgress';
import { BattleView } from '../gameplay/view/BattleView';
const { ccclass, property } = _decorator;

const DESIGN_ROOT_WIDTH = 750;
const DESIGN_ROOT_HEIGHT = 1334;

/**
 * 游戏主面板 — 面板框架 + 玩法挂载点
 *
 * 框架部分：面板生命周期、关卡号记录、暂停流程、游戏根节点按分辨率缩放。
 * 玩法部分：把 BattleView 挂到 m_GameRoot 上，实现位于 gameplay/ 目录
 * （core/ 是纯逻辑、可单测；view/ 负责节点与占位美术）。
 *
 * ⚠️ 这里【故意】不声明任何数值型 @property。
 * 历史坑：这些字段曾在 prefab 里存了另一套值并【静默覆盖】GameConfig.DefaultTuning，
 * 导致改 .ts 不生效、code review 也看不出差异（详见策划案 §14.0）。
 * 以后新增玩法数值，请集中到一个配置真源里，不要再挂 @property。
 */
@ccclass('GamePanel')
export class GamePanel extends UIBase {
    @property(Node)
    m_GameRoot: Node = null;
    @property(Button)
    m_PauseBtn: Button = null;
    @property(RichText)
    m_LevelText: RichText = null;
    @property(Node)
    m_GameBg: Node = null;

    // —— 以下 3 个是"面板自身"的配置，与玩法数值无关，保留在 prefab 里可调 ——
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
    private m_Battle: BattleView | null = null;

    OnInit(): void {
        this.SetBtnEvent(this.m_PauseBtn, () => this.onPauseBtnClick());
        view.on('resize', this.adjustGameRootScale, this);
    }

    onDestroy(): void {
        view.off('resize', this.adjustGameRootScale, this);
    }

    OnOpen(level: number = this.m_StartLevel): void {
        this.WaitOpenReady();
        this.m_IsPaused = false;
        this.updateLevel(level);
        this.adjustGameRootScale();
        // 玩法：挂载 BattleView（占位美术从 bundle game 加载），素材就绪后再结束打开中状态
        void this.startBattle(level);
    }

    OnClose(): void {
        super.OnClose();
        this.destroyBattle();
        this.m_IsPaused = false;

        if (this.m_GameRoot && this.m_GameRoot.isValid) {
            this.m_GameRoot.removeAllChildren();
        }
    }

    /** 启动一局战斗（等待占位素材加载完成后结束哦打开中哦状态） */
    private async startBattle(level: number): Promise<void> {
        this.destroyBattle();
        if (!this.m_GameRoot || !this.m_GameRoot.isValid) {
            this.NotifyOpenReady();
            return;
        }

        this.m_Battle = await BattleView.create(this.m_GameRoot, {
            level,
            // 滚动背景用面板自己的真实背景节点 m_GameBg（v1.10 起）：
            // 在这里**显式注入**（BattleOptions 字段），BattleView 不做 getChildByName 之类的
            // 字符串查找（脆弱），也不需要"先建网格再换贴图"的二次重建（那样第一帧会跳位）。
            backgroundNode: this.m_GameBg,
            onRestart: () => this.restartCurrentLevel(),
            onExit: () => this.goBackMainPanel(),
        });
        this.NotifyOpenReady();
    }

    /** 卸载战斗（重开 / 关闭面板时调用） */
    private destroyBattle(): void {
        if (this.m_Battle && this.m_Battle.isValid) {
            this.m_Battle.node.destroy();
        }
        this.m_Battle = null;
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
        this.m_Battle?.setPaused(true);
        UIManager.GetInstance().OpenPanel(CommonUIID.PausePanel, {
            onContinue: () => this.continueCurrentLevel(),
            onRestart: () => this.restartCurrentLevel(),
            onGoBack: () => this.goBackMainPanel(),
        });
    }

    private continueCurrentLevel(): void {
        this.m_IsPaused = false;
        this.m_Battle?.setPaused(false);
    }

    private restartCurrentLevel(): void {
        this.m_IsPaused = false;
        this.destroyBattle();
        this.OnOpen(this.m_CurrentLevel);
    }

    private goBackMainPanel(): void {
        this.m_IsPaused = false;
        UIManager.GetInstance().OpenPanelWithCallback(CommonUIID.MainPanel, () => {
            UIManager.GetInstance().ClosePanel(CommonUIID.GamePanel);
        });
    }
}