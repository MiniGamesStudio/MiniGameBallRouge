import { Node, SpriteFrame, UITransform } from 'cc';
import { AimCursor } from './AimCursor';
import { BattleHud } from './BattleHud';
import { BulletManager } from './BulletManager';
import { ChainLightning } from './ChainLightning';
import {
    BULLET_ASSET,
    CURSOR_ASSET,
    DESIGN_HEIGHT,
    DESIGN_WIDTH,
    GameTuning,
    PLAYER_ASSET,
} from './GameConfig';
import { EnemyData, EnemyManager } from './EnemyManager';
import { PlayerController } from './PlayerController';
import { SkillId, WINGMAN_BULLETS_PER_UNIT, WINGMAN_MAX } from './SkillConfig';
import { SkillLevels, SkillSystem } from './SkillSystem';
import { Wingman } from './Wingman';

export interface BattleCallbacks {
    /** 玩家血量归零 */
    onGameOver: () => void;
    /** 结算浮层里点了重新开始 */
    onRestart: () => void;
    /**
     * 升到新的一级，需要玩家选技能。参数是【选择前】的各技能等级，
     * 面板靠它显示"Lv.n -> Lv.n+1"和满级状态。
     *
     * 【可选】：不传就完全没有升级流程（验证脚本就是这么跑的），
     * 那时候连队列都不排，免得堆出一个永远没人消费的待办。
     * 暂停不由这里负责 —— 谁开面板谁负责冻结（见 GamePanel.m_IsPaused）。
     */
    onLevelUp?: (levels: Readonly<SkillLevels>) => void;
}

/**
 * 单帧最大推进时间。掉帧或从后台切回来时 dt 可能是零点几秒，
 * 不夹住的话敌人会瞬移一大段、子弹也会一步跨过敌人。
 */
const MAX_FRAME_DT = 0.1;

/**
 * 玩法主控 — 组装层级、驱动每帧推进、处理子弹命中和结算
 *
 * 对外只有 start / update / dispose 三个口子，GamePanel 负责把资源、数值和回调喂进来。
 */
export class BattleWorld {
    private m_Tuning: GameTuning = null;
    private m_Callbacks: BattleCallbacks = null;

    private m_Enemies: EnemyManager = new EnemyManager();
    private m_Player: PlayerController = new PlayerController();
    private m_Bullets: BulletManager = new BulletManager();
    private m_Cursor: AimCursor = new AimCursor();
    private m_Hud: BattleHud = new BattleHud();
    private m_Skills: SkillSystem = new SkillSystem();
    private m_Wingmen: Wingman = new Wingman();
    private m_Lightning: ChainLightning = new ChainLightning();
    /** 本局创建的层级节点，dispose 时要显式销毁（removeAllChildren 只解挂不销毁） */
    private m_Layers: Node[] = [];

    private m_WaveTimer = 0;
    private m_RowTimer = 0;
    private m_Started = false;
    private m_GameOver = false;
    /**
     * 还没弹给玩家的升级次数。不直接在 generateWave 里弹面板，见 update 里的说明。
     * 只在有人监听 onLevelUp 时才会涨。
     */
    private m_PendingLevelUpCount = 0;

    get isRunning(): boolean {
        return this.m_Started && !this.m_GameOver;
    }

    /** 本局玩家等级，给 HUD / 面板用 */
    get playerLevel(): number {
        return this.m_Skills.playerLevel;
    }

    /** 各技能等级（只读），HUD 技能栏靠它点亮 */
    get skillLevels(): Readonly<SkillLevels> {
        return this.m_Skills.levels;
    }

    start(root: Node, tuning: GameTuning, frames: Map<string, SpriteFrame>, callbacks: BattleCallbacks): void {
        this.dispose();

        this.m_Tuning = tuning;
        this.m_Callbacks = callbacks;

        // 层级顺序即渲染顺序：敌人 -> 子弹 -> 玩家 -> 瞄准游标 -> HUD -> 触摸层
        const enemyLayer = this.createLayer('EnemyLayer', root);
        const bulletLayer = this.createLayer('BulletLayer', root);
        const playerLayer = this.createLayer('PlayerLayer', root);
        const cursorLayer = this.createLayer('CursorLayer', root);
        const hudLayer = this.createLayer('HudLayer', root);
        const inputLayer = this.createLayer('InputLayer', root);

        this.m_Enemies.init(enemyLayer, tuning, frames);
        this.m_Bullets.init(bulletLayer, tuning, frames.get(BULLET_ASSET));
        this.m_Cursor.init(cursorLayer, frames.get(CURSOR_ASSET));
        this.m_Player.init({ input: inputLayer, player: playerLayer }, tuning, frames);
        this.m_Player.setBulletManager(this.m_Bullets);
        this.m_Player.setAimCursor(this.m_Cursor);
        // 僚机弹不占玩家弹匣，但必须有在场上限：近水平的弹永远回不来，
        // 没有上限的话节点会一直堆下去
        this.m_Bullets.setFreeCapacity(WINGMAN_MAX * WINGMAN_BULLETS_PER_UNIT);
        // 僚机和闪电都挂在 PlayerLayer：不用新增层级（层数是有断言的），
        // 渲染上又刚好盖住敌人和子弹
        this.m_Wingmen.init(playerLayer, frames.get(PLAYER_ASSET), this.m_Bullets);
        this.m_Lightning.init(playerLayer);
        this.m_Hud.init(hudLayer, () => this.m_Callbacks?.onRestart());
        this.m_Hud.updateHp(this.m_Player.hp, this.m_Player.maxHp);

        // 开局立刻来一波，不必等第一个 waveInterval。
        // 它同时也会记下第一级 —— 第一波也是"新的一波"
        this.startWave();
        this.m_Started = true;
    }

    /**
     * 开一波，并记下一次升级。
     *
     * generateWave 的唯一调用点，这样"每波升 1 级"不会漏也不会重。
     */
    private startWave(): void {
        this.m_Enemies.generateWave();
        this.m_Skills.gainLevel();
        // 没人监听就不排队：否则计数一直涨着，"有待选技能"会永远为真
        if (!this.m_Callbacks?.onLevelUp) return;
        this.m_PendingLevelUpCount++;
    }

    /**
     * 玩家在升级面板里选了技能。等级是唯一真源，加成全部从等级重算，
     * 所以这里选完统一同步一次派生值。
     */
    applySkillChoice(id: SkillId): void {
        this.m_Skills.choose(id);
        this.syncSkillEffects();
    }

    /** 把技能等级推导出的加成推给各管理器 */
    private syncSkillEffects(): void {
        this.m_Bullets.setDamageScale(this.m_Skills.damageScale);
        this.m_Wingmen.setCount(this.m_Skills.wingmanCount);
    }

    update(dt: number): void {
        if (!this.isRunning) return;

        // 升级面板要等这一帧才弹，不能在第一波那里同步弹：
        // start() 里的第一波是同步发生的，那时 GamePanel 自己还在 WaitOpenReady、
        // 整个面板节点还没激活，同步开面板会叠在一个看不见的画面上。
        // 排到下一帧，画面就已经在了。挂起期间不推进战斗 —— 正在选技能，
        // 底下的敌人不该还在往下压。
        if (this.m_PendingLevelUpCount > 0) {
            this.m_PendingLevelUpCount--;
            this.m_Callbacks?.onLevelUp?.(this.m_Skills.levels);
            return;
        }

        const step = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
        if (step <= 0) return;

        this.updateWave(step);

        const hasEnemy = this.m_Enemies.aliveEnemies.length > 0;
        this.m_Player.update(step, hasEnemy);

        // 僚机必须在 m_Player.update 之后：位置和瞄准方向都是玩家本帧算出来的。
        // 又要赶在子弹推进之前，这样僚机这一帧打出的子弹当帧就开始飞。
        this.m_Wingmen.update(step, this.m_Player.position, this.m_Player.aimX, this.m_Player.aimY);

        // 子弹自己推进并处理撞墙 / 撞敌人反弹 / 回到玩家身上回收，
        // 扣血通过回调交回 EnemyManager，子弹管理器不直接改敌人状态。
        this.m_Bullets.update(step, this.m_Player.position, this.m_Player.radius, this.m_Enemies.aliveEnemies, (enemy, damage) =>
            this.onBulletHitEnemy(enemy, damage),
        );

        // 敌人推进：墙下移、到线俯冲、贴近的持续攻击玩家
        this.m_Enemies.update(step, this.m_Player.position, damage => this.damagePlayer(damage));

        this.m_Lightning.update(step);

        this.m_Hud.updateHp(this.m_Player.hp, this.m_Player.maxHp);
        this.m_Hud.updateStatus(
            this.m_Enemies.waveCount,
            this.m_Enemies.aliveEnemies.length,
            this.m_Enemies.difficulty,
            this.m_Skills.playerLevel,
        );
    }

    /**
     * 子弹打中敌人：先结算这一下，再放连锁闪电。
     *
     * 命中点的坐标必须在结算【之前】读出来 —— damage() 一旦击杀就会
     * removeEnemy（destroy 节点、从各数组里摘掉），之后再问节点要位置就是踩尸体了。
     */
    private onBulletHitEnemy(enemy: EnemyData, damage: number): void {
        const hitX = enemy.node.position.x;
        const hitY = enemy.node.position.y;

        this.m_Enemies.damage(enemy, damage);
        this.strikeChainLightning(enemy, hitX, hitY);
    }

    /**
     * 连锁闪电：劈中命中点最近的若干个敌人。
     *
     * 目标是【纯数据快照】（SkillSystem.pickChainTargets 里连坐标一起固化），
     * 因为下面会连着 damage() 好几个 —— 每一下都可能删掉元素，
     * 拿着活数组边遍历边结算就是在踩自己的脚。
     */
    private strikeChainLightning(hit: EnemyData, hitX: number, hitY: number): void {
        const ratio = this.m_Skills.chainDamageRatio;
        if (ratio <= 0) return;

        const targets = this.m_Skills.pickChainTargets(hit, this.m_Enemies.aliveEnemies);
        if (targets.length === 0) return;

        this.m_Lightning.strike(hitX, hitY, targets);

        const damage = Math.max(1, Math.ceil(this.m_Bullets.bulletDamage * ratio));
        targets.forEach(target => this.m_Enemies.damage(target.enemy, damage));
    }

    dispose(): void {
        this.m_Started = false;
        this.m_GameOver = false;
        this.m_WaveTimer = 0;
        this.m_RowTimer = 0;
        this.m_PendingLevelUpCount = 0;

        this.m_Player.dispose();
        this.m_Enemies.clear();
        this.m_Bullets.clear();
        this.m_Cursor.dispose();
        this.m_Wingmen.dispose();
        this.m_Lightning.dispose();
        this.m_Skills.reset();
        this.m_Hud.dispose();
        this.disposeLayers();
        this.m_Callbacks = null;
    }

    private updateWave(dt: number): void {
        this.m_WaveTimer += dt;
        const interval = Math.max(1, this.m_Tuning.waveInterval);
        if (this.m_WaveTimer >= interval) {
            this.m_WaveTimer -= interval;
            this.startWave();
        }

        if (this.m_Enemies.pendingRowCount <= 0) return;

        const rowInterval = Math.max(0.02, this.m_Tuning.rowSpawnInterval);
        this.m_RowTimer += dt;
        while (this.m_RowTimer >= rowInterval && this.m_Enemies.pendingRowCount > 0) {
            // 墙堆满了就先不入场，并重新计时，否则解堵后会一次性涌入一大批
            if (!this.m_Enemies.spawnPendingRow()) {
                this.m_RowTimer = 0;
                break;
            }
            this.m_RowTimer -= rowInterval;
        }
    }

    private damagePlayer(damage: number): void {
        if (this.m_GameOver) return;
        if (!this.m_Player.takeDamage(damage)) return;
        this.endGame();
    }

    private endGame(): void {
        if (this.m_GameOver) return;

        this.m_GameOver = true;
        // 死了就别再弹升级面板了：面板在 PopUp 层，恒在结算浮层之上，
        // 会把"重新开始"按钮整个盖住 —— 那是软锁
        this.m_PendingLevelUpCount = 0;
        this.m_Hud.showGameOver(this.m_Enemies.waveCount);
        this.m_Callbacks?.onGameOver();
    }

    private disposeLayers(): void {
        this.m_Layers.forEach(layer => {
            if (layer && layer.isValid) {
                layer.removeFromParent();
                layer.destroy();
            }
        });
        this.m_Layers.length = 0;
    }

    private createLayer(name: string, parent: Node): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(0, 0, 0);

        const transform = node.addComponent(UITransform);
        transform.setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);
        this.m_Layers.push(node);
        return node;
    }
}