/**
 * SchemaGenerator - FlatBuffers Schema 生成器
 * 
 * 根据 Excel 解析后的 SheetData 自动生成 .fbs Schema 文件。
 * 
 * 类型映射：
 *   int       → int32
 *   float     → float32
 *   bool      → bool
 *   string    → string
 *   enum:Name → byte
 *   array:int → [int32]
 *   array:string → [string]
 * 
 * 输出两种形态：
 *   1. 每张表一个 .fbs（generate / generateContent）—— 便于单表查阅与对比
 *   2. 全部表合并成一个 config.fbs（generateCombined）—— 用于编译 TypeScript
 * 
 * 为什么必须合并：flatc 25.x 的 --ts 输出按 namespace 组织
 * （一个 config.ts 出口文件 + config/ 目录）。多张表各自声明 `namespace Config`
 * 时，无论分几次调用 flatc，出口文件都只会保留最后一次输入的内容
 * （实测：13 个 .fbs 一次性编译，config.ts 里只剩最后一张表）。
 * 合并成一个 schema 文件后，出口文件才是完整的。
 */

import * as fs from 'fs';
import * as path from 'path';
import { SheetData, FieldDef } from './ExcelReader';

/** 生成的 Schema 信息 */
export interface SchemaInfo {
    /** Schema 文件名（不含路径） */
    fileName: string;
    /** Schema 文件完整路径 */
    filePath: string;
    /** Schema 文件内容 */
    content: string;
    /** 对应的表名 */
    tableName: string;
}

/**
 * 将 Excel 类型标注映射为 FlatBuffers 类型
 */
function mapToFbsType(excelType: string): string {
    switch (excelType) {
        case 'int':
            return 'int32';
        case 'float':
            return 'float32';
        case 'bool':
            return 'bool';
        case 'string':
            return 'string';
        default:
            if (excelType.startsWith('enum:')) {
                // 枚举类型映射为 byte
                return 'byte';
            }
            if (excelType.startsWith('array:')) {
                const innerType = excelType.substring(6);
                const fbsInner = mapToFbsType(innerType);
                return `[${fbsInner}]`;
            }
            return 'string'; // 默认回退
    }
}

/**
 * 将表名转换为 PascalCase 格式（用于 FlatBuffers table 名称）
 *
 * 注意：每段首字母大写、其余小写，所以工作表名不能写 camelCase：
 * "BossPhase" 会被压平成 "Bossphase"，必须写成 "Boss_Phase"。
 */
function toPascalCase(name: string): string {
    return name
        .split(/[_\-\s]+/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('');
}

export class SchemaGenerator {
    /**
     * 根据 SheetData 生成 FBS Schema 文件（每张表一个文件）
     * @param sheets 解析后的工作表数据
     * @param outputDir Schema 输出目录
     * @returns 生成的 Schema 信息列表
     */
    static generate(sheets: SheetData[], outputDir: string): SchemaInfo[] {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const results: SchemaInfo[] = [];

        for (const sheet of sheets) {
            const schemaInfo = SchemaGenerator.generateSchema(sheet, outputDir);
            results.push(schemaInfo);
        }

        return results;
    }

    /**
     * 为单个工作表生成并写入 .fbs 文件
     */
    private static generateSchema(sheet: SheetData, outputDir: string): SchemaInfo {
        const tableName = toPascalCase(sheet.sheetName);
        const fileName = `${tableName}.fbs`;
        const filePath = path.join(outputDir, fileName);
        const content = SchemaGenerator.generateContent(sheet);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf-8');

        return { fileName, filePath, content, tableName };
    }

    /**
     * 生成单张表的 Schema 内容（不写文件，也用于注册表对比）
     */
    static generateContent(sheet: SheetData): string {
        const tableName = toPascalCase(sheet.sheetName);
        const listTableName = `${tableName}List`;

        const lines: string[] = [];

        lines.push(`// 自动生成的 FlatBuffers Schema 文件`);
        lines.push(`// 源工作表: ${sheet.sheetName}`);
        lines.push(`// 请勿手动修改此文件`);
        lines.push('');
        lines.push(`namespace Config;`);
        lines.push('');

        SchemaGenerator.pushTable(lines, sheet);

        lines.push(`root_type ${listTableName};`);
        lines.push('');

        return lines.join('\n');
    }

    /**
     * 把全部表合并成一个 schema 文件，供 flatc 一次性编译 TypeScript
     * @param sheets 解析后的工作表数据（全部表）
     * @param outputDir Schema 输出目录
     * @param fileName 合并文件名，默认 config.fbs
     * @returns 合并后的 .fbs 完整路径
     */
    static generateCombined(
        sheets: SheetData[],
        outputDir: string,
        fileName: string = 'config.fbs'
    ): string {
        const lines: string[] = [];

        lines.push(`// 自动生成的 FlatBuffers Schema 文件（全部配置表合并）`);
        lines.push(`// 源工作表: ${sheets.map(s => s.sheetName).join(', ')}`);
        lines.push(`// 请勿手动修改此文件`);
        lines.push('');
        lines.push(`namespace Config;`);
        lines.push('');

        for (const sheet of sheets) {
            SchemaGenerator.pushTable(lines, sheet);
        }

        // 一个 schema 只能有一个 root_type。它只影响 flatc 的 --json/--binary 工具；
        // 每张表的 List 都会生成自己的 getRootAsXxx，所以各表的 .bin 都能独立解析，
        // 这里声明第一张表的 List 即可。
        if (sheets.length > 0) {
            lines.push(`root_type ${toPascalCase(sheets[0].sheetName)}List;`);
            lines.push('');
        }

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

        return filePath;
    }

    /**
     * 把一张表的「记录表 + 列表表」追加到 schema 行缓冲里
     * （单表生成与合并生成共用，避免两处逻辑漂移）
     */
    private static pushTable(lines: string[], sheet: SheetData): void {
        const tableName = toPascalCase(sheet.sheetName);
        const listTableName = `${tableName}List`;

        lines.push(`/// ${sheet.sheetName} 单条记录`);
        lines.push(`table ${tableName} {`);

        for (const field of sheet.fields) {
            const fbsType = mapToFbsType(field.type);
            // 注释必须单独占一行：flatc 25.x 起，行尾的 /// 会被拒绝
            // （error: a documentation comment should be on a line on its own）。
            // 单独成行还有额外好处：flatc --ts 会把注释带进生成的访问器 JSDoc 里。
            if (field.comment) {
                lines.push(`  /// ${field.comment}`);
            }
            lines.push(`  ${field.name}:${fbsType};`);
        }

        lines.push('}');
        lines.push('');
        lines.push(`/// ${sheet.sheetName} 记录列表`);
        lines.push(`table ${listTableName} {`);
        lines.push(`  items:[${tableName}];`);
        lines.push('}');
        lines.push('');
    }
}
