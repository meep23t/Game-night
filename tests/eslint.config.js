// Quick bug check for the site's code: undefined names, typos, duplicate keys, dead code.
// Run from the repo root:  npx --prefix tests eslint -c tests/eslint.config.js
// (the test suite runs it first and reports the results under "Code check").
const html = require('eslint-plugin-html');
const globals = require('globals');

module.exports = [
  { ignores: ['tests/**', 'docs/**', 'tools/**', 'node_modules/**'] },
  {
    files: ['index.html', 'words/*.js'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, GN_WORDS: 'writable' },
    },
    rules: {
      'no-undef': 'error',             // a misspelled or missing name
      'no-dupe-keys': 'error',         // the same key twice in one object (the second silently wins)
      'no-redeclare': ['error', { builtinGlobals: false }],   // our name() helper may shadow window.name
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-dupe-else-if': 'error',
      'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],  // dead code inside functions
    },
  },
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none' }], 'no-unreachable': 'error' },
  },
];
