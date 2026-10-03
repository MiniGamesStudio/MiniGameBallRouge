/**
 * 打击反馈：受击闪白（敌人与玩家）+ 敌人轻微震动
 *
 * 闪白为什么用 Mask 模板裁切，而不是直接画一个白色圆角块：
 * 白块只能画"占格矩形"，而占格 ≠ 美术轮廓 —— 贴图四周有透明留白，
 * 白块会把透明区域一起盖住，看起来像"贴了个白方块"，而不是"这只怪被打白了"。
 * 这里把**精灵自己的 spriteFrame** 设成 Mask 模板（SPRITE_STENCIL），
 * 再在模板里填白色矩形：白色只出现在贴图 alpha ≥ 0.1 的地方，
 * 形状与美术轮廓完全一致（含两格怪，以及用两格图拉伸出来的 4/6/8 格大怪）。
 *
 * 两个实现坑：
 * ① Mask 的 SPRITE_STENCIL 会给**同一个节点**挂一个内部 Sprite 当模板，
 *    所以必须先设 type 再设 spriteFrame（顺序反了内部 Sprite 还不存在，spriteFrame 会被丢掉）；
 * ② 那个内部 Sprite 的尺寸模式要显式改成 CUSTOM，否则它会按贴图原始尺寸反改节点大小，
 *    拉伸后的大怪就会只被裁到一小块。
 *
 * 坐标说明：闪白块是目标节点的子节点，自动跟随目标移动与缩放；
 * 震动由本类直接改目标节点位置，所以调用方每帧要传一次"基准位置"（未震动时的位置）。
 */
import { Color, Graphics, Mask, Node, Sprite, SpriteFrame, UIOpacity, UITransform } from 'cc';
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
     * @param frame 目标精灵的 spriteFrame，用作闪白模板（null 时退化为圆角矩形）
     * @param enableShake 是否需要震动（玩家不震，只有敌人震）
     */
    static attach(
        target: Node,
        frame: SpriteFrame | null,
        width: number,
        height: number,
        enableShake: boolean
    ): HitFeedback {
        const feedback = new HitFeedback(target);
        feedback.m_ShakeEnabled = enableShake;
        feedback.m_FlashNode = HitFeedback.createFlashNode(target, frame, width, height);
        if (feedback.m_FlashNode) feedback.m_Opacity = feedback.m_FlashNode.getComponent(UIOpacity);
        return feedback;
    }

    /** 建闪白层：有贴图就用贴图轮廓当模板，缺图退化成圆角矩形（平时 active=false，不产生绘制） */
    private static createFlashNode(target: Node, frame: SpriteFrame | null, width: number, height: number): Node {
        const node = makeNode(target, 'HitFlash');
        const transform = node.addComponent(UITransform);
        transform.setContentSize(width, height);

        if (frame) {
            const mask = node.addComponent(Mask);
            mask.type = Mask.Type.SPRITE_STENCIL;   // 先设 type：内部模板 Sprite 在这一步才被创建
            mask.spriteFrame = frame;

            // 模板 Sprite 必须按我们的占格尺寸拉伸绘制，不能按贴图原始尺寸反改节点
            const stencil = node.getComponent(Sprite);
            if (stencil) {
                stencil.type = Sprite.Type.SIMPLE;
                stencil.sizeMode = Sprite.SizeMode.CUSTOM;
            }
            transform.setContentSize(width, height);
        }

        // 白色填充块：有模板时形状由模板决定，这里铺满整格即可
        const white = makeNode(node, 'White');
        const whiteTransform = white.addComponent(UITransform);
        whiteTransform.setContentSize(width, height);
        const graphics = white.addComponent(Graphics);
        graphics.fillColor = new Color(255, 255, 255, 255);
        if (frame) {
            graphics.rect(-width / 2, -height / 2, width, height);
        } else {
            // 缺图兜底：小圆角，贴近占位方块；不要用大圆角（会和美术轮廓差得更远）
            graphics.roundRect(-width / 2, -height / 2, width, height, Math.min(width, height) * 0.18);
        }
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
            this.m_ShakeTime = Math.max(0, this.m_ShakeTime - dt);
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