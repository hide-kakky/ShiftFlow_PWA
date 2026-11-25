#!/usr/bin/env node
import { webcrypto } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const subjectIndex = process.argv.indexOf('--subject');
const subject = subjectIndex >= 0 ? process.argv[subjectIndex + 1] : '';
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject || '')) {
  console.error('使い方: node scripts/create-web-push-keys.mjs --subject mailto:運用連絡先');
  process.exit(1);
}
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const privateJwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const output = resolve('.local-web-push.json');
try {
  await writeFile(output, JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateJwk.d, VAPID_SUBJECT: subject }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('通知用鍵を.local-web-push.jsonへ作成しました。秘密鍵は画面に表示しません。');
} catch (error) {
  console.error(error.code === 'EEXIST' ? '既存の通知用鍵があります。上書きしていません。' : '通知用鍵ファイルを作成できませんでした。');
  process.exit(1);
}
