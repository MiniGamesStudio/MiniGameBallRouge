/**
 * Excel 配置导出工具 - CLI 入口
 * 
 * 将 Excel 表格转换为 FlatBuffers 二进制配置文件。
 * 
 * 用法:
 *   npx ts-node src/index.ts --source <dir> --output <dir> --schema <dir> [--flatc <path>] [--force]
 *   npm run export-config
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { ExportPipeline, ExportOptions } from './ExportPipeline';

/** 默认配置文件路径 */
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/** 加载配置文件 */
function loadConfig(configPath: string): Record<string, string> {
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(content);
        } catch {
            console.warn(`⚠️  配置文件解析失败: ${configPath}`);
        }
    }
    return {};
}

/** 解析路径（相对于工具根目录） */
function resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) return inputPath;
    return path.resolve(process.cwd(), inputPath);
}

// 创建 CLI 程序
const program = new Command();

program
    .name('excel-exporter')
    .description('Excel 配置导出工具 - 将 Excel 表格转换为 FlatBuffers 二进制配置文件')
    .version('1.0.0')
    .option('-s, --source <dir>', 'Excel 源文件目录')
    .option('-o, --output <dir>', '二进制输出目录')
    .option('-S, --schema <dir>', 'Schema 输出目录')
    .option('-f, --flatc <path>', 'flatc 编译器路径（缺省读 config.json 的 flatcPath）')
    .option('-t, --ts <dir>', 'TypeScript 访问器输出目录（默认 <输出目录>/generated）')
    .option('--force', '强制导出（忽略增量检测和兼容性检查）', false)
    .option('-c, --config <path>', '配置文件路径', DEFAULT_CONFIG_PATH)
    .action(async (opts) => {
        // 加载配置文件作为默认值
        const config = loadConfig(opts.config);

        // 合并命令行参数和配置文件（命令行优先）
        const options: ExportOptions = {
            sourceDir: resolvePath(opts.source || config.sourceDir || '../excel-config'),
            outputDir: resolvePath(opts.output || config.outputDir || '../../assets/resources/config/roguelike'),
            schemaDir: resolvePath(opts.schema || config.schemaDir || './schemas'),
            flatcPath: opts.flatc || config.flatcPath || 'flatc',
            tsOutDir: resolvePath(
                opts.ts ||
                config.tsOutDir ||
                path.join(opts.output || config.outputDir || '../../assets/resources/config/roguelike', 'generated')
            ),
            force: opts.force || false,
        };

        console.log('🚀 Excel 配置导出工具 v1.0.0');
        console.log('─'.repeat(40));
        console.log(`  源目录:     ${options.sourceDir}`);
        console.log(`  输出目录:   ${options.outputDir}`);
        console.log(`  Schema 目录: ${options.schemaDir}`);
        console.log(`  flatc 路径:  ${options.flatcPath}`);
        console.log(`  TS 输出目录: ${options.tsOutDir}`);
        console.log(`  强制模式:    ${options.force ? '是' : '否'}`);
        console.log('─'.repeat(40));

        // 检查源目录是否存在
        if (!fs.existsSync(options.sourceDir)) {
            console.error(`\n❌ 源目录不存在: ${options.sourceDir}`);
            console.error('请确认 --source 参数或 config.json 中的 sourceDir 配置正确');
            process.exit(1);
        }

        // 执行导出
        const pipeline = new ExportPipeline(options);
        const summary = await pipeline.run();

        // 根据结果设置退出码
        if (summary.failedCount > 0) {
            process.exit(1);
        }
    });

program.parse(process.argv);
