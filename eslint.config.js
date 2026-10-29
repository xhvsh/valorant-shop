'use strict';

const globals = require('globals');

// Catches the bugs `node --check` cannot: a variable used without being defined
// (ReferenceError at request time) and unused leftovers.
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

module.exports = [
  { ignores: ['node_modules/**', 'graphify-out/**', '.brain/**', 'supabase/**', 'cloudflare/**/.wrangler/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    files: ['website/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
    rules,
  },
  {
    files: ['cloudflare/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.serviceworker, ...globals.node } },
    rules,
  },
  { files: ['eslint.config.js'], rules: { 'no-undef': 'off' } },
];
