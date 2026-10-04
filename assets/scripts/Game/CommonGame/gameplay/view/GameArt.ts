/**
 * 美术层：把 assets/subpackages/game（bundle 名 `game`）里的图片接到节点上
 *
 * 当前素材（用户提供）：
 *   品质底图   white / green / blue / purple / yellow / red   128×128     白绿蓝紫金红，一格一张
 *   怪物       monster_0001 … monster_0010                    80×(72~94)  普通与精英
 *   BOSS       Boss_001 / Boss_002 / Boss_003                 80×(59~87)  四格 / 六格 / 八格
 *   玩家       player_001                                     80×76
 *   子弹       game_bullet                                    20×30
 *   瞄准游标   game_cursor                                    40×56
 *   背景       background/game_bg
 *
 * 敌人外观的合成方式（重要）：
 *   = 品质底图**按格平铺**（1 格 1 张，不拉伸）+ 怪物图**contain 适配**叠在中间。
 *   底图是 128×128 的整格美术，拉伸会把描边与质感拉变形；怪物图原始宽度只有 80，
 *   直接按占格缩放同样会变形，所以统一走 applyContainFit() 按美术自身长宽比算缩放。
 *
 * ⚠️ 图片在 Cocos 里是「图片资源 + spriteFrame 子资源」两级结构，取 SpriteFrame 时
 *    路径可能要补 `/spriteFrame`，所以下面 loadSpriteFrame() 走两段兜底
 *    （与 engine/ui/UIBase.ts 加载按钮图标的方式保持一致）。
 */

import { Color, Graphics, Label, Layers, Node, Sprite, SpriteFrame, UITransform, Vec3, assetManager } from 'cc';
import { ResManager } from '../../../../engine/ResManager';
import { EnemyShape, Quality } from '../core/GameTypes';
import { GameTuning } from '../core/GameTuning';

/** 玩法素材所在的 bundle（assets/subpackages/game 配了 isBundle + bundleName=game） */
export const GAME_BUNDLE = 'game';

/** 素材路径（相对 bundle 根，不带扩展名） */
export const GameArtPath = {
    // ── 玩家与通用 ──
    player: 'texture/player_001',
    bullet: 'texture/game_bullet',
    cursor: 'texture/game_cursor',
    background: 'background/game_bg',
    // ── 品质底图（一格一张，128×128）──
    tileWhite: 'texture/white',
    tileGreen: 'texture/green',
    tileBlue: 'texture/blue',
    tilePurple: 'texture/purple',
    tileYellow: 'texture/yellow',
    tileRed: 'texture/red',
    // 掉落物（需求 4）
    dropExp: 'texture/exp',
    dropCoin: 'texture/coin',
    dropSoul: 'texture/hun',
    dropSuper: 'texture/super',
    // ── 怪物（普通 / 精英，10 张）──
    monster01: 'texture/monster_0001',
    monster02: 'texture/monster_0002',
    monster03: 'texture/monster_0003',
    monster04: 'texture/monster_0004',
    monster05: 'texture/monster_0005',
    monster06: 'texture/monster_0006',
    monster07: 'texture/monster_0007',
    monster08: 'texture/monster_0008',
    monster09: 'texture/monster_0009',
    monster10: 'texture/monster_0010',
    // ── BOSS（四格 / 六格 / 八格）──
    bossQuad: 'texture/Boss_001',
    bossSix: 'texture/Boss_002',
    bossEight: 'texture/Boss_003',
} as const;

/** 品质 → 底图路径，索引与 Quality 枚举一致（0 白 / 1 绿 / 2 蓝 / 3 紫 / 4 金 / 5 红） */
const QUALITY_TILE_PATHS: readonly string[] = [
    GameArtPath.tileWhite,
    GameArtPath.tileGreen,
    GameArtPath.tileBlue,
    GameArtPath.tilePurple,
    GameArtPath.tileYellow,
    GameArtPath.tileRed,
];

/** 普通 / 精英怪可用的怪物图（10 张） */
const MONSTER_PATHS: readonly string[] = [
    GameArtPath.monster01,
    GameArtPath.monster02,
    GameArtPath.monster03,
    GameArtPath.monster04,
    GameArtPath.monster05,
    GameArtPath.monster06,
    GameArtPath.monster07,
    GameArtPath.monster08,
    GameArtPath.monster09,
    GameArtPath.monster10,
];

/** 四格 / 六格 / 八格 BOSS 图（索引 = shape - EnemyShape.Quad） */
const BOSS_PATHS: readonly string[] = [GameArtPath.bossQuad, GameArtPath.bossSix, GameArtPath.bossEight];

/** 稳定字符串哈希（FNV-1a）：同一个 defId 永远取到同一只怪，不会每次生成都换脸 */
function stableHash(text: string): number {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
}

/** 品质 → 底图贴图路径 */
export function qualityArtPath(quality: Quality): string {
    return QUALITY_TILE_PATHS[quality] || GameArtPath.tileWhite;
}

/**
 * 怪物贴图路径
 * 四 / 六 / 八格走 BOSS 图（与体型一一对应），普通与精英按 defId 稳定散列到 monster_0001-0010。
 * ⚠️ P0 临时规则（6 品质 × 10 怪物 = 60 种外观组合）；正式值应走 Enemy 表的贴图列。
 */
export function enemyMonsterArtPath(defId: string, shape: EnemyShape): string {
    if (shape >= EnemyShape.Quad) {
        const index = shape - EnemyShape.Quad;
        return BOSS_PATHS[index] || BOSS_PATHS[0];
    }
    return MONSTER_PATHS[stableHash(defId || 'e') % MONSTER_PATHS.length];
}

/** 敌人外观 = 品质底图（按格平铺）+ 怪物图（contain 适配） */
export function enemyArtPaths(defId: string, shape: EnemyShape, quality: Quality): { base: string; monster: string } {
    return {
        base: qualityArtPath(quality),
        monster: enemyMonsterArtPath(defId, shape),
    };
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

/** 按占格设置节点尺寸（= cols × cellSize, rows × cellSize），敌人根节点用 */
export function applyCellSize(node: Node, cols: number, rows: number): void {
    if (!node || !node.isValid) return;
    const transform = node.getComponent(UITransform);
    if (!transform) return;
    transform.setContentSize(cols * GameTuning.cellSize, rows * GameTuning.cellSize);
}

/**
 * contain 适配：把精灵按美术自身长宽比缩放，塞进 boxW × boxH 内并留出 margin 比例的边。
 * 用于怪物图 / 玩家图叠在占格之上（美术原始宽度 80，占格是 128 的整数倍，直接拉伸会变形）。
 * @returns 适配后的实际尺寸；**受击闪白的模板必须用这个尺寸**，用占格尺寸会和怪物轮廓错位
 */
export function applyContainFit(
    node: Node,
    frame: SpriteFrame | null,
    boxW: number,
    boxH: number,
    margin: number
): { width: number; height: number } | null {
    if (!node || !node.isValid || !frame) return null;
    const transform = node.getComponent(UITransform);
    if (!transform) return null;

    const original = frame.originalSize;
    const artW = Math.max(1, original && original.width > 0 ? original.width : frame.rect.width);
    const artH = Math.max(1, original && original.height > 0 ? original.height : frame.rect.height);
    const scale = Math.max(0.01, margin) * Math.min(boxW / artW, boxH / artH);
    const width = artW * scale;
    const height = artH * scale;
    transform.setContentSize(width, height);
    return { width, height };
}

/** 把节点朝向速度方向（子弹贴图默认朝上 → 角度 = atan2 转成度） */
/**
 * 九宫格（SLICED）：底图是整格美术（多层描边 + 圆角），拉大铺满整个占格时只拉伸中间区域，
 * 四角与描边按 1:1 保留，不会糊成一团。inset 默认 16px（128 的 12.5%，实测描边环在内）。
 */
export function applyNineSlice(node: Node, frame: SpriteFrame | null, inset: number): void {
    if (!frame) return;
    const sprite = node.getComponent(Sprite);
    if (!sprite) return;
    const w = frame.originalSize.width;
    const h = frame.originalSize.height;
    const ix = Math.max(0, Math.min(Math.floor(inset), Math.floor(w * 0.5) - 1));
    const iy = Math.max(0, Math.min(Math.floor(inset), Math.floor(h * 0.5) - 1));
    if (ix <= 0 || iy <= 0) return;
    frame.insetLeft = ix;
    frame.insetRight = ix;
    frame.insetTop = iy;
    frame.insetBottom = iy;
    frame.packable = false;
    sprite.type = Sprite.Type.SLICED;
}

export function faceVelocity(node: Node, vx: number, vy: number): void {
    if (!node || !node.isValid) return;
    if (Math.abs(vx) < 1e-4 && Math.abs(vy) < 1e-4) return;
    const angle = (Math.atan2(vy, vx) * 180) / Math.PI - 90;
    node.angle = angle;
}