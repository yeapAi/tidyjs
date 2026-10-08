/** @type {import('jest').Config} */
export default {
    testEnvironment: 'node',
    testMatch: [
        "**/unit/**/*.ts",
        "**/parser/**/*.ts",
        "**/configLoader/**/*.ts",
        "**/path-resolver/**/*.ts",
        "**/test/ir/**/*.ts",
        "**/test/compat/**/*.test.ts"
    ],
    globalSetup: "<rootDir>/test/compat/global-setup.cjs",
    moduleNameMapper: {
        "^vscode$": "<rootDir>/test/mocks/vscode.ts",
        "^oxc-parser$": "<rootDir>/test/mocks/oxc-parser.ts"
    },
    transform: {
        "^.+\\.tsx?$": "ts-jest"
    },
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    testPathIgnorePatterns: [
        "/node_modules/",
        "/.vscode-test/",
        "/test/compat/fixtures/",
        "/test/compat/expected/"
    ],
    modulePathIgnorePatterns: [
        "/.vscode-test/"
    ]
};
