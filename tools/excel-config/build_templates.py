# -*- coding: utf-8 -*-
"""
生成《弹球 Roguelike》配置表模板（tools/excel-config/*.xlsx）。

表头三行制（与 tools/excel-exporter 的 ExcelReader 约定一致）：
    第 1 行 = 字段名
    第 2 行 = 字段类型（int / float / bool / string / enum:X / array:int / array:string）
    第 3 行 = 注释说明
    第 4 行起 = 数据行

注意：int / float 列必须写真数字（写成文本会导致导出器类型校验失败并中止整表导出）。
字段定义与《弹球Roguelike玩法策划案.md》§15 / 附录 A 保持一致。

用法： python build_templates.py
"""

import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

HEADER_FILL = PatternFill("solid", fgColor="2F5597")   # 字段名
TYPE_FILL = PatternFill("solid", fgColor="D9E2F3")     # 字段类型
COMMENT_FILL = PatternFill("solid", fgColor="F2F2F2")  # 注释
HEADER_FONT = Font(bold=True, color="FFFFFF", size=10)
TYPE_FONT = Font(bold=True, color="1F3864", size=9)
COMMENT_FONT = Font(italic=True, color="595959", size=9)
CELL_FONT = Font(size=10)


def disp_width(text):
    """中文字符按 2 个宽度估算"""
    w = 0
    for ch in str(text):
        w += 2 if ord(ch) > 0x2E80 else 1
    return w


def add_sheet(wb, title, fields, rows, enum_hints=None):
    """
    fields: [(name, type, comment), ...]
    rows:   [[value, ...], ...] 值顺序与 fields 一致
    enum_hints: {col_index: "0,1,2"} 为该列加下拉校验
    """
    ws = wb.create_sheet(title)
    for col, (name, ftype, comment) in enumerate(fields, start=1):
        c1 = ws.cell(row=1, column=col, value=name)
        c1.font = HEADER_FONT
        c1.fill = HEADER_FILL
        c1.alignment = Alignment(horizontal="center", vertical="center")
        c2 = ws.cell(row=2, column=col, value=ftype)
        c2.font = TYPE_FONT
        c2.fill = TYPE_FILL
        c2.alignment = Alignment(horizontal="center", vertical="center")
        c3 = ws.cell(row=3, column=col, value=comment)
        c3.font = COMMENT_FONT
        c3.fill = COMMENT_FILL
        c3.alignment = Alignment(vertical="center", wrap_text=False)

    for r, row in enumerate(rows, start=4):
        assert len(row) == len(fields), \
            f"{title} 第 {r} 行有 {len(row)} 个值，期望 {len(fields)} 个"
        for col, value in enumerate(row, start=1):
            c = ws.cell(row=r, column=col, value=value)
            c.font = CELL_FONT

    # 列宽
    for col in range(1, len(fields) + 1):
        longest = disp_width(fields[col - 1][0])
        for row in rows:
            longest = max(longest, disp_width(row[col - 1]))
        ws.column_dimensions[get_column_letter(col)].width = min(42, max(10, longest + 3))

    ws.freeze_panes = "A4"
    ws.row_dimensions[1].height = 20
    ws.row_dimensions[2].height = 16
    ws.row_dimensions[3].height = 16

    # 枚举 / 布尔列加下拉校验（覆盖到第 300 行，便于后续追加数据）
    last_data_row = 300
    if enum_hints:
        for col, options in enum_hints.items():
            dv = DataValidation(type="list", formula1='"%s"' % options, allow_blank=True)
            dv.error = "取值必须在：%s" % options
            dv.errorTitle = "枚举取值非法"
            ws.add_data_validation(dv)
            dv.add(f"{get_column_letter(col)}4:{get_column_letter(col)}{last_data_row}")
    return ws


def new_wb():
    wb = Workbook()
    wb.remove(wb.active)  # 去掉默认空表，避免生成多余工作表
    return wb


def save(wb, filename):
    path = os.path.join(OUT_DIR, filename)
    wb.save(path)
    print(f"  [ok] {filename:<14} sheets={wb.sheetnames}")
    return path


# ══════════════════════════════════════════════════════════════
# 1. player.xlsx → Player
# ══════════════════════════════════════════════════════════════
def build_player():
    fields = [
        ("id", "string", "主键（固定 p_default）"),
        ("name", "string", "显示名"),
        ("maxHp", "int", "最大血量"),
        ("visualRadius", "int", "视觉半径 px（贴图内切圆）"),
        ("hitRadius", "int", "受击判定半径 px（建议 24~28，越小越耐玩）"),
        ("moveSpeed", "int", "移动速度 px/s"),
        ("bulletCount", "int", "初始弹匣容量（需求：初始 5 发，可配置）"),
        ("fireInterval", "float", "开火间隔 秒"),
        ("bulletSpeed", "int", "子弹速度 px/s"),
        ("bulletDamage", "int", "单发伤害"),
        ("bulletRadius", "int", "子弹半径 px"),
        ("catchRadius", "int", "回收/主动接弹半径 px（建议 = hitRadius + bulletRadius）"),
        ("maxBulletLife", "float", "子弹最长存活 秒（超时强制回身，兜底）"),
        ("magnetRadius", "int", "掉落物磁吸半径 px（可被技能/加点提升）"),
        ("freeBulletMax", "int", "免费弹上限（僚机/分裂弹，不占弹匣）"),
        ("sprite", "string", "贴图名"),
        ("desc", "string", "备注"),
    ]
    rows = [[
        "p_default", "默认球体", 100, 40, 26, 320,
        5, 0.35, 900, 10, 10, 36, 8.0, 120, 8,
        "game_player",
        "判定半径比视觉半径小是刻意设计：擦弹手感 + 弹幕可躲",
    ]]
    wb = new_wb()
    add_sheet(wb, "Player", fields, rows)
    return save(wb, "player.xlsx")


# ══════════════════════════════════════════════════════════════
# 2. enemy.xlsx → Quality / Enemy / BossPhase
# ══════════════════════════════════════════════════════════════
def build_enemy():
    wb = new_wb()

    # ── Quality：6 品质（白绿蓝紫金红）
    q_fields = [
        ("quality", "enum:EnemyQuality", "品质 0白 1绿 2蓝 3紫 4金 5红"),
        ("name", "string", "品质名"),
        ("colorHex", "string", "染色色值（零美术方案：同一贴图按品质染色）"),
        ("hpPerCell", "int", "单格血量（约 ×1.65 几何递增）"),
        ("weight", "int", "生成权重（越大越常见）"),
        ("exp", "int", "单格基础经验"),
        ("coin", "int", "单格基础金币"),
        ("desc", "string", "备注"),
    ]
    q_rows = [
        [0, "白", "#FFFFFF", 12, 30, 1, 1, "最弱的杂兵，教学期主力"],
        [1, "绿", "#4CD964", 20, 25, 2, 2, "基础档"],
        [2, "蓝", "#3B82F6", 35, 20, 4, 3, "需要两三发"],
        [3, "紫", "#A855F7", 55, 13, 8, 6, "明显更硬，见到要优先处理"],
        [4, "金", "#F5C542", 90, 8, 16, 12, "小高潮"],
        [5, "红", "#EF4444", 150, 4, 32, 25, "稀有，见到即高价值目标"],
    ]
    add_sheet(wb, "Quality", q_fields, q_rows, enum_hints={1: "0,1,2,3,4,5"})

    # ── Enemy：三轴（品质 × 类型 × 体型）+ 攻击手段
    e_fields = [
        ("id", "string", "敌人 ID（关卡行模板里引用它）"),
        ("name", "string", "显示名"),
        ("quality", "enum:EnemyQuality", "品质 0白 1绿 2蓝 3紫 4金 5红"),
        ("type", "enum:EnemyType", "类型 0普通 1精英 2小BOSS 3大BOSS"),
        ("shape", "enum:EnemyShape", "体型 0单格 1双格横 2双格竖 3四格 4六格 5八格"),
        ("asset", "string", "贴图名（零美术方案：按品质染色）"),
        ("hpMul", "float", "额外血量倍率（默认 1，血量主要走品质表）"),
        ("attackEnabled", "bool", "是否攻击（普通怪默认 FALSE）"),
        ("attackKind", "enum:EnemyAttackKind", "手段 0无 1射箭 2子弹 3激光 4直线冲击"),
        ("attackRange", "int", "触发距离 px（玩家进入才攻击）"),
        ("attackInterval", "float", "攻击间隔 秒"),
        ("attackDamage", "int", "单次伤害"),
        ("attackWindup", "float", "预警时长 秒（除子弹外必须 > 0）"),
        ("attackSpeed", "int", "弹速/冲刺速度 px/s"),
        ("attackCount", "int", "连发数（扇形子弹用）"),
        ("attackSpreadDeg", "float", "发散角 度（扇形子弹用）"),
        ("stopToCast", "bool", "BOSS：停下移动释放技能"),
        ("castDuration", "float", "停下时长 秒"),
        ("expMul", "float", "经验倍率（普通1 精英3 小BOSS8 大BOSS20）"),
        ("coinMul", "float", "金币倍率"),
        ("weight", "int", "随机生成权重（BOSS 一般由关卡指定，权重给 0）"),
        ("desc", "string", "备注"),
    ]
    e_rows = [
        ["e_slime_white", "白史莱姆", 0, 0, 0, "enemy_white", 1.0,
         False, 0, 0, 0.0, 0, 0.0, 0, 0, 0.0, False, 0.0, 1.0, 1.0, 30,
         "普通怪默认不攻击（Q4 已拍板）"],
        ["e_slime_green", "绿史莱姆", 1, 0, 0, "enemy_green", 1.0,
         False, 0, 0, 0.0, 0, 0.0, 0, 0, 0.0, False, 0.0, 1.0, 1.0, 25,
         "基础杂兵"],
        ["e_archer_green", "绿弓手", 1, 0, 0, "enemy_green", 1.0,
         True, 1, 520, 3.0, 8, 0.4, 520, 1, 0.0, False, 0.0, 1.0, 1.0, 18,
         "普通怪带攻击的示例：射箭，预警 0.4s 可躲"],
        ["e_gunner_blue", "蓝枪手", 2, 1, 1, "enemy_blue", 1.0,
         True, 2, 450, 2.5, 6, 0.1, 420, 3, 15.0, False, 0.0, 3.0, 3.0, 14,
         "精英：双格横，扇形三连发（唯一可以预警很短的攻击）"],
        ["e_laser_purple", "紫光炮", 3, 1, 2, "enemy_purple", 1.0,
         True, 3, 620, 4.0, 15, 0.8, 0, 1, 0.0, False, 0.0, 3.0, 3.0, 10,
         "精英：双格竖，激光蓄力 0.8s（红线预警）"],
        ["e_charger_gold", "金冲角", 4, 1, 0, "enemy_gold", 1.0,
         True, 4, 360, 5.0, 12, 0.6, 620, 1, 0.0, False, 0.0, 3.0, 3.0, 6,
         "精英：直线冲击，后仰 0.6s 后冲刺"],
        ["e_miniboss_blue4", "蓝盾卫（小BOSS）", 2, 2, 3, "enemy_blue", 1.0,
         True, 3, 600, 3.0, 14, 0.8, 0, 1, 0.0, True, 2.0, 8.0, 6.0, 0,
         "四格小BOSS：停下释放激光"],
        ["e_boss_red6", "赤焰巨像（大BOSS）", 5, 3, 4, "enemy_red", 1.0,
         True, 1, 700, 2.2, 18, 0.5, 560, 1, 0.0, True, 2.5, 20.0, 25.0, 0,
         "六格大BOSS：三阶段，见 BossPhase 表"],
        ["e_boss_red8", "终焉之墙（大BOSS）", 5, 3, 5, "enemy_red", 1.0,
         True, 2, 750, 2.0, 12, 0.2, 400, 5, 20.0, True, 2.5, 20.0, 25.0, 0,
         "八格大BOSS：占 4 列，几乎霸屏"],
    ]
    add_sheet(wb, "Enemy", e_fields, e_rows, enum_hints={
        3: "0,1,2,3,4,5", 4: "0,1,2,3", 5: "0,1,2,3,4,5", 9: "0,1,2,3,4",
        8: "TRUE,FALSE", 17: "TRUE,FALSE",
    })

    # ── BossPhase：大BOSS 多阶段
    p_fields = [
        ("enemyId", "string", "关联 Enemy.id"),
        ("phaseIndex", "int", "阶段序号 1/2/3"),
        ("hpThreshold", "float", "该阶段血量上限比例（1.0 / 0.66 / 0.33）"),
        ("speedScale", "float", "下移速度倍率（阶段越后越快）"),
        ("intervalScale", "float", "攻击间隔倍率（越小越狂暴）"),
        ("attackKinds", "array:int", "本阶段可用手段，如 [1,4]"),
        ("summonDefId", "string", "召唤的小怪 ID（可空）"),
        ("summonCount", "int", "召唤数量"),
        ("desc", "string", "备注"),
    ]
    p_rows = [
        ["e_boss_red6", 1, 1.0, 1.0, 1.0, "[1,4]", "", 0, "射箭 + 直线冲击"],
        ["e_boss_red6", 2, 0.66, 1.2, 0.9, "[1,3,4]", "e_slime_green", 2, "加入激光，并召唤 2 个小怪"],
        ["e_boss_red6", 3, 0.33, 1.5, 0.7, "[1,2,3,4]", "", 0, "狂暴：全技能 + 攻击更密"],
        ["e_boss_red8", 1, 1.0, 1.0, 1.0, "[2,3]", "", 0, "扇形弹幕 + 激光"],
        ["e_boss_red8", 2, 0.66, 1.2, 0.9, "[1,2,3]", "e_archer_green", 2, "加入射箭与召唤"],
        ["e_boss_red8", 3, 0.33, 1.5, 0.7, "[1,2,3,4]", "", 0, "终阶段：全技能"],
    ]
    # 工作表名用下划线分隔单词：导出时 toPascalCase 会把每段首字母大写，
    # "Boss_Phase" → 表名 BossPhase；若直接写 camelCase "BossPhase" 会被压平成 Bossphase。
    add_sheet(wb, "Boss_Phase", p_fields, p_rows)
    return save(wb, "enemy.xlsx")


# ══════════════════════════════════════════════════════════════
# 3. level.xlsx → Level / Wave / Row
# ══════════════════════════════════════════════════════════════
def build_level():
    wb = new_wb()

    l_fields = [
        ("id", "string", "关卡 ID"),
        ("name", "string", "关卡名"),
        ("seed", "int", "随机种子（0 = 不使用随机）"),
        ("isEndless", "bool", "是否无尽（波次按难度公式持续生成）"),
        ("hpMul", "float", "关卡级血量倍率"),
        ("speedMul", "float", "关卡级速度倍率"),
        ("desc", "string", "备注"),
    ]
    l_rows = [
        ["L001", "教学关", 0, False, 1.0, 1.0, "手写波次，教弹射与接弹"],
        ["L_ENDLESS", "无尽模式（默认）", 20261003, True, 1.0, 1.0, "随机生成，同 seed 可复现"],
    ]
    add_sheet(wb, "Level", l_fields, l_rows, enum_hints={4: "TRUE,FALSE"})

    w_fields = [
        ("id", "string", "波次 ID"),
        ("levelId", "string", "所属关卡 Level.id"),
        ("waveIndex", "int", "第几波（从 1 开始）"),
        ("mode", "enum:WaveMode", "生成方式 0手写 1随机"),
        ("seed", "int", "随机模式种子（0 = 用关卡种子）"),
        ("bands", "int", "随机模式生成几个带（1 带 = 2 行 = 10 格）"),
        ("qualityWeights", "array:int", "6 项品质权重，如 [60,40,0,0,0,0]"),
        ("typeWeights", "array:int", "4 项类型权重，如 [78,18,3,1]"),
        ("shapeWeights", "array:int", "6 项体型权重 [单格,双横,双竖,四格,六格,八格]"),
        ("spawnStagger", "float", "带内错峰 秒（做出逐个弹出）"),
        ("fallSpeed", "float", "覆盖默认下移速度 px/s（0 = 用难度曲线）"),
        ("isBossWave", "bool", "是否 BOSS 波"),
        ("desc", "string", "备注"),
    ]
    w_rows = [
        ["L001_W1", "L001", 1, 0, 0, 0, "[60,40,0,0,0,0]", "[100,0,0,0]", "[6,3,3,0,0,0]",
         0.08, 0.0, False, "手写：见 Row 表"],
        ["L001_W2", "L001", 2, 0, 0, 0, "[40,40,20,0,0,0]", "[90,10,0,0]", "[6,3,3,1,0,0]",
         0.08, 0.0, False, "手写：引入精英"],
        ["L001_W3", "L001", 3, 1, 0, 2, "[40,40,20,0,0,0]", "[85,15,0,0]", "[6,3,3,1,0,0]",
         0.08, 0.0, False, "随机：2 个带 = 4 行"],
        ["L001_W4", "L001", 4, 0, 0, 0, "[0,60,40,0,0,0]", "[0,0,100,0]", "[0,0,0,1,0,0]",
         0.08, 0.0, True, "手写 BOSS 波：四格小BOSS"],
        ["LE_W1", "L_ENDLESS", 1, 1, 0, 3, "[60,40,0,0,0,0]", "[100,0,0,0]", "[6,3,3,0,0,0]",
         0.08, 0.0, False, "教学期：只有白绿"],
        ["LE_W2", "L_ENDLESS", 2, 1, 0, 3, "[40,35,20,5,0,0]", "[90,10,0,0]", "[6,3,3,1,0,0]",
         0.08, 0.0, False, "引入蓝与少量紫"],
        ["LE_W5", "L_ENDLESS", 5, 1, 0, 4, "[25,30,25,15,5,0]", "[80,18,2,0]", "[6,3,3,1,0.5,0.3]",
         0.08, 0.0, False, "攻击型占比上升（§8.5）"],
        ["LE_W10", "L_ENDLESS", 10, 1, 0, 5, "[10,20,25,20,15,10]", "[62,33,4,1]", "[6,3,3,1,0.5,0.3]",
         0.08, 0.0, False, "全品质开放"],
    ]
    add_sheet(wb, "Wave", w_fields, w_rows, enum_hints={4: "0,1", 12: "TRUE,FALSE"})

    r_fields = [
        ("id", "string", "行 ID"),
        ("levelId", "string", "所属关卡"),
        ("waveIndex", "int", "所属波次"),
        ("rowIndex", "int", "行序号（0 = 最先进场）"),
        ("template", "string", "行模板：5 槽位用 | 分隔；defId=锚点格、-=被相邻锚点占用的格（同行左侧或上一行）、_=空列"),
        ("desc", "string", "备注"),
    ]
    r_rows = [
        ["L001_W1_R0", "L001", 1, 0, "e_slime_white|e_slime_white|e_slime_white|e_slime_white|e_slime_white", "满行 5 单格"],
        ["L001_W1_R1", "L001", 1, 1, "e_slime_green|_|e_archer_green|_|e_slime_green", "空两列做造型"],
        ["L001_W1_R2", "L001", 1, 2, "e_slime_white|e_slime_white|e_slime_white|e_slime_white|e_slime_white", "满行"],
        ["L001_W2_R0", "L001", 2, 0, "e_slime_green|e_archer_green|e_slime_green|e_archer_green|e_slime_green", "弓手成组"],
        ["L001_W2_R1", "L001", 2, 1, "e_gunner_blue|-|_|e_slime_green|e_slime_green", "双格横占 0~1 列"],
        ["L001_W4_R0", "L001", 4, 0, "e_miniboss_blue4|-|e_slime_green|_|e_slime_green", "四格小BOSS 锚点（占 2 列 × 2 行）"],
        ["L001_W4_R1", "L001", 4, 1, "-|-|e_slime_white|_|e_slime_white", "承接上一行的四格占位"],
        ["LE_BOSS_R0", "L_ENDLESS", 10, 0, "e_boss_red6|-|-|e_slime_green|_", "六格大BOSS 锚点（占 3 列 × 2 行）"],
        ["LE_BOSS_R1", "L_ENDLESS", 10, 1, "-|-|-|e_slime_white|_", "承接大BOSS 占位"],
    ]
    add_sheet(wb, "Row", r_fields, r_rows)
    return save(wb, "level.xlsx")


# ══════════════════════════════════════════════════════════════
# 4. skill.xlsx → Skill / SkillEffect
# ══════════════════════════════════════════════════════════════
def build_skill():
    wb = new_wb()

    s_fields = [
        ("id", "string", "技能 ID"),
        ("name", "string", "名称"),
        ("kind", "enum:SkillKind", "类别 0天赋 1主动 2被动（天赋也是技能）"),
        ("rarity", "enum:SkillRarity", "稀有度 0普通 1稀有 2史诗 3传说"),
        ("maxLevel", "int", "等级上限（不允许无上限）"),
        ("weight", "int", "抽取权重（0 = 不参与随机，只能由进化/融合得到）"),
        ("icon", "string", "图标资源名"),
        ("tags", "array:string", "标签，如 [\"chain\",\"electric\"]（融合判定用）"),
        ("evolveInto", "string", "满级后进化成的技能 ID（可空）"),
        ("evolveCost", "int", "进化消耗超级水晶数"),
        ("fusePartners", "array:string", "融合组合：[\"对方技能ID:产物技能ID:消耗水晶数\"]"),
        ("desc", "string", "描述文案"),
    ]
    s_rows = [
        # ── 开局天赋（kind=0）
        ["t_extra_bullet", "多发弹匣", 0, 0, 1, 60, "skill_extra_bullet", "[]", "", 0, "[]", "开局天赋：弹匣 +2"],
        ["t_heavy_shot", "重弹头", 0, 0, 1, 60, "skill_heavy_shot", "[]", "", 0, "[]", "开局天赋：子弹伤害 +40%"],
        ["t_fast_hands", "快枪手", 0, 1, 1, 30, "skill_fast_hands", "[]", "", 0, "[]", "开局天赋：开火间隔 -20%"],
        ["t_magnet_core", "磁吸核心", 0, 0, 1, 60, "skill_magnet_core", "[]", "", 0, "[]", "开局天赋：磁吸范围 +50%"],
        ["t_iron_body", "铁壁", 0, 1, 1, 30, "skill_iron_body", "[]", "", 0, "[]", "开局天赋：血量 +30，俯冲伤害 -20%"],
        ["t_bounce_master", "弹射大师", 0, 2, 1, 10, "skill_bounce_master", "[\"bounce\"]", "", 0, "[]", "开局天赋：撞墙后子弹加速（可叠 3 次）"],
        # ── v1.0 首批技能池（kind=2 被动，除僚机/冰封）
        ["s_heavy", "重炮", 2, 0, 10, 60, "skill_heavy", "[\"damage\"]", "s_overload", 1, "[\"s_rapid:s_ammo_belt:2\"]", "子弹伤害 +20%/级（线性，不是复利）"],
        ["s_chain", "连锁闪电", 2, 1, 8, 30, "skill_chain", "[\"chain\",\"electric\"]", "s_thunderstorm", 1, "[\"s_pierce:s_thunderball:2\"]", "命中时劈中最近的若干敌人"],
        ["s_wingman", "僚机", 1, 2, 4, 10, "skill_wingman", "[\"summon\"]", "", 0, "[]", "环绕一架僚机，每 3s 打出一发免费弹"],
        ["s_pierce", "穿透弹", 2, 1, 3, 30, "skill_pierce", "[\"pierce\"]", "s_mirror", 1, "[\"s_chain:s_thunderball:2\"]", "命中后有一小段不反弹窗口，可继续穿行"],
        ["s_big_bullet", "重弹", 2, 0, 5, 60, "skill_big_bullet", "[\"size\"]", "", 0, "[]", "子弹更大更疼（更易命中）"],
        ["s_rapid", "速射", 2, 0, 5, 60, "skill_rapid", "[\"speed\"]", "s_barrage", 1, "[\"s_heavy:s_ammo_belt:2\"]", "开火间隔 -8%/级（下限 0.15s）"],
        ["s_magazine", "扩容弹匣", 2, 0, 4, 60, "skill_magazine", "[\"ammo\"]", "", 0, "[]", "弹匣 +1/级"],
        ["s_fast_return", "磁力回收", 2, 0, 4, 60, "skill_fast_return", "[\"return\"]", "", 0, "[]", "子弹回身速度 +25%/级"],
        ["s_magnet", "磁吸范围", 2, 0, 5, 60, "skill_magnet", "[\"pickup\"]", "s_blackhole", 1, "[\"s_greed:s_alchemy:2\",\"s_vitality:s_lifesteal_field:2\"]", "磁吸范围 +20%/级"],
        ["s_vitality", "强化体质", 2, 0, 5, 60, "skill_vitality", "[\"hp\"]", "s_lifesteal", 1, "[\"s_magnet:s_lifesteal_field:2\"]", "最大血量 +20/级，并立即回复 20"],
        ["s_slow_field", "缓速场", 2, 0, 5, 60, "skill_slow_field", "[\"field\"]", "", 0, "[\"s_freeze:s_absolute_zero:2\"]", "敌人下移速度 -6%/级"],
        ["s_shield", "回收护盾", 2, 1, 3, 30, "skill_shield", "[\"shield\",\"return\"]", "", 0, "[]", "每回收 10 发获得 1 点护盾（上限 20，优先于血扣除）"],
        # ── 候选 / 扩展技能
        ["s_regen", "再生", 2, 1, 4, 30, "skill_regen", "[\"hp\"]", "", 0, "[]", "每 5s 回复 1 血/级（受伤后 3s 内不触发）"],
        ["s_greed", "贪婪", 2, 0, 3, 60, "skill_greed", "[\"economy\"]", "", 0, "[\"s_magnet:s_alchemy:2\"]", "金币获取 +25%/级"],
        ["s_split", "分裂弹", 2, 3, 3, 3, "skill_split", "[\"split\"]", "", 0, "[]", "子弹撞墙时分裂出一发反向子弹（走免费弹通道）"],
        ["s_freeze", "冰封", 1, 3, 3, 3, "skill_freeze", "[\"field\",\"control\"]", "", 0, "[\"s_slow_field:s_absolute_zero:2\"]", "每 20s 冻结全场敌人 1.5s"],
        # ── 进化产物（weight=0，不参与随机）
        ["s_overload", "过载", 2, 2, 1, 0, "skill_overload", "[\"evolved\"]", "", 0, "[]", "重炮进化：伤害 +100%，但每发多消耗 1 发弹匣耐久"],
        ["s_thunderstorm", "雷暴", 2, 2, 1, 0, "skill_thunderstorm", "[\"evolved\",\"chain\"]", "", 0, "[]", "闪电进化：不再依赖命中，每次开火自动电击最近敌人"],
        ["s_mirror", "镜面", 2, 2, 1, 0, "skill_mirror", "[\"evolved\",\"bounce\"]", "", 0, "[]", "穿透进化：子弹撞墙时分裂出一颗临时子弹（存在 3s）"],
        ["s_barrage", "弹幕", 2, 2, 1, 0, "skill_barrage", "[\"evolved\",\"speed\"]", "", 0, "[]", "速射进化：射速 +100%，子弹速度 -30%"],
        ["s_blackhole", "黑洞", 2, 2, 1, 0, "skill_blackhole", "[\"evolved\",\"pickup\"]", "", 0, "[]", "磁吸进化：范围内掉落物主动飞向玩家，经验 +20%"],
        ["s_lifesteal", "吸血", 2, 2, 1, 0, "skill_lifesteal", "[\"evolved\",\"hp\"]", "", 0, "[]", "体质进化：每次回收子弹回复 1 点血"],
        # ── 融合产物（weight=0，终态）
        ["s_thunderball", "雷球", 2, 3, 1, 0, "skill_thunderball", "[\"fusion\",\"chain\",\"pierce\"]", "", 0, "[]", "融合：命中必定连锁，且连锁闪电也会弹射"],
        ["s_ammo_belt", "弹链", 2, 2, 1, 0, "skill_ammo_belt", "[\"fusion\",\"ammo\",\"speed\"]", "", 0, "[]", "融合：弹匣 +50%，回收速度 +30%"],
        ["s_alchemy", "炼金", 2, 2, 1, 0, "skill_alchemy", "[\"fusion\",\"economy\"]", "", 0, "[]", "融合：吸附掉落物时 30% 概率转化为超级水晶"],
        ["s_lifesteal_field", "吸血领域", 2, 2, 1, 0, "skill_lifesteal_field", "[\"fusion\",\"hp\",\"pickup\"]", "", 0, "[]", "融合：回收回血 + 磁吸范围翻倍"],
        ["s_absolute_zero", "绝对零度", 2, 3, 1, 0, "skill_absolute_zero", "[\"fusion\",\"field\",\"control\"]", "", 0, "[]", "融合：冻结期间敌人血量上限 -20%（可斩杀）"],
    ]
    add_sheet(wb, "Skill", s_fields, s_rows, enum_hints={3: "0,1,2", 4: "0,1,2,3"})

    ef_fields = [
        ("skillId", "string", "关联 Skill.id"),
        ("target", "string", "作用目标，如 bulletDamage / fireInterval / chainTargets / magnetRadius"),
        ("op", "enum:EffectOp", "运算 0加法 1乘法（乘法填 0.2 表示 +20%）"),
        ("perLevel", "float", "每级增量"),
        ("base", "float", "基础加成（Lv.0 也生效，可空填 0）"),
        ("cap", "float", "该效果封顶（0 = 不封顶）"),
        ("desc", "string", "备注"),
    ]
    ef_rows = [
        ["t_extra_bullet", "bulletCount", 0, 2, 0, 0, "开局 +2 发"],
        ["t_heavy_shot", "bulletDamage", 1, 0.4, 0, 0, ""],
        ["t_fast_hands", "fireInterval", 1, -0.2, 0, 0, ""],
        ["t_magnet_core", "magnetRadius", 1, 0.5, 0, 0, ""],
        ["t_iron_body", "maxHp", 0, 30, 0, 0, ""],
        ["t_iron_body", "diveDamageTaken", 1, -0.2, 0, 0, "俯冲伤害减免"],
        ["t_bounce_master", "bounceSpeedGain", 1, 0.15, 0, 0.45, "撞墙加速，最多叠到 +45%"],
        ["s_heavy", "bulletDamage", 1, 0.2, 0, 0, "线性加成，10 级 = ×3.0"],
        ["s_chain", "chainTargets", 0, 1, 0, 12, "8 级劈 12 个"],
        ["s_chain", "chainDamageRatio", 0, 0.05, 0.5, 1.0, "雷击伤害占子弹伤害的比例"],
        ["s_wingman", "wingmanCount", 0, 1, 0, 4, "4 架满级"],
        ["s_pierce", "pierceDuration", 0, 0.03, 0.06, 0.15, "穿透窗时长 秒"],
        ["s_big_bullet", "bulletRadius", 1, 0.3, 0, 1.5, ""],
        ["s_big_bullet", "bulletDamage", 1, 0.15, 0, 0, ""],
        ["s_rapid", "fireInterval", 1, -0.08, 0, 0, "下限由 cap 控制（秒）"],
        ["s_rapid", "fireIntervalFloor", 0, 0, 0, 0, "占位：射速下限见 tuning"],
        ["s_magazine", "bulletCount", 0, 1, 0, 0, ""],
        ["s_fast_return", "returnSpeedScale", 1, 0.25, 0, 0, ""],
        ["s_magnet", "magnetRadius", 1, 0.2, 0, 2.0, "最多 ×3"],
        ["s_vitality", "maxHp", 0, 20, 0, 0, "学到的瞬间也回复 20"],
        ["s_slow_field", "enemyFallSpeed", 1, -0.06, 0, -0.4, "最多 -40%"],
        ["s_shield", "shieldPerRecycle10", 0, 1, 0, 20, "每回收 10 发 +1 护盾，上限 20"],
        ["s_regen", "hpRegenPer5s", 0, 1, 0, 4, ""],
        ["s_greed", "coinGain", 1, 0.25, 0, 0, ""],
        ["s_split", "splitOnBounce", 0, 1, 0, 3, "撞墙分裂，走免费弹通道"],
        ["s_freeze", "freezeDuration", 0, 0.3, 1.5, 3.0, ""],
        ["s_freeze", "freezeCooldown", 1, -0.1, 20, 0, "基础冷却 20s，逐级减少"],
        ["s_overload", "bulletDamage", 1, 1.0, 0, 0, "进化：伤害翻倍"],
        ["s_overload", "magazineCostPerShot", 0, 1, 1, 0, "每发额外消耗 1 发弹匣耐久"],
        ["s_thunderstorm", "autoChainTargets", 0, 1, 2, 6, "每次开火自动电击最近 N 个"],
        ["s_mirror", "mirrorSplitOnBounce", 0, 1, 1, 2, "临时子弹存在 3s"],
        ["s_barrage", "fireInterval", 1, -1.0, 0, 0, "射速 +100%"],
        ["s_barrage", "bulletSpeed", 1, -0.3, 0, 0, "代价：子弹更慢回来"],
        ["s_blackhole", "magnetRadius", 1, 1.0, 0, 0, "磁吸范围翻倍"],
        ["s_blackhole", "expGain", 1, 0.2, 0, 0, ""],
        ["s_lifesteal", "healOnRecycle", 0, 1, 0, 0, "每次回收回 1 血"],
        ["s_thunderball", "chainTargets", 0, 2, 0, 0, "融合：额外 +2 目标"],
        ["s_thunderball", "chainBounce", 0, 1, 1, 1, "连锁也会弹射"],
        ["s_ammo_belt", "bulletCount", 1, 0.5, 0, 0, "弹匣 +50%"],
        ["s_ammo_belt", "returnSpeedScale", 1, 0.3, 0, 0, ""],
        ["s_alchemy", "superCrystalChanceOnPick", 0, 0.3, 0, 0.3, "吸附掉落物时转超级水晶"],
        ["s_lifesteal_field", "healOnRecycle", 0, 1, 1, 0, ""],
        ["s_lifesteal_field", "magnetRadius", 1, 1.0, 0, 0, ""],
        ["s_absolute_zero", "freezeHpShred", 1, 0.2, 0, -0.2, "冻结期间敌人血量上限 -20%"],
    ]
    add_sheet(wb, "Skill_Effect", ef_fields, ef_rows, enum_hints={3: "0,1"})
    return save(wb, "skill.xlsx")


# ══════════════════════════════════════════════════════════════
# 5. drop.xlsx → Drop
# ══════════════════════════════════════════════════════════════
def build_drop():
    fields = [
        ("id", "string", "掉落规则 ID"),
        ("sourceKind", "enum:DropSource", "来源 0全局默认 1按品质 2按类型 3按具体敌人"),
        ("sourceId", "string", "配合来源：品质 0~5 / 类型 0~3 / 敌人 ID；全局填 *"),
        ("kind", "enum:DropKind", "掉落物 0经验水晶 1超级水晶 2金币 3魂晶"),
        ("chance", "float", "概率 0~1（经验水晶固定 1.0）"),
        ("amountMin", "int", "数量下限"),
        ("amountMax", "int", "数量上限"),
        ("scatterRadius", "float", "散落半径 px（0.2 格 = 16 px）"),
        ("magnetRadius", "int", "磁吸半径 px（0 = 需手动拾取）"),
        ("lifeTime", "float", "存活时间 秒（最后 3s 闪烁）"),
        ("value", "int", "经验水晶携带经验（0 = 按品质×类型算）"),
        ("desc", "string", "备注"),
    ]
    rows = [
        # 经验水晶：每次击杀必掉 1 颗（BOSS 按占格数多掉）
        ["d_exp_default", 0, "*", 0, 1.0, 1, 1, 16.0, 120, 15.0, 0, "每次击杀必掉（需求 4）"],
        ["d_exp_mini", 2, "2", 0, 1.0, 2, 2, 16.0, 120, 15.0, 0, "小BOSS 掉 2 颗"],
        ["d_exp_boss", 2, "3", 0, 1.0, 4, 4, 16.0, 120, 15.0, 0, "大BOSS 掉 4 颗"],
        # 金币：按品质给量（每次击杀）
        ["d_coin_0", 1, "0", 2, 1.0, 1, 1, 16.0, 120, 15.0, 0, "白"],
        ["d_coin_1", 1, "1", 2, 1.0, 2, 2, 16.0, 120, 15.0, 0, "绿"],
        ["d_coin_2", 1, "2", 2, 1.0, 3, 3, 16.0, 120, 15.0, 0, "蓝"],
        ["d_coin_3", 1, "3", 2, 1.0, 6, 6, 16.0, 120, 15.0, 0, "紫"],
        ["d_coin_4", 1, "4", 2, 1.0, 12, 12, 16.0, 120, 15.0, 0, "金"],
        ["d_coin_5", 1, "5", 2, 1.0, 25, 25, 16.0, 120, 15.0, 0, "红"],
        # 超级水晶：精英低概率 / BOSS 必定
        ["d_super_elite", 2, "1", 1, 0.15, 1, 1, 16.0, 120, 15.0, 0, "精英 15%"],
        ["d_super_mini", 2, "2", 1, 1.0, 1, 1, 16.0, 120, 15.0, 0, "小BOSS 必掉 1"],
        ["d_super_boss", 2, "3", 1, 1.0, 2, 2, 16.0, 120, 15.0, 0, "大BOSS 掉 2"],
        # 魂晶：精英 / BOSS（外围加点唯一来源）
        ["d_soul_elite", 2, "1", 3, 1.0, 1, 1, 16.0, 120, 15.0, 0, "精英 1"],
        ["d_soul_mini", 2, "2", 3, 1.0, 3, 3, 16.0, 120, 15.0, 0, "小BOSS 3"],
        ["d_soul_boss", 2, "3", 3, 1.0, 10, 10, 16.0, 120, 15.0, 0, "大BOSS 10"],
        # 具体敌人覆盖示例（价值最高的 BOSS 额外给一颗超级水晶）
        ["d_super_boss_red8", 3, "e_boss_red8", 1, 1.0, 1, 1, 16.0, 120, 15.0, 0, "按具体敌人追加"],
    ]
    wb = new_wb()
    add_sheet(wb, "Drop", fields, rows, enum_hints={2: "0,1,2,3", 4: "0,1,2,3"})
    return save(wb, "drop.xlsx")


# ══════════════════════════════════════════════════════════════
# 6. meta.xlsx → MetaPoint（外围加点）
# ══════════════════════════════════════════════════════════════
def build_meta():
    fields = [
        ("id", "string", "节点 ID"),
        ("name", "string", "名称"),
        ("desc", "string", "描述"),
        ("icon", "string", "图标"),
        ("maxLevel", "int", "等级上限"),
        ("effectTarget", "string", "效果目标（与 SkillEffect.target 同一套命名）"),
        ("effectOp", "enum:EffectOp", "运算 0加法 1乘法"),
        ("effectPerLevel", "float", "每级效果"),
        ("costBase", "float", "成本系数（默认 2）"),
        ("costPow", "float", "成本指数（默认 1.4）"),
        ("sortOrder", "int", "面板排序"),
    ]
    rows = [
        ["m_bullet_count", "子弹数量", "每级弹匣 +1（需求：增加玩家子弹数量）", "icon_bullet", 10,
         "bulletCount", 0, 1, 2, 1.4, 1],
        ["m_damage", "攻击力", "每级子弹伤害 +5%", "icon_damage", 20,
         "bulletDamage", 1, 0.05, 2, 1.4, 2],
        ["m_move_speed", "移动速度", "每级移速 +3%（同时提升接弹与走位）", "icon_move", 10,
         "moveSpeed", 1, 0.03, 2, 1.4, 3],
        ["m_max_hp", "血量", "每级最大血量 +10", "icon_hp", 20,
         "maxHp", 0, 10, 2, 1.4, 4],
        ["m_high_rarity", "高级技能概率", "每级高稀有度技能出现率 +2%（建议改保底，见 §18.3）", "icon_rarity", 10,
         "highRarityChance", 0, 0.02, 2, 1.4, 5],
    ]
    wb = new_wb()
    add_sheet(wb, "Meta_Point", fields, rows, enum_hints={7: "0,1"})
    return save(wb, "meta.xlsx")


# ══════════════════════════════════════════════════════════════
# 7. skin.xlsx → Skin（召唤系统）
# ══════════════════════════════════════════════════════════════
def build_skin():
    fields = [
        ("id", "string", "皮肤 ID"),
        ("name", "string", "名称"),
        ("asset", "string", "资源名"),
        ("unlock", "enum:SkinUnlock", "获取方式 0默认拥有 1魂晶兑换 2召唤"),
        ("cost", "int", "兑换消耗魂晶（召唤皮肤填 0）"),
        ("bonusTarget", "string", "属性加成目标（留空 = 纯外观）"),
        ("bonusOp", "enum:EffectOp", "运算 0加法 1乘法"),
        ("bonusValue", "float", "加成数值（建议 ≤ 0.05）"),
        ("desc", "string", "备注"),
    ]
    rows = [
        ["sk_default", "初始球体", "skin_player_default", 0, 0, "", 0, 0, "默认拥有"],
        ["sk_iron", "铁球", "skin_player_iron", 1, 80, "maxHp", 0, 10, "魂晶兑换"],
        ["sk_swift", "疾风球", "skin_player_swift", 1, 120, "moveSpeed", 1, 0.03, "魂晶兑换"],
        ["sk_prism", "棱镜球", "skin_player_prism", 2, 0, "magnetRadius", 1, 0.1, "召唤获得"],
        ["sk_ember", "余烬球", "skin_player_ember", 2, 0, "bulletDamage", 1, 0.03, "召唤获得"],
        ["sk_void", "虚空球", "skin_player_void", 2, 0, "", 0, 0, "召唤保底产物，纯外观"],
    ]
    wb = new_wb()
    add_sheet(wb, "Skin", fields, rows, enum_hints={4: "0,1,2", 7: "0,1"})
    return save(wb, "skin.xlsx")


# ══════════════════════════════════════════════════════════════
# 8. tuning.xlsx → Tuning（全局数值）
# ══════════════════════════════════════════════════════════════
def build_tuning():
    fields = [
        ("key", "string", "数值键（与 GameTuning 字段名一致）"),
        ("value", "float", "数值（整数也填数字）"),
        ("group", "string", "分组"),
        ("desc", "string", "说明"),
    ]
    rows = [
        # 场地
        ["designWidth", 750, "场地", "设计分辨率宽"],
        ["designHeight", 1334, "场地", "设计分辨率高"],
        ["cellSize", 80, "场地", "格尺寸 px（体型与散落距离的基准）"],
        ["colCount", 5, "场地", "棋盘列数"],
        ["bottomLineOffset", 100, "场地", "底线距屏幕底部 px"],
        ["playerSpawnOffset", 120, "场地", "玩家出生点距屏幕底部 px"],
        # 判定与俯冲
        ["diveTelegraph", 1.0, "判定", "越线后判定窗 秒（可击杀）"],
        ["diveSpeed", 700, "判定", "俯冲速度 px/s"],
        ["diveDamagePerCell", 5, "判定", "俯冲伤害/格"],
        ["diveDamageMax", 40, "判定", "俯冲伤害上限（防止八格怪一击必杀）"],
        ["diveHitRadius", 45, "判定", "俯冲命中半径 px"],
        ["diveScaleUp", 1.35, "判定", "俯冲前放大的倍率"],
        ["diveScaleDown", 0.5, "判定", "飞行途中缩小到的倍率"],
        # 墙与生成
        ["maxWallRows", 20, "生成", "墙行数上限（满则排队）"],
        ["rowGapCells", 1.2, "生成", "相邻两行的纵向间距（格）：行间隔 = 该值 × cellSize ÷ 当前波下落速度"],
        ["spawnStaggerBudget", 0.5, "生成", "带内弹出允许占用一个行间隔的比例"],
        ["spawnStagger", 0.08, "生成", "带内错峰 秒"],
        ["spawnScaleFrom", 0.6, "生成", "入场缩放起始倍率"],
        ["spawnScaleDuration", 0.25, "生成", "入场缩放时长 秒"],
        # 打击反馈（受击闪白 / 敌人震动）
        ["hitFlashTime", 0.12, "反馈", "受击闪白持续时间 秒"],
        ["hitFlashAlpha", 210, "反馈", "受击闪白起始不透明度 0~255"],
        ["hitShakeTime", 0.16, "反馈", "敌人受击震动持续时间 秒"],
        ["hitShakeAmplitude", 3, "反馈", "敌人受击震动幅度 px（随时间衰减）"],
        # 难度曲线
        ["difficultyRowPerWave", 1, "难度", "每波行数增量"],
        ["difficultyRowMax", 30, "难度", "单波行数上限"],
        ["difficultySpeedGrowth", 0.08, "难度", "每波下移速度增幅"],
        ["difficultySpeedMax", 2.5, "难度", "下移速度倍率上限"],
        ["difficultyHpGrowth", 0.12, "难度", "每波血量增幅"],
        ["difficultyHpMax", 2.5, "难度", "血量倍率上限"],
        # 攻击型敌人占比（§8.5，数组拆成标量以兼容导出管线）
        ["attackRatioWave1", 0.0, "难度", "第 1 波攻击型占比"],
        ["attackRatioWave4", 0.1, "难度", "第 4 波攻击型占比"],
        ["attackRatioWave8", 0.2, "难度", "第 8 波攻击型占比"],
        ["attackRatioWave15", 0.35, "难度", "第 15 波攻击型占比"],
        ["attackRatioWave16", 0.5, "难度", "第 16 波及以后攻击型占比（封顶）"],
        # 掉落
        ["dropScatterRadius", 16, "掉落", "散落半径 px（0.2 格）"],
        ["dropMagnetRadius", 120, "掉落", "磁吸半径 px（1.5 格）"],
        ["dropLifeTime", 15, "掉落", "掉落物存活 秒"],
        ["dropMaxOnScreen", 80, "掉落", "同屏掉落物上限"],
        ["dropBossCrystalCount", 4, "掉落", "大BOSS 经验水晶颗数（按占格 2~4）"],
        # 经济
        ["coinRerollBase", 20, "经济", "刷新候选首次价格"],
        ["coinRerollStep", 20, "经济", "刷新候选每次涨价"],
        ["coinBuyCommon", 60, "经济", "购买普通技能价格"],
        ["coinBuyRare", 120, "经济", "购买稀有技能价格"],
        ["coinBuyEpic", 220, "经济", "购买史诗技能价格"],
        ["coinBuyLegendary", 400, "经济", "购买传说技能价格"],
        ["coinBuyGrowthPerWave", 0.05, "经济", "价格随波数上浮系数"],
        ["coinBuySuperCrystal", 200, "经济", "购买超级水晶价格"],
        ["expCurveBase", 8, "经济", "经验曲线常数项"],
        ["expCurveLinear", 6, "经济", "经验曲线一次项"],
        ["expCurveQuad", 1.5, "经济", "经验曲线二次项"],
        # 技能
        ["talentOfferCount", 3, "技能", "开局天赋候选数"],
        ["levelUpOfferCount", 3, "技能", "升级候选数"],
        ["rarityWeightCommon", 60, "技能", "普通技能权重"],
        ["rarityWeightRare", 30, "技能", "稀有技能权重"],
        ["rarityWeightEpic", 10, "技能", "史诗技能权重"],
        ["rarityWeightLegendary", 3, "技能", "传说技能权重"],
        ["legendaryMaxPerRun", 3, "技能", "传说卡每局最多出现次数"],
        ["superCrystalUpgradeCost", 1, "技能", "超级水晶：升级技能消耗"],
        ["superCrystalEvolveCost", 1, "技能", "超级水晶：进化消耗"],
        ["superCrystalFuseCost", 2, "技能", "超级水晶：融合消耗"],
        # 外围养成
        ["metaCostBase", 2, "外围", "加点成本系数"],
        ["metaCostPow", 1.4, "外围", "加点成本指数"],
        ["gachaCost", 30, "外围", "召唤单次消耗魂晶"],
        ["gachaPity", 10, "外围", "召唤保底次数"],
        ["gachaReturnRate", 0.5, "外围", "重复皮肤返还魂晶比例"],
        # 表现与性能
        ["damageTextMaxOnScreen", 12, "表现", "同屏伤害数字上限"],
        ["deathFxMaxOnScreen", 20, "表现", "同屏击杀特效上限"],
        ["hudHpBarWidth", 520, "表现", "血条宽"],
        ["hudHpBarHeight", 26, "表现", "血条高"],
        ["maxSubStepDistance", 8, "性能", "子弹单子步最大位移 px（防穿模）"],
        ["maxSubStepCount", 16, "性能", "单帧最大子步数"],
        ["maxFrameDt", 0.1, "性能", "单帧最大推进时长 秒（掉帧/切后台夹紧）"],
    ]
    wb = new_wb()
    add_sheet(wb, "Tuning", fields, rows)
    return save(wb, "tuning.xlsx")


def main():
    print("生成配置表模板 →", OUT_DIR)
    build_player()
    build_enemy()
    build_level()
    build_skill()
    build_drop()
    build_meta()
    build_skin()
    build_tuning()
    print("完成。")


if __name__ == "__main__":
    main()