/**
 * 打击反馈：受击闪白（敌人与玩家）+ 敌人轻微震动
 *
 * 为什么用 Graphics 画白块，而不是改 Sprite 颜色：
 * 颜色是"乘算"，占位美术本身已经接近白色，把 sprite.color 调到最亮也只是原图；
 * 要真正"闪白"只能叠一层白色。目前没有纯白贴图素材，所以用 Graphics 画一个
 * 与占格等宽的白块（圆角），靠 UIOpacity 淡出 —— 与掉落物 / 经验条的占位画法保持一致。
 *
 * 坐标说明：闪白块是目标节点的子节点，自动跟随目标移动与缩放；
 * 震动由本类直接改目标节点位置，所以调用方每帧要传一次"基准位置"（未震动时的位置）。
 */
import { Color, Graphics, Node, UIOpacity, UITransform } from 'cc';
import { GameTuning } from '../core/GameTuning';
import { makeNode, setPos } from './GameArt';

/** 一次受击表现的运行时状态（闪白 + 可选震动） */
export class HitFeedback {
    private m_Target: Node;
    private m_FlashNode: Node | null = null;
    private m_Opacity: UIOpacity | null = null;
    private m_FlashTime: number = 0;
    private m_ShakeTime: number = 0;
    private m_Shaking: boolean = false;
    private m_ShakeEnabled: boolean = false;

    private constructor(target: Node) {
        this.m_Target = target;
    }

    /**
     * 给目标节点挂一份受击表现
     * @param enableShake 是否需要震动（玩家不震，只有敌人震）
     */
    static attach(target: Node, width: number, height: number, enableShake: boolean): HitFeedback {
        const feedback = new HitFeedback(target);
        feedback.m_ShakeEnabled = enableShake;
        feedback.m_FlashNode = HitFeedback.createFlashNode(target, width, height);
        if (feedback.m_FlashNode) feedback.m_Opacity = feedback.m_FlashNode.getComponent(UIOpacity);
        return feedback;
    }

    /** 建一个白色圆角块当闪白层（平时 active=false，不产生绘制开销） */
    private static createFlashNode(target: Node, width: number, height: number): Node {
        const node = makeNode(target, 'HitFlash');
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);

        const graphics = node.addComponent(Graphics);
        const radius = Math.min(width, height) * 0.35;
        graphics.fillColor = new Color(255, 255, 255, 255);
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
        graphics.fill();

        const opacity = node.addComponent(UIOpacity);
        opacity.opacity = 0;
        node.active = false;
        return node;
    }

    /** 受击：触发闪白（敌人顺带触发震动） */
    trigger(): void {
        if (!this.m_Target || !this.m_Target.isValid) return;

        this.m_FlashTime = GameTuning.hitFlashTime;
        if (this.m_FlashNode && this.m_FlashNode.isValid) {
            this.m_FlashNode.active = true;
            if (this.m_Opacity && this.m_Opacity.isValid) this.m_Opacity.opacity = GameTuning.hitFlashAlpha;
        }

        if (this.m_ShakeEnabled) {
            this.m_ShakeTime = GameTuning.hitShakeTime;
            this.m_Shaking = true;
        }
    }

    /**
     * 每帧更新，必须在目标节点本帧的基准位置确定之后调用
     * @param baseX/baseY 未震动时的位置
     */
    update(dt: number, baseX: number, baseY: number): void {
        if (!this.m_Target || !this.m_Target.isValid) return;
        const d = Math.max(0, dt);

        // 闪白：随时间线性淡出，结束后关掉节点
        if (this.m_FlashTime > 0) {
            this.m_FlashTime = Math.max(0, this.m_FlashTime - d);
            const ratio = GameTuning.hitFlashTime > 0 ? this.m_FlashTime / GameTuning.hitFlashTime : 0;
            if (this.m_Opacity && this.m_Opacity.isValid) {
                this.m_Opacity.opacity = Math.round(GameTuning.hitFlashAlpha * ratio);
            }
            if (this.m_FlashNode && this.m_FlashNode.isValid && this.m_FlashTime <= 0) {
                this.m_FlashNode.active = false;
            }
        }

        // 震动：幅度随时间衰减的随机抖动；结束时精确归位，避免留下偏移
        if (this.m_Shaking) {
            this.m_ShakeTime = Math.max(0, this.m_ShakeTime - d);
            if (this.m_ShakeTime > 0) {
                const ratio = GameTuning.hitShakeTime > 0 ? this.m_ShakeTime / GameTuning.hitShakeTime : 0;
                const amplitude = GameTuning.hitShakeAmplitude * ratio;
                setPos(
                    this.m_Target,
                    baseX + (Math.random() * 2 - 1) * amplitude,
                    baseY + (Math.random() * 2 - 1) * amplitude
                );
            } else {
                this.m_Shaking = false;
                setPos(this.m_Target, baseX, baseY);
            }
        }
    }
}