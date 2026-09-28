import { Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { EnemyData } from './EnemyManager';
import { DESIGN_HEIGHT, DESIGN_WIDTH, DefaultTuning, GameTuning } from './GameConfig';

/** 单次推进的最大距离（像素），超了就拆成多步，避免高速时穿过敌人 */
const MAX_SUBSTEP_DISTANCE = 8;
/** 一帧最多拆几步，防止极端 dt（掉帧、切后台回来）下空转 */
const MAX_SUBSTEP_COUNT = 16;
const RAD_TO_DEG = 180 / Math.PI;

export interface BulletData {
    node: Node;
    /** 速度向量，反弹改的就是它 */
    vx: number;
    vy: number;
    /** 碰撞半径：边缘反弹和撞敌人都按圆算，和精灵朝向无关 */
    radius: number;
    /** 离开玩家碰撞范围之后才允许回收，否则刚出膛就被收回去了 */
    armed: boolean;
}

/**
 * 子弹管理器 —— 弹球玩法的核心
 *
 * 子弹是【有限且循环使用】的：一共 bulletCount 发，撞敌人和撞屏幕四周都只反弹、不消失，
 * 只有飞回玩家身上才回收。所以玩家的开火节奏完全由子弹什么时候飞回来决定，
 * 场上没有剩余子弹时打不出去。
 */
export class BulletManager {
    private m_Parent: Node = null;
    private m_Tuning: GameTuning = DefaultTuning;
    private m_Frame: SpriteFrame = null;
    private m_Width = 0;
    private m_Height = 0;
    private m_Radius = 0;

    private m_Bullets: BulletData[] = [];

    init(parent: Node, tuning: GameTuning, frame: SpriteFrame): void {
        this.m_Parent = parent;
        this.m_Tuning = tuning;
        this.m_Frame = frame;

        // 子弹按原图尺寸显示，不缩放
        const rect = frame ? frame.rect : null;
        this.m_Width = rect ? rect.width : 20;
        this.m_Height = rect ? rect.height : 30;
        // 用外接圆半径：子弹会跟着速度转向，取长边一半保证任何朝向下都不会插进墙里
        this.m_Radius = Math.max(this.m_Width, this.m_Height) * 0.5;
    }

    get bullets(): BulletData[] {
        return this.m_Bullets;
    }

    /** 场上还没回收的子弹数 */
    get activeCount(): number {
        return this.m_Bullets.length;
    }

    /** 弹药上限 */
    get capacity(): number {
        return Math.max(1, Math.floor(this.m_Tuning.bulletCount));
    }

    /** 还有剩余子弹才能发射 */
    get canFire(): boolean {
        return this.m_Bullets.length < this.capacity;
    }

    /** 从 (originX, originY) 垂直向上打出一发，没有余弹时返回 false */
    fire(originX: number, originY: number): boolean {
        if (!this.m_Frame || !this.m_Parent || !this.canFire) return false;

        const node = new Node('Bullet');
        node.layer = this.m_Parent.layer;
        this.m_Parent.addChild(node);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        sprite.spriteFrame = this.m_Frame;
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        transform.setContentSize(this.m_Width, this.m_Height);

        node.setPosition(originX, originY, 0);
        this.m_Bullets.push({
            node,
            vx: 0,
            vy: Math.max(1, this.m_Tuning.bulletSpeed),
            radius: this.m_Radius,
            armed: false,
        });
        return true;
    }

    /**
     * 推进一帧：移动 -> 撞墙反弹 -> 撞敌人反弹 -> 回到玩家身上回收。
     *
     * 顺序不能反：先移动再判碰撞，否则子弹会在撞击点前一步就反弹。
     * 每帧拆成若干小步，保证一步不超过 MAX_SUBSTEP_DISTANCE 像素，
     * 这样子弹不会因为一帧走太远而穿过敌人。
     */
    update(
        dt: number,
        playerPos: Readonly<{ x: number; y: number }>,
        playerRadius: number,
        enemies: EnemyData[],
        onEnemyHit: (enemy: EnemyData, damage: number) => void,
    ): void {
        if (this.m_Bullets.length === 0 || dt <= 0) return;

        // 倒序遍历：回收会从数组里摘掉当前项，倒着走不会影响还没处理的元素
        for (let i = this.m_Bullets.length - 1; i >= 0; i--) {
            const bullet = this.m_Bullets[i];
            const speed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
            const stepCount = Math.min(
                MAX_SUBSTEP_COUNT,
                Math.max(1, Math.ceil((speed * dt) / MAX_SUBSTEP_DISTANCE)),
            );
            const step = dt / stepCount;
            const recycleReach = playerRadius + bullet.radius;

            for (let s = 0; s < stepCount; s++) {
                const pos = bullet.node.position;
                bullet.node.setPosition(pos.x + bullet.vx * step, pos.y + bullet.vy * step, 0);

                this.bounceOffWalls(bullet);
                this.hitEnemy(bullet, enemies, onEnemyHit);
                if (this.tryRecycle(bullet, playerPos, recycleReach)) break;
            }

            // 回收掉的话节点已经没了
            if (bullet.node.isValid) {
                bullet.node.angle = Math.atan2(-bullet.vx, bullet.vy) * RAD_TO_DEG;
            }
        }
    }

    clear(): void {
        this.m_Bullets.slice().forEach(bullet => this.recycle(bullet));
        this.m_Bullets.length = 0;
    }

    /** 撞到屏幕四周就反弹，并把子弹推回边界内 */
    private bounceOffWalls(bullet: BulletData): void {
        const pos = bullet.node.position;
        const limitX = DESIGN_WIDTH * 0.5 - bullet.radius;
        const limitY = DESIGN_HEIGHT * 0.5 - bullet.radius;

        let x = pos.x;
        let y = pos.y;
        if (x < -limitX) {
            x = -limitX;
            bullet.vx = Math.abs(bullet.vx);
        } else if (x > limitX) {
            x = limitX;
            bullet.vx = -Math.abs(bullet.vx);
        }
        if (y < -limitY) {
            y = -limitY;
            bullet.vy = Math.abs(bullet.vy);
        } else if (y > limitY) {
            y = limitY;
            bullet.vy = -Math.abs(bullet.vy);
        }

        if (x !== pos.x || y !== pos.y) {
            bullet.node.setPosition(x, y, 0);
        }
    }

    /** 撞到敌人：扣血 + 沿穿透更浅的那条轴弹开，子弹本身不消失 */
    private hitEnemy(
        bullet: BulletData,
        enemies: EnemyData[],
        onEnemyHit: (enemy: EnemyData, damage: number) => void,
    ): void {
        const pos = bullet.node.position;

        for (const enemy of enemies) {
            if (enemy.hp <= 0) continue;

            const overlapX = enemy.width * 0.5 + bullet.radius - Math.abs(pos.x - enemy.node.position.x);
            if (overlapX <= 0) continue;
            const overlapY = enemy.height * 0.5 + bullet.radius - Math.abs(pos.y - enemy.node.position.y);
            if (overlapY <= 0) continue;

            this.reflectOffEnemy(bullet, enemy, overlapX, overlapY);
            onEnemyHit(enemy, this.m_Tuning.bulletDamage);
            // 一步只处理一次碰撞：已经弹出去了，再判下去没有意义。
            // 这里必须立刻 return —— onEnemyHit 可能当场把敌人从 enemies 数组里摘掉，
            // 继续遍历这个数组就是在"边遍历边删"。
            return;
        }
    }

    private reflectOffEnemy(bullet: BulletData, enemy: EnemyData, overlapX: number, overlapY: number): void {
        const pos = bullet.node.position;
        const center = enemy.node.position;

        // 从穿透更浅的那一轴弹开，等价于撞在最近的那条边上
        if (overlapX < overlapY) {
            const side = pos.x >= center.x ? 1 : -1;
            bullet.node.setPosition(center.x + side * (enemy.width * 0.5 + bullet.radius), pos.y, 0);
            bullet.vx = side * Math.abs(bullet.vx);
        } else {
            const side = pos.y >= center.y ? 1 : -1;
            bullet.node.setPosition(pos.x, center.y + side * (enemy.height * 0.5 + bullet.radius), 0);
            bullet.vy = side * Math.abs(bullet.vy);
        }
    }

    /**
     * 飞回玩家身上就回收：返回 true 表示这发子弹已经收掉了。
     *
     * armed 是必须的：子弹是从玩家中心出膛的，不先"离开过"的话第一帧就会被收回。
     */
    private tryRecycle(bullet: BulletData, playerPos: Readonly<{ x: number; y: number }>, reach: number): boolean {
        const pos = bullet.node.position;
        const dx = pos.x - playerPos.x;
        const dy = pos.y - playerPos.y;
        const inside = dx * dx + dy * dy <= reach * reach;

        if (!bullet.armed) {
            if (!inside) bullet.armed = true;
            return false;
        }
        if (!inside) return false;

        this.recycle(bullet);
        return true;
    }

    private recycle(bullet: BulletData): void {
        const index = this.m_Bullets.indexOf(bullet);
        if (index >= 0) this.m_Bullets.splice(index, 1);

        if (bullet.node && bullet.node.isValid) {
            bullet.node.removeFromParent();
            bullet.node.destroy();
        }
    }
}