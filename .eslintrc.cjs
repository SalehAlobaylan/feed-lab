module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  env: { browser: true, node: true, es2022: true },
  extends: ['eslint:recommended'],
  ignorePatterns: ['routeTree.gen.ts'],
  rules: { 'no-unused-vars': 'off', 'no-undef': 'off' },
}
