import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/.data/**',
      '**/*.json',
      '**/drizzle/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused vars are an error, but a leading underscore marks intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` defeats the point of the domain model; allow it only deliberately.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Scripts, tests and seeds legitimately log to stdout.
    files: ['**/*.test.ts', '**/scripts/**', '**/seed/**', '**/*.config.*'],
    rules: { 'no-console': 'off' },
  },
  {
    /**
     * CommonJS files. Metro's config and Expo config plugins are loaded by
     * Node before any transpilation, so they must be CJS — `require` and
     * `module` are correct here, not a lapse.
     */
    files: ['**/*.cjs', 'apps/mobile/metro.config.js', 'modules/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
);
