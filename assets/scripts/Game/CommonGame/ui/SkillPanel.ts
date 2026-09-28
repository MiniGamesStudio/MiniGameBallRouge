import { _decorator, Button, Color, Node, RichText, Sprite } from 'cc';
import { UIBase } from '../../../engine/ui/UIBase';
import { SkillDef, SkillId, SKILL_DEFS } from '../gameplay/SkillConfig';
import { SkillLevels } from '../gameplay/SkillSystem';
const { ccclass } = _decorator;

/** 满级卡片的压暗色。Sprite.color 是【乘算】，所以只能压暗、不能提亮 */
const COLOR_DISABLED = new Color(110, 110, 110, 255);
const COLOR_NORMAL = new Color(255, 255, 255, 255);

export interface SkillPanelOptions {
    /** 选择【之前】的各技能等级，0 = 还没学过。缺省当作全 0 */
    levels?: Readonly<SkillLevels>;
    /** 选中某个技能时回调。面板会先关掉自己再回调 */
    onPick?: (id: SkillId) => void;
}

/**
 * 升级选技能面板
 *
 * 三张卡（Skill_1 / Skill_2 / Skill_3）对应 SKILL_DEFS 里的三个技能，
 * 文案与可用状态在打开时按当前等级刷一遍：满级的压暗并禁止点击。
 *
 * 绑定方式沿用 PausePanel 的【按节点名找】而不是 @property：
 * prefab 里这个脚本组件没有任何序列化属性字段，加了 @property 运行期也只会拿到 null，
 * 而且 SetBtnEvent 对 null 是静默放过的 —— 到时候面板能开、能挡输入、点什么都没反应，
 * 日志一句不报。按名字找就不会有这种"安静的坏掉"。
 */
@ccclass('SkillPanel')
export class SkillPanel extends UIBase {
    private m_Levels: Readonly<SkillLevels> = null;
    private m_OnPick: ((id: SkillId) => void) | null = null;
    /** 首次点击后上锁：连点两下不能让同一个技能白加两级 */
    private m_Chosen = false;

    OnOpen(options: SkillPanelOptions = {}): void {
        // 没有回调就没人能消化这次选择，先把自己藏起来，免得停在一个点不动的面板上。
        //
        // 这里【不能】用 CloseSelf()：UIManager 是在调完 OnOpen 之后才把节点
        // 登记进 m_PanelNodeMap 的，此刻关面板找不到节点，只会清掉记录、不销毁节点，
        // 结果是一块关不掉的空面板留在屏幕上。
        // 直接把节点设成 inactive 反而是对的：记录还在，下次 OpenPanel 走 CheckPanel
        // 的复用分支，重新 active = true 并重跑一遍 OnOpen。
        if (!options.onPick) {
            this.node.active = false;
            return;
        }

        this.m_Levels = options.levels || null;
        this.m_OnPick = options.onPick;
        // 面板是缓存复用的（注册时 cacheCount = 1），每次打开都要把锁复位
        this.m_Chosen = false;

        this.refreshCards();
        this.bindCards();
    }

    OnClose(): void {
        super.OnClose();
        this.m_Levels = null;
        this.m_OnPick = null;
        this.m_Chosen = false;
    }

    /** 按当前等级刷三张卡的文案与可用状态 */
    private refreshCards(): void {
        SKILL_DEFS.forEach((def, index) => {
            const card = this.findCard(index);
            if (!card) return;

            const current = this.levelOf(def.id);
            const maxed = current >= def.maxLevel;

            const text = this.findChildByName(card, 'RichText')?.getComponent(RichText);
            if (text) {
                text.string = maxed
                    ? `${def.name} Lv.${current}（已满级）\n${def.desc}`
                    : `${def.name}  Lv.${current} → Lv.${current + 1}\n${def.desc}`;
            }

            const button = card.getComponent(Button);
            if (button) button.interactable = !maxed;

            const sprite = card.getComponent(Sprite);
            if (sprite) sprite.color = maxed ? COLOR_DISABLED : COLOR_NORMAL;
        });
    }

    private bindCards(): void {
        SKILL_DEFS.forEach((def, index) => {
            const card = this.findCard(index);
            if (!card) return;

            const button = card.getComponent(Button) || card.addComponent(Button);
            if (!button) return;

            this.SetBtnEvent(button, () => this.pick(def));
        });
    }

    private pick(def: SkillDef): void {
        if (this.m_Chosen) return;
        // 满级的卡虽然 interactable = false，但这里再挡一道：
        // 状态和可点性是两回事，锁住的应该是语义而不是手感
        if (this.levelOf(def.id) >= def.maxLevel) return;

        this.m_Chosen = true;
        const onPick = this.m_OnPick;

        // 先关面板再回调：和 PausePanel 同序，回调里会解冻战斗，
        // 那一刻面板必须已经不见了
        this.CloseSelf();
        onPick?.(def.id);
    }

    private levelOf(id: SkillId): number {
        return (this.m_Levels && this.m_Levels[id]) || 0;
    }

    private findCard(index: number): Node | null {
        return this.findChildByName(this.node, `Skill_${index + 1}`);
    }

    private findChildByName(root: Node, name: string): Node | null {
        if (!root) return null;
        if (root.name === name) return root;

        for (const child of root.children) {
            const matched = this.findChildByName(child, name);
            if (matched) return matched;
        }

        return null;
    }
}