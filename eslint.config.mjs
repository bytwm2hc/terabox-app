import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

export default [
  // 導入 next/core-web-vitals 的規則
  {
    files: ['**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx'],
    ...nextPlugin.configs['core-web-vitals'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
];