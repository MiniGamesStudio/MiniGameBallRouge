/**
 * ExportPipeline - 导出管线
 * 
 * 串联完整导出流程：
 *   扫描 Excel 文件 → 增量检测 → 读取 Excel → 生成 Schema → 编译 → 导出二进制 → 更新注册表
 * 
 * 支持批量导出和增量导出两种模式。
 * 导出完成后输出统计摘要。
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExcelReader, SheetData } from './ExcelReader';
import { SchemaGenerator, SchemaInfo } from './SchemaGenerator';
import { SchemaCompiler } from './SchemaCompiler';
import { BinaryExporter, ExportResult as BinaryExportResult } from './BinaryExporter';
import { SchemaRegistry, CompatibilityResult } from './SchemaRegistry';

/** 导出选项 */
export interface ExportOptions {
    /** Excel 源文件目录 */
    sourceDir: string;
    /** 二进制输出目录 */
    outputDir: string;
    /** Schema 输出目录 */
    schemaDir: string;
    /** flatc 编译器路径 */
    flatcPath: string;
    /** TypeScript 访问器输出目录（默认 <outputDir>/generated） */
    tsOutDir: string;
    /** 是否强制导出（忽略增量检测和兼容性检查） */
    force: boolean;
}

/** 单个文件的处理结果 */
export interface FileProcessResult {
    /** 文件名 */
    fileName: string;
    /** 是否成功 */
    success: boolean;
    /** 处理的工作表数量 */
    sheetCount: number;
    /** 总记录数 */
    totalRows: number;
    /** 是否跳过（增量模式下未变更） */
    skipped: boolean;
    /** 错误信息 */
    error?: string;
}

/** 导出统计摘要 */
export interface ExportSummary {
    /** 扫描到的文件总数 */
    totalFiles: number;
    /** 成功处理的文件数 */
    successCount: number;
    /** 失败的文件数 */
    failedCount: number;
    /** 跳过的文件数（增量模式） */
    skippedCount: number;
    /** 总耗时（毫秒） */
    elapsedMs: number;
    /** 各文件处理结果 */
    results: FileProcessResult[];
}

/**
 * 将表名转换为 PascalCase
 */
function toPascalCase(name: string): string {
    return name
        .split(/[_\-\s]+/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('');
}

export class ExportPipeline {
    private options: ExportOptions;
    private registry: SchemaRegistry;
    private compiler: SchemaCompiler;
    /** 本次运行生成的全部 .fbs 路径（供统计/排查用） */
    private schemaFiles: string[] = [];
    /** 本次运行解析出的全部工作表（最后合并成一个 schema 编译 TS） */
    private allSheets: SheetData[] = [];

    constructor(options: ExportOptions) {
        this.options = options;
        this.registry = new SchemaRegistry(options.schemaDir);
        this.compiler = new SchemaCompiler(options.flatcPath);
    }

    /**
     * 执行完整导出流程
     */
    async run(): Promise<ExportSummary> {
        const startTime = Date.now();
        const results: FileProcessResult[] = [];

        // 1. 扫描 Excel 源目录
        console.log(`\n📂 扫描目录: ${this.options.sourceDir}`);
        const excelFiles = this.scanExcelFiles();

        if (excelFiles.length === 0) {
            console.log('⚠️  未找到 Excel 文件');
            return {
                totalFiles: 0,
                successCount: 0,
                failedCount: 0,
                skippedCount: 0,
                elapsedMs: Date.now() - startTime,
                results: [],
            };
        }

        console.log(`📋 找到 ${excelFiles.length} 个 Excel 文件\n`);

        // 2. 逐文件处理
        for (const filePath of excelFiles) {
            const fileName = path.basename(filePath);
            const result = this.processFile(filePath, fileName);
            results.push(result);
        }

        // 2.5 统一生成 TypeScript 访问器
        this.compileSchemas();

        // 3. 保存注册表
        this.registry.save();

        // 4. 计算统计
        const elapsedMs = Date.now() - startTime;
        const summary: ExportSummary = {
            totalFiles: excelFiles.length,
            successCount: results.filter(r => r.success && !r.skipped).length,
            failedCount: results.filter(r => !r.success && !r.skipped).length,
            skippedCount: results.filter(r => r.skipped).length,
            elapsedMs,
            results,
        };

        // 5. 输出统计摘要
        this.printSummary(summary);

        return summary;
    }

    /**
     * 扫描 Excel 源目录，返回所有 .xlsx 文件路径
     */
    private scanExcelFiles(): string[] {
        const sourceDir = this.options.sourceDir;

        if (!fs.existsSync(sourceDir)) {
            console.error(`❌ 源目录不存在: ${sourceDir}`);
            return [];
        }

        const files = fs.readdirSync(sourceDir);
        return files
            .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$')) // 排除临时文件
            .map(f => path.join(sourceDir, f))
            .sort();
    }

    /**
     * 处理单个 Excel 文件
     */
    private processFile(filePath: string, fileName: string): FileProcessResult {
        console.log(`📄 处理: ${fileName}`);

        try {
            // 2a. 增量检测
            if (!this.options.force && this.shouldSkip(filePath, fileName)) {
                console.log(`  ⏭️  跳过（未变更）`);
                return {
                    fileName,
                    success: true,
                    sheetCount: 0,
                    totalRows: 0,
                    skipped: true,
                };
            }

            // 2b. 读取 Excel
            const sheets = ExcelReader.read(filePath);
            if (sheets.length === 0) {
                console.log(`  ⚠️  无有效工作表`);
                return {
                    fileName,
                    success: false,
                    sheetCount: 0,
                    totalRows: 0,
                    skipped: false,
                    error: '无有效工作表',
                };
            }

            this.allSheets.push(...sheets);

            let totalRows = 0;
            let allSuccess = true;

            for (const sheet of sheets) {
                const sheetSuccess = this.processSheet(sheet, fileName);
                if (!sheetSuccess) allSuccess = false;
                totalRows += sheet.rows.length;
            }

            return {
                fileName,
                success: allSuccess,
                sheetCount: sheets.length,
                totalRows,
                skipped: false,
            };
        } catch (err: any) {
            const errorMsg = err.message || '未知错误';
            console.error(`  ❌ 处理失败: ${errorMsg}`);
            return {
                fileName,
                success: false,
                sheetCount: 0,
                totalRows: 0,
                skipped: false,
                error: errorMsg,
            };
        }
    }

    /**
     * 处理单个工作表
     */
    private processSheet(sheet: SheetData, fileName: string): boolean {
        const tableName = toPascalCase(sheet.sheetName);

        // 2c. 生成 Schema 内容
        const schemaContent = SchemaGenerator.generateContent(sheet);

        // 2d. 检测 Schema 兼容性
        const compat = this.registry.checkCompatibility(tableName, sheet.fields);
        if (compat.hasChanges) {
            this.printCompatibilityInfo(tableName, compat);

            if (!compat.compatible && !this.options.force) {
                console.error(
                    `  ❌ ${tableName}: Schema 存在不兼容变更，使用 --force 强制导出`
                );
                return false;
            }
        }

        // 2e. 生成 Schema 文件
        const schemaInfos = SchemaGenerator.generate([sheet], this.options.schemaDir);
        if (schemaInfos.length === 0) {
            console.error(`  ❌ ${tableName}: Schema 生成失败`);
            return false;
        }

        // 2f. 收集 Schema 路径（统一在所有表处理完后编译一次，见 compileSchemas）
        this.schemaFiles.push(...schemaInfos.map(s => s.filePath));

        // 2g. 导出二进制数据
        const exportResult = BinaryExporter.export(sheet, this.options.outputDir);
        if (!exportResult.success) {
            console.error(`  ❌ ${tableName}: 二进制导出失败 - ${exportResult.error}`);
            return false;
        }

        // 2h. 更新注册表
        this.registry.update(tableName, schemaContent, sheet.fields);

        console.log(
            `  ✅ ${tableName}: ${sheet.rows.length} 条记录, ` +
            `${exportResult.fileSize} 字节`
        );

        return true;
    }

    /**
     * 生成 TypeScript 访问器
     *
     * 关键：全部表要**合并成一个 schema 文件**再交给 flatc。
     * flatc 25.x 的 --ts 输出按 namespace 组织（config.ts 出口文件 + config/ 目录），
     * 每张表各写一个 `namespace Config` 的 .fbs 时，无论分几次调用，
     * 出口文件都只会保留最后一次输入的表（实测 13 个 .fbs 只剩 1 张表）。
     *
     * 编译失败不阻止二进制导出 —— .bin 此时已经写好了。
     */
    private compileSchemas(): void {
        if (this.allSheets.length === 0) return;

        const generatedDir = this.options.tsOutDir || path.join(this.options.outputDir, 'generated');

        if (!this.compiler.isAvailable()) {
            console.warn(
                `  ⚠️  flatc 不可用（${this.options.flatcPath}），跳过 TypeScript 访问器生成；` +
                `二进制配置不受影响`
            );
            return;
        }

        const combinedPath = SchemaGenerator.generateCombined(
            this.allSheets,
            this.options.schemaDir
        );

        const results = this.compiler.compileAll([combinedPath], generatedDir);
        const failed = results.filter(r => !r.success).length;

        if (failed > 0) {
            console.warn(`  ⚠️  TypeScript 访问器生成失败（不影响二进制配置）`);
        } else {
            console.log(
                `  🧩 TypeScript 访问器: ${this.allSheets.length} 张表 → ${generatedDir}` +
                `（合并 schema: ${path.basename(combinedPath)}）`
            );
        }
    }

    /**
     * 增量检测：判断文件是否需要重新导出
     */
    private shouldSkip(filePath: string, fileName: string): boolean {
        const baseName = path.basename(fileName, '.xlsx');
        const tableName = toPascalCase(baseName);
        const lastExportTime = this.registry.getLastExportTime(tableName);

        if (!lastExportTime) return false; // 从未导出过

        try {
            const stat = fs.statSync(filePath);
            return stat.mtime <= lastExportTime;
        } catch {
            return false;
        }
    }

    /**
     * 输出兼容性检查信息
     */
    private printCompatibilityInfo(tableName: string, compat: CompatibilityResult): void {
        if (!compat.hasChanges) return;

        for (const detail of compat.details) {
            const icon = detail.breaking ? '🔴' : '🟡';
            console.log(`  ${icon} ${detail.message}`);
        }
    }

    /**
     * 输出统计摘要
     */
    private printSummary(summary: ExportSummary): void {
        const seconds = (summary.elapsedMs / 1000).toFixed(2);

        console.log('\n' + '═'.repeat(50));
        console.log('📊 导出统计摘要');
        console.log('═'.repeat(50));
        console.log(`  📁 文件总数:   ${summary.totalFiles}`);
        console.log(`  ✅ 成功:       ${summary.successCount}`);
        console.log(`  ❌ 失败:       ${summary.failedCount}`);
        console.log(`  ⏭️  跳过:       ${summary.skippedCount}`);
        console.log(`  ⏱️  总耗时:     ${seconds}s`);
        console.log('═'.repeat(50));

        // 列出失败的文件
        const failed = summary.results.filter(r => !r.success && !r.skipped);
        if (failed.length > 0) {
            console.log('\n❌ 失败文件:');
            for (const f of failed) {
                console.log(`  - ${f.fileName}: ${f.error || '未知错误'}`);
            }
        }

        console.log('');
    }
}
