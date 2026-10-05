/**
 * L1 单测：面板 HUD 数值组装（barRatio / magazineFree / buildHudSnapshot）
 * 纯逻辑，不依赖 cc。对应策划案 HUD 一节。
 */
import { barRatio, buildHudSnapshot, createRunStats, expToNextLevel, magazineFree } from '../../assets/scripts/Game/CommonGame/gameplay/core/PlayerStats';
import { GameTuning } from '../../assets/scripts/Game/CommonGame/gameplay/core/GameTuning';

describe('barRatio', () => {
    it('0 / 满 / 超上限 都钳到 [0,1]', () => {
        expect(barRatio(0, 100)).toBe(0);
        expect(barRatio(50, 100)).toBe(0.5);
        expect(barRatio(100, 100)).toBe(1);
        expect(barRatio(999, 100)).toBe(1);
    });
    it('非法输入一律安全兜底为 0', () => {
        expect(barRatio(10, 0)).toBe(0);
        expect(barRatio(10, -5)).toBe(0);
        expect(barRatio(-3, 100)).toBe(0);
        expect(barRatio(NaN, 100)).toBe(0);
        expect(barRatio(Infinity, 100)).toBe(0);
        expect(barRatio(10, Infinity)).toBe(0);
    });
});
describe('magazineFree', () => {
    it('正常 / 打空 / 换弹异常 都不为负', () => {
        const s = createRunStats();
        expect(magazineFree(s, 0)).toBe(s.bulletCount);
        expect(magazineFree(s, s.bulletCount)).toBe(0);
        expect(magazineFree(s, s.bulletCount + 5)).toBe(0);
        expect(magazineFree(s, NaN)).toBe(s.bulletCount);
    });
});

describe('buildHudSnapshot', () => {
    it('文案与 BattleView.updateHud() 逐字一致（含全角空格）', () => {
        const s = createRunStats();
        const hud = buildHudSnapshot(3, 2, s, 1);
        expect(hud.levelText).toBe('关卡 3　波次 2/' + GameTuning.wavesPerLevel);
        expect(hud.magazineText).toBe('弹匣 ' + (s.bulletCount - 1) + '/' + s.bulletCount);
    });
    it('比例来自 expToNextLevel / maxHp，且都在 [0,1]', () => {
        const s = createRunStats();
        const hud = buildHudSnapshot(1, 1, s, 0);
        expect(hud.expRatio).toBe(barRatio(s.exp, expToNextLevel(s)));
        expect(hud.hpRatio).toBe(barRatio(s.hp, s.maxHp));
        expect(hud.expRatio).toBeGreaterThanOrEqual(0);
        expect(hud.expRatio).toBeLessThanOrEqual(1);
        expect(hud.hpRatio).toBeGreaterThanOrEqual(0);
        expect(hud.hpRatio).toBeLessThanOrEqual(1);
    });
    it('关卡/波次非法输入兜底为 1', () => {
        const s = createRunStats();
        expect(buildHudSnapshot(NaN, 0, s, 0).levelText).toBe('关卡 1　波次 1/' + GameTuning.wavesPerLevel);
    });
});