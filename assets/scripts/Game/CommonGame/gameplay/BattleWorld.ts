import { Node, SpriteFrame, UITransform } from 'cc';
import { AimCursor } from './AimCursor';
import { BattleHud } from './BattleHud';
import { BulletManager } from './BulletManager';
import { BULLET_ASSET, CURSOR_ASSET, DESIGN_HEIGHT, DESIGN_WIDTH, GameTuning } from './GameConfig';
import { EnemyManager } from './EnemyManager';
import { PlayerController } from './PlayerController';

export interface BattleCallbacks {
    /** 玩家血量归零 */
    onGameOver: () => void;
    /** 结算浮层里点了重新开始 */
    onRestart: () => void;
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
    /** 本局创建的层级节点，dispose 时要显式销毁（removeAllChildren 只解挂不销毁） */
    private m_Layers: Node[] = [];

    private m_WaveTimer = 0;
    private m_RowTimer = 0;
    private m_Started = false;
    private m_GameOver = false;

    get isRunning(): boolean {
        return this.m_Started && !this.m_GameOver;
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
        this.m_Hud.init(hudLayer, () => this.m_Callbacks?.onRestart());
        this.m_Hud.updateHp(this.m_Player.hp, this.m_Player.maxHp);

        // 开局立刻来一波，不必等第一个 waveInterval
        this.m_Enemies.generateWave();
        this.m_Started = true;
    }

    update(dt: number): void {
        if (!this.isRunning) return;

        const step = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
        if (step <= 0) return;

        this.updateWave(step);

        const hasEnemy = this.m_Enemies.aliveEnemies.length > 0;
        this.m_Player.update(step, hasEnemy);

        // 子弹自己推进并处理撞墙 / 撞敌人反弹 / 回到玩家身上回收，
        // 扣血通过回调交回 EnemyManager，子弹管理器不直接改敌人状态。
        this.m_Bullets.update(step, this.m_Player.position, this.m_Player.radius, this.m_Enemies.aliveEnemies, (enemy, damage) =>
            this.m_Enemies.damage(enemy, damage),
        );

        // 敌人推进：墙下移、到线俯冲、贴近的持续攻击玩家
        this.m_Enemies.update(step, this.m_Player.position, damage => this.damagePlayer(damage));

        this.m_Hud.updateHp(this.m_Player.hp, this.m_Player.maxHp);
        this.m_Hud.updateStatus(this.m_Enemies.waveCount, this.m_Enemies.aliveEnemies.length, this.m_Enemies.difficulty);
    }

    dispose(): void {
        this.m_Started = false;
        this.m_GameOver = false;
        this.m_WaveTimer = 0;
        this.m_RowTimer = 0;

        this.m_Player.dispose();
        this.m_Enemies.clear();
        this.m_Bullets.clear();
        this.m_Cursor.dispose();
        this.m_Hud.dispose();
        this.disposeLayers();
        this.m_Callbacks = null;
    }

    private updateWave(dt: number): void {
        this.m_WaveTimer += dt;
        const interval = Math.max(1, this.m_Tuning.waveInterval);
        if (this.m_WaveTimer >= interval) {
            this.m_WaveTimer -= interval;
            this.m_Enemies.generateWave();
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