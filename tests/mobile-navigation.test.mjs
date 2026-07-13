import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(
  new URL('../frontend/public/index.html', import.meta.url),
  'utf8'
);
const manifestSource = await readFile(
  new URL('../frontend/public/manifest.webmanifest', import.meta.url),
  'utf8'
);
const appConfigSource = await readFile(
  new URL('../frontend/public/app-config.js', import.meta.url),
  'utf8'
);
const serviceWorkerSource = await readFile(
  new URL('../frontend/public/sw.js', import.meta.url),
  'utf8'
);
const readmeSource = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('画面遷移は下部ナビのタップ導線だけを使う', () => {
  assert.doesNotMatch(indexSource, /enableSwipe|enableAdminSwipe/);
  assert.doesNotMatch(indexSource, /SWIPE_LOCK|stepAdminSection|__SHIFT_FLOW_GESTURE__/);
  assert.match(indexSource, /link\.addEventListener\('click', handleViewLinkClick\)/);
  assert.match(indexSource, /el\.addEventListener\('click', handleAdminTargetClick\)/);

  const mainNav = indexSource.match(
    /<!-- SECTION: サイドバー（モバイル下部ナビゲーション） -->([\s\S]*?)<nav class="navbar navbar-expand footer-nav admin-footer-nav/
  );
  const adminNav = indexSource.match(
    /<nav class="navbar navbar-expand footer-nav admin-footer-nav[\s\S]*?<\/nav>/
  );
  assert.ok(mainNav, '通常画面の下部ナビが存在する');
  assert.ok(adminNav, '管理画面の下部ナビが存在する');
  assert.equal((mainNav[1].match(/data-view=/g) || []).length, 4);
  assert.equal((adminNav[0].match(/data-admin-target=/g) || []).length, 5);
});

test('ステータスバー、下部ナビ、FABはモバイル表示ルールに揃う', () => {
  assert.doesNotMatch(
    indexSource,
    /appleStatus\.setAttribute\('content', 'default'\)/
  );
  assert.doesNotMatch(indexSource, /statusBar: 'default'/);
  assert.match(
    indexSource,
    /appleStatus\.setAttribute\('content', 'black-translucent'\)/
  );
  assert.equal(JSON.parse(manifestSource).background_color, '#f2f4f9');
  assert.match(
    indexSource,
    /--footer-bottom-inset: max\(4px, calc\(var\(--safe-bottom\) - 12px\)\);/
  );
  assert.doesNotMatch(indexSource, /--footer-extra:/);
  assert.match(indexSource, /padding-bottom: var\(--footer-bottom-inset\);/);
  assert.match(indexSource, /calc\(10px \+ var\(--safe-right\)\)/);
  assert.match(indexSource, /calc\(10px \+ var\(--safe-left\)\)/);
  assert.match(indexSource, /background-color: var\(--fab\);/);
  assert.doesNotMatch(indexSource, /#6479da|#586dca|rgba\(80, 110, 220/);
});

test('PWAのAPP_VERSIONは設定・Service Worker・READMEで一致する', () => {
  const configVersion = appConfigSource.match(/APP_VERSION: '(\d+\.\d+\.\d+)'/)?.[1];
  const serviceWorkerVersion = serviceWorkerSource.match(
    /const APP_VERSION = '(\d+\.\d+\.\d+)'/
  )?.[1];
  const readmeVersion = readmeSource.match(
    /現在の APP_VERSION: `(\d+\.\d+\.\d+)`/
  )?.[1];
  assert.ok(configVersion, 'app-config.jsにAPP_VERSIONがある');
  assert.equal(serviceWorkerVersion, configVersion);
  assert.equal(readmeVersion, configVersion);
});
