/**
 * 闪电链特效（表现层）
 *
 * 把 core/ChainLightning.ts 算出来的折线画出来，并让它**依次劈过 N 个目标**：
 * 锚点 →（第 1 跳）→ 目标 →（第 2 跳）→ … ，时长取自 GameTuning（v1.12 起 0.35s）。
 *
 * 被闪电链接的**每个目标身上也会画一个电光爆点**（需求：「被闪电链接的目标需要有闪电效果」）
 * —— 爆点跟着"已劈到第几个"逐个点亮，与伤害结算的节奏严格一致（同一个 reachedTargets）。
 *
 * 为什么是 Graphics 而不是美术帧动画 / tween：
 * ① 工程里没有闪电素材，程序化折线零资源就能出效果（同「网格背景兜底」的思路，
 *    缺图不再是"什么都没有"）；
 * ② 策划案 §B.3 明确要求**特效不用 tween**，纯 `update(dt)` 推进 —— 无头环境与暂停逻辑
 *    才有一致的口径（暂停时整个特效冻结，和 HitFeedback / 飘字一个待遇）；
 * ③ 折线每隔 `chainLightningFlicker` 重新抖动一次，"电在跳"的闪烁感是随机数给的，
 *    贴图动画做不到。
 *
 * 层级：**四层 Graphics**（外发光折线 / 核心折线 / 外发光爆点 / 核心爆点）各挂一个子节点，
 * 而不是让同一个 Graphics 画两种东西 —— Graphics 的路径状态在 `stroke()` / `fill()` 后不会自动清空，
 * 既描线又填圆会在同一份路径上互相污染（外发光会整条变成核心色、开折线会被当成多边形填充）。
 * 爆点层加在折线层**之后** → 爆点压在线上，目标处更亮。
 *
 * 位置：目标点用的是**场地坐标**（敌人就在这个坐标系里），所以特效根节点固定在 (0,0)，
 * 折线直接用目标坐标画。敌人会随世界滚动下移，所以每帧都要 `refresh()` 最新坐标，
 * 否则闪电会在播放期间和自己的目标脱开。
 */
import { Color, Graphics, Node, UIOpacity, UITransform } from 'cc';
import { GameTuning } from '../core/GameTuning';
import { Point, buildBoltPath, pathLength, reachedTargetCount, truncatePath } from '../core/ChainLightning';
import { IRandom } from '../core/Rng';
import { makeNode } from './GameArt';

/** 外发光色（半透明蓝）/ 核心色（近白的冷光） */
const BOLT_GLOW = new Color(80, 150, 255, 140);
const BOLT_CORE = new Color(210, 245, 255, 255);

export class ChainLightningFx {
    private m_Node: Node;
    /** 折线两层：外发光在下、核心在上 */
    private m_LineGlow: Graphics;
    private m_LineCore: Graphics;
    /** 目标爆点两层：同样先发光后核心，且整体压在折线之上 */
    private m_MarkGlow: Graphics;
    private m_MarkCore: Graphics;
    private m_Opacity: UIOpacity;
    private m_Rng: IRandom;

    /** 当前目标点（场地坐标），随敌人移动每帧刷新 */
    private m_Targets: Point[] = [];
    /** 当前折线（整条链拼接而成），按闪烁间隔重建 */
    private m_Path: Point[] = [];
    /** 已经"劈到"第几个目标（1 起），玩法层据此按到达顺序结算伤害 */
    private m_Reached: number = 1;

    private m_Time: number = 0;
    private m_FlickerTimer: number = 0;
    private m_Done: boolean = false;

    private constructor(parent: Node, rng: IRandom, points: Point[]) {
        this.m_Rng = rng;
        this.m_Node = makeNode(parent, 'ChainLightningFx');
        // 与 HitFeedback 同样的顺序：先 UITransform，再挂 UIOpacity / Graphics
        // （UIOpacity 与 Graphics 都是 UI 组件，节点上没 UITransform 时行为不确定）
        this.m_Node.addComponent(UITransform);
        this.m_Opacity = this.m_Node.addComponent(UIOpacity);

        // 四个层分开挂，加入顺序 = 渲染顺序：发光折线 → 核心折线 → 发光爆点 → 核心爆点
        this.m_LineGlow = ChainLightningFx.makeGraphicsNode(this.m_Node, 'LineGlow');
        this.m_LineCore = ChainLightningFx.makeGraphicsNode(this.m_Node, 'LineCore');
        this.m_MarkGlow = ChainLightningFx.makeGraphicsNode(this.m_Node, 'MarkGlow');
        this.m_MarkCore = ChainLightningFx.makeGraphicsNode(this.m_Node, 'MarkCore');

        this.m_Targets = points.map(p => ({ x: p.x, y: p.y }));
        this.rebuildPath();
    }

    /** 在 parent 下播放一条闪电链（目标不足 1 个时直接返回 null，不建节点） */
    static play(parent: Node, points: readonly Point[], rng: IRandom): ChainLightningFx | null {
        if (!parent || !parent.isValid || !points || points.length === 0) return null;
        return new ChainLightningFx(parent, rng, points as Point[]);
    }

    private static makeGraphicsNode(parent: Node, name: string): Graphics {
        const node = makeNode(parent, name);
        node.addComponent(UITransform);
        return node.addComponent(Graphics);
    }

    /** 每帧用**最新**目标位置刷新（敌人随世界滚动下移，不刷新闪电会和目标脱开） */
    refresh(points: readonly Point[]): void {
        if (!points || points.length === 0) return;
        this.m_Targets = points.map(p => ({ x: p.x, y: p.y }));
    }

    /** 已经劈到第几个目标（1 起；最大 = 目标数） */
    get reachedTargets(): number {
        return this.m_Reached;
    }

    /** 播放结束（调用方负责 destroy） */
    get finished(): boolean {
        return this.m_Done;
    }

    update(dt: number): void {
        if (this.m_Done || !this.m_Node || !this.m_Node.isValid) return;
        const d = Math.max(0, dt);
        this.m_Time += d;

        const duration = Math.max(0.01, GameTuning.chainLightningDuration);
        const revealTime = Math.max(0.01, duration * GameTuning.chainLightningRevealRatio);

        // 折线按固定间隔重新抖动（不是每帧）：每帧重抖会变成噪点，20Hz 左右才像"电在跳"
        this.m_FlickerTimer -= d;
        if (this.m_FlickerTimer <= 0) {
            this.rebuildPath();
            this.m_FlickerTimer = Math.max(0, GameTuning.chainLightningFlicker);
        }

        const progress = Math.min(1, this.m_Time / revealTime);
        this.m_Reached = reachedTargetCount(this.m_Path, this.m_Targets.length, progress);
        this.draw(truncatePath(this.m_Path, progress), this.m_Reached);

        // 淡出：推进阶段结束后，用剩余时间线性淡出
        if (this.m_Time > revealTime) {
            const fade = Math.max(0.01, duration - revealTime);
            const k = Math.min(1, (this.m_Time - revealTime) / fade);
            if (this.m_Opacity && this.m_Opacity.isValid) {
                this.m_Opacity.opacity = Math.round(255 * (1 - k));
            }
        }

        if (this.m_Time >= duration) {
            this.m_Done = true;
        }
    }

    destroy(): void {
        if (this.m_Node && this.m_Node.isValid) this.m_Node.destroy();
    }

    /** 把「目标点序列」拼成一条折线：逐跳 buildBoltPath，相邻跳共享一个端点 */
    private rebuildPath(): void {
        const targets = this.m_Targets;
        const segments = Math.max(1, Math.floor(GameTuning.chainLightningSegments));
        const jitter = GameTuning.chainLightningJitter;

        const path: Point[] = [];
        for (let i = 0; i < targets.length; i++) {
            if (i === 0) {
                path.push({ x: targets[0].x, y: targets[0].y });
                continue;
            }
            const hop = buildBoltPath(this.m_Rng, targets[i - 1], targets[i], segments, jitter);
            // hop[0] 与上一跳的末点重合 → 跳过，避免零长度段
            for (let k = 1; k < hop.length; k++) path.push(hop[k]);
        }
        this.m_Path = path;
    }

    /**
     * 画一帧：折线（按进度截断）+ 已劈到的目标身上的电光爆点。
     *
     * @param shown 本帧要画的折线（已按进度截断）
     * @param reached 已经劈到第几个目标（1 起）—— 爆点个数与伤害结算用的是同一个数
     */
    private draw(shown: Point[], reached: number): void {
        const glowWidth = Math.max(1, GameTuning.chainLightningGlowWidth);
        const coreWidth = Math.max(1, GameTuning.chainLightningCoreWidth);
        const markRadius = Math.max(1, GameTuning.chainLightningMarkRadius);
        const markGlowRadius = markRadius * Math.max(1, GameTuning.chainLightningMarkGlowScale);

        // ① 折线：只有一个目标 / 目标点重合（折线长度 0）时线层清空即可 ——
        //    这种情况下目标爆点照样会画出来，不会"什么都没有"
        const degenerate = shown.length < 2 || pathLength(shown) <= 0.5;
        if (degenerate) {
            this.m_LineGlow.clear();
            this.m_LineCore.clear();
        } else {
            ChainLightningFx.stroke(this.m_LineGlow, shown, glowWidth, BOLT_GLOW);
            ChainLightningFx.stroke(this.m_LineCore, shown, coreWidth, BOLT_CORE);
        }

        // ② 目标爆点：逐跳点亮（"被链接的目标身上有闪电效果"）
        this.drawMarks(this.m_MarkGlow, reached, markGlowRadius, BOLT_GLOW);
        this.drawMarks(this.m_MarkCore, reached, markRadius, BOLT_CORE);
    }

    /** 在**前 count 个**目标处各画一个实心爆点（一次攒齐所有圆再 fill，免得每画一个刷一次） */
    private drawMarks(layer: Graphics, count: number, radius: number, color: Color): void {
        layer.clear();
        const n = Math.min(Math.max(0, Math.floor(count)), this.m_Targets.length);
        if (n <= 0) return;
        layer.fillColor = color;
        for (let i = 0; i < n; i++) {
            const at = this.m_Targets[i];
            if (!at) continue;
            layer.circle(at.x, at.y, radius);
        }
        layer.fill();
    }

    private static stroke(g: Graphics, points: readonly Point[], width: number, color: Color): void {
        g.clear();
        g.lineWidth = width;
        g.strokeColor = color;
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
        g.stroke();
    }
}