/**
 * 敌人持续状态的表现：灼烧 / 冰冻（表现层）
 *
 * 一只敌人一份，挂在**敌人根节点**下，所以天然继承 `enemyVisualScale`（出生缩放 / 俯冲放大）
 * 与受击震动的位移 —— 不需要在 update 里自己同步这两件事。
 *
 * 为什么是"模板裁切色块"而不是重新画一个矩形：
 * 灼烧 / 冰冻必须**盖住这只怪本身**（而不是给它套一个占格方框），
 * 所以直接用品质底图的 frame 当遮罩，形状 = 底图的圆角 + 描边轮廓，
 * 铺满整个占格 → 一层就覆盖整只怪（不必像闪白那样按格切，闪白要避开"整只怪变白块"，
 * 而状态覆盖本来就是要盖住的）。实现见 view/StencilQuad.ts。
 *
 * 层级：**灼烧在下、冰冻在上**（冰冻是"被冰封住"，压在火焰之上才说得通）。
 * 两者可以同时存在（先被火球打中、又被冰冻），同时点亮时两层颜色自然叠加。
 */
import { Color, Node, SpriteFrame } from 'cc';
import { EnemyRuntime } from '../core/GameTypes';
import { isBurning, isFrozen } from '../core/StatusEffects';
import { StencilQuad, createStencilQuad, hideStencilQuad, showStencilQuad } from './StencilQuad';

/** 灼烧色：暖橙（脉动闪烁 → 像火在跳） */
const BURN_COLOR = new Color(255, 132, 24, 255);
/** 冰冻色：冷青白（常亮 + 极轻微呼吸 → 像一层冰壳） */
const FREEZE_COLOR = new Color(150, 224, 255, 255);

/** 灼烧脉动：基准不透明度 ± 幅度，角速度 rad/s */
const BURN_ALPHA_BASE = 78;
const BURN_ALPHA_SWING = 50;
const BURN_PULSE_SPEED = 13;
/** 冰冻呼吸：基准 ± 幅度（幅度小，免得看起来像在闪） */
const FREEZE_ALPHA_BASE = 118;
const FREEZE_ALPHA_SWING = 14;
const FREEZE_PULSE_SPEED = 4;

export class EnemyStatusFx {
    private m_Burn: StencilQuad | null = null;
    private m_Freeze: StencilQuad | null = null;
    private m_Time: number = 0;

    private constructor() {}

    /**
     * 给敌人根节点挂一份状态表现。
     *
     * @param enemyRoot 敌人**根节点**（底图与怪物图都是它的子节点）
     * @param tileFrame 品质底图的 spriteFrame —— 用作遮罩模板，让覆盖形状贴合美术轮廓
     * @param boxW/boxH 整个占格的尺寸（= 底图的显示尺寸）
     */
    static attach(enemyRoot: Node, tileFrame: SpriteFrame | null, boxW: number, boxH: number): EnemyStatusFx {
        const fx = new EnemyStatusFx();
        if (!enemyRoot || !enemyRoot.isValid) return fx;
        // 先加灼烧、后加冰冻 → 兄弟序决定渲染顺序：冰冻压在上面
        fx.m_Burn = createStencilQuad(enemyRoot, 'BurnFx', tileFrame, boxW, boxH, BURN_COLOR);
        fx.m_Freeze = createStencilQuad(enemyRoot, 'FreezeFx', tileFrame, boxW, boxH, FREEZE_COLOR);
        return fx;
    }

    /**
     * 每帧更新：读敌人的状态决定两层是否点亮，并推进脉动相位。
     *
     * 纯粹由 `enemy.status` 驱动（而不是"命中时点亮、超时熄灭"各自记时），
     * 所以刷新 / 提前清除（敌人死亡）都会自动反映到画面上，不存在两份计时走偏的可能。
     */
    update(dt: number, enemy: EnemyRuntime): void {
        const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
        this.m_Time += d;

        if (isBurning(enemy)) {
            const pulse = Math.sin(this.m_Time * BURN_PULSE_SPEED);
            showStencilQuad(this.m_Burn, BURN_ALPHA_BASE + BURN_ALPHA_SWING * pulse);
        } else {
            hideStencilQuad(this.m_Burn);
        }

        if (isFrozen(enemy)) {
            const pulse = Math.sin(this.m_Time * FREEZE_PULSE_SPEED);
            showStencilQuad(this.m_Freeze, FREEZE_ALPHA_BASE + FREEZE_ALPHA_SWING * pulse);
        } else {
            hideStencilQuad(this.m_Freeze);
        }
    }

    /** 立即熄灭两层（不销毁节点；关节点用 destroy） */
    clear(): void {
        hideStencilQuad(this.m_Burn);
        hideStencilQuad(this.m_Freeze);
    }

    /**
     * 销毁两层节点。
     * 正常路径下它们建在敌人根节点里、会随敌人节点一起销毁，所以这里主要是
     * 关卡重开 / 外部主动回收时的显式收尾。
     */
    destroy(): void {
        for (const quad of [this.m_Burn, this.m_Freeze]) {
            if (quad && quad.node && quad.node.isValid) quad.node.destroy();
        }
        this.m_Burn = null;
        this.m_Freeze = null;
    }
}