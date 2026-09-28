import { Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { BulletManager } from './BulletManager';
import { WINGMAN_FIRE_INTERVAL, WINGMAN_ORBIT_RADIUS, WINGMAN_ORBIT_SPEED, WINGMAN_SIZE } from './SkillConfig';

const DEG_TO_RAD = Math.PI / 180;

/** 一架僚机 */
interface WingmanData {
    node: Node;
    /** 相对公共环绕角的相位（度），多架之间均分 */
    phase: number;
    /** 自己的开火计时，按相位错峰起步，避免几架同时吐子弹 */
    fireTimer: number;
}

/**
 * 僚机 —— 围着玩家转、每 WINGMAN_FIRE_INTERVAL 秒朝瞄准方向打一发
 *
 * 贴图复用玩家的 game_player（本身就是个紫色圆球），缩到一半，
 * 所以不需要新美术。
 *
 * 僚机弹走 BulletManager 的【免费通道】（fireFree）：不占玩家弹匣，
 * 但一样会撞墙反弹、撞敌人、到底边回身、回到玩家身上被回收。
 *
 * 玩家位置和瞄准方向由宿主每帧传进来，而不是持有 PlayerController ——
 * 这样僚机不依赖玩家控制器，单独就能验证。
 */
export class Wingman {
    private m_Parent: Node = null;
    private m_Frame: SpriteFrame = null;
    private m_Bullets: BulletManager = null;

    private m_Units: WingmanData[] = [];
    /** 公共环绕角（度），每架的实际角度 = 它 + 各自相位 */
    private m_OrbitAngle = 0;

    init(parent: Node, frame: SpriteFrame, bullets: BulletManager): void {
        this.clear();
        this.m_Parent = parent;
        this.m_Frame = frame;
        this.m_Bullets = bullets;
        this.m_OrbitAngle = 0;
    }

    get count(): number {
        return this.m_Units.length;
    }

    /** 在场僚机的位置，给验证用 */
    get positions(): ReadonlyArray<Readonly<{ x: number; y: number }>> {
        return this.m_Units.map(unit => {
            const pos = unit.node.position;
            return { x: pos.x, y: pos.y };
        });
    }

    /**
     * 调到指定架数：多了删、少了补，然后重排相位让它们始终均匀分布。
     *
     * 相位和开火计时整体重排（而不是只给新的补）：
     * 架数变化只在升级那一刻发生，重排一次反而能让错峰重新整齐。
     */
    setCount(count: number): void {
        const target = Math.max(0, Math.floor(count));

        // 贴图没加载出来就不生成：GamePanel 加载单张失败只告警不阻断，
        // 真拿到 null 的话 Sprite 会画不出来，不如干脆没有僚机
        if (!this.m_Parent || !this.m_Parent.isValid || !this.m_Frame) {
            this.clear();
            return;
        }

        while (this.m_Units.length > target) this.removeUnit(this.m_Units.length - 1);
        while (this.m_Units.length < target) this.m_Units.push(this.createUnit());

        this.relayout();
    }

    /**
     * 推进一帧：转角度 -> 摆位置 -> 各自计时开火。
     *
     * playerPos 和瞄准方向都取自本帧的 PlayerController，
     * 所以宿主必须在 m_Player.update 之后调用。
     */
    update(
        dt: number,
        playerPos: Readonly<{ x: number; y: number }>,
        aimX: number,
        aimY: number,
    ): void {
        if (this.m_Units.length === 0 || !this.m_Parent || !this.m_Parent.isValid) return;

        this.m_OrbitAngle = (this.m_OrbitAngle + WINGMAN_ORBIT_SPEED * dt) % 360;

        for (const unit of this.m_Units) {
            const radians = (this.m_OrbitAngle + unit.phase) * DEG_TO_RAD;
            const x = playerPos.x + Math.cos(radians) * WINGMAN_ORBIT_RADIUS;
            const y = playerPos.y + Math.sin(radians) * WINGMAN_ORBIT_RADIUS;
            if (unit.node && unit.node.isValid) unit.node.setPosition(x, y, 0);

            unit.fireTimer -= dt;
            if (unit.fireTimer > 0) continue;

            // 不管这一发打没打出去都重新计时：打不出去说明免费弹上限满了，
            // 下一个周期再试，不会退化成每帧重试
            unit.fireTimer += WINGMAN_FIRE_INTERVAL;
            this.m_Bullets?.fireFree(x, y, aimX, aimY);
        }
    }

    clear(): void {
        for (let i = this.m_Units.length - 1; i >= 0; i--) this.removeUnit(i);
        this.m_Units.length = 0;
    }

    dispose(): void {
        this.clear();
        this.m_Parent = null;
        this.m_Frame = null;
        this.m_Bullets = null;
    }

    /** 均分相位，并让开火计时跟着错峰 */
    private relayout(): void {
        const total = this.m_Units.length;
        if (total <= 0) return;

        this.m_Units.forEach((unit, index) => {
            unit.phase = (360 / total) * index;
            unit.fireTimer = (WINGMAN_FIRE_INTERVAL / total) * index;
        });
    }

    private createUnit(): WingmanData {
        const node = new Node('Wingman');
        node.layer = this.m_Parent.layer;
        this.m_Parent.addChild(node);
        node.setPosition(0, 0, 0);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        sprite.spriteFrame = this.m_Frame;
        // 原图 80x80，僚机缩到一半
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        transform.setContentSize(WINGMAN_SIZE, WINGMAN_SIZE);

        return { node, phase: 0, fireTimer: 0 };
    }

    private removeUnit(index: number): void {
        const unit = this.m_Units[index];
        if (!unit) return;

        this.m_Units.splice(index, 1);
        if (unit.node && unit.node.isValid) {
            unit.node.removeFromParent();
            unit.node.destroy();
        }
    }
}