/**
 * 伤害飘字：按**伤害类型**区分颜色 / 字号 / 位置，暴击再提升一级（更大、更亮、带 "!"）
 *
 * 为什么单独成文件：飘字是唯一会「同时出现很多份、各自有生命周期」的表现层对象，
 * 塞进 BattleView 会让原本只做"读状态 + 摆节点"的编排层再多一份动画状态机。
 *
 * 类型区分（需求：不同伤害类型的伤害数字大小、颜色、位置要有区分）：
 *   · 颜色：子弹=暖黄 / 闪电=青白 / 连锁=浅蓝 / 火球=橙 / 灼烧=暗橙 / 冰冻=冰蓝 / 玩家受击=红；
 *   · 字号：火球最大、子弹居中；灼烧跳伤最小 —— 它是高频 DoT（每 0.5s 一次），
 *     字号大了会糊住敌人，读不出别的伤害；
 *   · 位置：直击系落在目标中心偏上；**灼烧固定偏左下、冰冻偏右下、连锁偏右上、闪电偏上** ——
 *     同一只怪同时吃多种伤害时，几串数字不会挤在同一个点上互相盖住；
 *   · 运动：灼烧上浮距离与存活时间都更短（连续跳伤像"滴血"，不抢主伤害的注意力），
 *     玩家受击飘得更高、活得略久（玩家最需要注意到自己掉血）。
 *
 * 随机散落用注入的 IRandom（与玩法共用同一条随机序列）：同种子录像里飘字位置也可复现。
 */
import { Color, Node } from 'cc';
import { GameTuning } from '../core/GameTuning';
import { IRandom } from '../core/Rng';
import { createLabel, setPos } from './GameArt';

/** 伤害类型：决定飘字的颜色 / 字号 / 位置 / 运动手感，也决定是否参与暴击 */
export enum DamageKind {
    /** 弹匣子弹命中 */
    Bullet = 0,
    /** 闪电子弹本体命中 */
    Lightning = 1,
    /** 闪电链跳伤 */
    Chain = 2,
    /** 火球本体命中 */
    Fire = 3,
    /** 灼烧持续跳伤（不暴击） */
    Burn = 4,
    /** 冰冻弹本体命中 */
    Ice = 5,
    /** 玩家受击 */
    Player = 6,
}

const DMG_BULLET = new Color(255, 232, 120, 255);
const DMG_BULLET_CRIT = new Color(255, 120, 40, 255);
const DMG_LIGHTNING = new Color(170, 245, 255, 255);
const DMG_LIGHTNING_CRIT = new Color(225, 255, 255, 255);
const DMG_CHAIN = new Color(140, 210, 255, 255);
const DMG_CHAIN_CRIT = new Color(190, 240, 255, 255);
const DMG_FIRE = new Color(255, 150, 55, 255);
const DMG_FIRE_CRIT = new Color(255, 95, 20, 255);
const DMG_BURN = new Color(255, 178, 92, 255);
const DMG_ICE = new Color(150, 218, 255, 255);
const DMG_ICE_CRIT = new Color(105, 185, 255, 255);
const DMG_PLAYER = new Color(255, 92, 92, 255);
const DMG_PLAYER_CRIT = new Color(255, 60, 200, 255);
/** 飘字描边色（深色）：所有类型共用，保证在任何底色上都读得清 */
const DMG_OUTLINE = new Color(20, 12, 0, 255);

/** 一种伤害类型的飘字外观 */
interface DamageStyle {
    color: Color;
    critColor: Color;
    /** 字号 = cellSize × sizeMul（暴击再乘 damageTextCritScale） */
    sizeMul: number;
    /** 上浮距离 = damageTextRise × riseMul */
    riseMul: number;
    /** 存活时长 = damageTextLife × lifeMul */
    lifeMul: number;
    /** 随机散落半径 = damageTextScatter × scatterMul */
    scatterMul: number;
    /** 固定偏移 px：同一种伤害类型的数字永远出现在目标的这个方位 */
    offsetX: number;
    offsetY: number;
    /** 弹出峰值缩放 = damageTextPopScale × popMul */
    popMul: number;
}

const DAMAGE_STYLE: Record<DamageKind, DamageStyle> = {
    [DamageKind.Bullet]: {
        color: DMG_BULLET, critColor: DMG_BULLET_CRIT,
        sizeMul: 0.26, riseMul: 1, lifeMul: 1, scatterMul: 1,
        offsetX: 0, offsetY: 0, popMul: 1,
    },
    [DamageKind.Lightning]: {
        color: DMG_LIGHTNING, critColor: DMG_LIGHTNING_CRIT,
        sizeMul: 0.29, riseMul: 1.15, lifeMul: 0.95, scatterMul: 0.85,
        offsetX: 0, offsetY: 30, popMul: 1.1,
    },
    [DamageKind.Chain]: {
        color: DMG_CHAIN, critColor: DMG_CHAIN_CRIT,
        sizeMul: 0.23, riseMul: 0.8, lifeMul: 0.75, scatterMul: 0.5,
        offsetX: 34, offsetY: 14, popMul: 0.9,
    },
    [DamageKind.Fire]: {
        color: DMG_FIRE, critColor: DMG_FIRE_CRIT,
        sizeMul: 0.3, riseMul: 1.1, lifeMul: 1.05, scatterMul: 0.8,
        offsetX: 0, offsetY: 18, popMul: 1.1,
    },
    [DamageKind.Burn]: {
        color: DMG_BURN, critColor: DMG_BURN,
        sizeMul: 0.19, riseMul: 0.5, lifeMul: 0.6, scatterMul: 0.9,
        offsetX: -38, offsetY: -16, popMul: 0.8,
    },
    [DamageKind.Ice]: {
        color: DMG_ICE, critColor: DMG_ICE_CRIT,
        sizeMul: 0.26, riseMul: 0.8, lifeMul: 0.85, scatterMul: 0.7,
        offsetX: 38, offsetY: -16, popMul: 0.95,
    },
    [DamageKind.Player]: {
        color: DMG_PLAYER, critColor: DMG_PLAYER_CRIT,
        sizeMul: 0.32, riseMul: 1.25, lifeMul: 1.1, scatterMul: 0.6,
        offsetX: 0, offsetY: 24, popMul: 1.15,
    },
};

/** 一条飘字的运行状态（生命周期参数在出生时就定好，不同类型各不相同） */
interface DamageTextEntry {
    node: Node;
    /** 出生点（散落之后的位置），上浮以它为基准 */
    x0: number;
    y0: number;
    /** 剩余存活时间 */
    life: number;
    /** 出生时的总存活时间 */
    maxLife: number;
    /** 上浮总距离 px */
    rise: number;
    /** 弹出峰值缩放 */
    peak: number;
    /** 弹出 / 回稳各占的时长（s） */
    pop: number;
}

/** 伤害飘字管理器：一个 BattleView 一份，节点都挂在 Field 下（随镜头震屏一起动） */
export class DamageTextFx {
    private m_Root: Node;
    private m_Rng: IRandom;
    private m_Texts: DamageTextEntry[] = [];

    constructor(root: Node, rng: IRandom) {
        this.m_Root = root;
        this.m_Rng = rng;
    }

    /**
     * 飘一个数字。
     * @param x/y 目标中心（场空间）
     * @param value 最终伤害（已含暴击倍率）
     * @param kind 伤害类型（决定颜色 / 字号 / 位置 / 运动）
     * @param crit 是否暴击（更大、换成暴击色、追加 "!"）
     */
    spawn(x: number, y: number, value: number, kind: DamageKind, crit: boolean): void {
        if (!this.m_Root || !this.m_Root.isValid) return;
        const style = DAMAGE_STYLE[kind] || DAMAGE_STYLE[DamageKind.Bullet];
        const size = Math.round(
            GameTuning.cellSize * style.sizeMul * (crit ? GameTuning.damageTextCritScale : 1)
        );
        const color = crit ? style.critColor : style.color;
        const label = createLabel(this.m_Root, `Dmg_${value}`, crit ? `${value}!` : `${value}`, size, color);
        // 描边 + 加粗：任何底色上都读得清
        label.isBold = true;
        label.enableOutline = true;
        label.outlineColor = DMG_OUTLINE;
        label.outlineWidth = GameTuning.damageTextOutline;

        // 出生点：固定类型偏移 + 圆形内均匀随机（√u × 半径），避免连击时数字叠在同一位置
        const scatter = GameTuning.damageTextScatter * style.scatterMul;
        const angle = this.m_Rng.next() * Math.PI * 2;
        const radius = Math.sqrt(this.m_Rng.next()) * scatter;
        const px = x + style.offsetX + Math.cos(angle) * radius;
        const py = y + style.offsetY + Math.sin(angle) * radius;
        setPos(label.node, px, py);
        // 从 0 放大（弹出动画的第一帧）
        label.node.setScale(0, 0, 1);

        const life = Math.max(0.05, GameTuning.damageTextLife * style.lifeMul);
        this.m_Texts.push({
            node: label.node,
            x0: px,
            y0: py,
            life,
            maxLife: life,
            rise: GameTuning.damageTextRise * style.riseMul,
            peak: GameTuning.damageTextPopScale * style.popMul,
            pop: GameTuning.damageTextPop,
        });
    }

    /** 每帧推进：上浮 + 弹出回稳 + 尾段缩小 + 到期销毁 */
    update(dt: number): void {
        if (this.m_Texts.length === 0) return;
        const d = Math.max(0, dt);
        for (let i = this.m_Texts.length - 1; i >= 0; i--) {
            const t = this.m_Texts[i];
            t.life -= d;
            if (t.life <= 0 || !t.node || !t.node.isValid) {
                if (t.node && t.node.isValid) t.node.destroy();
                this.m_Texts.splice(i, 1);
                continue;
            }
            const life = t.maxLife;
            const passed = life - t.life;
            const pop = Math.max(1e-4, Math.min(t.pop, life * 0.5));
            const peak = t.peak;
            // ① 弹出：0 → peak　② 回稳：peak → 1　③ 尾段缩到 0.85
            let sc: number;
            if (passed < pop) sc = peak * (passed / pop);
            else if (passed < pop * 2) sc = peak - (peak - 1) * ((passed - pop) / pop);
            else sc = 1 - 0.15 * ((passed - pop * 2) / Math.max(1e-4, life - pop * 2));
            t.node.setScale(sc, sc, 1);
            // 向上飘：缓出（先快后慢）
            const rk = 1 - (1 - passed / life) * (1 - passed / life);
            t.node.setPosition(t.x0, t.y0 + t.rise * rk, 0);
        }
    }

    /** 清空（重开 / 销毁时调用）：销毁在飞的飘字并断开引用（与父节点销毁幂等） */
    clear(): void {
        for (const t of this.m_Texts) {
            if (t.node && t.node.isValid) t.node.destroy();
        }
        this.m_Texts.length = 0;
    }
}