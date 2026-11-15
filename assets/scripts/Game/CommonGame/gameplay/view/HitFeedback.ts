/**
 * 打击反馈：受击闪白（敌人与玩家）+ 敌人轻微震动 + 受击形变（压扁回弹）
 *
 * 闪白为什么用 Mask 模板裁切，而不是直接画一个白色圆角块：
 * 白块只能画"占格矩形"，而占格 ≠ 美术轮廓 —— 贴图四周有透明留白，
 * 白块会把透明区域一起盖住，看起来像"贴了个白方块"，而不是"这只怪被打白了"。
 * 具体怎么挂模板（以及两个顺序坑）见 view/StencilQuad.ts —— 那一块已经被抽成公共件，
 * 灼烧 / 冰冻覆盖用的是同一份实现，不会各写一套。
 *
 * 坐标说明：
 * ① **震动目标 = 传入的 target 节点本身**，闪白块也挂在它下面（可带偏移）。
 *    敌人必须传**根节点**（底图与怪物图都是它的子节点）—— 曾经把闪白 / 震动挂在怪物图精灵上，
 *    抖动只动怪物图、品质底图钉在原地，看起来像"怪物图在底图里滑动"；
 * ② 震动由本类直接改 target 的位置，所以调用方每帧要传一次"基准位置"（未震动时的位置）。
 * ③ 形变同样直接改 target 的缩放，**基准缩放必须由调用方每帧传入** ——
 *    敌人的基准缩放来自生成动画 / 体型（`enemyVisualScale`），本类不能自己缓存一份，
 *    否则出生放大动画期间命中会把它弹回旧值（见 update 的 baseScale 参数）。
 * ④ **抖动作用在怪物图容器（ArtRoot）上、形变只压缩不放大**：
 *    敌人是按格紧密排列的（格与格之间没有空隙），只要让整格品质底图**外扩 / 挪动**，
 *    就会压到邻居身上 —— 也就是"敌人重叠"。所以：
 *      · 抖动 → 只动 `ArtRoot`（怪物图四周有 `artFitMargin` 的留白，位移被夹在留白内）；
 *      · 形变 → 作用在整个根节点，但**只允许 scale ≤ 基准值**（压缩），永远不越格；
 *      · 品质底图本身不位移，只跟着压缩（压缩只会变小，不会压到邻居）。
 *    这两条约束都与 `cellSize` 无关 → 以后改敌人大小也不会重新引入重叠。
 */
import { Color, Node, SpriteFrame } from 'cc';
import { GameTuning } from '../core/GameTuning';
import { setPos, setScaleXY } from './GameArt';
import { StencilQuad, createStencilQuad, hideStencilQuad, showStencilQuad } from './StencilQuad';

/** 闪白色（受击那一瞬间的纯白，只在贴图轮廓内出现） */
const FLASH_COLOR = new Color(255, 255, 255, 255);

/**
 * 受击抖动允许的最大位移 px。
 *
 * 怪物图按 `artFitMargin` 缩在格子里，四周留白 = `cellSize × (1 − artFitMargin) / 2`；
 * 位移超过这个白边就会压进邻格。用 `cellSize` 现算而不是写死 px：
 * 以后改格子 / 敌人大小，安全上限自动跟着变，不需要重新调参。
 */
function safeShakeAmplitude(): number {
    const margin = Math.max(0, 1 - GameTuning.artFitMargin);
    return Math.max(0, GameTuning.cellSize * margin * 0.5);
}

/** 一次受击表现的运行时状态（闪白 + 可选震动） */
export class HitFeedback {
    private m_Target: Node;
    /** 抖动作用的节点（缺省 = target）。敌人传怪物图容器，避免整格底图位移越格 */
    private m_ShakeTarget: Node;
    /** 形变作用的节点（缺省 = target）。敌人用整个根节点，缩放被限制为"只压缩" */
    private m_SquashTarget: Node;
    private m_Flashes: StencilQuad[] = [];
    private m_FlashTime: number = 0;
    private m_ShakeTime: number = 0;
    private m_Shaking: boolean = false;
    private m_ShakeEnabled: boolean = false;
    /** 形变剩余时间与本次强度倍率（暴击更大） */
    private m_SquashTime: number = 0;
    private m_SquashStrength: number = 1;

    private constructor(target: Node) {
        this.m_Target = target;
        this.m_ShakeTarget = target;
        this.m_SquashTarget = target;
    }

    /**
     * 给目标节点挂一份受击表现
     * @param target 闪白的载体（敌人传**根节点**：品质底图与怪物图都在它下面）
     * @param enableShake 是否需要震动（玩家不震，只有敌人震）
     */
    static attach(target: Node, enableShake: boolean): HitFeedback {
        const feedback = new HitFeedback(target);
        feedback.m_ShakeEnabled = enableShake;
        return feedback;
    }

    /**
     * 指定**抖动**作用的节点（缺省 = target）。
     *
     * 敌人必须传**怪物图容器**（`ArtRoot`，与品质底图平级）：整格品质底图一旦位移
     * 就会压到相邻格子的敌人，而怪物图在格内有 `artFitMargin` 的留白，位移被夹在留白内。
     * 形变则留在根节点上，但只允许压缩（见 update）——两者合起来保证任何反馈都不会越格。
     */
    setShakeTarget(node: Node): void {
        this.m_ShakeTarget = node && node.isValid ? node : this.m_Target;
    }

    /**
     * 加一片闪白（一个敌人可以多片：两格怪两格都要闪）
     * @param frame 目标精灵的 spriteFrame，用作闪白模板（null 时退化为圆角矩形）
     * @param width/height 该片闪白的显示尺寸（= 对应怪物图的实际显示尺寸）
     * @param offsetX/offsetY 在 target 局部空间的偏移（多格怪里这一格的位置）
     */
    addFlash(
        frame: SpriteFrame | null,
        width: number,
        height: number,
        offsetX: number = 0,
        offsetY: number = 0
    ): void {
        if (!this.m_Target || !this.m_Target.isValid) return;
        this.m_Flashes.push(
            createStencilQuad(this.m_Target, 'HitFlash', frame, width, height, FLASH_COLOR, offsetX, offsetY)
        );
    }

    /**
     * 受击：触发闪白 + 形变（敌人顺带触发震动）
     * @param strength 本次打击的强度倍率（暴击传 `hitSquashCritMul`，普通传 1）
     */
    trigger(strength: number = 1): void {
        if (!this.m_Target || !this.m_Target.isValid) return;

        this.m_FlashTime = GameTuning.hitFlashTime;
        for (const flash of this.m_Flashes) showStencilQuad(flash, GameTuning.hitFlashAlpha);

        if (this.m_ShakeEnabled) {
            this.m_ShakeTime = GameTuning.hitShakeTime;
            this.m_Shaking = true;
        }

        if (GameTuning.hitSquashTime > 0) {
            this.m_SquashTime = GameTuning.hitSquashTime;
            this.m_SquashStrength = Number.isFinite(strength) && strength > 0 ? strength : 1;
        }
    }

    /**
     * 每帧更新，必须在目标节点本帧的基准位置 / 基准缩放确定之后调用
     * @param baseX/baseY 未震动时的位置（对敌人的 ArtRoot 就是 0,0；玩家传世界坐标）
     * @param baseScale 未形变时的缩放（敌人的 `enemyVisualScale`、玩家 1）；
     *                  形变期间只会输出 **≤ baseScale** 的值（只压缩、不外扩）
     */
    update(dt: number, baseX: number, baseY: number, baseScale: number = 1): void {
        if (!this.m_Target || !this.m_Target.isValid) return;
        const shakeTarget = this.m_ShakeTarget && this.m_ShakeTarget.isValid ? this.m_ShakeTarget : this.m_Target;
        const squashTarget = this.m_SquashTarget && this.m_SquashTarget.isValid ? this.m_SquashTarget : this.m_Target;
        const d = Math.max(0, dt);

        // 闪白：随时间线性淡出，结束后关掉节点
        if (this.m_FlashTime > 0) {
            this.m_FlashTime = Math.max(0, this.m_FlashTime - d);
            const ratio = GameTuning.hitFlashTime > 0 ? this.m_FlashTime / GameTuning.hitFlashTime : 0;
            const alpha = Math.round(GameTuning.hitFlashAlpha * ratio);
            const done = this.m_FlashTime <= 0;
            for (const flash of this.m_Flashes) {
                if (done) hideStencilQuad(flash);
                else showStencilQuad(flash, alpha);
            }
        }

        // 震动：幅度随时间衰减的随机抖动；结束时精确归位，避免留下偏移。
        // 幅度还会被"格内留白"夹住 —— 见 safeShakeAmplitude()。
        if (this.m_Shaking) {
            this.m_ShakeTime = Math.max(0, this.m_ShakeTime - d);
            if (this.m_ShakeTime > 0) {
                const ratio = GameTuning.hitShakeTime > 0 ? this.m_ShakeTime / GameTuning.hitShakeTime : 0;
                const amplitude = Math.min(GameTuning.hitShakeAmplitude, safeShakeAmplitude()) * ratio;
                setPos(
                    shakeTarget,
                    baseX + (Math.random() * 2 - 1) * amplitude,
                    baseY + (Math.random() * 2 - 1) * amplitude
                );
            } else {
                this.m_Shaking = false;
                setPos(shakeTarget, baseX, baseY);
            }
        }

        // 形变：命中瞬间压扁、再用阻尼余弦来回弹（果冻感）。
        //
        // ⚠️ **只允许压缩（scale ≤ baseScale），绝不允许外扩**：
        // 敌人按格紧密排列、格与格之间没有空隙，任何 >1 的缩放都会压到邻居身上
        //（这正是"敌人重叠"的直接原因）；而"只压缩"与 `cellSize` / 敌人大小无关，
        // 以后调大调小敌人都不会再出现这个问题。
        // 阻尼余弦会在正负之间交替：正半周压扁纵向、负半周压扁横向，因此仍有"果冻回弹"的观感。
        if (this.m_SquashTime > 0) {
            const total = GameTuning.hitSquashTime;
            this.m_SquashTime = Math.max(0, this.m_SquashTime - d);
            if (this.m_SquashTime > 0 && total > 0) {
                // p：0 → 1；decay 让振幅收尾连续归零，cos 让"压扁 / 回弹"交替
                const p = 1 - this.m_SquashTime / total;
                const k = GameTuning.hitSquashAmount * this.m_SquashStrength * (1 - p) * Math.cos(p * Math.PI * 2);
                const sx = Math.min(1, 1 + k);
                const sy = Math.min(1, 1 - k * 0.85);
                setScaleXY(squashTarget, baseScale * sx, baseScale * sy);
            } else {
                // 归位那一帧也要显式写一次：不写就会停在最后一次形变的缩放上
                setScaleXY(squashTarget, baseScale, baseScale);
            }
        }
    }
}