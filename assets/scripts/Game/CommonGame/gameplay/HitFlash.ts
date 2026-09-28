import { Color, Graphics, Node, UITransform } from 'cc';

/** 闪白持续时间（秒），要足够短才像"挨了一下"而不是变色 */
const FLASH_DURATION = 0.09;
const COLOR_FLASH = new Color(255, 255, 255, 255);

/**
 * 受击闪白。
 *
 * 为什么不用 Sprite.color：color 是【乘算】，对纯色贴图设成白色等于什么都没改，
 * 只能把颜色调暗，做不出提亮。所以这里在实体上面挂一个同形状的白色 Graphics 子节点，
 * 命中时短暂显示，天然盖出纯白剪影。
 *
 * 子节点跟随父节点，竖版 double 的 90° 旋转会自动继承，不需要额外处理。
 * 计时由宿主每帧驱动（见 update），这样暂停时闪白也会一起停住。
 */
export class HitFlash {
    private m_Node: Node = null;
    private m_Timer = 0;

    private constructor(node: Node) {
        this.m_Node = node;
    }

    /** 圆角矩形闪白，宽高用贴图原始尺寸（旋转前的），与敌人图一致 */
    static rect(parent: Node, width: number, height: number, radius: number): HitFlash {
        const graphics = HitFlash.createGraphics(parent, 'HitFlashRect');
        graphics.roundRect(-width * 0.5, -height * 0.5, width, height, radius);
        graphics.fill();
        return new HitFlash(graphics.node);
    }

    /** 圆形闪白，用于玩家 */
    static circle(parent: Node, radius: number): HitFlash {
        const graphics = HitFlash.createGraphics(parent, 'HitFlashCircle');
        graphics.circle(0, 0, radius);
        graphics.fill();
        return new HitFlash(graphics.node);
    }

    /** 播放一次闪白；连续命中会重新计时，不会提前熄灭 */
    play(): void {
        if (!this.m_Node || !this.m_Node.isValid) return;

        this.m_Node.active = true;
        this.m_Timer = FLASH_DURATION;
    }

    /** 由宿主每帧驱动 */
    update(dt: number): void {
        if (this.m_Timer <= 0) return;

        this.m_Timer -= dt;
        if (this.m_Timer > 0) return;

        this.m_Timer = 0;
        if (this.m_Node && this.m_Node.isValid) {
            this.m_Node.active = false;
        }
    }

    dispose(): void {
        this.m_Node = null;
        this.m_Timer = 0;
    }

    private static createGraphics(parent: Node, name: string): Graphics {
        const node = new Node(name);
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(0, 0, 0);

        // 挂成子节点而不是和 Sprite 同节点：同节点多个 UIRenderer 会互相覆盖渲染数据
        node.addComponent(UITransform);
        const graphics = node.addComponent(Graphics);
        graphics.fillColor = COLOR_FLASH;
        node.active = false;
        return graphics;
    }
}