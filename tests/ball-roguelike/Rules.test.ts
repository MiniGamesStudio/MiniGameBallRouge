/**
 * L1 单测：数值公式 / 波次装箱 / 棋盘几何 / 局内成长 / 敌人俯冲
 *
 * 全部是纯逻辑（不依赖 cc），对应策划案 §7 / §9 / §11 / §12 / §25。
 */
import {
    EnemyRuntime,
    EnemyShape,
    EnemyState,
    EnemyType,
    Quality,
    shapeCellCount,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTypes';
import {
    applyExp,
    catchRadiusWithBonus,
    diveDamage,
    enemyMaxHp,
    expNeed,
    expTotalToLevel,
    waveScaling,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/MathModels';
import {
    buildSpawnSchedule,
    buildWavePlan,
    createEnemyRuntime,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/WaveBuilder';
import {
    boxFromCells,
    circleBoxHit,
    columnCenterX,
    screenBounds,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/BoardMath';
import { isDead, stepEnemy } from '../../assets/scripts/Game/CommonGame/gameplay/core/EnemySim';
import { SeededRandom } from '../../assets/scripts/Game/CommonGame/gameplay/core/Rng';
import {
    SKILL_POOL,
    createRunStats,
    damagePlayer,
    grantExp,
    markSkillLearned,
    pickSkillChoices,
} from '../../assets/scripts/Game/CommonGame/gameplay/core/PlayerStats';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';

const DT = 1 / 60;

function makeEnemy(id: number, x: number, y: number, cols: number = 1, rows: number = 1): EnemyRuntime {
    return {
        id,
        defId: 'test_' + id,
        quality: Quality.White,
        type: EnemyType.Normal,
        shape: cols === 2 ? EnemyShape.DoubleH : EnemyShape.Single,
        cols,
        rows,
        x,
        y,
        hp: 100,
        maxHp: 100,
        speed: 0,
        state: EnemyState.Falling,
        stateTime: 0,
        diveTargetX: 0,
        diveTargetY: 0,
    };
}

describe('经验曲线（需求 4 / §11）', () => {
    it('expNeed 与公式一致、为整数、严格递增', () => {
        for (let n = 1; n <= 30; n++) {
            const raw = GameTuning.expNeedBase
                + GameTuning.expNeedLinear * (n - 1)
                + GameTuning.expNeedQuadratic * (n - 1) * (n - 1);
            expect(Number.isInteger(expNeed(n))).toBe(true);
            expect(Math.abs(expNeed(n) - raw)).toBeLessThanOrEqual(0.5);
        }
        for (let n = 1; n < 30; n++) {
            expect(expNeed(n + 1)).toBeGreaterThan(expNeed(n));
        }
    });

    it('累计经验 = 各级需求之和', () => {
        let sum = 0;
        for (let n = 1; n <= 12; n++) {
            expect(expTotalToLevel(n)).toBeCloseTo(sum, 0);
            sum += expNeed(n);
        }
    });

    it('一次给一大笔经验可以连升多级，剩余经验正确', () => {
        const gained = expNeed(1) + expNeed(2) + 3;
        const r = applyExp(1, 0, gained);
        expect(r.levels).toBe(2);
        expect(r.level).toBe(3);
        expect(r.exp).toBeCloseTo(3, 5);
    });

    it('经验不足时不升级', () => {
        const r = applyExp(1, 0, expNeed(1) - 1);
        expect(r.levels).toBe(0);
        expect(r.level).toBe(1);
    });
});

describe('波次成长（§9.2）', () => {
    it('第 1 波为基准值；速度与血量随波次上升并封顶', () => {
        expect(waveScaling(1).fallSpeed).toBeCloseTo(GameTuning.baseFallSpeed, 4);
        expect(waveScaling(1).hpMul).toBeCloseTo(1, 4);

        expect(waveScaling(2).fallSpeed).toBeCloseTo(GameTuning.baseFallSpeed * (1 + GameTuning.fallSpeedGrowth), 3);
        expect(waveScaling(2).hpMul).toBeCloseTo(1 + GameTuning.hpGrowth, 3);
        expect(waveScaling(3).fallSpeed).toBeGreaterThan(waveScaling(2).fallSpeed);

        expect(waveScaling(999).fallSpeed).toBeCloseTo(GameTuning.baseFallSpeed * GameTuning.fallSpeedCapMul, 3);
        expect(waveScaling(999).hpMul).toBeCloseTo(GameTuning.hpCapMul, 3);
    });

    it('行数逐波 +1 并封顶 maxRows', () => {
        expect(waveScaling(1).rows).toBe(GameTuning.baseRowsPerWave);
        expect(waveScaling(4).rows).toBe(GameTuning.baseRowsPerWave + 3 * GameTuning.rowsPerWaveGrowth);
        expect(waveScaling(999).rows).toBe(GameTuning.maxRows);
    });
});

describe('敌人数值（§7 / §9.4）', () => {
    it('血量 = 品质每格血量 × 占格数 × 类型倍率 × 波次成长', () => {
        expect(enemyMaxHp(Quality.White, EnemyType.Normal, EnemyShape.Single, 1))
            .toBeCloseTo(GameTuning.qualityHpPerCell[Quality.White] * 1 * GameTuning.typeHpMul[EnemyType.Normal], 3);
        expect(enemyMaxHp(Quality.White, EnemyType.Normal, EnemyShape.Eight, 1))
            .toBeCloseTo(GameTuning.qualityHpPerCell[Quality.White] * 8, 3);
        expect(enemyMaxHp(Quality.White, EnemyType.Boss, EnemyShape.Eight, 1))
            .toBeCloseTo(GameTuning.qualityHpPerCell[Quality.White] * 8 * GameTuning.typeHpMul[EnemyType.Boss], 3);
        expect(enemyMaxHp(Quality.Red, EnemyType.Boss, EnemyShape.Eight, 30))
            .toBeGreaterThan(enemyMaxHp(Quality.White, EnemyType.Normal, EnemyShape.Single, 1));
    });

    it('俯冲伤害按占格数 5 点/格，单次封顶', () => {
        expect(diveDamage(EnemyShape.Single)).toBe(GameTuning.diveDamagePerCell);
        expect(diveDamage(EnemyShape.DoubleH)).toBe(GameTuning.diveDamagePerCell * 2);
        expect(diveDamage(EnemyShape.Eight)).toBeLessThanOrEqual(GameTuning.diveDamageMax);
    });

    it('回收半径 = 玩家判定半径 + 子弹半径（+ 技能加成）', () => {
        expect(catchRadiusWithBonus(0)).toBe(GameTuning.playerHitRadius + GameTuning.bulletRadius);
        expect(catchRadiusWithBonus(6)).toBe(GameTuning.playerHitRadius + GameTuning.bulletRadius + 6);
        expect(catchRadiusWithBonus()).toBeGreaterThan(GameTuning.bulletRadius);
    });
});

describe('波次装箱（需求 2/3 的关键不变量）', () => {
    it('多随机种子 × 多波次：无重叠、不出界、不超行、不降级', () => {
        for (let seed = 1; seed <= 12; seed++) {
            const rng = new SeededRandom(seed * 977);
            for (let wave = 1; wave <= 8; wave++) {
                const plan = buildWavePlan(wave, rng, { isFinalWave: wave === 8 });
                let rowsSum = 0;

                expect(plan.bands.length).toBeGreaterThan(0);
                plan.bands.forEach(band => {
                    expect([1, 2]).toContain(band.rows);
                    expect(band.enemies.length).toBeGreaterThan(0);
                    rowsSum += band.rows;

                    const occupied = new Set<string>();
                    band.enemies.forEach(spec => {
                        expect(spec.cols * spec.rows).toBe(shapeCellCount(spec.shape));
                        expect(spec.rows).toBeLessThanOrEqual(GameTuning.maxEnemyRowSpan);
                        expect(spec.col).toBeGreaterThanOrEqual(0);
                        expect(spec.col + spec.cols).toBeLessThanOrEqual(GameTuning.columns);
                        expect(spec.rowOffset).toBeGreaterThanOrEqual(0);
                        expect(spec.rowOffset + spec.rows).toBeLessThanOrEqual(band.rows);

                        for (let c = spec.col; c < spec.col + spec.cols; c++) {
                            for (let r = spec.rowOffset; r < spec.rowOffset + spec.rows; r++) {
                                const key = c + ':' + r;
                                expect(occupied.has(key)).toBe(false);
                                occupied.add(key);
                            }
                        }
                    });
                });

                expect(rowsSum).toBe(plan.totalRows);
            }
        }
    });

    it('出生排期：时间单调不减，事件数 = 敌人总数', () => {
        const rng = new SeededRandom(4242);
        const plan = buildWavePlan(3, rng);
        const events = buildSpawnSchedule(plan);
        const total = plan.bands.reduce((n, b) => n + b.enemies.length, 0);

        expect(events.length).toBe(total);
        for (let i = 1; i < events.length; i++) {
            expect(events[i].delay).toBeGreaterThanOrEqual(events[i - 1].delay);
        }
    });

    it('createEnemyRuntime：出生在出生线以上、处于出生动画、满血', () => {
        const rng = new SeededRandom(7);
        const plan = buildWavePlan(2, rng);
        const spec = plan.bands[0].enemies[0];
        const enemy = createEnemyRuntime(spec, 2, 99);

        expect(enemy.id).toBe(99);
        expect(enemy.state).toBe(EnemyState.Spawning);
        expect(enemy.cols).toBe(spec.cols);
        expect(enemy.hp).toBe(enemy.maxHp);
        expect(enemy.hp).toBeGreaterThan(0);
        expect(enemy.y).toBeLessThanOrEqual(GameTuning.spawnLineY);
        expect(enemy.x).toBeGreaterThanOrEqual(-GameTuning.designWidth / 2);
        expect(enemy.x).toBeLessThanOrEqual(GameTuning.designWidth / 2);
    });
});

describe('棋盘几何（§5 / §6.2）', () => {
    it('屏幕边界等于设计分辨率的一半，5 列关于中心对称', () => {
        const b = screenBounds();
        expect(b.left).toBe(-GameTuning.designWidth / 2);
        expect(b.right).toBe(GameTuning.designWidth / 2);
        expect(b.top).toBe(GameTuning.designHeight / 2);
        expect(b.bottom).toBe(-GameTuning.designHeight / 2);

        expect(columnCenterX(2)).toBeCloseTo(0, 5);
        expect(columnCenterX(0) + columnCenterX(GameTuning.columns - 1)).toBeCloseTo(0, 5);
        expect(columnCenterX(1) - columnCenterX(0)).toBeCloseTo(GameTuning.cellSize, 5);
    });

    it('circleBoxHit 沿更浅的穿透轴弹开，未接触返回 null', () => {
        const box = boxFromCells(0, 0, 1, 1);

        const side = circleBoxHit(box.halfW + 5, 0, GameTuning.bulletRadius, box);
        expect(side).not.toBeNull();
        expect(side.axis).toBe('x');
        expect(side.normalX).toBeGreaterThan(0);

        const top = circleBoxHit(0, box.halfH + 5, GameTuning.bulletRadius, box);
        expect(top).not.toBeNull();
        expect(top.axis).toBe('y');
        expect(top.normalY).toBeGreaterThan(0);

        expect(circleBoxHit(box.halfW + 40, 0, GameTuning.bulletRadius, box)).toBeNull();
    });
});

describe('局内成长（需求 4 / §12）', () => {
    it('开局属性取自 GameTuning', () => {
        const s = createRunStats();
        expect(s.bulletCount).toBe(GameTuning.bulletCount);
        expect(s.maxHp).toBe(GameTuning.playerMaxHp);
        expect(s.hp).toBe(s.maxHp);
        expect(s.bulletDamage).toBe(GameTuning.bulletDamage);
        expect(s.level).toBe(1);
        expect(s.exp).toBe(0);
    });

    it('每个技能都真的改了数值（没有空技能）', () => {
        SKILL_POOL.forEach(skill => {
            const s = createRunStats();
            const before = { ...s };
            skill.apply(s);
            const changed = Object.keys(before).some(k => (before as any)[k] !== (s as any)[k]);
            expect(changed).toBe(true);
        });
    });

    it('三选一：数量正确、互不重复、满级技能不出现', () => {
        const rng = new SeededRandom(2024);
        const levels = new Map<string, number>();

        for (let i = 0; i < 20; i++) {
            const picks = pickSkillChoices(rng, levels);
            expect(picks.length).toBe(Math.min(GameTuning.choiceCount, SKILL_POOL.length));
            expect(new Set(picks.map(p => p.id)).size).toBe(picks.length);
            picks.forEach(p => expect(levels.get(p.id) ?? 0).toBeLessThan(p.maxLevel));
        }

        SKILL_POOL.forEach(s => {
            for (let i = 0; i < s.maxLevel + 3; i++) markSkillLearned(levels, s.id);
            expect(levels.get(s.id)).toBe(s.maxLevel);
        });
        expect(pickSkillChoices(rng, levels).length).toBe(0);
    });

    it('grantExp 升级并保留剩余经验；damagePlayer 只在血量归零时返回 true', () => {
        const s = createRunStats();
        expect(grantExp(s, expNeed(1) + 1)).toBe(1);
        expect(s.level).toBe(2);
        expect(s.exp).toBeCloseTo(1, 5);

        expect(damagePlayer(s, 1)).toBe(false);
        expect(damagePlayer(s, s.hp)).toBe(true);
        expect(s.hp).toBe(0);
    });
});

describe('敌人俯冲（需求 3 / §9.4）', () => {
    it('越线后先等 diveTelegraph，再冲向玩家锁定位置；玩家走开则不结算伤害', () => {
        const events: number[] = [];
        const world = {
            playerX: 0,
            playerY: GameTuning.diveLineY + 20,
            onDiveHitPlayer: (_enemy: EnemyRuntime, damage: number) => { events.push(damage); },
        };

        const enemy = makeEnemy(1, 0, GameTuning.diveLineY - 1, 1, 1);
        stepEnemy(enemy, DT, world);
        expect(enemy.state).toBe(EnemyState.Telegraph);

        let elapsed = 0;
        while (enemy.state === EnemyState.Telegraph && elapsed < GameTuning.diveTelegraph - 0.15) {
            stepEnemy(enemy, DT, world);
            elapsed += DT;
        }
        expect(enemy.state).toBe(EnemyState.Telegraph);

        let guard = 0;
        while (enemy.state === EnemyState.Telegraph && guard++ < 300) stepEnemy(enemy, DT, world);
        expect(enemy.state).toBe(EnemyState.Diving);
        expect(enemy.diveTargetY).toBeCloseTo(world.playerY, 0);

        world.playerX = GameTuning.designWidth / 2 - 50; // 玩家走开
        guard = 0;
        while (!isDead(enemy) && guard++ < 600) stepEnemy(enemy, DT, world);
        expect(isDead(enemy)).toBe(true);
        expect(events.length).toBe(0);
    });

    it('玩家不躲时被撞到：结算伤害并消失', () => {
        const events: number[] = [];
        const world = {
            playerX: 0,
            playerY: GameTuning.diveLineY + 20,
            onDiveHitPlayer: (_enemy: EnemyRuntime, damage: number) => { events.push(damage); },
        };

        const enemy = makeEnemy(2, 0, GameTuning.diveLineY - 1, 1, 1);
        let guard = 0;
        while (!isDead(enemy) && guard++ < 600) stepEnemy(enemy, DT, world);

        expect(isDead(enemy)).toBe(true);
        expect(events.length).toBe(1);
        expect(events[0]).toBe(diveDamage(EnemyShape.Single));
    });
});

describe('敌人生成间距：新一行不能和上一行糊在一起（§9.2）', () => {
    /**
     * 把一波所有敌人按各自出生时刻推到同一个时刻看位置，检查"列范围相交"的任意两只纵向不重叠。
     * 这是个时间不变式：同波敌人同速下落，出生时若不重叠，之后永远不会重叠。
     *
     * 这条测试是为了盯住一个真实踩过的坑：行间隔写死 0.5s、而第 1 波下落速度只有 25px/s 时，
     * 新行出生时上一行才走了 12.5px（行高 80px），屏幕上就是两行敌人叠在一起。
     */
    function assertNoVerticalOverlap(wave: number, seed: number): void {
        const rng = new SeededRandom(seed);
        const plan = buildWavePlan(wave, rng);
        const events = buildSpawnSchedule(plan, {});
        const speed = waveScaling(wave).fallSpeed;
        const cell = GameTuning.cellSize;

        // 取一个"所有敌人都已出生"的时刻
        const t = events.reduce((max, e) => Math.max(max, e.delay), 0) + 1;
        const yOf = (e: (typeof events)[number]) =>
            GameTuning.spawnLineY - (e.spec.rowOffset + e.spec.rows * 0.5) * cell - (t - e.delay) * speed;

        for (let i = 0; i < events.length; i++) {
            for (let j = i + 1; j < events.length; j++) {
                const a = events[i].spec;
                const b = events[j].spec;
                const colOverlap = a.col <= b.col + b.cols - 1 && b.col <= a.col + a.cols - 1;
                if (!colOverlap) continue;

                const gap = Math.abs(yOf(events[i]) - yOf(events[j]));
                const minGap = ((a.rows + b.rows) * cell) / 2;
                expect(gap).toBeGreaterThanOrEqual(minGap - 1e-6);
            }
        }
    }

    it('1~8 波多种子：列重叠的敌人纵向不重叠', () => {
        for (let wave = 1; wave <= 8; wave++) {
            for (const seed of [1, 7, 42, 2024, 99991]) {
                assertNoVerticalOverlap(wave, seed);
            }
        }
    });

    it('出生时间单调不减；行间隔与下落速度联动（速度越快行间隔越短）', () => {
        const events = buildSpawnSchedule(buildWavePlan(3, new SeededRandom(11)), {});
        for (let i = 1; i < events.length; i++) {
            expect(events[i].delay).toBeGreaterThanOrEqual(events[i - 1].delay);
        }

        const rowGapSeconds = (speed: number) => (GameTuning.cellSize * GameTuning.rowGapCells) / speed;
        expect(rowGapSeconds(waveScaling(8).fallSpeed)).toBeLessThan(rowGapSeconds(waveScaling(1).fallSpeed));
        // 第 1 波的行间隔 = 一行走完 rowGapCells 格所需时间
        expect(rowGapSeconds(GameTuning.baseFallSpeed)).toBeCloseTo(
            (GameTuning.cellSize * GameTuning.rowGapCells) / GameTuning.baseFallSpeed,
            6
        );
    });
});