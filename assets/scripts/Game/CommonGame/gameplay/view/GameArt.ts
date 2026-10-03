/**
 * 占位美术层：把 assets/subpackages/game（bundle 名 `game`）里的图片接到节点上
 *
 * 当前使用的素材（用户提供，全部为 80 的整数倍，正好等于一格）：
 *   game_player       80×80    玩家
 *   game_bullet       20×30    玩家子弹
 *   game_cursor       40×56    瞄准游标
 *   game_single_*     80×80    单格敌人（blue / red / green）
 *   game_double_*    160×80    两格敌人（blue / red / geen）
 *
 * ⚠️ 三个必须知道的现状：
 *   1. 两格绿色素材的文件名是 **game_double_geen**（少一个 r），不是 game_double_green；
 *   2. 4/6/8 格 BOSS 暂时没有专属素材，这里用两格贴图**拉伸**到实际占格，
 *      等正式素材到位后只改 enemyArtPath 一处即可；
 *   3. 图片在 Cocos 里是「图片资源 + spriteFrame 子资源」两级结构，取 SpriteFrame 时
 *      路径可能要补 `/spriteFrame`，所以下面 loadSpriteFrame() 走两段兜底
 *      （与 engine/ui/UIBase.ts 加载按钮图标的方式保持一致）。
 */

import { Color, Graphics, Label, Layers, Node, Sprite, SpriteFrame, UITransform, Vec3, assetManager } from 'cc';
import { ResManager } from '../../../../engine/ResManager';
import { EnemyShape, Quality } from '../core/GameTypes';
import { GameTuning } from '../core/GameTuning';

/** 玩法素材所在的 bundle（assets/subpackages/game 配了 isBundle + bundleName=game） */
export const GAME_BUNDLE = 'game';

/** 素材路径（相对 bundle 根，不带扩展名） */
export const GameArtPath = {
    player: 'texture/game_player',
    bullet: 'texture/game_bullet',
    cursor: 'texture/game_cursor',
    singleBlue: 'texture/game_single_blue',
    singleRed: 'texture/game_single_red',
    singleGreen: 'texture/game_single_green',
    doubleBlue: 'texture/game_double_blue',
    doubleRed: 'texture/game_double_red',
    /** ⚠️ 文件名确实是 geen（素材命名笔误），不要"顺手修正"成 green */
    doubleGreen: 'texture/game_double_geen',
    background: 'background/game_bg',
} as const;

export type EnemyArtColor = 'blue' | 'red' | 'green';

/**
 * 品质 → 占位配色（只有三种颜色可用）
 * 白/绿 → green、蓝 → blue、紫/金/红 → red
 */
export function qualityArtColor(quality: Quality): EnemyArtColor {
    switch (quality) {
        case Quality.Blue:
            return 'blue';
        case Quality.Purple:
        case Quality.Gold:
        case Quality.Red:
            return 'red';
        case Quality.White:
        case Quality.Green:
        default:
            return 'green';
    }
}

/** 体型 + 品质 → 贴图路径 */
export function enemyArtPath(shape: EnemyShape, quality: Quality): string {
    const color = qualityArtColor(quality);
    const useDouble = shape !== EnemyShape.Single;
    if (color === 'blue') return useDouble ? GameArtPath.doubleBlue : GameArtPath.singleBlue;
    if (color === 'red') return useDouble ? GameArtPath.doubleRed : GameArtPath.singleRed;
    return useDouble ? GameArtPath.doubleGreen : GameArtPath.singleGreen;
}

/** 一张素材的加载结果 */
export interface ArtEntry {
    frame: SpriteFrame;
    /** 真正命中的资源路径（可能是 `路径/spriteFrame`） */
    resolvedPath: string;
}

/** 逻辑路径 → 素材 */
export type ArtCache = Map<string, ArtEntry>;

/**
 * 常驻缓存：占位素材只有 10 张小图，常驻既省掉每次重开关卡的重复加载，
 * 也避免「释放路径写错 → 贴图被提前释放 → 又变成看不见」这类时序坑。
 */
let g_ResidentCache: ArtCache | null = null;

/** 绕过 ResManager 的引擎原生取图（兜底：万一 ResManager 的 bundle 缓存/引用计数出问题，这里能自愈） */
function loadRawSpriteFrame(path: string): Promise<SpriteFrame | null> {
    return new Promise(resolve => {
        assetManager.loadBundle(GAME_BUNDLE, (bundleErr, bundle) => {
            if (bundleErr || !bundle) {
                resolve(null);
                return;
            }
            bundle.load(path, SpriteFrame, (err, frame) => {
                resolve(!err && frame ? frame : null);
            });
        });
    });
}

/**
 * 取一张图的 SpriteFrame：先按图片路径取，失败再退到子资源约定 `路径/spriteFrame`。
 * 两条都失败才算缺图（会打印 error，并在画面上画洋红方块，绝不静默空白）。
 */
async function loadSpriteFrame(path: string): Promise<ArtEntry | null> {
    const res = ResManager.getInstance();
    const candidates = [path, `${path}/spriteFrame`];
    let lastError: unknown = null;

    for (const candidate of candidates) {
        try {
            const frame = await res.loadFromBundleAsync(GAME_BUNDLE, candidate, SpriteFrame);
            if (frame) return { frame, resolvedPath: candidate };
        } catch (err) {
            lastError = err;
        }
    }

    // 兜底：绕过 ResManager，直接用引擎原生 API 再试一遍
    // （万一 ResManager 的 bundle 缓存 / 引用计数出了问题，这里能自愈并留下证据）
    for (const candidate of candidates) {
        const rawFrame = await loadRawSpriteFrame(candidate);
        if (rawFrame) {
            console.warn(`[GameArt] ResManager 取图失败、引擎原生 bundle.load 成功：${candidate}（建议排查 ResManager）`);
            return { frame: rawFrame, resolvedPath: candidate };
        }
    }

    console.error(
        `[GameArt] 素材加载失败：${GAME_BUNDLE}/${path}（ResManager 与引擎原生 API 均失败，已尝试 ${candidates.join(' 和 ')}。` +
        `请检查：① 图片是否真的在 assets/subpackages/game/${path}.png；② game bundle 是否已加载；③ 文件名大小写）`,
        lastError
    );
    return null;
}

/**
 * 预加载全部占位素材（结果常驻缓存）。
 * 单张失败不影响开局，但会 warn + 画面上显示洋红方块，方便一眼定位。
 */
export async function preloadGameArt(): Promise<ArtCache> {
    if (g_ResidentCache) return g_ResidentCache;

    const paths: string[] = Object.values(GameArtPath);
    const cache: ArtCache = new Map();

    await Promise.all(
        paths.map(async path => {
            const entry = await loadSpriteFrame(path);
            if (entry) cache.set(path, entry);
        })
    );

    g_ResidentCache = cache;
    const ok = cache.size === paths.length;
    console.info(
        `[GameArt] 占位素材 ${cache.size}/${paths.length} 就绪（bundle: ${GAME_BUNDLE}）` +
        (ok ? '' : ' ⚠️ 有素材没加载成功，请看上面的 warn')
    );
    return cache;
}

/** 已加载素材张数（调试 HUD 用） */
export function gameArtCount(cache: ArtCache | null): number {
    return (cache && cache.size) || 0;
}

/** 素材总张数（调试 HUD 用） */
export function gameArtTotal(): number {
    return Object.values(GameArtPath).length;
}

/** 取贴图（缺失返回 null） */
export function getArt(cache: ArtCache | null, path: string): SpriteFrame | null {
    const entry = cache && cache.get(path);
    return (entry && entry.frame) || null;
}

/** 清掉常驻缓存（热重载 / 换素材后想强制重新加载时用；正常玩法流程不需要） */
export function clearGameArtCache(): void {
    g_ResidentCache = null;
}

/** 建一个 UI 节点（自动继承父节点 layer，否则 UI 不渲染） */
export function makeNode(parent: Node, name: string): Node {
    const node = new Node(name);
    node.layer = parent ? parent.layer : Layers.Enum.UI_2D;
    if (parent) parent.addChild(node);
    node.setPosition(0, 0, 0);
    return node;
}

/**
 * 缺图兜底：画一个半透明洋红方块。
 * 宁可难看也不能「什么都没有」——否则素材加载失败时画布上完全看不出问题（本项目已踩过）。
 */
function drawMissingArtBox(node: Node, width: number, height: number): void {
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = new Color(255, 0, 200, 90);
    graphics.rect(-width / 2, -height / 2, width, height);
    graphics.fill();
    graphics.strokeColor = new Color(255, 0, 200, 220);
    graphics.lineWidth = 2;
    graphics.rect(-width / 2, -height / 2, width, height);
    graphics.stroke();
}

/**
 * 建一个精灵节点
 * @param width/height 不传则用素材原始尺寸
 */
export function createSprite(
    parent: Node,
    name: string,
    frame: SpriteFrame | null,
    width?: number,
    height?: number
): Node {
    const node = makeNode(parent, name);
    const transform = node.addComponent(UITransform);
    const sprite = node.addComponent(Sprite);
    sprite.spriteFrame = frame;
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;

    if (width && height) {
        transform.setContentSize(width, height);
    } else if (frame) {
        transform.setContentSize(frame.rect.width, frame.rect.height);
    } else {
        transform.setContentSize(GameTuning.cellSize, GameTuning.cellSize);
    }

    if (!frame) {
        drawMissingArtBox(node, transform.contentSize.width, transform.contentSize.height);
    }
    return node;
}

/** 建一个文本节点（居中，默认 24 号白字） */
export function createLabel(
    parent: Node,
    name: string,
    text: string = '',
    fontSize: number = 24,
    color: Color = Color.WHITE
): Label {
    const node = makeNode(parent, name);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(GameTuning.designWidth, fontSize + 8);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 6;
    label.color = color;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    return label;
}

/** 设置节点位置（忽略 z） */
export function setPos(node: Node, x: number, y: number): void {
    if (!node || !node.isValid) return;
    node.setPosition(new Vec3(x, y, 0));
}

/** 设置节点缩放（等比） */
export function setScale(node: Node, scale: number): void {
    if (!node || !node.isValid) return;
    node.setScale(new Vec3(scale, scale, 1));
}

/** 按占格设置精灵尺寸（多格敌人用一张贴图拉伸到实际占格） */
export function applyCellSize(node: Node, cols: number, rows: number): void {
    if (!node || !node.isValid) return;
    const transform = node.getComponent(UITransform);
    if (!transform) return;
    transform.setContentSize(cols * GameTuning.cellSize, rows * GameTuning.cellSize);
}

/** 把节点朝向速度方向（子弹贴图默认朝上 → 角度 = atan2 转成度） */
export function faceVelocity(node: Node, vx: number, vy: number): void {
    if (!node || !node.isValid) return;
    if (Math.abs(vx) < 1e-4 && Math.abs(vy) < 1e-4) return;
    const angle = (Math.atan2(vy, vx) * 180) / Math.PI - 90;
    node.angle = angle;
}