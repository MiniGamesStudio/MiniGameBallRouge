# -*- coding: utf-8 -*-
"""接入 4 张掉落图：exp.png（经验水晶，经验值越大越大）、coin.png（金币，品质 0~8 枚）、
   hun.png（魂晶，BOSS 品质越高越大越多）、super.png（超级水晶）。一次性补丁，改完可删。"""
import io, os, re, sys

ROOT = r'C:\MyFiles\MiniGames\MiniGameBallRouge'
log = []


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        raw = f.read()
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


def save(p, s, nl):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s.replace('\n', nl))


def rd(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


# ── ① GameArt.ts：新增 4 条掉落图路径（GameArtPath 的值会自动预加载）──
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\view\GameArt.ts')
s, nl = load(p)
anchor = "    tileRed: 'texture/red',\n"
add = ("    tileRed: 'texture/red',\n"
       "    // 掉落物（需求 4）\n"
       "    dropExp: 'texture/exp',\n"
       "    dropCoin: 'texture/coin',\n"
       "    dropSoul: 'texture/hun',\n"
       "    dropSuper: 'texture/super',\n")
hit = anchor in s and 'dropExp' not in s
if hit:
    s = s.replace(anchor, add, 1)
    save(p, s, nl)
a = rd(p)
log.append(('GameArt 4 条掉落路径', hit, all(k in a for k in ('dropExp', 'dropCoin', 'dropSoul', 'dropSuper'))))

# ── ② GameTuning.ts：掉落缩放参数 ──
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\core\GameTuning.ts')
s, nl = load(p)
anchor = '    baseSliceInset: 16,\n'
add = ('    baseSliceInset: 16,\n'
       '    /** 掉落物缩放：尺寸 = cellSize × 基准 × (1 + (value-1) × perValue)，封顶 max */\n'
       '    dropExpScalePerValue: 0.06,\n'
       '    dropExpMaxScale: 1.8,\n'
       '    dropSoulScalePerValue: 0.25,\n'
       '    dropSoulMaxScale: 2.0,\n')
hit = anchor in s and 'dropExpScalePerValue' not in s
if hit:
    s = s.replace(anchor, add, 1)
    save(p, s, nl)
a = rd(p)
log.append(('GameTuning 缩放参数', hit, 'dropExpScalePerValue' in a and 'dropSoulMaxScale' in a))

# ── ③ BattleView.ts ──
p = os.path.join(ROOT, r'assets\scripts\Game\CommonGame\gameplay\view\BattleView.ts')
s, nl = load(p)

# ③-1 美术表 + 金币枚数表（插在 DROP_STYLE 之后）
m = re.search(r'const DROP_STYLE: Record<DropKind, \{ radius: number; color: Color \}> = \{.*?\n\};\n', s, re.S)
hit1 = bool(m) and 'DROP_ART' not in s
if hit1:
    extra = (
        '\n'
        '/** 掉落物美术与基准尺寸（cellSize 的倍数）：经验水晶按经验值放大、魂晶按品质放大 */\n'
        'const DROP_ART: Record<DropKind, { path: string; size: number }> = {\n'
        '    [DropKind.Exp]: { path: GameArtPath.dropExp, size: 0.30 },\n'
        '    [DropKind.Coin]: { path: GameArtPath.dropCoin, size: 0.20 },\n'
        '    [DropKind.Soul]: { path: GameArtPath.dropSoul, size: 0.26 },\n'
        '    [DropKind.SuperCrystal]: { path: GameArtPath.dropSuper, size: 0.34 },\n'
        '};\n'
        '\n'
        '/** 金币掉落枚数：按品质 0~8 枚（白怪 0 枚，红怪 8 枚） */\n'
        'const COIN_COUNT_BY_QUALITY: readonly number[] = [0, 1, 3, 5, 6, 8];\n'
    )
    s = s[:m.end()] + extra + s[m.end():]

# ③-2 金币：0~8 枚，总值仍按原表（拆成多枚）
old_coin = ('        // 金币：普通怪 35% 概率，精英及以上必掉\n'
            '        const coinChance = enemy.type === EnemyType.Normal ? 0.35 : 1;\n'
            '        if (RandomUtil.chance(rng, coinChance)) {\n'
            '            this.addDrop(DropKind.Coin, enemyCoinValue(enemy.quality, enemy.type), enemy.x, enemy.y, scatter);\n'
            '        }\n')
new_coin = ('        // 金币：数量按品质 0~8 枚（普通怪 35% 概率，精英及以上必掉）；总值仍按配置表，拆成多枚\n'
            '        const coinChance = enemy.type === EnemyType.Normal ? 0.35 : 1;\n'
            '        if (RandomUtil.chance(rng, coinChance)) {\n'
            '            const coins = COIN_COUNT_BY_QUALITY[enemy.quality] ?? 0;\n'
            '            if (coins > 0) {\n'
            '                const unit = Math.max(1, Math.round(enemyCoinValue(enemy.quality, enemy.type) / coins));\n'
            '                for (let i = 0; i < coins; i++) this.addDrop(DropKind.Coin, unit, enemy.x, enemy.y, scatter);\n'
            '            }\n'
            '        }\n')
hit2 = old_coin in s
if hit2:
    s = s.replace(old_coin, new_coin, 1)

# ③-3 魂晶：BOSS 品质越高越大（value）× 越多（枚数）
old_soul = ('        // 魂晶：精英及以上\n'
            '        const soul = enemySoulValue(enemy.type);\n'
            '        if (soul > 0) this.addDrop(DropKind.Soul, soul, enemy.x, enemy.y, scatter);\n')
new_soul = ('        // 魂晶：击杀 BOSS / 精英掉落，品质越高越大（value）× 越多（枚数）（需求 4）\n'
            '        if (enemySoulValue(enemy.type) > 0) {\n'
            '            const tier = Math.floor(enemy.quality / 2);\n'
            '            const unit = Math.max(1, tier + 1);\n'
            '            const count = Math.max(1, tier);\n'
            '            for (let i = 0; i < count; i++) this.addDrop(DropKind.Soul, unit, enemy.x, enemy.y, scatter);\n'
            '        }\n')
hit3 = old_soul in s
if hit3:
    s = s.replace(old_soul, new_soul, 1)

# ③-4 外观：改用精灵图（缺图时退回原来的洋红圆点兜底）
old_vis = ('        const style = DROP_STYLE[kind];\n'
           '        const node = makeNode(this.m_FieldRoot, `Drop_${drop.id}`);\n'
           '        const transform = node.addComponent(UITransform);\n'
           '        transform.setContentSize(style.radius * 2, style.radius * 2);\n'
           '        const graphics = node.addComponent(Graphics);\n'
           '        graphics.fillColor = style.color;\n'
           '        graphics.circle(0, 0, style.radius);\n'
           '        graphics.fill();\n'
           '        graphics.strokeColor = new Color(255, 255, 255, 220);\n'
           '        graphics.lineWidth = 2;\n'
           '        graphics.circle(0, 0, style.radius);\n'
           '        graphics.stroke();\n')
new_vis = ('        // 外观：经验水晶 / 金币 / 魂晶 / 超级水晶用各自的图；\n'
           '        // 经验水晶按经验值放大、魂晶按品质放大（需求 4）\n'
           '        const art = DROP_ART[kind];\n'
           '        const cell = GameTuning.cellSize;\n'
           '        const valueScale = kind === DropKind.Exp\n'
           '            ? Math.min(GameTuning.dropExpMaxScale, 1 + (value - 1) * GameTuning.dropExpScalePerValue)\n'
           '            : kind === DropKind.Soul\n'
           '                ? Math.min(GameTuning.dropSoulMaxScale, 1 + (value - 1) * GameTuning.dropSoulScalePerValue)\n'
           '                : 1;\n'
           '        const size = cell * art.size * valueScale;\n'
           '        const node = makeNode(this.m_FieldRoot, `Drop_${drop.id}`);\n'
           '        const frame = getArt(this.m_Art, art.path);\n'
           '        if (frame) {\n'
           '            const sprite = createSprite(node, \'Art\', frame, size, size);\n'
           '            setPos(sprite, 0, 0);\n'
           '        } else {\n'
           '            // 素材缺失兜底（正常不会走到）\n'
           '            const style = DROP_STYLE[kind];\n'
           '            const transform = node.addComponent(UITransform);\n'
           '            transform.setContentSize(style.radius * 2, style.radius * 2);\n'
           '            const graphics = node.addComponent(Graphics);\n'
           '            graphics.fillColor = style.color;\n'
           '            graphics.circle(0, 0, style.radius);\n'
           '            graphics.fill();\n'
           '        }\n')
hit4 = old_vis in s
if hit4:
    s = s.replace(old_vis, new_vis, 1)
save(p, s, nl)

a = rd(p)
log.append(('BattleView 美术表 + 金币枚数表', hit1, 'DROP_ART' in a and 'COIN_COUNT_BY_QUALITY' in a))
log.append(('BattleView 金币 0~8 枚', hit2, 'COIN_COUNT_BY_QUALITY[enemy.quality]' in a))
log.append(('BattleView 魂晶 大小×数量', hit3, 'const tier = Math.floor(enemy.quality / 2);' in a))
log.append(('BattleView 掉改用精灵图', hit4, 'DROP_ART[kind]' in a and 'art.size * valueScale' in a))

print('=== 结果 ===')
ok = True
for name, h, landed in log:
    if not landed:
        ok = False
    print('  %s %-30s 锚点=%-5s %s' % ('OK  ' if landed else '失败', name, h, landed))
sys.exit(0 if ok else 1)