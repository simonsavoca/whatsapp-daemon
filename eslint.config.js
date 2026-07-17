const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Dashboard client-side, servi tel quel au navigateur — pas du code Node.
    files: ["web/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        SwaggerUIBundle: "readonly",
        SwaggerUIStandalonePreset: "readonly",
      },
    },
  },
  {
    ignores: ["node_modules/", "data/"],
  },
];
