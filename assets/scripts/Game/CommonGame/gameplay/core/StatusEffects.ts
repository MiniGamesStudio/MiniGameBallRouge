/**
 * 敌人持续状态：灼烧 / 冰冻（纯逻辑层，不依赖 cc）
 *
 * 两件事都只改 `EnemyRuntime.status` 与 `EnemyRuntime.frozen`，不碰任何引擎对象 ——
 * 伤害数字、掉落、特效由 view 层按返回值驱动（见 BattleView.updateStatuses）。
 *
 * ⚠️⚠️ 本文件最重要的一条不变量：**计时器按真实时间走，绝不随世界暂停而冻结。**
 *
 * 冻结会把整个世界停住（`frozen` → `EnemySim.isEnemyStopped` → `applyStopBlocking`
 * → 滚动 delta = 0），这是本工程既有的「任一敌人停住 ⇒ 全场一起停」口径（用户拍板沿用）。
 * 如果冻结计时也跟着世界一起停，就永远走不到 0、`frozen` 永远为 true、世界**永久卡死**。
 * 所以 `stepStatus` 必须由 `update()` 每帧无条件调用（`update()` 只对**弹窗/外部**暂停早退，
 * 世界暂停时照跑），这一条与掉落物 `life` 的口径**故意不同**（那边 `dropLifePausesWithWorld = true`）。
 *
 * 另一条：**刷新取 max，不做叠加**。同一只怪在灼烧中被第二发火球打中，
 * 是"延长 / 加强到更狠的那一份"，而不是把两份灼烧叠成双倍跳伤 —— 否则火球一多，
 * 伤害会随命中次数指数爆炸，且没有任何数值上限能兜住。
 */

import { EnemyRuntime, EnemyState, EnemyStatus } from './GameTypes';

/** 本帧灼烧跳伤的结果：交给 view 去走唯一的伤害入口 */
export interface StatusStepResult {
    /** 本帧应结算的跳伤次数（0 = 没有跳伤）。伤害 = 次数 × status.burnDamage */
    burnTicks: number;
}

/** 取（必要时创建）状态对象 */
function statusOf(enemy: EnemyRuntime): EnemyStatus {
    if (!enemy.status) {
        enemy.status = { burnTime: 0, burnDamage: 0, burnInterval: 0, burnAccum: 0, freezeTime: 0 };
    }
    return enemy.status;
}

/**
 * 施加 / 刷新灼烧。
 *
 * 时长与跳伤**各自取 max**：只用更强的火球覆盖弱的，弱的火球打上去不会削弱已有的灼烧。
 * `burnAccum` 保留（不清零）—— 连打两发火球不应该把"下一次跳伤"重新推后一个间隔。
 *
 * @param duration 持续（s）
 * @param damagePerTick 每次跳伤的基础伤害
 * @param interval 跳伤间隔（s），<= 0 时按 1 次/帧处理（退化保护）
 */
export function applyBurn(enemy: EnemyRuntime, duration: number, damagePerTick: number, interval: number): void {
    if (!enemy) return;
    const status = statusOf(enemy);
    const d = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const dmg = Number.isFinite(damagePerTick) ? Math.max(0, damagePerTick) : 0;
    const itv = Number.isFinite(interval) ? Math.max(0.01, interval) : 1;

    if (d > 0) status.burnTime = Math.max(status.burnTime, d);
    if (dmg > 0) status.burnDamage = Math.max(status.burnDamage, dmg);
    status.burnInterval = itv;
}

/**
 * 施加 / 刷新冰冻。时长取 max（冻结中再挨一发冰冻只会更长，不会把剩余时间重置成更短的一份）。
 * `frozen` 由 `stepStatus` 统一同步，这里不直接写，避免两处口径。
 */
export function applyFreeze(enemy: EnemyRuntime, duration: number): void {
    if (!enemy) return;
    const d = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    if (d <= 0) return;
    const status = statusOf(enemy);
    status.freezeTime = Math.max(status.freezeTime, d);
}

/**
 * 推进一帧：两个计时器递减、按累计时间吐出跳伤次数、同步 `frozen`。
 *
 * 已死亡的敌人直接跳过（死亡时 `clearStatus` 已清过，这里再兜一层，
 * 防止"死了但状态还在跑"继续扣血 / 继续冻住世界）。
 *
 * @returns 本帧应结算的跳伤次数（由调用方乘 `burnDamage` 后走唯一伤害入口）
 */
export function stepStatus(enemy: EnemyRuntime, dt: number): StatusStepResult {
    const result: StatusStepResult = { burnTicks: 0 };
    if (!enemy) return result;
    const status = enemy.status;
    if (!status) {
        // 没中过状态的敌人（绝大多数）——**什么都不做**。
        // ⚠️ 这里刻意不写 `enemy.frozen = false`：`frozen` 是"被技能定住"的通用标志，
        // 将来说不定有别的定身技能直接置它而没有 status 对象，本函数不该替别人解冻。
        // （本文件的冰冻一律同时写 status.freezeTime，所以同步责任在下面那条路径上。）
        return result;
    }
    if (isDeadEnemy(enemy)) {
        clearStatus(enemy);
        return result;
    }

    const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;

    // ① 冰冻：先减时长再同步 frozen —— 到期的那一帧就能解冻，
    //    于是 updateScroll 本帧就能让世界恢复滚动（不掉帧）
    if (status.freezeTime > 0) status.freezeTime = Math.max(0, status.freezeTime - d);
    enemy.frozen = status.freezeTime > 0;

    // ② 灼烧：按累计时间吐跳数（大 dt 也能一次补多跳，不会漏伤）
    if (status.burnTime > 0) {
        // 只累计**本帧真正在烧的那一段**：到期那一帧的 dt 常常大于剩余灼烧时间，
        // 若整个 dt 都记进去，就会在"只烧了 0.4s"的帧上凭空多跳一次。
        const burning = Math.min(d, status.burnTime);
        status.burnTime = Math.max(0, status.burnTime - d);
        if (status.burnDamage > 0) {
            status.burnAccum += burning;
            const interval = status.burnInterval > 0 ? status.burnInterval : 1;
            const ticks = Math.floor(status.burnAccum / interval);
            if (ticks > 0) {
                status.burnAccum -= ticks * interval;
                result.burnTicks = ticks;
            }
        }
        // 灼烧到期：清掉残余累计，下一次中火球从"立刻跳第一下"开始
        if (status.burnTime <= 0) status.burnAccum = 0;
    }

    return result;
}

/**
 * 清空状态并解除冻结。
 *
 * ⚠️ 由 `EnemySim.killEnemy()` 调用，这是**必须**的：`updateScroll`（全场暂停裁决）
 * 跑在"移除死亡敌人"**之前**，一只"死了但还冻着"的敌人会一直让 `isEnemyStopped` 为真，
 * 世界就永久停住了。
 */
export function clearStatus(enemy: EnemyRuntime): void {
    if (!enemy) return;
    enemy.frozen = false;
    const status = enemy.status;
    if (!status) return;
    status.burnTime = 0;
    status.burnAccum = 0;
    status.burnDamage = 0;
    status.freezeTime = 0;
}

/** 是否正在灼烧 / 正在冻结（view 层驱动表现层显隐用） */
export function isBurning(enemy: EnemyRuntime): boolean {
    return !!enemy.status && enemy.status.burnTime > 0;
}

export function isFrozen(enemy: EnemyRuntime): boolean {
    return !!enemy.status && enemy.status.freezeTime > 0;
}

/**
 * 是否已死（等回收）。
 *
 * 故意在本地写一行而不是 import `EnemySim.isDead`：`EnemySim.killEnemy` 要反向调用本文件的
 * `clearStatus`，两边互相 import 会形成模块环。判断本身就是一行比较，重复它的代价远小于一个环。
 */
function isDeadEnemy(enemy: EnemyRuntime): boolean {
    return enemy.state === EnemyState.Dead;
}