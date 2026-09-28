import { Button, Color, Graphics, Label, Node, UITransform, Vec3 } from 'cc';
import { DESIGN_WIDTH } from './GameConfig';

const HP_BAR_WIDTH = 520;
const HP_BAR_HEIGHT = 26;
const HP_BAR_Y = 640;
const STATUS_TEXT_Y = 604;

const COLOR_BAR_BG = new Color(18, 22, 34, 220);
const COLOR_HP_HIGH = new Color(80, 220, 120, 255);
const COLOR_HP_MID = new Color(240, 200, 70, 255);
const COLOR_HP_LOW = new Color(232, 84, 84, 255);
const COLOR_MASK = new Color(0, 0, 0, 170);
const COLOR_BUTTON = new Color(72, 132, 232, 255);

/**
 * 战斗 HUD — 血条、波次状态、结算浮层
 *
 * 全部运行时创建挂在 HudLayer 下，坐标系和 m_GameRoot 一致（设计分辨率 750x1334）。
 */
export class BattleHud {
    private m_Layer: Node = null;
    private m_HpGraphics: Graphics = null;
    private m_HpLabel: Label = null;
    private m_StatusLabel: Label = null;
    private m_StatusText: string = '';
    private m_OverOverlay: Node = null;

    private m_OnRestart: (() => void) | null = null;

    init(layer: Node, onRestart: () => void): void {
        this.m_Layer = layer;
        this.m_OnRestart = onRestart;

        this.createHpBar();
        this.m_StatusLabel = this.createLabel('StatusText', layer, '', 24, new Vec3(0, STATUS_TEXT_Y, 0));
        this.m_StatusLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.m_StatusLabel.color = new Color(255, 255, 255, 220);
    }

    /** 刷新血条与状态文案 */
    updateHp(hp: number, maxHp: number): void {
        const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
        this.drawHpBar(ratio);
        if (this.m_HpLabel) {
            this.m_HpLabel.string = `${Math.ceil(hp)} / ${Math.ceil(maxHp)}`;
        }
    }

    /** 刷新波次文案，内容没变就不碰 Label（避免每帧触发重排） */
    updateStatus(waveCount: number, aliveCount: number): void {
        if (!this.m_StatusLabel) return;

        const text = waveCount > 0 ? `第 ${waveCount} 波   场上敌人 ${aliveCount}` : '';
        if (text === this.m_StatusText) return;

        this.m_StatusText = text;
        this.m_StatusLabel.string = text;
    }

    /** 显示结算浮层 */
    showGameOver(waveCount: number): void {
        if (this.m_OverOverlay || !this.m_Layer) return;

        const overlay = new Node('GameOverOverlay');
        overlay.layer = this.m_Layer.layer;
        this.m_Layer.addChild(overlay);
        overlay.setPosition(0, 0, 0);

        const transform = overlay.addComponent(UITransform);
        transform.setContentSize(DESIGN_WIDTH, 1400);

        const mask = overlay.addComponent(Graphics);
        mask.fillColor = COLOR_MASK;
        mask.rect(-DESIGN_WIDTH * 0.5, -700, DESIGN_WIDTH, 1400);
        mask.fill();

        const title = this.createLabel('GameOverTitle', overlay, '游戏结束', 76, new Vec3(0, 120, 0));
        title.color = new Color(255, 236, 200, 255);

        const detail = this.createLabel('GameOverDetail', overlay, `坚持了 ${waveCount} 波`, 32, new Vec3(0, 20, 0));
        detail.color = new Color(220, 224, 236, 255);

        this.createButton(overlay, '重新开始', new Vec3(0, -140, 0), () => {
            this.m_OnRestart?.();
        });

        this.m_OverOverlay = overlay;
    }

    dispose(): void {
        this.m_OnRestart = null;
        this.m_OverOverlay = null;
        this.m_HpGraphics = null;
        this.m_HpLabel = null;
        this.m_StatusLabel = null;
        this.m_StatusText = '';
    }

    private createHpBar(): void {
        const barNode = new Node('HpBar');
        barNode.layer = this.m_Layer.layer;
        this.m_Layer.addChild(barNode);
        barNode.setPosition(0, HP_BAR_Y, 0);

        const transform = barNode.addComponent(UITransform);
        transform.setContentSize(HP_BAR_WIDTH, HP_BAR_HEIGHT);

        this.m_HpGraphics = barNode.addComponent(Graphics);

        this.m_HpLabel = this.createLabel('HpText', barNode, '', 22, new Vec3(0, 0, 0));
        this.m_HpLabel.color = new Color(255, 255, 255, 255);
    }

    private drawHpBar(ratio: number): void {
        if (!this.m_HpGraphics) return;

        const halfWidth = HP_BAR_WIDTH * 0.5;
        const halfHeight = HP_BAR_HEIGHT * 0.5;
        const graphics = this.m_HpGraphics;
        graphics.clear();

        graphics.fillColor = COLOR_BAR_BG;
        graphics.roundRect(-halfWidth, -halfHeight, HP_BAR_WIDTH, HP_BAR_HEIGHT, halfHeight);
        graphics.fill();

        if (ratio <= 0) return;

        graphics.fillColor = ratio > 0.5 ? COLOR_HP_HIGH : ratio > 0.25 ? COLOR_HP_MID : COLOR_HP_LOW;
        const fillWidth = Math.max(HP_BAR_HEIGHT, HP_BAR_WIDTH * ratio);
        graphics.roundRect(-halfWidth + 3, -halfHeight + 3, fillWidth - 6, HP_BAR_HEIGHT - 6, (HP_BAR_HEIGHT - 6) * 0.5);
        graphics.fill();
    }

    private createLabel(name: string, parent: Node, text: string, fontSize: number, position: Vec3): Label {
        const node = new Node(name);
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(position);

        node.addComponent(UITransform);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = Math.round(fontSize * 1.2);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.color = Color.WHITE;
        return label;
    }

    private createButton(parent: Node, text: string, position: Vec3, onClick: () => void): void {
        const width = 280;
        const height = 96;

        const node = new Node('RestartBtn');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(position);

        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);

        const graphics = node.addComponent(Graphics);
        graphics.fillColor = COLOR_BUTTON;
        graphics.roundRect(-width * 0.5, -height * 0.5, width, height, 18);
        graphics.fill();

        this.createLabel('Text', node, text, 36, new Vec3(0, 0, 0));

        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        // 引擎明确提示 zoomScale < 1 可能触发 touchCancel 吞掉点击，所以按下时放大而不是缩小
        button.zoomScale = 1.06;
        node.on(Button.EventType.CLICK, onClick, this);
    }
}