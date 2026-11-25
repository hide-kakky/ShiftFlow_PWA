import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(process.env.SHIFTFLOW_CHROME_SOURCE || new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const compactCss = await readFile(process.env.SHIFTFLOW_CHROME_CSS_SOURCE || new URL('../frontend/public/compact-ui.css', import.meta.url), 'utf8');
const chromeScript = source.match(/\(function enableScrollLinkedChrome\(\) \{[\s\S]*?\}\)\(\);/)?.[0];
assert.ok(chromeScript);

// 既存の合成DOMを再利用する。fixtureだけを読み、既存test自体は再実行しない。
const helperSource = await readFile(new URL('../tests/scroll-chrome.test.mjs', import.meta.url), 'utf8');
const start = helperSource.indexOf('function fixture() {');
const end = helperSource.indexOf('function assertNoReadAfterWrite', start);
assert.ok(start >= 0 && end > start);
const context = { assert, runInNewContext, chromeScript };
runInNewContext(helperSource.slice(start, end) + '\nglobalThis.createFixture = fixture;', context);
function fixture() {
  const page = context.createFixture();
  let toggles = 0;
  for (const element of [page.header, page.footer, page.adminFooter]) {
    const toggle = element.classList.toggle;
    element.classList.toggle = function (...args) { toggles++; return toggle.apply(this, args); };
  }
  page.toggleCount = () => toggles;
  page.clearToggles = () => { toggles = 0; };
  return page;
}

test('退避限界後の20フレームは同値styleを書かずhidden classも再操作しない', () => {
  const page = fixture(); page.scroll(200); page.flush(); page.clear(); page.clearToggles();
  for (let index = 1; index <= 20; index++) { page.scroll(200 + index); page.flush(); }
  assert.equal(page.operations.filter(operation => operation.kind === 'write').length, 0);
  assert.equal(page.toggleCount(), 0);
  assert.equal(page.operations.filter(operation => operation.kind === 'read').length, 0);
});

test('同値描画を省略してもlastYを更新し、1pxの方向反転から復帰する', () => {
  const page = fixture(); page.scroll(200); page.flush();
  for (let index = 1; index <= 20; index++) { page.scroll(200 + index); page.flush(); }
  page.clear(); page.scroll(219); page.flush();
  assert.equal(page.offset(page.header, '--header-hide-offset'), -71);
  assert.equal(page.header.classList.contains('navbar--hidden'), false);
  // footerは64pxで先に隠れているため、共通退避量が64pxを下回るまではその位置を保つ。
  assert.equal(page.offset(page.footer, '--footer-hide-offset'), 64);
  assert.ok(page.operations.some(operation => operation.kind === 'write'));
});

test('上端への即時移動は完了後のユーザースクロールを次フレームで巻き戻さない', () => {
  const reset = source.match(/function scrollToTopNow\(\) \{[\s\S]*?\n      \}/)?.[0];
  assert.ok(reset, '画面切替のスクロール初期化が存在する');
  const root = { scrollTop: 300 }, body = { scrollTop: 300 }, frames = [];
  const scrollTo = value => { root.scrollTop = body.scrollTop = typeof value === 'object' ? value.top : 0; };
  const window = { requestAnimationFrame(callback) { frames.push(callback); }, scrollTo };
  const sandbox = { document: { documentElement: root, body, scrollingElement: root }, window,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame() {} };
  runInNewContext(reset + '\nglobalThis.resetScroll = scrollToTopNow;', sandbox);
  sandbox.resetScroll();
  assert.equal(root.scrollTop, 0); assert.equal(body.scrollTop, 0);
  root.scrollTop = body.scrollTop = 27;
  frames.splice(0).forEach(callback => callback());
  assert.equal(root.scrollTop, 27); assert.equal(body.scrollTop, 27);
});

test('通常ナビは履歴を保存してから上端へ移動し、新画面のDOMへ切り替える',()=>{
  const start=source.indexOf('function navigateTo(v, opts)'),end=source.indexOf('function handleViewHistoryPop',start);
  const calls=[];
  const sandbox={order:['home','tasks','messages','settings'],CURRENT_VIEW:'home',LAST_VIEW_HISTORY:'home',
    document:{body:{dataset:{}},dispatchEvent(){}},CustomEvent:class {},
    ensureAdminViewHidden(){},pushViewHistoryState(){calls.push('history');},scrollToTopNow(){calls.push('top');},
    setActiveNav(){},updateViewHeader(){},showPanel(){calls.push('panel');},loadViewContent(){}};
  runInNewContext(source.slice(start,end)+'globalThis.nav=navigateTo;',sandbox);
  sandbox.nav('messages');assert.deepEqual(calls,['history','top','panel']);
  calls.length=0;sandbox.nav('home',{skipHistory:true,skipScroll:true});assert.deepEqual(calls,['panel']);
});

// 既知のローカルCSSから、最上位のルールを抽出する。media内だけの上書きは除外する。
function unconditionalRules(css) {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [], rules = [];
  let boundary = 0, quote = '', escaped = false;
  for (let index = 0; index < cleaned.length; index++) {
    const character = cleaned[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') { stack.push(cleaned.slice(boundary, index).trim()); boundary = index + 1; }
    else if (character === '}') {
      const declaration = cleaned.slice(boundary, index), selector = stack.pop();
      if (!stack.length && selector && !selector.startsWith('@')) rules.push({ selector, declaration });
      boundary = index + 1;
    }
  }
  return rules;
}

test('通常motion設定でもhtml/bodyのCSS smooth scrollを無条件に上書きする', () => {
  const inlineCss = Array.from(source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g), match => match[1]).join('\n');
  const selectors = unconditionalRules(inlineCss + '\n' + compactCss)
    .filter(rule => /(?:^|;)\s*scroll-behavior\s*:\s*auto\s*!important\s*(?:;|$)/i.test(rule.declaration))
    .flatMap(rule => rule.selector.split(',').map(selector => selector.trim()));
  assert.ok(selectors.includes('html') || selectors.includes(':root'), 'htmlのauto指定がmediaの外に存在する');
  assert.ok(selectors.includes('body'), 'bodyのauto指定がmediaの外に存在する');
});
