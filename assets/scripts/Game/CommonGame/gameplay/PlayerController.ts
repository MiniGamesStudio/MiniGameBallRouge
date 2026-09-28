import { EventTouch, Node, Sprite, SpriteFrame, UITransform, Vec3 } from 'cc';
import { HitFlash } from './HitFlash';
import {
    BULLET_ASSET,
    DESIGN_HEIGHT,
    DESIGN_WIDTH,
    DefaultTuning,
    GameTuning,
    PLAYER_ASSET,
    PLAYER_SIZE,
    PLAYER_SPAWN_OFFSET,
} from './GameConfig';

export interface BulletData {
    node: Node;
    speed: number;
    width: number;
    height: number;
}

/** 玩家相关的层级节点，由 BattleWorld 统一按渲染顺序创建 */
export interface PlayerLayers {
    /** 全屏触摸层，必须是最上面一层 */
    input: Node;
    bullet: Node;
    player: Node;
}

/**
 * 玩家控制器 — 拖拽移动、自动开火、血量
 *
 * 拖拽用按下瞬间的手指-玩家偏移量做相对跟随，点屏幕任何位置都不会让玩家瞬移。
 */
export class PlayerController {
    private m_Tuning: GameTuning = DefaultTuning;
    private m_InputTransform: UITransform = null;
    private m_PlayerNode: Node = null;
    private m_BulletParent: Node = null;
    private m_BulletFrame: SpriteFrame = null;
    private m_BulletWidth = 0;
    private m_BulletHeight = 0;

    private m_Bullets: BulletData[] = [];
    private m_Hp = 0;
    private m_FireTimer = 0;
    /** 玩家实际显示边长，和素材原图一致，用来限制移动范围 */
    private m_PlayerSize = PLAYER_SIZE;
    private m_Flash: HitFlash = null;

    private m_Dragging = false;
    /** 按下瞬间手指与玩家的偏移 */
    private mDragOffset = new Vec3();

    init(layers: PlayerLayers, tuning: GameTuning, frames: Map<string, SpriteFrame>): void {
        this.m_Tuning = tuning;
        this.m_BulletParent = layers.bullet;
        this.m_Hp = Math.max(1, tuning.playerMaxHp);

        this.createInputLayer(layers.input);
        this.createPlayer(layers.player, frames.get(PLAYER_ASSET), frames.get(BULLET_ASSET));
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

    get bullets(): BulletData[] {
        return this.m_Bullets;
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

    /** 推进一帧。canFire 为 false 时不发射（开局、场上没敌人、已结束时） */
    update(dt: number, canFire: boolean): void {
        this.m_Flash?.update(dt);
        this.updateBullets(dt);

        if (!canFire || !this.m_PlayerNode) return;

        const interval = Math.max(0.02, this.m_Tuning.fireInterval);
        this.m_FireTimer += dt;
        while (this.m_FireTimer >= interval) {
            this.m_FireTimer -= interval;
            this.fire();
        }
    }

    /** 回收一颗子弹（命中敌人时由 BattleWorld 调用） */
    removeBullet(bullet: BulletData): void {
        const index = this.m_Bullets.indexOf(bullet);
        if (index >= 0) this.m_Bullets.splice(index, 1);

        if (bullet.node && bullet.node.isValid) {
            bullet.node.removeFromParent();
            bullet.node.destroy();
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

        this.m_Bullets.slice().forEach(bullet => this.removeBullet(bullet));
        this.m_Bullets.length = 0;
        this.m_Dragging = false;

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

    private createPlayer(playerLayer: Node, playerFrame: SpriteFrame, bulletFrame: SpriteFrame): void {
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

        // 子弹同样用原图尺寸
        const bulletRect = bulletFrame ? bulletFrame.rect : null;
        this.m_BulletWidth = bulletRect ? bulletRect.width : 20;
        this.m_BulletHeight = bulletRect ? bulletRect.height : 30;
        this.m_BulletFrame = bulletFrame;
    }

    private fire(): void {
        if (!this.m_BulletFrame || !this.m_BulletParent) return;

        const node = new Node('Bullet');
        node.layer = this.m_BulletParent.layer;
        this.m_BulletParent.addChild(node);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        sprite.spriteFrame = this.m_BulletFrame;
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        transform.setContentSize(this.m_BulletWidth, this.m_BulletHeight);

        const origin = this.m_PlayerNode.position;
        node.setPosition(origin.x, origin.y, 0);
        this.m_Bullets.push({
            node,
            speed: this.m_Tuning.bulletSpeed,
            width: this.m_BulletWidth,
            height: this.m_BulletHeight,
        });
    }

    private updateBullets(dt: number): void {
        const topLimit = DESIGN_HEIGHT * 0.5;

        for (let i = this.m_Bullets.length - 1; i >= 0; i--) {
            const bullet = this.m_Bullets[i];
            const pos = bullet.node.position;
            const y = pos.y + bullet.speed * dt;

            if (y - bullet.height * 0.5 > topLimit) {
                this.removeBullet(bullet);
                continue;
            }
            bullet.node.setPosition(pos.x, y, 0);
        }
    }

    private onTouchStart(event: EventTouch): void {
        if (!this.m_PlayerNode) return;

        const point = this.toLocalPoint(event);
        const pos = this.m_PlayerNode.position;
        this.mDragOffset.set(pos.x - point.x, pos.y - point.y, 0);
        this.m_Dragging = true;
    }

    private onTouchMove(event: EventTouch): void {
        if (!this.m_Dragging || !this.m_PlayerNode) return;

        const point = this.toLocalPoint(event);
        this.moveTo(point.x + this.mDragOffset.x, point.y + this.mDragOffset.y);
    }

    private onTouchEnd(): void {
        this.m_Dragging = false;
    }

    /** 触摸点转到输入层局部坐标（输入层和 m_GameRoot 同空间，缩放已包含在矩阵里） */
    private toLocalPoint(event: EventTouch): Vec3 {
        const ui = event.getUILocation();
        return this.m_InputTransform.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
    }

    private moveTo(x: number, y: number): void {
        const halfWidth = (DESIGN_WIDTH - this.m_PlayerSize) * 0.5;
        const halfHeight = (DESIGN_HEIGHT - this.m_PlayerSize) * 0.5;
        const clampedX = Math.min(halfWidth, Math.max(-halfWidth, x));
        const clampedY = Math.min(halfHeight, Math.max(-halfHeight, y));
        this.m_PlayerNode.setPosition(clampedX, clampedY, 0);
    }
}