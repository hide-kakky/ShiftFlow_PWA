import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const dark = source.match(/\/\* ===== Dark theme overrides ===== \*\/\s*:root\[data-theme='dark'\] \{([\s\S]*?)\n      \}/)[1];
function color(name) { return dark.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))[1]; }
function luminance(hex) {
 const rgb = hex.slice(1).match(/../g).map(x => parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
 return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
function contrast(a,b) { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('ダークの本文・補助文・文字アクセントは基本背景で4.5:1以上',()=>{
 for(const ink of ['text-900','text-700','muted','primary-ink','primary-ink-hover'])
  for(const bg of ['surface','card','input-bg'])
   assert.ok(contrast(color(ink),color(bg))>=4.5,`${ink}/${bg}`);
});
test('歓迎ブロックを除去しても新規作成のFABを残す',()=>{
 assert.doesNotMatch(source, /<section class="home-hero"/);
 assert.match(source, /id="fab/);
 assert.match(source, /id="home-today-tasks"/);
 assert.match(source, /id="home-unread"/);
});
test('広幅のshell上限を解除しhomeの列が縮小可能',()=>{
 assert.doesNotMatch(source,/max-width: (1600|1760)px/);
 assert.match(source,/grid-template-columns: 220px minmax\(0, 1fr\)/);
 assert.match(source,/@media \(min-width: 1600px\)[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});
test('部品ライブラリの文字色もダークテーマへ追従',()=>{
 assert.match(source,/--bs-body-color: var\(--text-900\)/);
 assert.match(source,/:root\[data-theme='dark'\] \.form-text/);
});
test('ダークの下部ナビと主要ボタンは十分なコントラストを持つ',()=>{
 for(const [ink,bg,minimum] of [
   ['footer-dark-ink','footer-dark-bg',4.5], ['text-900','footer-dark-active',4.5],
   ['button-dark-ink','card',4.5], ['button-dark-ink','input-bg',4.5],
   ['button-dark-border','card',3], ['primary-ink','surface',4.5],
   ['text-900','button-dark-primary',4.5], ['text-900','button-dark-primary-hover',4.5],
 ]) assert.ok(contrast(color(ink),color(bg))>=minimum,`${ink}/${bg}`);
 assert.match(source, /\.footer-nav \.navbar-nav \.nav-link\s*\{\s*color: var\(--footer-dark-ink\)/);
});
test('iPhoneの上端は通常テーマに追従し、全画面の操作ボタンを覆わない',()=>{
 assert.match(source, /viewport-fit=cover/);
 assert.match(source, /:root\[data-theme='dark'\]\s*\{\s*background-color: var\(--surface\);\s*\}/);
 assert.match(source, /body::before\s*\{[^}]*height: var\(--safe-top\);\s*background: var\(--surface\);/s);
 assert.match(source, /\.modal-fullscreen-sm-down \.modal-header\s*\{\s*padding-top: calc\(18px \+ var\(--safe-top\)\);\s*background: var\(--surface\);/);
 assert.match(source, /!iosHome && root\.dataset\.splash === 'true'[\s\S]*\? '#557abb'[\s\S]*normalColor\(mode\)/);
 assert.match(source, /data-theme='dark'\]\[data-ios-home='true'\]:not\(\[data-splash='true'\]\) header\.navbar/);
 assert.doesNotMatch(source, /:root\[data-ios-home='true'\] header\.navbar/);
});
