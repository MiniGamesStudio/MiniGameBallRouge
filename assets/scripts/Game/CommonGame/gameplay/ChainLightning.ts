import { Color, Graphics, Node, UITransform } from 'cc';
import { CHAIN_BOLT_DURATION, CHAIN_BOLT_JITTER, CHAIN_BOLT_SEGMENTS, CHAIN_BOLT_WIDTH } from './SkillConfig';

/** 一条闪电：两端点 + 定死的折线偏移 + 剩余寿命 */
interface BoltData {
    node: Node;
    graphics: Graphics;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /**
     * 折线每个中间点的横向偏移，画的时候定死。
     * 不每帧重新随机：那样线会一直抖成噪点，淡出时看不清是从谁连到谁。
     */
    offsets: number[];
    timer: number;
    /** 复用一个 Color 实例改 alpha，省得每帧 new */
    color: Color;
}

const BOLT_COLOR = { r: 180, g: 225, b: 255 };

/**
 * 连锁闪电的视觉 —— 从被击中的敌人向每个被连锁到的敌人各画一条折线，然后淡出。
 *
 * 和 HitFlash 一样是【纯 dt 驱动】的：不用 tween，也不用 UIOpacity。
 * 一是暂停时特效会跟着一起停；二是这两样在验证桩里没有桩件，
 * 编译能过但一跑就炸 —— 这种"编译通过"的假象最容易骗人。
 * 淡出直接在每次重画时改 strokeColor 的 alpha。
 */
export class ChainLightning {
    private m_Parent: Node = null;
    private m_Bolts: BoltData[] = [];

    init(parent: Node): void {
        this.m_Parent = parent;
    }

    /** 场上还在闪的闪电数，给验证用 */
    get activeCount(): number {
        return this.m_Bolts.length;
    }

    /** 从 (fromX, fromY) 向每个目标各劈一条 */
    strike(fromX: number, fromY: number, targets: ReadonlyArray<{ x: number; y: number }>): void {
        if (!this.m_Parent || !this.m_Parent.isValid) return;
        targets.forEach(target => this.m_Bolts.push(this.createBolt(fromX, fromY, target.x, target.y)));
    }

    /** 由宿主每帧驱动：老化 + 重画 */
    update(dt: number): void {
        for (let i = this.m_Bolts.length - 1; i >= 0; i--) {
            const bolt = this.m_Bolts[i];
            bolt.timer -= dt;

            if (bolt.timer <= 0) {
                this.recycle(i);
                continue;
            }
            this.redraw(bolt);
        }
    }

    clear(): void {
        for (let i = this.m_Bolts.length - 1; i >= 0; i--) this.recycle(i);
        this.m_Bolts.length = 0;
    }

    dispose(): void {
        this.clear();
        this.m_Parent = null;
    }

    private createBolt(fromX: number, fromY: number, toX: number, toY: number): BoltData {
        const node = new Node('ChainBolt');
        node.layer = this.m_Parent.layer;
        this.m_Parent.addChild(node);
        node.setPosition(0, 0, 0);

        // 挂成独立节点而不是和别的渲染组件同节点：同节点多个 UIRenderer 会互相覆盖渲染数据
        node.addComponent(UITransform);
        const graphics = node.addComponent(Graphics);

        const bolt: BoltData = {
            node,
            graphics,
            fromX,
            fromY,
            toX,
            toY,
            offsets: ChainLightning.makeOffsets(),
            timer: CHAIN_BOLT_DURATION,
            color: new Color(BOLT_COLOR.r, BOLT_COLOR.g, BOLT_COLOR.b, 255),
        };
        this.redraw(bolt);
        return bolt;
    }

    /** 折线中间点的偏移量，中间最大、两端为 0 */
    private static makeOffsets(): number[] {
        const offsets: number[] = [];
        for (let i = 1; i < CHAIN_BOLT_SEGMENTS; i++) {
            // 让中间的折点抖得最厉害，两端收拢，看起来才是"两端接住了"的电弧
            const taper = Math.sin((i / CHAIN_BOLT_SEGMENTS) * Math.PI);
            offsets.push((Math.random() * 2 - 1) * CHAIN_BOLT_JITTER * taper);
        }
        return offsets;
    }

    private redraw(bolt: BoltData): void {
        if (!bolt.node || !bolt.node.isValid) return;

        const graphics = bolt.graphics;
        const ratio = Math.max(0, Math.min(1, bolt.timer / CHAIN_BOLT_DURATION));

        graphics.clear();
        bolt.color.a = Math.round(255 * ratio);
        graphics.strokeColor = bolt.color;
        graphics.lineWidth = CHAIN_BOLT_WIDTH;

        const dx = bolt.toX - bolt.fromX;
        const dy = bolt.toY - bolt.fromY;
        const length = Math.sqrt(dx * dx + dy * dy);
        // 垂直于连线的单位向量，折点就沿这个方向抖
        const normalX = length > 1e-6 ? -dy / length : 0;
        const normalY = length > 1e-6 ? dx / length : 0;

        graphics.moveTo(bolt.fromX, bolt.fromY);
        bolt.offsets.forEach((offset, index) => {
            const t = (index + 1) / CHAIN_BOLT_SEGMENTS;
            graphics.lineTo(
                bolt.fromX + dx * t + normalX * offset,
                bolt.fromY + dy * t + normalY * offset,
            );
        });
        graphics.lineTo(bolt.toX, bolt.toY);
        graphics.stroke();
    }

    private recycle(index: number): void {
        const bolt = this.m_Bolts[index];
        this.m_Bolts.splice(index, 1);
        if (bolt.node && bolt.node.isValid) {
            bolt.node.removeFromParent();
            bolt.node.destroy();
        }
    }
}