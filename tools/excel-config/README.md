# Excel 配置文件目录

本目录存放游戏配置的 Excel 源文件（.xlsx 格式）。

## 表头约定

| 行号 | 用途 | 示例 |
|------|------|------|
| 第1行 | 字段名 | id, name, hp, speed, skills |
| 第2行 | 字段类型 | int, string, float, float, array:int |
| 第3行 | 注释说明 | 敌人ID, 名称, 生命值, 移动速度, 技能列表 |
| 第4行起 | 数据行 | 1001, 史莱姆, 100, 50, [1,2] |

## 支持的字段类型

| 类型标注 | 说明 | 示例值 |
|---------|------|--------|
| int | 整数 | 100 |
| float | 浮点数 | 3.14 |
| bool | 布尔值 | true / false / 0 / 1 |
| string | 字符串 | 史莱姆 |
| enum:EnumName | 枚举 | 0 / 1 / 2 |
| array:int | 整数数组 | [1,2,3] |
| array:string | 字符串数组 | ["a","b"] |

## 特殊行处理

- 空行会被自动跳过
- 第一列以 `#` 开头的行视为注释行，会被跳过

## 需要创建的配置文件

### 《弹球 Roguelike》配置表（当前生效的一套）

> 字段含义见《弹球Roguelike玩法策划案.md》**附录 A**；生成与自检脚本见 **§17.4**。

| 文件名 | 工作表 | 说明 | 关键字段 |
|--------|--------|------|----------|
| player.xlsx | Player | 玩家属性与子弹参数 | id, maxHp, hitRadius, moveSpeed, bulletCount, fireInterval, bulletSpeed, bulletDamage, catchRadius, maxBulletLife, magnetRadius |
| enemy.xlsx | Quality | 6 色品质 | quality, hpPerCell, weight, exp, coin |
| enemy.xlsx | Enemy | 敌人定义（三轴 + 攻击） | id, quality, type, shape, asset, attackKind, attackRange, attackInterval, attackDamage, attackWindup, stopToCast, expMul, coinMul, weight |
| enemy.xlsx | Boss_Phase | 大BOSS 多阶段（导出表名 BossPhase） | enemyId, phaseIndex, hpThreshold, speedScale, intervalScale, attackKinds, summonDefId, summonCount |
| level.xlsx | Level / Wave / Row | 关卡、波次（手写/随机）、行模板 | levelId, waveIndex, mode, seed, bands, qualityWeights, typeWeights, shapeWeights, template |
| skill.xlsx | Skill | 技能与天赋（天赋也是技能） | id, kind, rarity, maxLevel, weight, tags, evolveInto, evolveCost, fusePartners |
| skill.xlsx | Skill_Effect | 技能每级效果（导出表名 SkillEffect） | skillId, target, op, perLevel, base, cap |
| drop.xlsx | Drop | 四类掉落物（经验/超级水晶/金币/魂晶） | sourceKind, sourceId, kind, chance, amountMin, amountMax, scatterRadius, magnetRadius, lifeTime |
| meta.xlsx | Meta_Point | 外围加点节点（导出表名 MetaPoint） | id, maxLevel, effectTarget, effectOp, effectPerLevel, costBase, costPow |
| skin.xlsx | Skin | 皮肤 / 召唤 | id, asset, unlock, cost, bonusTarget, bonusOp, bonusValue |
| tuning.xlsx | Tuning | 全局数值与难度曲线 | key, value, group |

**行模板写法**（`level.xlsx` / `Row.template`）：5 个槽位用 `|` 分隔。

| 写法 | 含义 |
|------|------|
| `defId` | 该格放这个敌人（锚点格） |
| `-` | 该格被**相邻锚点**占用（同行左侧的横版敌人，或上一行的竖版/大怪），不是空列 |
| `_` 或留空 | 该格故意空着（造型用） |

**工作表命名**：不要用 camelCase。导出器按 `_`/`-`/空格 分词、每段首字母大写其余小写，写 `BossPhase` 会被压平成 `Bossphase`；写 `Boss_Phase` 才得到表名 `BossPhase`。（`verify_templates.py` 会拦这个错。）

**类型映射**（Excel 标注 → FlatBuffers）：

| Excel 标注 | FlatBuffers | 说明 |
|------------|-------------|------|
| `int` / `float` / `bool` / `string` | `int32` / `float32` / `bool` / `string` | |
| `enum:任意名` | `byte` | **不会生成 FBS enum**：`enum:A`、`enum:B` 出来都是 `byte`，枚举名只是给策划看的标注 |
| `array:int` / `array:string` | `[int32]` / `[string]` | Excel 里要写成 JSON 字符串，如 `[1,2]` |

每张表会生成 `table <表名>` + `table <表名>List`（`root_type <表名>List`），客户端读的是 `List` 那张。

### 旧地牢玩法配置表（归档，未接入当前玩法）

| 文件名 | 说明 | 关键字段 |
|--------|------|----------|
| weapon.xlsx | 武器配置 | id, name, typeId, baseDamage, attackSpeed, range, cooldown, projectileCount, rarity, icon, description |
| item.xlsx | 道具配置 | id, name, typeId, attribute, modType, baseValue, valuePerLevel, maxLevel, rarity, icon, description |
| pet.xlsx | 宠物配置 | id, name, typeId, baseAttack, followDistance, attackRange, attackCooldown, passiveAttribute, passiveModType, passiveValue, maxLevel, icon, description |
| class.xlsx | 职业配置 | id, name, typeId, rarity, bonusMaxHp, bonusAttack, bonusDefense, bonusMoveSpeed, unlockType, unlockTargetValue, unlockDescription, icon, description |
| npc.xlsx | NPC配置 | id, name, typeId, services, baseDialogue, affinityDialogue, icon, description |
| costume.xlsx | 换装配置 | id, name, slot, unlockMethod, unlockValue, icon, description |
| event.xlsx | 事件配置 | id, name, typeId, description, options, weight, icon |
| shop.xlsx | 商店配置 | id, name, goodsTypeId, basePrice, priceGrowth, rarity, weight, icon, description |
| dungeon.xlsx | 地牢配置 | id, name, baseRoomCount, roomGrowth, typeWeights, eliteMinFloor, bossRequired, difficultyMultiplier |

## 生成与自检

```bash
# 按策划文档 §15 的 Schema 重新生成模板（会覆盖同名文件）
python build_templates.py

# 自检：表头/类型/枚举/引用/权重/行模板（0 错误才算过关）
python verify_templates.py
```

## 导出命令

```bash
cd tools/excel-exporter
npm install
npm run build
npm run export-config
```
