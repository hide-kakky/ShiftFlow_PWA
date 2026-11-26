import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../frontend/public/manifest.webmanifest', import.meta.url)));
const script = html.match(/<script id="shiftflow-theme-startup">([\s\S]*?)<\/script>/)[1];

function open(storage, {darkOS = false, blocked = false, iosHome = false} = {}) {
  const root = {dataset: {splash: 'true'}, setAttribute(_attr, value) { this.dataset.theme = value; }};
  const meta = {
    color: '#557abb', writes: 0,
    getAttribute() { return this.color; },
    setAttribute(_attr, color) { this.writes++; this.color = color; },
  };
  const media = {matches: darkOS};
  const window = {
    matchMedia: () => media,
    navigator: {standalone: iosHome},
    get localStorage() {
      if (blocked) throw new Error('blocked');
      return {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key,value)};
    },
  };
  runInNewContext(script, {window, document: {documentElement: root, querySelector: () => meta}});
  return {api: window.__SHIFT_FLOW_THEME__, root, meta, media};
}
const key = 'shiftflow.theme.v1';

test('共通ブランド青のロゴ画面でも保存済みの暗色を外部CSS読み込み前に先読み', () => {
  assert.ok(html.indexOf('id="shiftflow-theme-startup"') < html.indexOf('rel="manifest"'));
  assert.ok(html.indexOf('id="shiftflow-theme-startup"') < html.indexOf('cdn.jsdelivr.net'));
  assert.equal(manifest.theme_color, '#f2f4f9');
  assert.equal(manifest.background_color, '#f2f4f9');
  const {root,meta} = open(new Map([[key,'dark']]));
  assert.equal(root.dataset.theme,'dark');
  assert.equal(root.dataset.splash,'true');
  assert.equal(meta.color,'#557abb');
  assert.equal(meta.writes,0);
});

test('切替プレビューは即座に色を更新し、保存が確認された外観だけ次回起動に使う', () => {
  const storage = new Map([[key,'light']]);
  const {api,root,meta} = open(storage);
  api.sync(api.resolve('dark'));
  assert.equal(root.dataset.theme,'dark');
  assert.equal(meta.color,'#557abb');
  api.setSplash(false);
  assert.equal(meta.color,'#0b1224');
  assert.equal(open(storage).root.dataset.theme,'light');
  api.remember('dark');
  assert.equal(open(storage).root.dataset.theme,'dark');
  api.sync(api.resolve('light'));
  assert.equal(meta.color,'#f2f4f9');
  assert.match(html, /if \(res && res\.success\) \{\s*DEVICE_THEME\.remember\(payload\.theme\)/);
  assert.match(html, /fromCache && DEVICE_THEME\.read\(\)/);
});

test('「システム」は起動時と変更後のOS外観に従い、無効値と保存不可は安全に扱う', () => {
  const storage = new Map([[key,'system']]);
  const a = open(storage,{darkOS:true});
  assert.equal(a.root.dataset.theme,'dark');
  a.media.matches = false;
  a.api.sync(a.api.resolve('system'));
  assert.equal(a.meta.color,'#557abb');
  a.api.setSplash(false);
  assert.equal(a.meta.color,'#f2f4f9');
  assert.equal(storage.get(key),'system');
  a.api.remember('bad');
  assert.equal(storage.get(key),'system');
  assert.equal(open(new Map([[key,'bad']])).root.dataset.theme,'light');
  const b = open(storage,{blocked:true});
  assert.equal(b.root.dataset.theme,'light');
  assert.doesNotThrow(() => b.api.remember('dark'));
});

test('ロゴの保持中とフェード終了時に、上端・背景・metaを同じ色へ同期', () => {
  assert.match(html, /<html data-theme="light" data-splash="true">/);
  assert.match(html, /<meta name="theme-color" content="#557abb" \/>/);
  assert.match(html, /:root\[data-splash='true'\] body::before,[\s\S]*\.bootstrap-loading \{[\s\S]*background: var\(--splash-surface\);[\s\S]*background-image: none;/);
  assert.match(html, /if \(themeStartup\) themeStartup\.setSplash\(false\);/);

  const {api,root,meta} = open(new Map([[key,'dark']]),{iosHome:true});
  assert.equal(root.dataset.theme,'dark');
  assert.equal(meta.color,'#557abb');
  api.sync('light');
  assert.equal(meta.color,'#557abb');
  api.setSplash(false);
  assert.equal(root.dataset.splash,undefined);
  assert.equal(meta.color,'#f2f4f9');
  api.setSplash(true);
  assert.equal(meta.color,'#557abb');
});

test('iOSホーム画面版の濃紺指定はロゴ終了後のダークだけに限定', () => {
  const {api,root,meta} = open(new Map([[key,'light']]),{iosHome:true});
  assert.equal(root.dataset.iosHome,'true');
  assert.equal(root.dataset.theme,'light');
  assert.equal(meta.color,'#557abb');
  api.setSplash(false);
  assert.equal(meta.color,'#f2f4f9');
  api.sync('dark');
  assert.equal(meta.color,'#0b1224');
  assert.equal(open(new Map()).root.dataset.iosHome,undefined);
  assert.match(html, /data-theme='dark'\]\[data-ios-home='true'\]:not\(\[data-splash='true'\]\) body::before/);
  assert.doesNotMatch(html, /:root\[data-ios-home='true'\] header\.navbar/);
});

test('ホームを公開する描画で通常背景へ同期し、青はフェード層だけに残す', () => {
  const source = html.match(/function setBootstrapLoading\(isLoading\) \{[\s\S]*?\n      \}\n\n      function isAuthError/)[0]
    .replace(/\n\n      function isAuthError[\s\S]*/, '');
  const classes = new Set(['bootstrapping']);
  const loadingClasses = new Set(['is-visible']);
  const attributes = new Map();
  const root = {dataset: {theme: 'dark', splash: 'true'}};
  const meta = {color: '#557abb'};
  const loadingEl = {
    __shownAt: 0,
    classList: {
      add: (...names) => names.forEach(name => loadingClasses.add(name)),
      remove: (...names) => names.forEach(name => loadingClasses.delete(name)),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const timers = [];
  const themeStartup = {
    setSplash(visible) {
      if (visible) root.dataset.splash = 'true';
      else delete root.dataset.splash;
      meta.color = visible ? '#557abb' : (root.dataset.theme === 'dark' ? '#0b1224' : '#f2f4f9');
    },
  };
  const context = {
    document: {
      body: {classList: {toggle: (name, on) => on ? classes.add(name) : classes.delete(name)}},
    },
    window: {__SHIFT_FLOW_THEME__: themeStartup},
    byId: () => loadingEl,
    Date: {now: () => 100},
    clearTimeout: () => {},
    setTimeout(callback, ms) {
      timers.push({callback, ms});
      return timers.length;
    },
  };
  runInNewContext(source + '\nsetBootstrapLoading(false);', context);

  // 最小表示時間中はホームを青い下地の上へ先に公開しない。
  assert.equal(classes.has('bootstrapping'), true);
  assert.equal(root.dataset.splash, 'true');
  assert.equal(meta.color, '#557abb');

  timers.shift().callback();
  // ホームが描画可能になる最初のフレームで下地・上端・metaを通常色へそろえる。
  assert.equal(classes.has('bootstrapping'), false);
  assert.equal(root.dataset.splash, undefined);
  assert.equal(meta.color, '#0b1224');
  assert.equal(loadingClasses.has('is-splash-exit'), true);
  assert.equal(loadingClasses.has('is-fading'), true);
  assert.match(html, /\.bootstrap-loading\.is-splash-exit \{[\s\S]*background: var\(--splash-surface\);/);

  timers.shift().callback();
  // 次の状態でも通常背景を維持し、フェード専用の青だけを片付ける。
  assert.equal(root.dataset.splash, undefined);
  assert.equal(meta.color, '#0b1224');
  assert.equal(loadingClasses.has('is-splash-exit'), false);
});

test('iOSホーム画面版の上端だけを半透明でぼかし、読みやすい代替面を持つ', () => {
  assert.match(html, /data-ios-home='true'\]:not\(\[data-splash='true'\]\) body::before \{[\s\S]*background: rgba\(242, 244, 249, 0\.68\);[\s\S]*-webkit-backdrop-filter: saturate\(145%\) blur\(14px\);[\s\S]*backdrop-filter: saturate\(145%\) blur\(14px\);/);
  assert.match(html, /prefers-reduced-transparency: reduce[\s\S]*data-ios-home='true'[\s\S]*background: rgba\(242, 244, 249, 0\.96\);[\s\S]*backdrop-filter: none;/);
  assert.match(html, /data-theme='dark'\]\[data-ios-home='true'[\s\S]*body::before \{[\s\S]*background: rgba\(11, 18, 36, 0\.68\);/);
});
