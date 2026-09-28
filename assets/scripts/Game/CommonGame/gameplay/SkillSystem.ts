import { EnemyData } from './EnemyManager';
import {
    CANNON_DAMAGE_PER_LEVEL,
    CHAIN_BASE_TARGETS,
    CHAIN_DAMAGE_RATIO,
    CHAIN_RADIUS,
    CHAIN_TARGETS_PER_LEVEL,
    SkillId,
    SkillDef,
    SKILL_DEFS,
    WINGMAN_MAX,
} from './SkillConfig';

/** 各技能的当前等级，0 = 还没学 */
export type SkillLevels = Record<SkillId, number>;

/** 连锁闪电锁定的一个目标：位置在结算前就固化下来，见 pickChainTargets */
export interface ChainTarget {
    enemy: EnemyData;
    x: number;
    y: number;
}

/**
 * 技能状态 —— 一局之内累积的等级与由此推导出的各种加成
 *
 * 只管【数值】：等级、伤害倍率、连锁目标数、僚机架数。
 * 真正改玩法的地方（子弹伤害、生成僚机、画闪电）由 BattleWorld 拿着这些数去驱动，
 * 这样技能系统本身不依赖 BulletManager / EnemyManager，能被单独验证。
 *
 * 一局的进度存在这里，而 BattleWorld 每次 start 都会 new 一个，
 * 所以"重新开始"天然把技能清零，不会跨局残留。
 */
export class SkillSystem {
    private m_Levels: SkillLevels = SkillSystem.emptyLevels();
    /** 玩家等级，等于本局已经升过几次 */
    private m_PlayerLevel = 0;

    private static emptyLevels(): SkillLevels {
        const levels = {} as SkillLevels;
        SKILL_DEFS.forEach(def => (levels[def.id] = 0));
        return levels;
    }

    /** 玩家等级 */
    get playerLevel(): number {
        return this.m_PlayerLevel;
    }

    /** 各技能等级（只读，给面板显示用） */
    get levels(): Readonly<SkillLevels> {
        return this.m_Levels;
    }

    /** 重炮的伤害倍率：1 + 0.2 × 等级 */
    get damageScale(): number {
        return 1 + CANNON_DAMAGE_PER_LEVEL * this.m_Levels[SkillId.Cannon];
    }

    /**
     * 连锁闪电一次劈几个，0 = 没学。
     * 第 1 级就是 CHAIN_BASE_TARGETS 个，和卡片文案一致。
     */
    get chainTargets(): number {
        const level = this.m_Levels[SkillId.ChainLightning];
        if (level <= 0) return 0;
        return CHAIN_BASE_TARGETS + CHAIN_TARGETS_PER_LEVEL * (level - 1);
    }

    /** 雷击伤害占当前子弹伤害的比例 */
    get chainDamageRatio(): number {
        return this.m_Levels[SkillId.ChainLightning] > 0 ? CHAIN_DAMAGE_RATIO : 0;
    }

    /** 僚机架数 */
    get wingmanCount(): number {
        return this.m_Levels[SkillId.Wingman];
    }

    /** 升一级，返回新的玩家等级 */
    gainLevel(): number {
        this.m_PlayerLevel++;
        return this.m_PlayerLevel;
    }

    /** 某个技能还能不能选（满级的从候选里剔除） */
    canChoose(def: SkillDef): boolean {
        return this.m_Levels[def.id] < def.maxLevel;
    }

    /** 记下一次选择。等级即加成，所以这里只是 +1，倍率都是从等级重算的 */
    choose(id: SkillId): void {
        const def = SKILL_DEFS.find(item => item.id === id);
        if (!def) return;
        if (this.m_Levels[id] >= def.maxLevel) return;
        this.m_Levels[id]++;
    }

    /**
     * 挑出连锁闪电要劈的目标：离命中点最近的若干个，且不含被打中的那个自己。
     *
     * 【位置在返回前就固化】：调用方接下来会对这些敌人逐个 damage()，
     * 而 damage() 一旦击杀就会 removeEnemy —— destroy 节点、splice 掉
     * m_EnemyList / 行数组。所以这里返回的是纯数据快照，
     * 调用方拿着快照去结算，就不会在读位置时踩到已经销毁的节点。
     *
     * 半径外的宁可不劈：不然"连锁"会变成全屏点名。
     */
    pickChainTargets(hit: EnemyData, enemies: EnemyData[]): ChainTarget[] {
        const count = this.chainTargets;
        if (count <= 0 || !hit) return [];

        const originX = hit.node.position.x;
        const originY = hit.node.position.y;
        const radiusSq = CHAIN_RADIUS * CHAIN_RADIUS;

        const candidates: ChainTarget[] = [];
        for (const enemy of enemies) {
            if (enemy === hit || enemy.hp <= 0) continue;

            const x = enemy.node.position.x;
            const y = enemy.node.position.y;
            const dx = x - originX;
            const dy = y - originY;
            if (dx * dx + dy * dy > radiusSq) continue;

            candidates.push({ enemy, x, y });
        }

        if (candidates.length <= count) return candidates;

        // 只按距离取前 count 个，不需要完整排序
        candidates.sort((a, b) => {
            const da = (a.x - originX) * (a.x - originX) + (a.y - originY) * (a.y - originY);
            const db = (b.x - originX) * (b.x - originX) + (b.y - originY) * (b.y - originY);
            return da - db;
        });
        return candidates.slice(0, count);
    }

    /** 新的一局：等级清零 */
    reset(): void {
        this.m_Levels = SkillSystem.emptyLevels();
        this.m_PlayerLevel = 0;
    }

    /** 僚机上限，给 BattleWorld 设子弹上限用 */
    static get wingmanMax(): number {
        return WINGMAN_MAX;
    }
}