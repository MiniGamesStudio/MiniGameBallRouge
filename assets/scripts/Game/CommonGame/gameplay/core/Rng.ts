/**
 * 可注入的确定性随机（纯逻辑层，不依赖 cc）
 *
 * 为什么不用 Math.random：
 * 1. 策划案 §9 要求「同 seed 生成完全相同的关卡」，方便复现 bug 与录屏；
 * 2. L1 单测需要可重复的随机序列；
 * 3. 把随机数来源集中在玩法入口注入，禁止在逻辑里散落 Math.random()。
 */

/** 随机源接口：玩法只依赖这个接口，测试里可以塞固定序列 */
export interface IRandom {
    /** [0, 1) */
    next(): number;
}

/** mulberry32：小、快、质量够用的 32 位种子随机 */
export class SeededRandom implements IRandom {
    private state: number;

    constructor(seed: number = 1) {
        // 保证种子是非零 32 位整数
        this.state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    }

    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/** 固定序列随机：单测里断言"给定随机数一定得到某个结果" */
export class ScriptedRandom implements IRandom {
    private values: number[];
    private index: number = 0;

    constructor(values: number[]) {
        this.values = values && values.length > 0 ? values.slice() : [0];
    }

    next(): number {
        const value = this.values[this.index % this.values.length];
        this.index++;
        return value;
    }
}

/** 随机工具集：把常用取整 / 区间 / 加权抽取集中在一处 */
export class RandomUtil {
    /** [min, max) 浮点 */
    static range(rng: IRandom, min: number, max: number): number {
        return min + (max - min) * rng.next();
    }

    /** [min, max] 整数 */
    static int(rng: IRandom, min: number, max: number): number {
        if (max <= min) return min;
        return min + Math.floor(rng.next() * (max - min + 1));
    }

    /** 数组随机取一个（空数组返回 null） */
    static pick<T>(rng: IRandom, list: readonly T[]): T | null {
        if (!list || list.length === 0) return null;
        const index = Math.floor(rng.next() * list.length);
        return list[Math.min(index, list.length - 1)];
    }

    /**
     * 按权重抽取下标（权重全为 0 或数组为空时返回 0）
     * 用于品质权重、类型权重、体型权重
     */
    static weightedIndex(rng: IRandom, weights: readonly number[]): number {
        if (!weights || weights.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < weights.length; i++) {
            if (weights[i] > 0) total += weights[i];
        }
        if (total <= 0) return 0;

        let roll = rng.next() * total;
        for (let i = 0; i < weights.length; i++) {
            const w = weights[i] > 0 ? weights[i] : 0;
            if (roll < w) return i;
            roll -= w;
        }
        return weights.length - 1;
    }

    /** 概率判定 */
    static chance(rng: IRandom, probability: number): boolean {
        if (probability <= 0) return false;
        if (probability >= 1) return true;
        return rng.next() < probability;
    }

    /** 不重复地抽 count 个元素（不足则返回全部） */
    static sample<T>(rng: IRandom, list: readonly T[], count: number): T[] {
        const pool = (list || []).slice();
        const result: T[] = [];
        const take = Math.max(0, Math.min(count, pool.length));
        for (let i = 0; i < take; i++) {
            const index = Math.floor(rng.next() * pool.length);
            result.push(pool.splice(Math.min(index, pool.length - 1), 1)[0]);
        }
        return result;
    }
}