import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(
  new URL('../frontend/public/index.html', import.meta.url),
  'utf8'
);

test('グローバルヘッダーはBootstrapモーダルの背面に留まる', () => {
  const headerBlocks = Array.from(
    indexSource.matchAll(/header\.navbar\s*\{([\s\S]*?)\}/g),
    (match) => match[1]
  );
  const headerZIndexes = headerBlocks
    .map((block) => block.match(/z-index:\s*(\d+)/)?.[1])
    .filter(Boolean)
    .map(Number);

  assert.deepEqual(headerZIndexes, [1040, 1040]);
  assert.ok(
    headerZIndexes.every((value) => value < 1050),
    'ヘッダーはBootstrap backdrop (1050) より低い'
  );

  const imageViewerZIndex = Number(
    indexSource.match(/\.image-viewer-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]
  );
  assert.equal(imageViewerZIndex, 1080, '添付画像ビューアはmodal (1055) より前面を維持する');
});

test('メッセージ詳細はモバイル全画面用の固有ヘッダーを持つ', () => {
  const modalMarkup = indexSource.match(
    /<!-- ----- Message detail modal ----- -->([\s\S]*?)<div class="modal" id="quickFolderModal"/
  )?.[1];

  assert.ok(modalMarkup, 'メッセージ詳細モーダルが存在する');
  assert.match(modalMarkup, /modal-dialog modal-fullscreen-sm-down/);
  assert.match(modalMarkup, /aria-labelledby="messageDetailModalTitle"/);
  assert.match(modalMarkup, /id="messageDetailModalTitle"/);
  assert.match(modalMarkup, /class="material-icons" aria-hidden="true">arrow_back/);
  assert.match(modalMarkup, /class="visually-hidden" data-i18n="btn_back">戻る/);
});
