// @ts-check
const { defineConfig } = require("eslint/config");
const tseslint = require("typescript-eslint");
const angular = require("angular-eslint");

module.exports = defineConfig([
  {
    files: ["**/*.ts"],
    extends: [
      tseslint.configs.recommended,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrors": "none"
        }
      ],
      "@angular-eslint/no-output-on-prefix": "off",
      // Angular 22 makes OnPush the default, and the v22 migration wrote an explicit
      // `ChangeDetectionStrategy.Eager` on every component to preserve v21 behaviour. Only
      // map-explorer and summarizer hold local signals; the rest read service signals and mutate
      // plain fields from async callbacks, which OnPush would stop rendering. Converting them is a
      // change-detection rewrite with no test that would catch a regression — a separate change
      // from a security upgrade. Turn this back on when that happens.
      "@angular-eslint/prefer-on-push-component-change-detection": "off"
    }
  },
  {
    files: ["**/*.html"],
    extends: [
      angular.configs.templateRecommended
    ],
    rules: {
      "@angular-eslint/template/eqeqeq": "off"
    }
  }
]);
