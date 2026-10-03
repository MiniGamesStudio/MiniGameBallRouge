/**
 * 棋盘几何（纯逻辑层，不依赖 cc）
 *
 * 坐标约定（策划案 §5）：原点在屏幕中心，x 向右、y 向上；屏幕范围 ±designWidth/2、±designHeight/2。
 * 墙体就是**屏幕四周边缘**；棋盘（列）宽 400 px，居中于 750。
 */

import { Box, Vec2 } from './GameTypes';
import { GameTuning } from './GameTuning';

/** 屏幕边界 */
export interface ScreenBounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export function screenBounds(): ScreenBounds {
    const halfW = GameTuning.designWidth * 0.5;
    const halfH = GameTuning.designHeight * 0.5;
    return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

/** 棋盘总宽（列数 × 格边长） */
export function boardWidth(): number {
    return GameTuning.columns * GameTuning.cellSize;
}

/** 第 col 列的中心 x（col 从 0 开始，整体居中） */
export function columnCenterX(col: number): number {
    const half = GameTuning.columns * 0.5;
    return (col + 0.5 - half) * GameTuning.cellSize;
}

/** 棋盘最左列的左边线 x */
export function boardLeftX(): number {
    return columnCenterX(0) - GameTuning.cellSize * 0.5;
}

/** 世界 x → 列索引（越界会夹到合法列） */
export function worldToColumn(x: number): number {
    const raw = Math.floor((x - boardLeftX()) / GameTuning.cellSize);
    return clamp(raw, 0, GameTuning.columns - 1);
}

/** 数值夹取 */
export function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** 玩家位置夹取：整体留在屏幕内（用判定半径留边） */
export function clampPlayerPosition(x: number, y: number, hitRadius: number): Vec2 {
    const bounds = screenBounds();
    return {
        x: clamp(x, bounds.left + hitRadius, bounds.right - hitRadius),
        y: clamp(y, bounds.bottom + hitRadius, bounds.top - hitRadius),
    };
}

/** 瞄准游标位置夹取 */
export function clampCursorPosition(x: number, y: number, radius: number): Vec2 {
    const bounds = screenBounds();
    return {
        x: clamp(x, bounds.left + radius, bounds.right - radius),
        y: clamp(y, bounds.bottom + radius, bounds.top - radius),
    };
}

/** 两点距离 */
export function distance(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

/** 点是否在矩形内 */
export function pointInBox(x: number, y: number, box: Box): boolean {
    return Math.abs(x - box.x) <= box.halfW && Math.abs(y - box.y) <= box.halfH;
}

/** 圆与圆相交 */
export function circleHitsCircle(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
    return distance(ax, ay, bx, by) <= ar + br;
}

/** 圆是否触及矩形（扩张矩形法） */
export function circleHitsBox(cx: number, cy: number, radius: number, box: Box): boolean {
    return (
        Math.abs(cx - box.x) <= box.halfW + radius &&
        Math.abs(cy - box.y) <= box.halfH + radius
    );
}

/** 矩形命中信息：沿哪条轴弹开、法线方向、穿透深度 */
export interface BoxHit {
    /** 反弹轴：'x' 翻转 vx，'y' 翻转 vy */
    axis: 'x' | 'y';
    /** 法线（指向子弹所在的一侧） */
    normalX: number;
    normalY: number;
    /** 穿透深度（越小说明撞得越浅，= 该轴的重叠量） */
    depth: number;
}

/**
 * 圆 vs 矩形的最浅穿透命中检测（§6.2：沿穿透更浅的那条轴弹开，等价于撞在最近的边上）
 * @returns 未命中返回 null
 */
export function circleBoxHit(cx: number, cy: number, radius: number, box: Box): BoxHit | null {
    const dx = cx - box.x;
    const dy = cy - box.y;
    const overlapX = box.halfW + radius - Math.abs(dx);
    const overlapY = box.halfH + radius - Math.abs(dy);

    // 任一轴不重叠 = 没碰到
    if (overlapX <= 0 || overlapY <= 0) return null;

    if (overlapX < overlapY) {
        return { axis: 'x', normalX: dx >= 0 ? 1 : -1, normalY: 0, depth: overlapX };
    }
    return { axis: 'y', normalX: 0, normalY: dy >= 0 ? 1 : -1, depth: overlapY };
}

/** 由中心 + 占格生成矩形（敌人判定框；外扩 padding 可用于放大手感） */
export function boxFromCells(x: number, y: number, cols: number, rows: number, padding: number = 0): Box {
    return {
        x,
        y,
        halfW: (cols * GameTuning.cellSize) * 0.5 + padding,
        halfH: (rows * GameTuning.cellSize) * 0.5 + padding,
    };
}

/** 屏幕内随机 x（用于掉落物散落等） */
export function randomScreenX(rng: { next(): number }, margin: number = 0): number {
    const bounds = screenBounds();
    return bounds.left + margin + rng.next() * (bounds.right - bounds.left - margin * 2);
}