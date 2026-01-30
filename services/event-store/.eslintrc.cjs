module.exports = {
  root: true,
  extends: ['../../.eslintrc.cjs', 'plugin:@typescript-eslint/recommended-requiring-type-checking'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
