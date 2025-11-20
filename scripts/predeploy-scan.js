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
const ENV_FILE = '.env';
const APP_CONFIG_FILE = path.join('frontend', 'public', 'app-config.js');
const SENSITIVE_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET_JSON',
  'SHIFT_FLOW_SHARED_SECRET',
  'SHIFT_FLOW_SHARED_SECRET_NEXT',
  'GAS_SHARED_SECRET',
  'GAS_SHARED_SECRET_NEXT',
];
const PLACEHOLDER_HINTS = ['dummy', 'example', 'test', 'xxxx', 'your_', 'sample', 'placeholder'];
const SENSITIVE_PATTERNS = [
  { pattern: /AIza[0-9A-Za-z_\-]{12,}/g, label: 'Google API key' },
  { pattern: /ya29\.[0-9A-Za-z_\-]+/g, label: 'Google OAuth token' },
  { pattern: /sk_(?:live|test)_[0-9a-zA-Z]{20,}/g, label: 'Stripe secret key' },
  { pattern: /apps\.googleusercontent\.com/gi, label: 'Google OAuth client ID' },
  { pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/, label: 'Private key block' },
];

console.log('[predeploy-scan] Scan start:', ROOT);

let flagged = 0;

for (const flag of FLAGS) {
  const target = path.join(ROOT, flag);
  if (fs.existsSync(target)) {
    flagged += 1;
    console.warn(`⚠️  Sensitive file detected at root: ${flag}`);
  }
}

function isPlaceholder(value) {
  if (!value) return true;
  const lower = value.trim().toLowerCase();
  if (!lower) return true;
  return PLACEHOLDER_HINTS.some((hint) => lower.includes(hint));
}

function scanEnvFile() {
  const target = path.join(ROOT, ENV_FILE);
  if (!fs.existsSync(target)) {
    return;
  }
  const contents = fs.readFileSync(target, 'utf8');
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...rest] = trimmed.split('=');
    if (!key || rest.length === 0) return;
    const value = rest.join('=').trim();
    if (!value) return;
    if (SENSITIVE_ENV_KEYS.includes(key.trim()) && !isPlaceholder(value)) {
      flagged += 1;
      console.error(
        `🚫  ${ENV_FILE}:${index + 1} contains sensitive key "${key.trim()}". Move it to Cloudflare Secrets before deploying.`
      );
    }
  });
}

function scanStaticConfig() {
  const target = path.join(ROOT, APP_CONFIG_FILE);
  if (!fs.existsSync(target)) {
    console.warn(`[predeploy-scan] ${APP_CONFIG_FILE} is missing. Skipping static scan.`);
    return;
  }
  const contents = fs.readFileSync(target, 'utf8');
  for (const entry of SENSITIVE_PATTERNS) {
    const match = contents.match(entry.pattern);
    if (match && match.length) {
      flagged += 1;
      console.error(
        `🚫  ${APP_CONFIG_FILE} contains ${entry.label}. Remove hard-coded secrets before deploying.`
      );
    }
  }
}

scanEnvFile();
scanStaticConfig();

if (flagged === 0) {
  console.log('[predeploy-scan] OK: No sensitive files or tokens detected.');
  process.exit(0);
} else {
  console.error(`[predeploy-scan] FAILED: Detected ${flagged} issue(s). Resolve before deploying.`);
  process.exit(1);
}
