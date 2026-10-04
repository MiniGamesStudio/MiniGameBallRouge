# -*- coding: utf-8 -*-
"""① 删掉 MathModels 里那行过时注释；② 把新难度数值同步进策划案（含难度曲线附录 + v1.6 版本行）。
   一次性补丁脚本，改完可删。"""
import io, os, re, sys

ROOT = r'C:\MyFiles\MiniGames\MiniGameBallRouge'
log = []


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


def save(p, s, nl):
    wr(p, s.replace('\n', nl))


# ── ① 删掉 MathModels 的过时注释行 ─────────────────────────────
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\core\MathModels.ts')
s, nl = load(p)
old = '/** 波次成长（§9.2）：速度 +8%/波、血量 +12%/波，各自封顶 2.5 倍；行数逐波 +1，封顶 30 */\n'
hit1 = old in s
if hit1:
    s = s.replace(old, '')
    save(p, s, nl)
after = rd(p)
log.append(('MathModels 注释已删除', hit1, '行数逐波' not in after))
log.append(('MathModels waveScaling 仍在', hit1, 'export function waveScaling' in after))

# ── ② 策划案：数值就地同步 + 难度曲线附录 + v1.6 版本行 ─────────
p = os.path.join(ROOT, r'docs\弹球Roguelike玩法策划案.md')
s, nl = load(p)
before = s

# 数值同步（只动明确指向这几个参数的措辞）
num_pairs = [
    ('40 px/s', '20 px/s'),
    ('基础 40', '基础 20'),
    ('每波 +1 行', '每波 +0.5 行'),
    ('逐波 +1，封顶 30', '逐波 +0.5，封顶 12'),
    ('封顶 30', '封顶 12'),
]
num_hits = []
for a, b in num_pairs:
    if a in s:
        n = s.count(a)
        s = s.replace(a, b)
        num_hits.append('%s->%s x%d' % (a, b, n))

# 逐行同步含 baseFallSpeed / rowsPerWaveGrowth / maxRows 的调参行
tuned_lines = []
for pat, a, b in [('baseFallSpeed', '40', '20'), ('rowsPerWaveGrowth', '1', '0.5'), ('maxRows', '30', '12')]:
    out = []
    for line in s.split('\n'):
        if pat in line and re.search(r'(?<![\d.])%s(?![\d.])' % re.escape(a), line):
            newline = re.sub(r'(?<![\d.])%s(?![\d.])' % re.escape(a), b, line, count=1)
            out.append('      %s -> %s' % (line.strip()[:70], newline.strip()[:70]))
            line = newline
        out.append(line) if False else None
        tuned_lines.append(line) if False else None
    s = '\n'.join([out[i] for i in range(0, len(out))]) if False else s
    # 上面这种写法太绕：改为一次性重建
    lines = []
    for line in s.split('\n'):
        if pat in line and re.search(r'(?<![\d.])%s(?![\d.])' % re.escape(a), line):
            nl2 = re.sub(r'(?<![\d.])%s(?![\d.])' % re.escape(a), b, line, count=1)
            tuned_lines.append('      %s  →  %s' % (line.strip()[:60], nl2.strip()[:60]))
            line = nl2
        lines.append(line)
    s = '\n'.join(lines)

# 难度曲线附录（追加到文末）
curve = '''
## 附录 G　难度曲线（v1.6 定稿）

行数、下落速度、血量三轴联动，公式来自 `MathModels.waveScaling()`：
`行数 = min(3 + 0.5 × (波-1), 12)`；`速度 = 20 × min(1 + 0.08 × (波-1), 2.5)`；`血量 = min(1 + 0.12 × (波-1), 2.5)`。
每带间隔 = `rowGapCells(1.2) × 128 / 下落速度`，一波时长 ≈ `行数 × 每带间隔`。

| 波 | 行数 | 下落速度 px/s | 每带间隔 | 生成时长 | 血量倍率 | 备注 |
|---|---|---|---|---|---|---|
| 1 | 3.0 | 20.0 | 7.68 s | 23 s | 1.00 | 白/绿、单格为主 |
| 2 | 3.5 | 21.6 | 7.11 s | 25 s | 1.12 | 双格登场 |
| 3 | 4.0 | 23.2 | 6.62 s | 26 s | 1.24 | 蓝登场、小BOSS 收尾 |
| 4 | 4.5 | 24.8 | 6.19 s | 28 s | 1.36 | 紫开始出现 |
| 5 | 5.0 | 26.4 | 5.82 s | 29 s | 1.48 | 阶段小高峰 |
| 6 | 5.5 + 小BOSS | 28.0 | 5.49 s | 30 s | 1.60 | `isBossWave` + 3~4 行护卫 |
| 7 | 6.0 | 29.6 | 5.19 s | 31 s | 1.72 | 喘息（BOSS 后） |
| 8 | 6.5 | 31.2 | 4.92 s | 32 s | 1.84 | 六格登场 |
| 9 | 7.0 | 32.8 | 4.68 s | 33 s | 1.96 | 阶段高峰 |
| 10 | 7.5 + 大BOSS | 34.4 | 4.47 s | 34 s | 2.08 | `isBossWave` + 4~6 行护卫 |

**三条取舍**：① 行数**不再**堆到 15~20 —— 速度砍半后每带间隔翻倍，15 行 = 87 s 光生成，一波会拖到一分半；② 难度主要交给**速度 / 血量 / 构成权重**（`qualityWeights`、`typeWeights`、`shapeWeights`），行数只做温和增长；③ BOSS 波必须带护卫行，避免"单只 BOSS 独占一波"又短又空（配合"全场停止"规则尤其明显）。
'''
if '## 附录 G' not in s:
    s = s.rstrip('\n') + '\n' + curve
app_g = '## 附录 G' in s

# v1.6 版本行
ver_anchor = '| **v1.5** | **2026-10-04** |'
v16 = ('| **v1.6** | **2026-10-04** | **难度曲线重排**：下落速度砍半（`baseFallSpeed` 40 → **20**），'
       '行数成长同步减半（`rowsPerWaveGrowth` 1 → **0.5**、`maxRows` 30 → **12**）；'
       '曲线改为"行数 3→7.5 + 速度 20→34 + 血量 1.0→2.08"三轴联动，一波 23~34 s、BOSS 波 45~50 s（见 **附录 G**） |\n')
hit_v = ver_anchor in s
if hit_v:
    s = s.replace(ver_anchor, v16 + ver_anchor, 1)

save(p, s, nl)
after = rd(p)
log.append(('文档 数值同步（措辞）', bool(num_hits), '; '.join(num_hits) or '无匹配'))
log.append(('文档 数值同步（调参行）', bool(tuned_lines), '; '.join(tuned_lines) or '无匹配'))
log.append(('文档 附录 G 难度曲线', app_g, '## 附录 G' in after))
log.append(('文档 v1.6 版本行', hit_v, '| **v1.6** |' in after))
log.append(('文档 仍含 40 px/s', True, ('40 px/s' not in after)))

print('=== 结果 ===')
ok = True
for name, hit, landed in log:
    if not landed:
        ok = False
    print('  %s %-28s 锚点=%-5s %s' % ('OK  ' if landed else '失败', name, hit, landed))
sys.exit(0 if ok else 1)