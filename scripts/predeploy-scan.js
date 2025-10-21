#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FLAGS = [
  '.clasp.json',
  'appsscript.json',
  'service-account.json',
  'service-account-key.json',
];

console.log('[predeploy-scan] Scan start:', ROOT);

let found = 0;

for (const flag of FLAGS) {
  const target = path.join(ROOT, flag);
  if (fs.existsSync(target)) {
    found += 1;
    console.warn(`⚠️  Sensitive file detected at root: ${flag}`);
  }
}

if (found === 0) {
  console.log('[predeploy-scan] No sensitive files found at repository root.');
} else {
  console.warn(`[predeploy-scan] Completed with ${found} warning(s). Remove or relocate before deploying.`);
}
