import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../frontend/public/compact-ui.css', import.meta.url), 'utf8');

test('メッセージ切替とFABボタン本体がモバイル・デスクトップで同じ下端を使う', () => {
  assert.match(html, /--fab-wide-bottom: 26px;/);
  assert.match(css, /\.message-mode \{[^}]*bottom: var\(--fab-rest-bottom\);/);
  assert.match(css, /@media \(min-width: 768px\)[\s\S]*\.message-mode \{[^}]*bottom: var\(--fab-wide-bottom\);/);
  assert.match(html, /@media \(min-width: 768px\)[\s\S]*\.fab \{[^}]*bottom: var\(--fab-wide-bottom\);/);
});

test('モバイルの切替とFABは同じスクロール追従式を保つ', () => {
  const follow = /calc\(\s*var\(--fab-rest-bottom\) - var\(--footer-h\) - var\(--footer-bottom-inset\) - 14px \+\s*var\(--(?:message-mode|fab)-follow-offset, 0px\)\s*\)/g;
  assert.equal((html + css).match(follow)?.length, 2);
});
