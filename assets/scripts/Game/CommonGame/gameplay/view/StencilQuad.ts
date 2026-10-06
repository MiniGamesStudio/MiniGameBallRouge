/**
 * 模板裁切色块（表现层公共件）
 *
 * 一块"形状跟美术轮廓走"的纯色填充：把精灵自己的 `spriteFrame` 设成 Mask 模板
 * （`SPRITE_STENCIL`），再在模板里铺一个满尺寸的矩形 —— 颜色只出现在贴图 alpha ≥ 0.1 的地方，
 * 所以形状与美术轮廓完全一致（含两格怪，以及用两格图拉伸出来的 4/6/8 格大怪）。
 *
 * 为什么要有这个文件：受击闪白（view/HitFeedback.ts）与灼烧 / 冰冻覆盖（view/EnemyStatusFx.ts）
 * 需要的是**同一块东西**，只是颜色与不透明度驱动方式不同。原来是写在 HitFeedback 里的私有实现，
 * 复制一份到状态特效就会出现两套"模板怎么挂"的坑（见下），所以抽出来共用。
 *
 * 两个实现坑（照抄自原 HitFeedback，别再踩）：
 * ① `Mask` 的 `SPRITE_STENCIL` 会给**同一个节点**挂一个内部 Sprite 当模板，
 *    所以必须先设 `type` 再设 `spriteFrame`（顺序反了内部 Sprite 还不存在，frame 会被丢掉）；
 * ② 那个内部 Sprite 的尺寸模式要显式改成 `CUSTOM`，否则它会按贴图原始尺寸反改节点大小，
 *    拉伸后的大怪就会只被裁到一小块。
 *
 * 约定：返回的节点**初始 `active = false` 且 opacity = 0**（不产生绘制），
 * 由调用方决定何时点亮 —— 闪白是"受击那一瞬间点亮"，灼烧 / 冰冻是"状态存续期间点亮"。
 */
import { Color, Graphics, Mask, Node, Sprite, SpriteFrame, UIOpacity, UITransform } from 'cc';
import { makeNode, setPos } from './GameArt';

/** 一块模板裁切色块：改 `opacity.opacity` 调透明度，`node.active` 控制有没有这块 */
export interface StencilQuad {
    node: Node;
    opacity: UIOpacity | null;
}

/**
 * 建一块模板裁切色块并挂到 parent 下。
 *
 * @param name 节点名（便于在层级面板里认出是谁）
 * @param frame 用于裁切轮廓的 spriteFrame；为 null 时退化成圆角矩形（缺图兜底）
 * @param width/height 显示尺寸（= 目标所占区域的尺寸）
 * @param color 填充色（含 alpha 语义的基准值；实际透明度由调用方写 opacity）
 * @param offsetX/offsetY 在 parent 局部空间的偏移（多格怪里"这一格"的位置）
 */
export function createStencilQuad(
    parent: Node,
    name: string,
    frame: SpriteFrame | null,
    width: number,
    height: number,
    color: Color,
    offsetX: number = 0,
    offsetY: number = 0
): StencilQuad {
    const node = makeNode(parent, name);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(width, height);
    setPos(node, offsetX, offsetY);

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

    // 填充块：有模板时形状由模板决定，这里铺满整格即可
    const fill = makeNode(node, 'Fill');
    const fillTransform = fill.addComponent(UITransform);
    fillTransform.setContentSize(width, height);
    const graphics = fill.addComponent(Graphics);
    graphics.fillColor = color;
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
    return { node, opacity };
}

/** 点亮一块色块并设透明度（节点或组件已失效时静默跳过） */
export function showStencilQuad(quad: StencilQuad, alpha: number): void {
    if (!quad || !quad.node || !quad.node.isValid) return;
    quad.node.active = true;
    if (quad.opacity && quad.opacity.isValid) quad.opacity.opacity = clampAlpha(alpha);
}

/** 熄灭一块色块 */
export function hideStencilQuad(quad: StencilQuad): void {
    if (!quad || !quad.node || !quad.node.isValid) return;
    quad.node.active = false;
    if (quad.opacity && quad.opacity.isValid) quad.opacity.opacity = 0;
}

/** 0~255 取整（透明度到处都是这个口径，收在一处免得各处 Math.round 写法不一） */
export function clampAlpha(alpha: number): number {
    if (!Number.isFinite(alpha)) return 0;
    return Math.min(255, Math.max(0, Math.round(alpha)));
}