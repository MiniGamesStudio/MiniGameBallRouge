import { _decorator, Button, Node, RichText, view } from 'cc';
import { UIBase } from '../../../engine/ui/UIBase';
import { UIManager } from '../../../engine/ui/UIManager';
import { CommonGameProgress } from '../CommonGameProgress';
import { CommonUIID } from '../CommonUIConfig';
const { ccclass, property } = _decorator;

const DESIGN_ROOT_WIDTH = 750;
const DESIGN_ROOT_HEIGHT = 1334;

/**
 * 游戏主面板 — 仅保留 UI 骨架，玩法逻辑待重写。
 * 节点引用与设计尺寸属性保留，避免编辑器内的绑定丢失。
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

    private m_CurrentLevel: number = 1;
    private m_IsPaused: boolean = false;

    OnInit(): void {
        this.SetBtnEvent(this.m_PauseBtn, () => this.onPauseBtnClick());
        this.SetBtnEvent(this.m_SkillOneBtn, () => this.onSkillOneBtnClick());
        this.SetBtnEvent(this.m_SkillTwoBtn, () => this.onSkillTwoBtnClick());
        this.SetBtnEvent(this.m_SkillThreeBtn, () => this.onSkillThreeBtnClick());
        view.on('resize', this.adjustGameRootScale, this);
    }

    onDestroy(): void {
        view.off('resize', this.adjustGameRootScale, this);
    }

    OnOpen(level: number = this.m_StartLevel): void {
        this.WaitOpenReady();
        this.m_IsPaused = false;
        this.updateLevel(level);

        // TODO: 在此初始化新玩法，准备完成后调用 NotifyOpenReady()
        this.NotifyOpenReady();
    }

    OnClose(): void {
        super.OnClose();
        this.m_IsPaused = false;

        // TODO: 在此清理新玩法的运行时对象
        if (this.m_GameRoot && this.m_GameRoot.isValid) {
            this.m_GameRoot.removeAllChildren();
        }
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