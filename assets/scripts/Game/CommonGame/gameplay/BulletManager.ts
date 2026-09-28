import { Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { EnemyData } from './EnemyManager';
import { DESIGN_HEIGHT, DESIGN_WIDTH, DefaultTuning, GameTuning } from './GameConfig';

/** 单次推进的最大距离（像素），超了就拆成多步，避免高速时穿过敌人 */
const MAX_SUBSTEP_DISTANCE = 8;
/** 一帧最多拆几步，防止极端 dt（掉帧、切后台回来）下空转 */
const MAX_SUBSTEP_COUNT = 16;
/** 偏转角上限（度）。留足余量，保证偏转后子弹一定还是往离开表面的方向走 */
const MAX_BOUNCE_TILT_DEG = 75;
const DEG_TO_RAD = Math.PI / 180;
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
    /** 已经反弹了几次（撞墙壁 / 撞敌人各算一次），到上限就回收 */
    bounceCount: number;
}

/**
 * 子弹管理器 —— 弹球玩法的核心
 *
 * 子弹是【有限且循环使用】的：一共 bulletCount 发，撞敌人和撞屏幕四周都只反弹、不消失，
 * 飞回玩家身上才回收，所以玩家的开火节奏很大程度上由子弹什么时候飞回来决定，
 * 场上没有剩余子弹时打不出去。
 *
 * 另外还有一道保险：同一发子弹反弹满 bulletMaxBounce 次也会被回收，
 * 免得飞不回玩家身上的子弹永久占着弹匣。
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
            bounceCount: 0,
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

                // 一次小步里最多算一次反弹（角上同时撞两面墙也只算一次）
                let bounced = this.bounceOffWalls(bullet);
                if (this.hitEnemy(bullet, enemies, onEnemyHit)) bounced = true;

                // 弹满次数就收掉，节点已经销毁，后面的回收判断不能再跑
                if (bounced && this.consumeBounce(bullet)) break;
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
     * 撞到屏幕四周就反弹，并把子弹推回边界内。返回 true 表示这一小步里确实弹了。
     *
     * 墙壁保持干净的镜面反射、不倾斜：倾斜会让弹道每穿过一次屏幕就横移
     * DESIGN_HEIGHT * tan(角度) 像素，一旦超过玩家的回收半径（40 + 15 = 55），
     * 子弹就再也回不到玩家身上、弹匣会长期空着（实测 15 度时只有 8% 的时间打得出来）。
     */
    private bounceOffWalls(bullet: BulletData): boolean {
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

        if (x === pos.x && y === pos.y) return false;
        bullet.node.setPosition(x, y, 0);
        return true;
    }

    /**
     * 记一次反弹，返回 true 表示这发子弹已经弹满次数、被回收了（调用方必须立刻停下来）。
     *
     * 撞完才回收：第 N 次的反弹和伤害都照常发生，之后子弹才消失，
     * 所以"最多反弹 5 次"= 第 5 次反弹结束后回收。
     */
    private consumeBounce(bullet: BulletData): boolean {
        bullet.bounceCount++;

        const limit = Math.floor(this.m_Tuning.bulletMaxBounce);
        if (limit <= 0) return false;   // <=0 不限次数，只记数不回收
        if (bullet.bounceCount < limit) return false;

        this.recycle(bullet);
        return true;
    }

    /** 撞到敌人：扣血 + 沿穿透更浅的那条轴弹开，子弹本身不消失；返回 true 表示撞上了 */
    private hitEnemy(
        bullet: BulletData,
        enemies: EnemyData[],
        onEnemyHit: (enemy: EnemyData, damage: number) => void,
    ): boolean {
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
            return true;
        }

        return false;
    }

    private reflectOffEnemy(bullet: BulletData, enemy: EnemyData, overlapX: number, overlapY: number): void {
        const pos = bullet.node.position;
        const center = enemy.node.position;

        // 从穿透更浅的那一轴弹开，等价于撞在最近的那条边上
        if (overlapX < overlapY) {
            const side = pos.x >= center.x ? 1 : -1;
            bullet.node.setPosition(center.x + side * (enemy.width * 0.5 + bullet.radius), pos.y, 0);
            bullet.vx = side * Math.abs(bullet.vx);
            this.tiltAfterBounce(bullet, side, 0);
        } else {
            const side = pos.y >= center.y ? 1 : -1;
            bullet.node.setPosition(pos.x, center.y + side * (enemy.height * 0.5 + bullet.radius), 0);
            bullet.vy = side * Math.abs(bullet.vy);
            this.tiltAfterBounce(bullet, 0, side);
        }
    }

    /**
     * 撞到敌人时，在镜面反射的基础上再偏转一个角度（速度大小不变），只作用于这一种反弹。
     *
     * 不偏的话子弹原路返回、沿着同一条线反复打同一个敌人；偏一点才会在敌阵里散开。
     * 墙壁反弹不偏，理由见 bounceOffWalls。
     *
     * normalX / normalY 是"反弹后这条轴必须朝着的方向"（±1；0 = 这条轴这次没反弹）。
     * 偏转方向随机取正负：固定朝一边偏的话弹道会退化成一个闭合循环，随机方向能打散它。
     * 随机到的那一侧如果偏完不满足朝向（擦着边命中时会这样），就换另一侧；
     * 两侧都不行就保留纯镜面反射，保证子弹一定往离开表面的方向走，
     * 不会卡在同一个敌人身上被反复判定。
     */
    private tiltAfterBounce(bullet: BulletData, normalX: number, normalY: number): void {
        if (normalX === 0 && normalY === 0) return;

        const tilt = Math.min(Math.abs(this.m_Tuning.bulletBounceAngle), MAX_BOUNCE_TILT_DEG) * DEG_TO_RAD;
        if (tilt <= 0) return;

        const vx = bullet.vx;
        const vy = bullet.vy;
        const cos = Math.cos(tilt);
        const sin = Math.sin(tilt);

        // 绕 s 方向旋转 tilt：s = +1 逆时针，-1 顺时针
        const applyTilt = (s: number): boolean => {
            const tx = vx * cos - s * vy * sin;
            const ty = s * vx * sin + vy * cos;
            if (!this.isSeparating(tx, ty, normalX, normalY)) return false;
            bullet.vx = tx;
            bullet.vy = ty;
            return true;
        };

        const first = Math.random() < 0.5 ? 1 : -1;
        if (!applyTilt(first)) applyTilt(-first);
    }

    private isSeparating(vx: number, vy: number, normalX: number, normalY: number): boolean {
        return (normalX === 0 || vx * normalX > 0) && (normalY === 0 || vy * normalY > 0);
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