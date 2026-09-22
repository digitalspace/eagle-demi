import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

const base = [js.configs.recommended, ...tseslint.configs.recommended, ...tseslint.configs.stylistic];

const rules = {
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...base, reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules,
  },
  {
    files: ['**/*.tsx'],
    extends: [jsxA11y.flatConfigs.recommended],
  },
  {
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
