import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(
  process.env.SHIFTFLOW_CHROME_SOURCE || new URL('../frontend/public/index.html', import.meta.url),
  'utf8'
);
const chromeScript = source.match(/\(function enableScrollLinkedChrome\(\) \{[\s\S]*?\}\)\(\);/)?.[0];
assert.ok(chromeScript, 'スクロール連動の制御が存在する');

// 描画時間ではなく、DOM寸法読み取りとstyle書き込みの順序を観測する。
function fixture() {
  const operations = [], windowEvents = {}, viewportEvents = {}, frames = [], observers = [];
  const record = (kind, element, property) => operations.push({ kind, element, property });
  function element(name, initialHeight, initialHidden = false) {
    const classes = new Set(), properties = new Map(), events = {};
    const node = {
      name, height: initialHeight, hidden: initialHidden, scrollTop: 0, events,
      style: {
        setProperty(key, value) { record('write', name, key); properties.set(key, value); },
        getPropertyValue(key) { return properties.get(key) || ''; },
      },
      classList: {
        contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key),
        toggle(key, force) { const on = force === undefined ? !classes.has(key) : force; on ? classes.add(key) : classes.delete(key); return on; },
      },
      addEventListener(type, callback) { (events[type] ||= []).push(callback); },
      querySelector() { return null; },
      getBoundingClientRect() { record('read', name, 'getBoundingClientRect'); return { height: node.hidden ? 0 : node.height }; },
    };
    Object.defineProperty(node, 'offsetHeight', { get() { record('read', name, 'offsetHeight'); return node.hidden ? 0 : node.height; } });
    return node;
  }
  const header = element('header', 72), footer = element('footer', 64);
  const adminFooter = element('admin-footer', 80, true), fab = element('fab', 48);
  const messageMode = element('message-mode', 32), root = element('root', 0), body = element('body', 0);
  const media = { matches: true, addEventListener() {}, addListener() {} };
  const document = {
    readyState: 'complete', documentElement: root, body, scrollingElement: root,
    querySelector(selector) { return selector === 'header.navbar' ? header : selector === '.fab' ? fab : messageMode; },
    querySelectorAll(selector) { return selector === 'nav.footer-nav' ? [footer, adminFooter] : []; },
    getElementById(id) { return id === 'message-mode' ? messageMode : null; },
    addEventListener() {},
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const window = {
    scrollY: 0, pageYOffset: 0, ResizeObserver, matchMedia() { return media; },
    getComputedStyle(node) { record('read', node.name, 'getComputedStyle'); return { display: node.hidden ? 'none' : 'block', height: (node.hidden ? 0 : node.height) + 'px' }; },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    addEventListener(type, callback) { (windowEvents[type] ||= []).push(callback); },
    visualViewport: { addEventListener(type, callback) { (viewportEvents[type] ||= []).push(callback); } },
  };
  const emit = (events, type, event = {}) => (events[type] || []).forEach(callback => callback(event));
  function flush() {
    let count = 0;
    while (frames.length) {
      assert.ok(++count <= 20, '描画を無限に予約しない');
      const batch = frames.splice(0);
      batch.forEach(callback => callback());
    }
    return count;
  }
  runInNewContext(chromeScript, { window, document, ResizeObserver, Set, Number, Math, Array });
  flush();
  return {
    operations, header, footer, adminFooter, fab, messageMode, root, observers,
    clear() { operations.length = 0; }, flush,
    scroll(y) { root.scrollTop = body.scrollTop = window.scrollY = window.pageYOffset = y; emit(windowEvents, 'scroll'); },
    resize() { emit(windowEvents, 'resize'); },
    viewportResize() { emit(viewportEvents, 'resize'); },
    notifyResize(...targets) {
      observers.forEach(observer => {
        const entries = targets.filter(target => observer.targets.has(target)).map(target => ({
          target, contentRect: { height: target.hidden ? 0 : target.height },
          borderBoxSize: [{ blockSize: target.hidden ? 0 : target.height }],
        }));
        if (entries.length) observer.callback(entries);
      });
    },
    event(target, type, detail = {}) { emit(target.events, type, detail); },
    offset(target, key) { return Number.parseFloat(target.style.getPropertyValue(key)); },
  };
}
function assertNoReadAfterWrite(operations) {
  const firstWrite = operations.findIndex(operation => operation.kind === 'write');
  if (firstWrite < 0) return;
  const lateReads = operations.slice(firstWrite + 1).filter(operation => operation.kind === 'read');
  assert.equal(lateReads.length, 0, 'style書き込み後に寸法・computed styleを読まない: ' + JSON.stringify(lateReads));
}
function assertOffsets(page, header, footer) {
  assert.equal(page.offset(page.header, '--header-hide-offset'), header);
  assert.equal(page.offset(page.footer, '--footer-hide-offset'), footer);
}

test('定常scrollでは寸法・computed styleを読まず、一つのrAFへ描画をまとめる', () => {
  const page = fixture(); page.clear();
  page.scroll(20); page.scroll(30); page.scroll(25);
  assert.equal(page.flush(), 1);
  assert.equal(page.operations.filter(operation => operation.kind === 'read').length, 0);
  assertNoReadAfterWrite(page.operations);
});

test('初回とresize後の測定もstyle書き込みより前にまとめる', () => {
  const page = fixture();
  assertNoReadAfterWrite(page.operations);
  page.clear(); page.header.height = 96; page.footer.height = 80;
  page.resize(); page.flush();
  assertNoReadAfterWrite(page.operations);
});

test('距離に比例して退避し、同じrAF内の下降後の戻りを失わない', () => {
  const page = fixture();
  page.scroll(20); page.flush(); assertOffsets(page, -20, 20);
  assert.equal(page.offset(page.header, '--header-hide-opacity'), 0.722);
  assert.equal(page.offset(page.footer, '--footer-hide-opacity'), 0.688);
  page.scroll(200); page.scroll(180); page.flush();
  // 退避限界72pxまで下降してから20px戻るので、最終退避は52px。
  assertOffsets(page, -52, 52);
});

test('画面上端1px以内へ戻ると完全表示し、hidden状態も解除する', () => {
  const page = fixture(); page.scroll(200); page.flush();
  assert.equal(page.header.classList.contains('navbar--hidden'), true);
  assert.equal(page.footer.classList.contains('footer-nav--hidden'), true);
  page.scroll(1); page.flush(); assertOffsets(page, 0, 0);
  assert.equal(page.header.classList.contains('navbar--hidden'), false);
  assert.equal(page.footer.classList.contains('footer-nav--hidden'), false);
});

test('native selectの操作中は表示を保ち、change後は新しい距離から退避する', () => {
  const page = fixture(); page.scroll(120); page.flush();
  const select = { matches: selector => selector === 'select.app-view-heading__folder-select' };
  page.event(page.header, 'pointerdown', { target: select });
  page.scroll(200); page.flush(); assertOffsets(page, 0, 0);
  page.event(page.header, 'change', { target: select });
  page.scroll(220); page.flush(); assertOffsets(page, -20, 20);
});

test('dropdownと検索を開いている間は退避せず、解除後に距離同期を再開する', () => {
  const page = fixture(); const dropdown = {};
  page.scroll(120); page.flush();
  page.event(page.header, 'show.bs.dropdown', { target: dropdown });
  page.scroll(200); page.flush(); assertOffsets(page, 0, 0);
  page.event(page.header, 'hidden.bs.dropdown', { target: dropdown });
  page.scroll(220); page.flush(); assertOffsets(page, -20, 20);
  page.header.classList.add('header--search-open');
  page.scroll(300); page.flush(); assertOffsets(page, 0, 0);
  page.header.classList.remove('header--search-open');
  page.scroll(310); page.flush(); assertOffsets(page, -10, 10);
});

test('window/visualViewport resize後の寸法を採用し、定常scrollの測定は増やさない', () => {
  const page = fixture(); page.header.height = 96; page.footer.height = 80;
  page.resize(); page.flush(); page.clear();
  page.scroll(200); page.flush(); assertOffsets(page, -96, 80);
  assert.equal(page.operations.filter(operation => operation.kind === 'read').length, 0);
  page.header.height = 112; page.viewportResize(); page.flush();
  page.scroll(1); page.flush(); page.clear();
  page.scroll(250); page.flush(); assertOffsets(page, -112, 80);
  assert.equal(page.operations.filter(operation => operation.kind === 'read').length, 0);
});

test('ResizeObserverで高さと表示footerの切替を更新する', () => {
  const page = fixture();
  assert.ok(page.observers.length > 0, 'ウィンドウresize以外の寸法変更も監視する');
  page.header.height = 100; page.notifyResize(page.header); page.flush();
  page.footer.hidden = true; page.adminFooter.hidden = false;
  page.notifyResize(page.footer, page.adminFooter); page.flush(); page.clear();
  page.scroll(200); page.flush();
  assert.equal(page.offset(page.header, '--header-hide-offset'), -100);
  assert.equal(page.offset(page.footer, '--footer-hide-offset'), 0);
  assert.equal(page.offset(page.adminFooter, '--footer-hide-offset'), 80);
  assert.equal(page.operations.filter(operation => operation.kind === 'read').length, 0);
});
