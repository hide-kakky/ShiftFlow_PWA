import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../frontend/public/manifest.webmanifest', import.meta.url)));
const script = html.match(/<script id="shiftflow-theme-startup">([\s\S]*?)<\/script>/)[1];

function open(storage, {darkOS = false, blocked = false, iosHome = false} = {}) {
  const root = {dataset: {}, setAttribute(_attr, value) { this.dataset.theme = value; }};
  const meta = {
    color: '#f2f4f9', writes: 0,
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

test('飾りの青を初期起動画面に出さず、保存済みの暗色を外部CSS読み込み前に適用', () => {
  assert.ok(html.indexOf('id="shiftflow-theme-startup"') < html.indexOf('rel="manifest"'));
  assert.ok(html.indexOf('id="shiftflow-theme-startup"') < html.indexOf('cdn.jsdelivr.net'));
  assert.equal(manifest.theme_color, '#f2f4f9');
  assert.equal(manifest.background_color, '#f2f4f9');
  const {root,meta} = open(new Map([[key,'dark']]));
  assert.equal(root.dataset.theme,'dark');
  assert.equal(meta.color,'#0b1224');
  assert.equal(meta.writes,1);
});

test('切替プレビューは即座に色を更新し、保存が確認された外観だけ次回起動に使う', () => {
  const storage = new Map([[key,'light']]);
  const {api,root,meta} = open(storage);
  api.sync(api.resolve('dark'));
  assert.equal(root.dataset.theme,'dark');
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
  assert.equal(a.meta.color,'#f2f4f9');
  assert.equal(storage.get(key),'system');
  a.api.remember('bad');
  assert.equal(storage.get(key),'system');
  assert.equal(open(new Map([[key,'bad']])).root.dataset.theme,'light');
  const b = open(storage,{blocked:true});
  assert.equal(b.root.dataset.theme,'light');
  assert.doesNotThrow(() => b.api.remember('dark'));
});

test('ロゴ表示から表示切替まで、読み込み画面も保存済みの外観色を保つ', () => {
  assert.match(html, /\.bootstrap-loading \{[^}]*background: var\(--surface\);/s);
  assert.match(html, /body\.bootstrapping \{\s*background: var\(--surface\);/);
});

test('iOSホーム画面版では設定を変えても上端の基準色を固定し、他の環境では画面に追従', () => {
  const {api,root,meta} = open(new Map([[key,'light']]),{iosHome:true});
  assert.equal(root.dataset.iosHome,'true');
  assert.equal(root.dataset.theme,'light');
  assert.equal(meta.color,'#0b1224');
  api.sync('dark');
  assert.equal(root.dataset.theme,'dark');
  assert.equal(meta.color,'#0b1224');
  assert.equal(meta.writes,1);
  assert.equal(open(new Map()).root.dataset.iosHome,undefined);
  assert.match(html, /data-ios-home='true'\] body::before\s*\{\s*background: var\(--ios-top\)/);
});
