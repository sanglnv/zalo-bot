'use strict';

const fs = require('node:fs');
const path = require('node:path');

const core = path.resolve(__dirname, '../src/core');
const forbidden = [
  { pattern: /SpreadsheetApp/g, label: 'Sheet runtime API' },
  { pattern: /UrlFetchApp/g, label: 'HTTP runtime API' },
  { pattern: /LockService/g, label: 'locking runtime API' },
  { pattern: /(?:telegram|zalo)/gi, label: 'platform-specific name' }
];
const violations = [];

for (const filename of fs.readdirSync(core).filter((name) => name.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(core, filename), 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) violations.push(`${filename}: contains ${rule.label}`);
    rule.pattern.lastIndex = 0;
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Core boundary check passed.');
}
