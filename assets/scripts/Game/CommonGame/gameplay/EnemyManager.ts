import { Node, Sprite, SpriteFrame, UITransform, Vec3 } from 'cc';
import { HitFlash } from './HitFlash';
import {
    BOTTOM_LINE_OFFSET,
    CELL_SIZE,
    ColorWeights,
    DESIGN_HEIGHT,
    DefaultTuning,
    DifficultyLevel,
    ENEMY_CORNER_RADIUS,
    EnemyColor,
    EnemyShape,
    EnemyType,
    GRID_COL_COUNT,
    GameTuning,
    IsolateTypes,
    MAX_WALL_ROWS,
    ShapeWeights,
    TypeWeights,
    getCellSpan,
    getDifficulty,
    getEnemyAssetName,
    getEnemyMaxHp,
    pickWeighted,
    scaleEnemyHp,
} from './GameConfig';

/** 波次排布里的一个敌人（尚未实例化），rowOffset 相对本波首行 */
export interface EnemySpec {
    color: EnemyColor;
    shape: EnemyShape;
    /** 类型：普通 / 精英 / 小BOSS / 大BOSS。决定行为、掉落与"周围是否留空" */
    type: EnemyType;
    col: number;
    rowOffset: number;
}

export type EnemyState = 'falling' | 'diving';

export interface EnemyData {
    node: Node;
    color: EnemyColor;
    shape: EnemyShape;
    /** 类型：普通 / 精英 / 小BOSS / 大BOSS。决定行为、掉落与"周围是否留空" */
    type: EnemyType;
    /** 屏幕上的实际包围盒（竖版 double 已把 160x80 折算成 80x160），碰撞用 */
    width: number;
    height: number;
    hp: number;
    maxHp: number;
    state: EnemyState;
    /** 所属行；俯冲之后脱离行，置空 */
    row: EnemyRow | null;
    /** 主动攻击玩家的计时器 */
    attackTimer: number;
    /** 受击闪白 */
    flash: HitFlash | null;
}

/** 敌人墙里的一行，y 是该行上边缘 */
export interface EnemyRow {
    y: number;
    enemies: EnemyData[];
}

/** 全部形状，供加权抽取和降级链使用 */
const ALL_SHAPES: EnemyShape[] = [
    EnemyShape.Single,
    EnemyShape.DoubleH,
    EnemyShape.DoubleV,
    EnemyShape.Quad,
    EnemyShape.Hexa,
    EnemyShape.Octa,
];

/**
 * 大怪形状，按占格数从大到小。
 *
 * 它们必须【先于普通格】占位：如果按"从左到右、抽到啥放啥"的顺序填，
 * 8 格的 octa 只有在 col=0 且连续两行都空着时才放得下，
 * 实际出现率会远低于 ShapeWeights 里配的权重，甚至永远见不到。
 */
const BIG_SHAPES: EnemyShape[] = [EnemyShape.Octa, EnemyShape.Hexa, EnemyShape.Quad];

/** 占格数：single 1、double 2、quad 4、hexa 6、octa 8 */
function cellCount(shape: EnemyShape): number {
    const span = getCellSpan(shape);
    return span.colSpan * span.rowSpan;
}

/**
 * 抽中的形状放不下时的降级顺序：从它自己开始，按占格数递减。
 * 每降一级都更容易放下，最后必然是 single（任何空格都放得下），
 * 所以调用方不需要再单独兜底。
 */
function downgradeChain(preferred: EnemyShape): EnemyShape[] {
    const chain = ALL_SHAPES.filter(shape => cellCount(shape) <= cellCount(preferred));
    chain.sort((a, b) => cellCount(b) - cellCount(a));
    return chain;
}

/**
 * 留空占位符：占住格子但不会变成敌人。
 *
 * col / rowOffset 都是 -1，永远不等于任何真实的格坐标，
 * 所以 spawnPendingRow 的"锚点格"判断会跳过它 —— 格子被占住、敌人不生成。
 * 是否需要留空由 GameConfig.IsolateTypes 决定：把该数组清空就等于关掉留空。
 */
const RESERVED_CELL: EnemySpec = {
    color: EnemyColor.Green,
    shape: EnemyShape.Single,
    type: EnemyType.Normal,
    col: -1,
    rowOffset: -1,
};

/**
 * 敌人管理器 — 负责波次排布、敌人墙下移、俯冲与近身攻击
 *
 * 墙的模型：m_Rows 里每行独立存一个 y，每帧统一减去下移速度，
 * 所以整面墙是刚性下移的。俯冲的敌人会从行里摘出来单独追玩家。
 */
export class EnemyManager {
    private m_Root: Node = null;
    private m_Tuning: GameTuning = DefaultTuning;
    private m_Frames: Map<string, SpriteFrame> = new Map();

    /** 敌人墙，下标越小越靠上 */
    private m_Rows: EnemyRow[] = [];
    /** 已俯冲、脱离墙的敌人 */
    private m_DivingList: EnemyData[] = [];
    /** 全部存活敌人，供子弹碰撞遍历 */
    private m_EnemyList: EnemyData[] = [];

    /** 当前波的排布：[rowOffset][col]；竖版 double 的两格指向同一个 spec */
    private m_Block: (EnemySpec | null)[][] = [];
    /** 当前波下一行待入场的下标 */
    private m_BlockCursor = 0;
    /** 已生成的波数，给 HUD 用 */
    private m_WaveCount = 0;
    /**
     * 当前波次的难度快照。只在开新波时刷新，
     * 这样整面墙的下落速度在一波之内是恒定的（速度突变只发生在波与波之间）。
     */
    private m_Difficulty: DifficultyLevel = null;

    private m_BottomLineY = 0;
    private m_SpawnLineY = 0;
    private m_BoardLeft = 0;

    init(root: Node, tuning: GameTuning, frames: Map<string, SpriteFrame>): void {
        this.m_Root = root;
        this.m_Tuning = tuning;
        this.m_Frames = frames;
        this.m_BottomLineY = -DESIGN_HEIGHT * 0.5 + BOTTOM_LINE_OFFSET;
        // 出生线在屏幕上方一格，敌人从屏幕外走进来
        this.m_SpawnLineY = DESIGN_HEIGHT * 0.5 + CELL_SIZE;
        // 棋盘要按格子总宽居中，而不是按屏幕宽：5 格 x 80 = 400，两边各留 175
        this.m_BoardLeft = -GRID_COL_COUNT * CELL_SIZE * 0.5;
        // BattleWorld 开局会立刻 generateWave()，这里只是给个合法初值
        this.m_Difficulty = getDifficulty(1, tuning);
    }

    /** 全部存活敌人（含已俯冲的） */
    get aliveEnemies(): EnemyData[] {
        return this.m_EnemyList;
    }

    /** 已生成的波数 */
    get waveCount(): number {
        return this.m_WaveCount;
    }

    /** 本波还有多少行没入场 */
    get pendingRowCount(): number {
        return Math.max(0, this.m_Block.length - this.m_BlockCursor);
    }

    /** 当前波次的难度（行数区间 / 下落速度 / 血量倍率），给 HUD 和调试用 */
    get difficulty(): DifficultyLevel {
        return this.m_Difficulty;
    }

    /**
     * 生成一波排布，返回本波行数。已经在场上的敌人不受影响。
     *
     * 上一波还有没入场的行时把它们保留在新波前面，避免墙被堆满时静默丢掉敌人
     * （竖版 double 不会跨波，所以按行拼接是安全的）。
     *
     * 行数按【本波】的难度取：先自增波次再算难度，所以第 1 波就是基准值。
     */
    generateWave(): number {
        this.m_WaveCount++;
        this.m_Difficulty = getDifficulty(this.m_WaveCount, this.m_Tuning);

        const min = this.m_Difficulty.rowMin;
        const max = Math.max(min, this.m_Difficulty.rowMax);
        const rowCount = min + Math.floor(Math.random() * (max - min + 1));
        const backlog = this.m_BlockCursor > 0 ? this.m_Block.slice(this.m_BlockCursor) : this.m_Block;

        this.m_Block = backlog.concat(this.generateBlock(rowCount));
        this.m_BlockCursor = 0;
        return rowCount;
    }

    /**
     * 把本波的下一行追加到墙顶。墙堆满（MAX_WALL_ROWS）时返回 false 让它排队等待。
     */
    spawnPendingRow(): boolean {
        if (this.m_BlockCursor >= this.m_Block.length) return false;
        if (this.m_Rows.length >= MAX_WALL_ROWS) return false;

        const specs = this.m_Block[this.m_BlockCursor];
        const rowOffset = this.m_BlockCursor;
        this.m_BlockCursor++;

        // 新行只能落在墙顶之上，避免和已有行重叠；墙还没让开时自动排队
        const topY = this.m_Rows.length > 0 ? this.m_Rows[0].y : this.m_SpawnLineY;
        const y = this.m_Rows.length > 0 ? Math.max(this.m_SpawnLineY, topY + CELL_SIZE) : this.m_SpawnLineY;

        const row: EnemyRow = { y, enemies: [] };
        this.m_Rows.unshift(row);

        // 血量按【入场那一刻】的难度算：一波的行可能拖到下一波才入场（墙堆满时排队），
        // 那时它本来就该按新的难度出场，所以这里不缓存生成时的倍率。
        const hpScale = this.m_Difficulty ? this.m_Difficulty.hpScale : 1;

        for (let col = 0; col < GRID_COL_COUNT; col++) {
            const spec = specs[col];
            // 一个 spec 会占住它覆盖的每一个格子，这里只在【锚点格】建节点：
            // 少了 col 这一项判断的话，横版 double 的两格会各建一次，两个节点完全重叠。
            if (!spec || spec.col !== col || spec.rowOffset !== rowOffset) continue;
            row.enemies.push(this.createEnemy(spec, row, hpScale));
        }
        return true;
    }

    /**
     * 推进一帧：墙下移、到线的敌人俯冲玩家、贴近玩家的敌人持续攻击。
     * 扣血通过 onHitPlayer 回调交给上层，敌人管理器不直接改玩家血量。
     */
    update(dt: number, playerPos: Readonly<Vec3>, onHitPlayer: (damage: number) => void): void {
        const tuning = this.m_Tuning;

        // 0. 推进受击闪白
        for (const enemy of this.m_EnemyList) {
            enemy.flash?.update(dt);
        }

        // 1. 整面墙刚性下移（速度取自本波难度快照：一波之内恒定，换波时才跳变）
        const fallSpeed = this.m_Difficulty ? this.m_Difficulty.fallSpeed : tuning.enemyFallSpeed;
        for (const row of this.m_Rows) {
            row.y -= fallSpeed * dt;
        }

        // 2. 墙上的敌人跟随所属行，越过底线后脱离行转为俯冲
        for (const row of this.m_Rows.slice()) {
            for (const enemy of row.enemies.slice()) {
                const span = getCellSpan(enemy.shape);
                const y = this.getEnemyY(row.y, span.rowSpan);
                enemy.node.setPosition(enemy.node.position.x, y, 0);

                if (y - enemy.height * 0.5 > this.m_BottomLineY) continue;

                enemy.state = 'diving';
                enemy.row = null;
                const index = row.enemies.indexOf(enemy);
                if (index >= 0) row.enemies.splice(index, 1);
                this.m_DivingList.push(enemy);
            }
            if (row.enemies.length === 0) {
                this.removeRow(row);
            }
        }

        // 3. 俯冲：追玩家当前位置，命中后扣血并消失
        for (const enemy of this.m_DivingList.slice()) {
            const pos = enemy.node.position;
            const dx = playerPos.x - pos.x;
            const dy = playerPos.y - pos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const step = tuning.diveSpeed * dt;

            if (distance <= Math.max(step, tuning.diveHitRadius)) {
                onHitPlayer(tuning.diveDamage);
                this.removeEnemy(enemy);
                continue;
            }

            enemy.node.setPosition(pos.x + (dx / distance) * step, pos.y + (dy / distance) * step, 0);
        }

        // 4. 贴近玩家的敌人主动攻击（俯冲中的不重复触发）
        for (const row of this.m_Rows) {
            for (const enemy of row.enemies) {
                if (enemy.state !== 'falling') continue;

                const pos = enemy.node.position;
                const dx = playerPos.x - pos.x;
                const dy = playerPos.y - pos.y;
                const reach = tuning.enemyAttackRange + Math.max(enemy.width, enemy.height) * 0.5;
                if (dx * dx + dy * dy > reach * reach) continue;

                enemy.attackTimer -= dt;
                if (enemy.attackTimer > 0) continue;
                enemy.attackTimer = tuning.enemyAttackInterval;
                onHitPlayer(tuning.enemyAttackDamage);
            }
        }
    }

    /** 扣血，返回本次是否击杀 */
    damage(enemy: EnemyData, damage: number): boolean {
        if (!enemy || enemy.hp <= 0) return false;

        enemy.hp -= damage;
        if (enemy.hp > 0) {
            // 只在没打死时闪：致死那一下节点会立刻销毁，闪白根本来不及显示
            enemy.flash?.play();
            return false;
        }

        this.removeEnemy(enemy);
        return true;
    }

    clear(): void {
        this.m_EnemyList.slice().forEach(enemy => this.removeEnemy(enemy));
        this.m_Rows.length = 0;
        this.m_DivingList.length = 0;
        this.m_EnemyList.length = 0;
        this.m_Block = [];
        this.m_BlockCursor = 0;
        this.m_WaveCount = 0;
        this.m_Difficulty = getDifficulty(1, this.m_Tuning);
    }

    /**
     * 离线生成一波的二维排布。
     *
     * 每行的 5 格都要填满，不留空格：单格填不下的位置由 single 兜底，
     * 所以只要一直往后填，5 列必然全部被占。
     *
     * 逐行从左到右填，竖版 double 需要骨架下方的格子也在本波内且为空，
     * 所以本波最后一行不会出现竖版 —— 这样整波生成完就天然不重叠，
     * 不需要在入场时再做跨行的占位检查。
     */
    private generateBlock(rowCount: number): (EnemySpec | null)[][] {
        const grid: (EnemySpec | null)[][] = [];
        for (let row = 0; row < rowCount; row++) {
            grid.push(new Array(GRID_COL_COUNT).fill(null));
        }

        // 第一遍：大怪优先占位。它们占格多、约束强，必须在普通格之前放下，
        // 否则会被先填进来的小怪挤掉（详见 BIG_SHAPES 的注释）。
        this.seedBigEnemies(grid, rowCount);

        // 第二遍：从左到右把剩下的空格填掉，每行的 5 格都要填满
        for (let row = 0; row < rowCount; row++) {
            let col = 0;
            while (col < GRID_COL_COUNT) {
                // 上一行的大怪会占掉这一行的对应格，直接跳过（不跳过会死循环）
                if (grid[row][col]) {
                    col++;
                    continue;
                }

                const preferred = pickWeighted(ShapeWeights, ALL_SHAPES);
                let placed = false;
                for (const shape of downgradeChain(preferred)) {
                    const span = getCellSpan(shape);
                    if (!this.canPlaceSpec(grid, row, col, span, rowCount)) continue;

                    this.placeSpec(grid, row, col, shape);
                    col += span.colSpan;
                    placed = true;
                    break;
                }
                // single 在当前格上必然放得下，placed 一定是 true；这里只是兜底，防止填不满时卡死
                if (!placed) col++;
            }
        }
        return grid;
    }

    /**
     * 大怪优先占位。
     *
     * 大怪的"应有数量"直接从 ShapeWeights 推出来：形状权重里大怪占多大比例，
     * 每波就放多少比例的大怪。策划改权重即可调整大怪频率，不需要再多配一个参数。
     * 从随机的一行开始往下找，避免大怪永远堆在最上面几行。
     */
    private seedBigEnemies(grid: (EnemySpec | null)[][], rowCount: number): void {
        const bigWeight = BIG_SHAPES.reduce((sum, shape) => sum + (ShapeWeights[shape] || 0), 0);
        const totalWeight = ALL_SHAPES.reduce((sum, shape) => sum + (ShapeWeights[shape] || 0), 0);
        if (bigWeight <= 0 || totalWeight <= 0) return;

        let budget = Math.round((bigWeight / totalWeight) * rowCount);
        if (budget <= 0) return;

        const startRow = Math.floor(Math.random() * rowCount);
        for (let offset = 0; offset < rowCount && budget > 0; offset++) {
            const row = (startRow + offset) % rowCount;
            if (this.tryPlaceBigEnemy(grid, row, rowCount)) budget--;
        }
    }

    /**
     * 在指定行放一只大怪，成功返回 true。
     *
     * 按占格数从大到小试（octa -> hexa -> quad），放不下就退而求其次；
     * 位置从随机起点开始向右找并绕回左边，避免大怪都贴在 col=0 形成规律。
     * 所有列都试过仍放不下就返回 false —— 大怪是"排得下才出现"的，
     * 不能为了保证它出现而破坏"每行填满"的规则。
     */
    private tryPlaceBigEnemy(grid: (EnemySpec | null)[][], row: number, rowCount: number): boolean {
        for (const shape of BIG_SHAPES) {
            const span = getCellSpan(shape);
            const maxCol = GRID_COL_COUNT - span.colSpan;
            if (maxCol < 0) continue;

            const start = Math.floor(Math.random() * (maxCol + 1));
            for (let offset = 0; offset <= maxCol; offset++) {
                const col = (start + offset) % (maxCol + 1);
                if (!this.canPlaceSpec(grid, row, col, span, rowCount)) continue;

                this.placeSpec(grid, row, col, shape);
                return true;
            }
        }
        return false;
    }

    /** 在 (row, col) 放一个 shape，并把同一个 spec 写满它覆盖的每一格 */
    private placeSpec(grid: (EnemySpec | null)[][], row: number, col: number, shape: EnemyShape): EnemySpec {
        const span = getCellSpan(shape);
        const type = pickWeighted(TypeWeights, [EnemyType.Normal, EnemyType.Elite, EnemyType.MiniBoss, EnemyType.Boss]);
        const spec: EnemySpec = {
            color: pickWeighted(ColorWeights, [EnemyColor.Green, EnemyColor.Blue, EnemyColor.Red]),
            shape,
            type,
            col,
            rowOffset: row,
        };
        for (let dr = 0; dr < span.rowSpan; dr++) {
            for (let dc = 0; dc < span.colSpan; dc++) {
                grid[row + dr][col + dc] = spec;
            }
        }

        // 精英 / BOSS 可以要求"周围留空"：名单在 GameConfig.IsolateTypes 里配。
        // 清空该数组 = 不留空；TypeWeights 里不给它们权重 = 根本不会出现，两者互不影响。
        if (IsolateTypes.indexOf(type) >= 0) {
            this.reserveRing(grid, row, col, span);
        }
        return spec;
    }

    /**
     * 把 (row, col) 这块矩形【外圈一圈】标成留空，越界自动忽略。
     *
     * 只处理外圈：矩形内部是自己占的格，不能覆盖成占位符。
     * 结果是"稀疏"而不是"掏空" —— 被留空的格子不会补怪，
     * 所以 BOSS 周围会真的空出一圈，给玩家留出接弹和走位的空间。
     */
    private reserveRing(grid: (EnemySpec | null)[][], row: number, col: number, span: { colSpan: number; rowSpan: number }): void {
        const rowCount = grid.length;
        for (let dr = -1; dr <= span.rowSpan; dr++) {
            for (let dc = -1; dc <= span.colSpan; dc++) {
                const inner = dr >= 0 && dr < span.rowSpan && dc >= 0 && dc < span.colSpan;
                if (inner) continue;

                const r = row + dr;
                const c = col + dc;
                if (r < 0 || r >= rowCount || c < 0 || c >= GRID_COL_COUNT) continue;
                if (grid[r][c]) continue;
                grid[r][c] = RESERVED_CELL;
            }
        }
    }

    private canPlaceSpec(grid: (EnemySpec | null)[][], row: number, col: number, span: { colSpan: number; rowSpan: number }, rowCount: number): boolean {
        if (col + span.colSpan > GRID_COL_COUNT) return false;
        if (row + span.rowSpan > rowCount) return false;

        for (let dr = 0; dr < span.rowSpan; dr++) {
            for (let dc = 0; dc < span.colSpan; dc++) {
                if (grid[row + dr][col + dc]) return false;
            }
        }
        return true;
    }

    private createEnemy(spec: EnemySpec, row: EnemyRow, hpScale: number): EnemyData {
        const span = getCellSpan(spec.shape);

        const node = new Node(`Enemy_${spec.color}_${spec.shape}_${spec.col}`);
        node.layer = this.m_Root.layer;
        this.m_Root.addChild(node);

        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);

        // 4/6/8 格没有专属美术：退回【单格图】并用 TILED 平铺铺满占格。
        // 好处是零美术也能一眼看出"这是个大怪"；以后美术补齐了，
        // 只要让 getEnemyAssetName 返回新图、把这里的 tiled 判断去掉即可。
        const tiled = cellCount(spec.shape) > 2;
        const frame = this.m_Frames.get(getEnemyAssetName(spec.color, tiled ? EnemyShape.Single : spec.shape));
        if (frame) sprite.spriteFrame = frame;
        if (tiled) {
            sprite.type = Sprite.Type.TILED;
            // 平铺必须让精灵服从节点尺寸，否则会被 SizeMode.TRIMMED 拉回贴图原始大小
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        }

        // single 80x80 正好一格、double 160x80 正好两格，可以直接用图片原始尺寸，
        // 相邻敌人的框边对边贴合，既填满格子又不会互相压住；
        // 平铺的大怪没有对应原图，必须按【占格】算，否则会被 80x80 的图缩成一格。
        const width = tiled || !frame ? CELL_SIZE * span.colSpan : frame.rect.width;
        const height = tiled || !frame ? CELL_SIZE * span.rowSpan : frame.rect.height;
        transform.setContentSize(width, height);

        // 竖版 double：把横版图片转 90°，contentSize 仍是原图 160x80，
        // 转过去之后屏幕上的包围盒变成 80 宽 x 160 高 = 1 格宽 2 格高。
        // 因为转的是节点而不是内容，所以碰撞盒要把宽高对调。
        const rotated = spec.shape === EnemyShape.DoubleV;
        if (rotated) {
            node.angle = 90;
        }

        // 基础血量来自颜色+形状，再乘上当前波次的血量倍率
        const maxHp = scaleEnemyHp(getEnemyMaxHp(spec.color, spec.shape), hpScale);
        const enemy: EnemyData = {
            node,
            color: spec.color,
            shape: spec.shape,
            type: spec.type,
            width: rotated ? height : width,
            height: rotated ? width : height,
            hp: maxHp,
            maxHp,
            state: 'falling',
            row,
            attackTimer: 0,
            // 闪白挂在敌人节点下，跟着一起旋转，宽高传旋转前的原图尺寸
            flash: HitFlash.rect(node, width, height, ENEMY_CORNER_RADIUS),
        };
        node.setPosition(this.getEnemyX(spec.col, span.colSpan), this.getEnemyY(row.y, span.rowSpan), 0);
        this.m_EnemyList.push(enemy);
        return enemy;
    }

    private removeEnemy(enemy: EnemyData): void {
        if (enemy.row) {
            const index = enemy.row.enemies.indexOf(enemy);
            if (index >= 0) enemy.row.enemies.splice(index, 1);
            if (enemy.row.enemies.length === 0) this.removeRow(enemy.row);
            enemy.row = null;
        }

        const divingIndex = this.m_DivingList.indexOf(enemy);
        if (divingIndex >= 0) this.m_DivingList.splice(divingIndex, 1);

        const listIndex = this.m_EnemyList.indexOf(enemy);
        if (listIndex >= 0) this.m_EnemyList.splice(listIndex, 1);

        enemy.flash?.dispose();
        enemy.flash = null;

        if (enemy.node && enemy.node.isValid) {
            enemy.node.removeFromParent();
            enemy.node.destroy();
        }
    }

    private removeRow(row: EnemyRow): void {
        const index = this.m_Rows.indexOf(row);
        if (index >= 0) this.m_Rows.splice(index, 1);
    }

    /** 格子 (col, colSpan) 的水平中心 */
    private getEnemyX(col: number, colSpan: number): number {
        return this.m_BoardLeft + CELL_SIZE * (col + colSpan * 0.5);
    }

    /**
     * 以 rowY 为上边缘、跨 rowSpan 行的敌人中心 y。
     *
     * 行是【依次入场】的，新行落在旧行上方，所以波次里 rowOffset 大的行在屏幕上反而更高：
     * 一个跨 2 行的敌人，第二格在锚点行的【上方】。
     * rowSpan = 1：中心在 rowY - CELL/2（就是这一格）
     * rowSpan = 2：中心在 rowY（下方一格是 rowY-CELL..rowY，上方一格是 rowY..rowY+CELL）
     */
    private getEnemyY(rowY: number, rowSpan: number): number {
        return rowY + CELL_SIZE * (rowSpan - 2) * 0.5;
    }
}