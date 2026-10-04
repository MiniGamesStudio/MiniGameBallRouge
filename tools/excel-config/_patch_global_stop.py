# -*- coding: utf-8 -*-
"""把「同列队首阻塞」改成「全场停止」：
   任意一个敌人停住不动（到底 Telegraph / 冰冻眩晕等技能 frozen）→ 所有敌人停止下落；
   该敌人被消灭或恢复 → 全场自动恢复。
   一次性补丁脚本，改完可直接删除。"""
import io, os, sys

ROOT = r'C:\MyFiles\MiniGames\MiniGameBallRouge'


def rd(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def wr(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def load(p):
    raw = rd(p)
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


report = []


def check(name, hit, landed, path):
    report.append((name, hit, landed, os.path.getmtime(path)))


# ── ① EnemySim.ts：核心规则改为全场停止 ──────────────────────────────
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\core\EnemySim.ts')
s, nl = load(p)

i = s.find('/**\n * 同列队首阻塞')
j = s.find('return aL < bR && bL < aR;')
hit1 = (i >= 0 and j > i)
if hit1:
    j = s.find('\n}\n', j) + 3
    new_block = (
        '/**\n'
        ' * 全场停止（需求）：只要**任意一个**敌人停住不动（到底站住 Telegraph、或被冰冻 / 眩晕等技能定住 frozen），\n'
        ' * **所有**敌人一律停止下落；该敌人被消灭或恢复后，全场自动恢复移动。\n'
        ' * 每帧调用一次，纯函数，原地改写 enemy.blocked。\n'
        ' */\n'
        'export function applyStopBlocking(enemies: EnemyRuntime[]): void {\n'
        '    const anyStopped = enemies.some(isEnemyStopped);\n'
        '    for (const e of enemies) e.blocked = anyStopped;\n'
        '}\n'
        '\n'
        '/** 是否"停住不动"：只看结果、不问原因（到底站住 Telegraph，或被技能定住 frozen） */\n'
        'export function isEnemyStopped(enemy: EnemyRuntime): boolean {\n'
        '    return enemy.state === EnemyState.Telegraph || enemy.frozen === true;\n'
        '}\n'
    )
    s = s[:i] + new_block + s[j:]
    wr(p, s.replace('\n', nl))

after = rd(p)
check('EnemySim.applyStopBlocking', hit1, 'export function applyStopBlocking' in after, p)
check('EnemySim 旧函数已移除', hit1, 'applyColumnBlocking' not in after, p)
check('EnemySim columnsOverlap 已移除', hit1, 'columnsOverlap' not in after, p)

# ── ② BattleView.ts：import + 调用点改名 ─────────────────────────────
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\view\BattleView.ts')
s, nl = load(p)
hit_a = 'applyColumnBlocking, enemyVisualScale' in s
hit_b = 'applyColumnBlocking(this.m_Enemies);' in s
if hit_a:
    s = s.replace('applyColumnBlocking, enemyVisualScale', 'applyStopBlocking, enemyVisualScale')
if hit_b:
    s = s.replace(
        '        // 同列队首阻塞：队首（最下面那只）停住时，同列后面的敌人一起停下\n'
        '        applyColumnBlocking(this.m_Enemies);',
        '        // 全场停止：只要有敌人停住不动（到底 / 被技能定住），所有敌人一律停止下落\n'
        '        applyStopBlocking(this.m_Enemies);',
    )
    if 'applyColumnBlocking(this.m_Enemies);' in s:  # 注释文本不一致时的兜底
        s = s.replace('applyColumnBlocking(this.m_Enemies);', 'applyStopBlocking(this.m_Enemies);')
wr(p, s.replace('\n', nl))
after = rd(p)
check('BattleView import', hit_a, 'applyStopBlocking, enemyVisualScale' in after, p)
check('BattleView 调用点', hit_b, 'applyStopBlocking(this.m_Enemies);' in after, p)
check('BattleView 无残留', hit_b, 'applyColumnBlocking' not in after, p)

# ── ③ 文档：规则行 + v1.5 版本行口径 ─────────────────────────────────
p = os.path.join(ROOT, r'docs\弹球Roguelike玩法策划案.md')
s, nl = load(p)
old_row = ('| **同列队首阻塞** | 同列最下面那只停住时（到底站住 Telegraph / 被技能定住 `frozen`），'
           '同列后面的敌人一并停下；它恢复移动或被消灭后自动放行（`applyColumnBlocking`） |')
new_row = ('| **全场停止** | **任意一个**敌人停住不动时（到底站住 Telegraph、或被冰冻 / 眩晕等技能定住 `frozen`），'
           '**全场敌人一律停止下落**；该敌人被消灭或恢复后，全场自动恢复移动（`applyStopBlocking` 每帧算 `enemy.blocked`） |')
hit_c = old_row in s
if hit_c:
    s = s.replace(old_row, new_row)

old_v = '**出生点进第一格 + 开火解锁 + 同列队首阻塞**'
if old_v in s:
    s = s.replace(old_v, '**出生点进第一格 + 开火解锁 + 全场停止**')
old_v2 = '同列最下面那只停住（到底 Telegraph / 技能 `frozen`）时，同列后面的敌人一并停下（`applyColumnBlocking`）'
if old_v2 in s:
    s = s.replace(old_v2, '任意敌人停住（到底 Telegraph / 冰冻眩晕等技能 `frozen`）时**全场敌人一起停止下落**，它被消灭或恢复后全场恢复（`applyStopBlocking`）')
wr(p, s.replace('\n', nl))
after = rd(p)
check('文档 全场停止行', hit_c, '**全场敌人一律停止下落**' in after, p)
check('文档 无旧词', hit_c, ('同列队首阻塞' not in after) and ('applyColumnBlocking' not in after), p)

print('=== 补丁结果 ===')
for name, hit, landed, mt in report:
    print('  %s %-26s 锚点=%s 落盘=%s' % ('OK  ' if landed else '失败', name, hit, landed))
sys.exit(0 if all(r[2] for r in report) else 1)