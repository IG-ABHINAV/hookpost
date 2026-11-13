// eslint-config-next 16 ships flat configs only. Spread them in directly:
// passing them through FlatCompat's `extends` makes @eslint/eslintrc try to
// serialise the plugin objects and crash ("Converting circular structure to
// JSON"). Same form as apps/frontend/eslint.config.mjs.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    settings: { next: { rootDir: 'apps/frontend/' } },
    rules: {
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'react/display-name': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.next-e2e/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/next-env.d.ts',
    ],
  },
];

export default eslintConfig;
