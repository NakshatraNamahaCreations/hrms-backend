/* eslint-disable no-console */
// Recursively runs `node --check` on every .js file (excluding node_modules).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
};
walk(root);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed += 1;
    console.error(`SYNTAX ERROR: ${file}\n${e.stderr ? e.stderr.toString() : e.message}`);
  }
}
console.log(failed === 0 ? `ALL SYNTAX OK (${files.length} files)` : `${failed} file(s) failed`);
process.exit(failed === 0 ? 0 : 1);
