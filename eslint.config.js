import stylistic from '@stylistic/eslint-plugin'

export default [
    {
        plugins: {
            '@stylistic': stylistic
        },
        rules: {
            '@stylistic/padding-line-between-statements': [
                "error",
                { blankLine: "always", prev: "*", next: "class" },
                { blankLine: "always", prev: "class", next: "*" },
                { blankLine: "always", prev: "*", next: "export" },
                { blankLine: "always", prev: "export", next: "*" },
                { blankLine: "always", prev: "*", next: "function" },
                { blankLine: "always", prev: "function", next: "*" },
                { blankLine: "always", prev: "import", next: "expression" }
            ]
        }
    }
]
