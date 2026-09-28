import { Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { EnemyData } from './EnemyManager';
import { DESIGN_HEIGHT, DESIGN_WIDTH, DefaultTuning, GameTuning } from './GameConfig';

/** 单次推进的最大距离（像素），超了就拆成多步，避免高速时穿过敌人 */
const MAX_SUBSTEP_DISTANCE = 8;
/** 一帧最多拆几步，防止极端 dt（掉帧、切后台回来）下空转 */
const MAX_SUBSTEP_COUNT = 16;
const RAD_TO_DEG = 180 / Math.PI;

/** bounceOffWalls 的返回值：这一小步撞到了哪几面墙（角上同时撞两面时两位都置） */
const WALL_NONE = 0;
const WALL_LEFT = 1;
const WALL_RIGHT = 2;
const WALL_TOP = 4;
const WALL_BOTTOM = 8;

export interface BulletData {
    node: Node;
    /** 速度向量，反弹改的就是它 */
    vx: number;
    vy: number;
    /** 碰撞半径：边缘反弹和撞敌人都按圆算，和精灵朝向无关 */
    radius: number;
    /** 离开玩家碰撞范围之后才允许回收，否则刚出膛就被收回去了 */
    armed: boolean;
    /**
     * 是否处于【回身】状态：锁定玩家飞回去，碰到玩家才回收，
     * 触发条件只有一个 —— 撞到屏幕底边（见 turnReturning）。
     * 回身期间穿过敌人、不结算伤害（见 update 里的说明）。
     */
    returning: boolean;
}

/**
 * 子弹管理器 —— 弹球玩法的核心
 *
 * 子弹是【有限且循环使用】的：一共 bulletCount 发，撞敌人和撞屏幕四周都只反弹、不消失，
 * 飞回玩家身上才回收，所以玩家的开火节奏很大程度上由子弹什么时候飞回来决定，
 * 场上没有剩余子弹时打不出去。
 *
 * 镜面反射本身不保证子弹能回得来（斜着打出去会一直在墙角之间折返），
 * 所以有一条回家的规则：子弹撞到屏幕【底边】就转为【回身】状态，
 * 锁定玩家直飞回去，命中玩家才回收 —— 球落到地上，就该滚回玩家手里。
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

    /**
     * 从 (originX, originY) 朝 (dirX, dirY) 打出一发，没有余弹时返回 false。
     *
     * 方向由瞄准游标决定（见 PlayerController）；方向给不出来时退回向正上方，
     * 免得游标正好压在玩家身上导致子弹原地不动。
     */
    fire(originX: number, originY: number, dirX: number, dirY: number): boolean {
        if (!this.m_Frame || !this.m_Parent || !this.canFire) return false;

        const speed = Math.max(1, this.m_Tuning.bulletSpeed);
        const length = Math.sqrt(dirX * dirX + dirY * dirY);
        const unitX = length > 1e-6 ? dirX / length : 0;
        const unitY = length > 1e-6 ? dirY / length : 1;

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
            vx: unitX * speed,
            vy: unitY * speed,
            radius: this.m_Radius,
            armed: false,
            returning: false,
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
                this.stepBullet(bullet, step, playerPos);

                const walls = this.bounceOffWalls(bullet);
                // 回身中的子弹【穿过敌人】：既不结算伤害也不被弹开。
                // 一是"必定回身"——不能被半路挡下来；二是 reflectOffEnemy 的推出
                // 正是防止一次碰撞被重复结算的那道保险，回身时不做推出的话，
                // 子弹会卡在敌人身体里每个小步扣一次血（一帧最多 16 次）。
                if (!bullet.returning) this.hitEnemy(bullet, enemies, onEnemyHit);

                // 撞到屏幕底边就回身：球落到地上，就该滚回玩家手里。
                // 顶墙、左右墙、撞敌人都只反弹不回身。
                if ((walls & WALL_BOTTOM) !== 0) this.turnReturning(bullet);

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

    /**
     * 撞到屏幕四周就反弹，并把子弹推回边界内。返回这一小步撞到了哪几面墙（WALL_* 位标志）。
     *
     * 就是标准的镜面反射：只翻转撞到那条轴的速度分量。
     * 之所以要把"撞的是哪面墙"报出来，是因为【底边】有特殊含义 —— 见 turnReturning。
     */
    private bounceOffWalls(bullet: BulletData): number {
        const pos = bullet.node.position;
        const limitX = DESIGN_WIDTH * 0.5 - bullet.radius;
        const limitY = DESIGN_HEIGHT * 0.5 - bullet.radius;

        let walls = WALL_NONE;
        let x = pos.x;
        let y = pos.y;
        if (x < -limitX) {
            x = -limitX;
            bullet.vx = Math.abs(bullet.vx);
            walls |= WALL_LEFT;
        } else if (x > limitX) {
            x = limitX;
            bullet.vx = -Math.abs(bullet.vx);
            walls |= WALL_RIGHT;
        }
        if (y < -limitY) {
            y = -limitY;
            bullet.vy = Math.abs(bullet.vy);
            walls |= WALL_BOTTOM;
        } else if (y > limitY) {
            y = limitY;
            bullet.vy = -Math.abs(bullet.vy);
            walls |= WALL_TOP;
        }

        if (walls === WALL_NONE) return WALL_NONE;
        bullet.node.setPosition(x, y, 0);
        return walls;
    }

    /**
     * 转入【回身】：从这一刻起锁定玩家直飞回去，碰到玩家才回收。
     * 唯一的触发点是撞到屏幕底边。重复调用是安全的（两个标志位都是幂等的）。
     *
     * armed 必须一起置位。回身 = 正在回家，从这一刻起就该允许回收；
     * 不置这一位的话，万一子弹是在玩家捕捉圈【内】转回身的（撞底边时完全可能，
     * 底边到玩家的距离和捕捉半径是一个量级），它会贴着玩家打转、
     * 永远等不到 armed，也就永远回收不掉。
     */
    private turnReturning(bullet: BulletData): void {
        bullet.returning = true;
        bullet.armed = true;
    }

    /**
     * 推进一步。普通子弹沿当前速度直线走；回身中的子弹每个小步都重新锁定玩家，
     * 所以玩家一边移动也不会 miss —— 这正是"必定回身"的实现。
     *
     * 玩家一定在子弹可达区域内部（玩家的活动范围比子弹的反弹边界更小），
     * 所以两点之间的直线不会碰墙，回身途中不需要额外处理边界。
     */
    private stepBullet(bullet: BulletData, step: number, playerPos: Readonly<{ x: number; y: number }>): void {
        const pos = bullet.node.position;

        if (bullet.returning) {
            const dx = playerPos.x - pos.x;
            const dy = playerPos.y - pos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > 1e-6) {
                const speed = Math.max(1, this.m_Tuning.bulletSpeed);
                bullet.vx = (dx / distance) * speed;
                bullet.vy = (dy / distance) * speed;
            }
        }

        bullet.node.setPosition(pos.x + bullet.vx * step, pos.y + bullet.vy * step, 0);
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