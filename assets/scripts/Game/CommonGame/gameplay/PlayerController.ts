import { EventTouch, Node, Sprite, SpriteFrame, UITransform, Vec3 } from 'cc';
import { AimCursor } from './AimCursor';
import { BulletManager } from './BulletManager';
import { HitFlash } from './HitFlash';
import {
    DESIGN_HEIGHT,
    DESIGN_WIDTH,
    DefaultTuning,
    GameTuning,
    PLAYER_ASSET,
    PLAYER_SIZE,
    PLAYER_SPAWN_OFFSET,
} from './GameConfig';

/** 把 +Y 方向转到 (x, y) 所需的节点角度（度） */
const RAD_TO_DEG = 180 / Math.PI;
/** 方向长度小于这个值就认为"游标压在玩家身上"，退回向正上方打 */
const MIN_AIM_LENGTH = 1e-3;

/** 玩家相关的层级节点，由 BattleWorld 统一按渲染顺序创建 */
export interface PlayerLayers {
    /** 全屏触摸层，必须是最上面一层 */
    input: Node;
    player: Node;
}

/**
 * 玩家控制器 — 拖拽移动、朝游标瞄准、自动开火、血量
 *
 * 输入层是全屏共用的，一次触摸拖动谁由【按下的位置】决定：落在瞄准游标上就拖游标，
 * 落在别处就拖玩家。两边各记一根手指 ID，所以两根手指可以同时操作
 * （一根挪玩家、一根调方向），互不抢；用一根手指则先按哪里就先拖谁。
 *
 * 拖拽都用按下瞬间的手指-目标偏移量做相对跟随，点哪里都不会让目标瞬移。
 * 子弹本身不归这里管（见 BulletManager），这里只负责"什么时候扣扳机、朝哪个方向扣"。
 */
export class PlayerController {
    private m_Tuning: GameTuning = DefaultTuning;
    private m_InputTransform: UITransform = null;
    private m_PlayerNode: Node = null;
    private m_Bullets: BulletManager = null;
    private m_Cursor: AimCursor = null;

    private m_Hp = 0;
    private m_FireTimer = 0;
    /** 玩家实际显示边长，和素材原图一致，用来限制移动范围和算回收半径 */
    private m_PlayerSize = PLAYER_SIZE;
    private m_Flash: HitFlash = null;

    /** 正在拖玩家的那根手指 ID，null 表示没人在拖玩家 */
    private m_PlayerTouchId: number | null = null;
    /** 按下瞬间手指与玩家的偏移 */
    private m_DragOffset = new Vec3();

    /** 本帧的瞄准方向（单位向量），由 updateAimDirection 每帧刷新 */
    private m_AimX = 0;
    private m_AimY = 1;

    init(layers: PlayerLayers, tuning: GameTuning, frames: Map<string, SpriteFrame>): void {
        this.m_Tuning = tuning;
        this.m_Hp = Math.max(1, tuning.playerMaxHp);

        this.createInputLayer(layers.input);
        this.createPlayer(layers.player, frames.get(PLAYER_ASSET));
    }

    /** 子弹管理器由 BattleWorld 创建并注入，玩家只负责触发发射 */
    setBulletManager(manager: BulletManager): void {
        this.m_Bullets = manager;
    }

    /** 瞄准游标由 BattleWorld 创建并注入，玩家朝它转向、子弹朝它飞 */
    setAimCursor(cursor: AimCursor): void {
        this.m_Cursor = cursor;
    }

    get hp(): number {
        return this.m_Hp;
    }

    get maxHp(): number {
        return this.m_Tuning.playerMaxHp;
    }

    get node(): Node {
        return this.m_PlayerNode;
    }

    /** 玩家碰撞半径，子弹飞回这个范围内就被回收 */
    get radius(): number {
        return this.m_PlayerSize * 0.5;
    }

    get position(): Readonly<Vec3> {
        return this.m_PlayerNode ? this.m_PlayerNode.position : Vec3.ZERO;
    }

    /** 扣血，返回玩家是否已经倒下 */
    takeDamage(damage: number): boolean {
        if (damage <= 0 || this.m_Hp <= 0) return this.m_Hp <= 0;

        this.m_Hp = Math.max(0, this.m_Hp - damage);
        this.m_Flash?.play();
        return this.m_Hp <= 0;
    }

    /**
     * 推进一帧。canFire 为 false 时不发射（开局、场上没敌人、已结束时）。
     *
     * 场上没余弹时计时器最多攒到"一发"，子弹一飞回来就能立刻打出去，
     * 但不会因为憋了几秒就一次性突突一串。
     */
    update(dt: number, canFire: boolean): void {
        this.m_Flash?.update(dt);

        if (!this.m_PlayerNode) return;

        this.updateAimDirection();
        // 玩家图是个正圆，转起来肉眼看不出差别；这里先把朝向摆正，
        // 换成有方向的玩家图之后自动就生效了。
        this.m_PlayerNode.angle = Math.atan2(-this.m_AimX, this.m_AimY) * RAD_TO_DEG;

        if (!canFire || !this.m_Bullets) return;

        const interval = Math.max(0.02, this.m_Tuning.fireInterval);
        this.m_FireTimer = Math.min(this.m_FireTimer + dt, interval);
        if (!this.m_Bullets.canFire) return;

        while (this.m_FireTimer >= interval) {
            this.m_FireTimer -= interval;
            const pos = this.m_PlayerNode.position;
            if (!this.m_Bullets.fire(pos.x, pos.y, this.m_AimX, this.m_AimY)) break;
        }
    }

    dispose(): void {
        if (this.m_InputTransform && this.m_InputTransform.isValid) {
            const inputNode = this.m_InputTransform.node;
            inputNode.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
            inputNode.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
            inputNode.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
            inputNode.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        }

        this.m_PlayerTouchId = null;
        this.m_FireTimer = 0;
        this.m_Bullets = null;
        this.m_Cursor = null;

        this.m_Flash?.dispose();
        this.m_Flash = null;
        this.m_PlayerNode = null;
    }

    private createInputLayer(inputLayer: Node): void {
        if (!inputLayer) return;

        this.m_InputTransform = inputLayer.getComponent(UITransform) || inputLayer.addComponent(UITransform);
        this.m_InputTransform.setContentSize(DESIGN_WIDTH, DESIGN_HEIGHT);
        inputLayer.setPosition(0, 0, 0);

        inputLayer.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        inputLayer.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        inputLayer.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        inputLayer.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    private createPlayer(playerLayer: Node, playerFrame: SpriteFrame): void {
        const node = new Node('Player');
        node.layer = playerLayer.layer;
        playerLayer.addChild(node);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        if (playerFrame) sprite.spriteFrame = playerFrame;

        // 玩家图和敌人图是同一套比例，按原图尺寸显示，不缩放
        const rect = playerFrame ? playerFrame.rect : null;
        const width = rect ? rect.width : PLAYER_SIZE;
        const height = rect ? rect.height : PLAYER_SIZE;
        transform.setContentSize(width, height);
        this.m_PlayerSize = Math.max(width, height);
        // 玩家图是个内切圆，闪白用正圆盖住
        this.m_Flash = HitFlash.circle(node, Math.min(width, height) * 0.5);

        node.setPosition(0, -DESIGN_HEIGHT * 0.5 + PLAYER_SPAWN_OFFSET, 0);
        this.m_PlayerNode = node;
    }

    private onTouchStart(event: EventTouch): void {
        if (!this.m_PlayerNode) return;

        const id = event.getID();
        const point = this.toLocalPoint(event);

        // 按在游标上就拖游标，否则拖玩家
        if (this.m_Cursor && this.m_Cursor.containsPoint(point.x, point.y)) {
            this.m_Cursor.beginDrag(id, point.x, point.y);
            return;
        }

        const pos = this.m_PlayerNode.position;
        this.m_DragOffset.set(pos.x - point.x, pos.y - point.y, 0);
        this.m_PlayerTouchId = id;
    }

    private onTouchMove(event: EventTouch): void {
        const id = event.getID();
        const point = this.toLocalPoint(event);

        if (this.m_Cursor && this.m_Cursor.isDragging(id)) {
            this.m_Cursor.moveDrag(id, point.x, point.y);
            return;
        }

        if (id !== this.m_PlayerTouchId || !this.m_PlayerNode) return;
        this.moveTo(point.x + this.m_DragOffset.x, point.y + this.m_DragOffset.y);
    }

    private onTouchEnd(event: EventTouch): void {
        const id = event.getID();

        this.m_Cursor?.endDrag(id);
        if (id === this.m_PlayerTouchId) this.m_PlayerTouchId = null;
    }

    /** 触摸点转到输入层局部坐标（输入层和 m_GameRoot 同空间，缩放已包含在矩阵里） */
    private toLocalPoint(event: EventTouch): Vec3 {
        const ui = event.getUILocation();
        return this.m_InputTransform.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
    }

    /** 刷新"玩家 -> 游标"的单位方向；游标还没建好或正好压在玩家身上时退回向正上方 */
    private updateAimDirection(): void {
        const cursor = this.m_Cursor;
        if (!cursor || !cursor.node) {
            this.m_AimX = 0;
            this.m_AimY = 1;
            return;
        }

        const pos = this.m_PlayerNode.position;
        const target = cursor.position;
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length <= MIN_AIM_LENGTH) {
            this.m_AimX = 0;
            this.m_AimY = 1;
            return;
        }

        this.m_AimX = dx / length;
        this.m_AimY = dy / length;
    }

    private moveTo(x: number, y: number): void {
        const halfWidth = (DESIGN_WIDTH - this.m_PlayerSize) * 0.5;
        const halfHeight = (DESIGN_HEIGHT - this.m_PlayerSize) * 0.5;
        const clampedX = Math.min(halfWidth, Math.max(-halfWidth, x));
        const clampedY = Math.min(halfHeight, Math.max(-halfHeight, y));
        this.m_PlayerNode.setPosition(clampedX, clampedY, 0);
    }
}