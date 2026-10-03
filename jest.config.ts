import type { Config } from 'jest';

/**
 * 两套测试各自独立配置：
 *   hex-terrain    上一版六边形地形玩法的纯逻辑测试（保留）
 *   ball-roguelike 弹球 Roguelike 的纯逻辑测试（core/ 不依赖 cc，可直接在 node 里跑）
 *
 * 跑全部：      npx jest
 * 只跑弹球：    npx jest --selectProjects ball-roguelike
 */
const shared = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};

const config: Config = {
    projects: [
        {
            displayName: 'hex-terrain',
            ...shared,
            roots: ['<rootDir>/tests/hex-terrain'],
            transform: {
                '^.+\\.tsx?$': ['ts-jest', {
                    tsconfig: 'tests/hex-terrain/tsconfig.json',
                }],
            },
            testMatch: [
                '**/tests/hex-terrain/**/*.test.ts',
                '**/tests/hex-terrain/**/*.spec.ts',
            ],
        },
        {
            displayName: 'ball-roguelike',
            ...shared,
            roots: ['<rootDir>/tests/ball-roguelike'],
            transform: {
                '^.+\\.tsx?$': ['ts-jest', {
                    tsconfig: 'tests/ball-roguelike/tsconfig.json',
                }],
            },
            testMatch: [
                '**/tests/ball-roguelike/**/*.test.ts',
                '**/tests/ball-roguelike/**/*.spec.ts',
            ],
        },
    ],
};

export default config;