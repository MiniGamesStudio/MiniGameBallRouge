import { Node, Sprite, SpriteFrame, UITransform, Vec3 } from 'cc';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './GameConfig';

/**
 * 瞄准游标 —— 玩家拖动的准心，开局在屏幕正中
 *
 * 只负责"位置"这一件事：玩家朝它转、子弹朝它飞（见 PlayerController）。
 * 触摸事件不在这里注册——输入层是全屏共用的，由 PlayerController 按"手指是不是落在游标上"
 * 分派给游标还是玩家，这里只接收已经换算到设计空间的坐标，
 * 所以这个类不依赖任何 cc 的触摸类型，也就没有任何输入相关的生命周期要管。
 */
export class AimCursor {
    private m_Node: Node = null;
    private m_Width = 0;
    private m_Height = 0;
    /** 按住游标的那根手指，null 表示没人在拖 */
    private m_TouchId: number | null = null;
    /** 按下瞬间手指与游标的偏移，避免游标瞬移到指尖 */
    private m_Offset = new Vec3();

    init(parent: Node, frame: SpriteFrame): void {
        const node = new Node('AimCursor');
        node.layer = parent.layer;
        parent.addChild(node);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        if (frame) sprite.spriteFrame = frame;

        // 和其他实体一样按原图尺寸显示，不缩放
        const rect = frame ? frame.rect : null;
        this.m_Width = rect ? rect.width : 40;
        this.m_Height = rect ? rect.height : 56;
        transform.setContentSize(this.m_Width, this.m_Height);

        // 开局在屏幕正中
        node.setPosition(0, 0, 0);
        this.m_Node = node;
    }

    get node(): Node {
        return this.m_Node;
    }

    get position(): Readonly<Vec3> {
        return this.m_Node ? this.m_Node.position : Vec3.ZERO;
    }

    /** 抓取半径：用外接圆，斜着点边角也算点上 */
    get grabRadius(): number {
        return Math.max(this.m_Width, this.m_Height) * 0.5;
    }

    /** 手指是否落在游标上——决定这次触摸是拖游标还是拖玩家 */
    containsPoint(x: number, y: number): boolean {
        if (!this.m_Node) return false;
        const pos = this.m_Node.position;
        const dx = x - pos.x;
        const dy = y - pos.y;
        const radius = this.grabRadius;
        return dx * dx + dy * dy <= radius * radius;
    }

    /** 按下：记住是哪根手指、以及手指与游标的偏移 */
    beginDrag(touchId: number, x: number, y: number): void {
        if (!this.m_Node) return;
        const pos = this.m_Node.position;
        this.m_Offset.set(pos.x - x, pos.y - y, 0);
        this.m_TouchId = touchId;
    }

    /** 拖动：只认按下时那根手指，别的手指划过不会把游标带走 */
    moveDrag(touchId: number, x: number, y: number): void {
        if (this.m_TouchId === null || touchId !== this.m_TouchId) return;
        this.moveTo(x + this.m_Offset.x, y + this.m_Offset.y);
    }

    /** 抬手：只有那根手指能结束拖动 */
    endDrag(touchId: number): void {
        if (touchId === this.m_TouchId) this.m_TouchId = null;
    }

    isDragging(touchId: number): boolean {
        return this.m_TouchId === touchId;
    }

    dispose(): void {
        this.m_TouchId = null;
        this.m_Node = null;
    }

    /** 移动并夹在设计区域内，不让游标被拖出屏幕 */
    private moveTo(x: number, y: number): void {
        const halfWidth = (DESIGN_WIDTH - this.m_Width) * 0.5;
        const halfHeight = (DESIGN_HEIGHT - this.m_Height) * 0.5;
        const clampedX = Math.min(halfWidth, Math.max(-halfWidth, x));
        const clampedY = Math.min(halfHeight, Math.max(-halfHeight, y));
        this.m_Node.setPosition(clampedX, clampedY, 0);
    }
}