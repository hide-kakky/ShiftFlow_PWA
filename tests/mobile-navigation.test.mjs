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

test('通常画面は横スライドせず選択パネルだけを即時表示する', () => {
  assert.match(indexSource, /\.views-track\s*{[^}]*display:\s*block;[^}]*transform:\s*none;[^}]*transition:\s*none;/s);
  assert.match(indexSource, /\.view-panel\.is-hidden\s*{[^}]*display:\s*none\s*!important;/s);
  assert.match(indexSource, /el\.hidden = !isActive;/);
  assert.match(indexSource, /setPanelInteractiveState\(el, isActive\);/);
  assert.equal((indexSource.match(/class="view-panel fade-container is-hidden"/g) || []).length, 3);
  assert.equal((indexSource.match(/aria-hidden="true"\s+hidden\s+inert/g) || []).length, 3);
  assert.doesNotMatch(
    indexSource,
    /VIEW_TRANSITION|translate3d\(|preparePanelTransition|waitForTrackTransition|trackTo\(/
  );
});

test('ステータスバー、下部ナビ、FABはモバイル表示ルールに揃う', () => {
  assert.doesNotMatch(
    indexSource,
    /appleStatus\.setAttribute\('content', 'default'\)/
  );
  assert.doesNotMatch(indexSource, /statusBar: 'default'/);
  assert.match(
    indexSource,
    /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/
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

test('下部メニューの件数バッジは各アイコンの右上に収まり、隣の項目を妨げない', () => {
  const footerBadgeRule = indexSource.match(
    /\.footer-nav \.nav-icon-badge\s*\{([\s\S]*?)\n\s*\}/
  )?.[1];

  assert.ok(footerBadgeRule, '下部メニュー用のバッジ配置ルールが存在する');
  assert.match(footerBadgeRule, /top:\s*16px\s*!important;/);
  assert.match(footerBadgeRule, /left:\s*calc\(50% \+ 14px\)\s*!important;/);
  assert.match(footerBadgeRule, /right:\s*auto\s*!important;/);
  assert.match(footerBadgeRule, /transform:\s*translate\(-12px, -10px\)\s*!important;/);
  assert.match(footerBadgeRule, /pointer-events:\s*none;/);
});

test('上下のchromeは速度や時間で補間せずスクロール実距離へ線形同期する', () => {
  const chromeScript = indexSource.match(
    /\(function enableScrollLinkedChrome\(\) \{([\s\S]*?)\}\)\(\);/
  );
  assert.ok(chromeScript, 'scroll-linked chrome制御が存在する');
  assert.doesNotMatch(
    chromeScript[1],
    /getHideMotionProfile|scheduleSettle|settleTimer|hideProgress|velocity|duration/
  );
  assert.match(
    chromeScript[1],
    /chromeTravel = clamp\(\s*chromeTravel \+ delta,\s*0,\s*getChromeTravelLimit\(\)\s*\);/
  );
  assert.match(chromeScript[1], /function syncChromeTravel\(current\)/);
  assert.match(chromeScript[1], /document\.body && document\.body\.scrollTop/);
  assert.match(chromeScript[1], /return candidates\.reduce\(function \(max, value\)/);
  assert.match(
    chromeScript[1],
    /function requestScrollUpdate\(\) \{\s*\/\/[^\n]+\s*\/\/[^\n]+\s*syncChromeTravel\(getScrollY\(\)\);\s*requestChromeRender\(\);\s*\}/
  );
  assert.match(chromeScript[1], /Math\.min\(chromeTravel, headerHeight\)/);
  assert.match(chromeScript[1], /Math\.min\(chromeTravel, footerHeight\)/);
  assert.match(chromeScript[1], /\(1 - ratio\)\.toFixed\(3\)/);
  assert.match(chromeScript[1], /window\.requestAnimationFrame\(renderChrome\)/);
  assert.match(chromeScript[1], /window\.addEventListener\('resize', requestChromeMeasure/);
  assert.doesNotMatch(indexSource, /--header-slide-duration|navbar--scrolling/);
  assert.match(
    indexSource,
    /transform:\s*translateY\(var\(--header-hide-offset, 0%\)\);\s*opacity:\s*var\(--header-hide-opacity, 1\);/
  );
  assert.match(
    indexSource,
    /transform:\s*translateY\(var\(--footer-hide-offset, 0px\)\);\s*opacity:\s*var\(--footer-hide-opacity, 1\);\s*transition:\s*none;/
  );
});

test('FABは右下で下部ナビへ追随し、中抜きの1/4ドーナツメニューを開く', () => {
  const fabMarkup = indexSource.match(
    /<!-- ===== Floating action button for quick actions ===== -->([\s\S]*?)<!-- SECTION: サイドバー（モバイル下部ナビゲーション） -->/
  );
  assert.ok(fabMarkup, 'FABのDOMが下部ナビから独立して存在する');
  assert.match(fabMarkup[1], /<div class="fab" data-app-shell hidden>/);
  assert.doesNotMatch(fabMarkup[1], /dropup|dropdown|data-bs-toggle/);
  assert.match(fabMarkup[1], /id="fabButton"[\s\S]*?aria-haspopup="menu"[\s\S]*?aria-controls="fabMenu"/);
  assert.match(fabMarkup[1], /id="fabMenu"[\s\S]*?role="menu"[\s\S]*?aria-hidden="true"[\s\S]*?inert/);
  assert.equal((fabMarkup[1].match(/role="menuitem"/g) || []).length, 2);
  assert.match(fabMarkup[1], /aria-label="タスクを作成"[\s\S]*?title="タスクを作成"/);
  assert.match(fabMarkup[1], /aria-label="メッセージを作成"[\s\S]*?title="メッセージを作成"/);
  assert.equal((fabMarkup[1].match(/class="visually-hidden"/g) || []).length, 2);

  assert.match(indexSource, /\.fab\s*{[^}]*right:\s*calc\(14px \+ var\(--safe-right\)\);/s);
  assert.match(
    indexSource,
    /--fab-rest-bottom:\s*max\(14px, calc\(var\(--safe-bottom\) \+ 8px\)\);/
  );
  assert.match(
    indexSource,
    /bottom:\s*var\(--fab-rest-bottom\);[\s\S]*?var\(--fab-follow-offset, 0px\)[\s\S]*?opacity:\s*1;/
  );
  assert.match(indexSource, /\.fab\s*{[^}]*isolation:\s*isolate;/s);
  assert.match(
    indexSource,
    /'--fab-follow-offset',[\s\S]*?footerTravel\.toFixed\(2\) \+ 'px'/
  );
  assert.match(
    indexSource,
    /\.fab__trigger\s*{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s
  );
  assert.match(
    indexSource,
    /\.fab__trigger\[aria-expanded\]\s*{[^}]*background-color:\s*var\(--fab\) !important;[^}]*opacity:\s*1;/s
  );
  assert.match(
    indexSource,
    /\.fab-arc-menu\s*{[^}]*--fab-menu-outer:\s*136px;[^}]*--fab-menu-inner:\s*54px;[^}]*z-index:\s*1;/s
  );
  assert.match(indexSource, /--fab-menu-surface:\s*rgba\(255, 250, 244, 0\.96\);/);
  assert.match(indexSource, /--fab-menu-surface-accent:\s*rgba\(255, 218, 190, 0\.94\);/);
  assert.match(indexSource, /:root\[data-theme='dark'\] \.fab-arc-menu\s*{[^}]*--fab-menu-surface:\s*rgba\(19, 29, 54, 0\.96\);/s);
  assert.match(indexSource, /border:\s*0;\s*border-radius:\s*100% 0 0 0;/s);
  assert.match(indexSource, /border:\s*0;\s*border-radius:\s*50%;/s);
  assert.match(indexSource, /linear-gradient\(145deg, var\(--fab-menu-surface\), var\(--fab-menu-surface-accent\)\)/);
  assert.match(indexSource, /linear-gradient\(145deg, var\(--fab-menu-action-start\), var\(--fab-menu-action-end\)\)/);
  assert.match(
    indexSource,
    /\.fab-arc-menu::before\s*{[^}]*border-radius:\s*100% 0 0 0;[\s\S]*?-webkit-mask:\s*radial-gradient\([\s\S]*?circle at 100% 100%,[\s\S]*?transparent var\(--fab-menu-inner\),[\s\S]*?#000 calc\(var\(--fab-menu-inner\) \+ 1px\)/
  );
  assert.match(indexSource, /--fab-item-x:\s*-32px;\s*--fab-item-y:\s*-88px;/);
  assert.match(indexSource, /--fab-item-x:\s*-88px;\s*--fab-item-y:\s*-32px;/);
  assert.match(indexSource, /menu\.toggleAttribute\('inert', !nextOpen\)/);
  assert.match(indexSource, /event\.key !== 'Escape' \|\| !isOpen\(\)/);
  assert.match(indexSource, /!isOpen\(\) \|\| fab\.contains\(event\.target\)/);
  assert.doesNotMatch(indexSource, /trigger\.style\.(?:background|opacity)/);
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
