#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const input = process.argv[2];

if (!input) {
  console.error('使い方: npm run bump:version -- <x.y.z>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(input)) {
  console.error('APP_VERSION は x.y.z の数値形式で指定してください');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const targets = [
  {
    label: 'frontend/public/app-config.js',
    file: path.join(repoRoot, 'frontend/public/app-config.js'),
    regex: /(APP_VERSION:\s*')[^']+(')/,
  },
  {
    label: 'frontend/public/sw.js',
    file: path.join(repoRoot, 'frontend/public/sw.js'),
    regex: /(const APP_VERSION = swConfig\.APP_VERSION \|\| ')[^']+(';)/,
  },
];

let hasError = false;

targets.forEach(({ label, file, regex }) => {
  try {
    const original = fs.readFileSync(file, 'utf8');
    if (!regex.test(original)) {
      console.error(`${label} から APP_VERSION を検出できませんでした`);
      hasError = true;
      return;
    }
    const updated = original.replace(regex, `$1${input}$2`);
    fs.writeFileSync(file, updated);
    console.log(`${label} を ${input} に更新しました`);
  } catch (error) {
    console.error(`${label} の更新中にエラー:`, error.message);
    hasError = true;
  }
});

if (hasError) {
  process.exit(1);
}
