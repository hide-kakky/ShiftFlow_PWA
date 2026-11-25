import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIdempotencyPayloadManifest,
  computeCanonicalPayloadSha256,
} from '../functions/api/[[route]].js';

function createAttachmentPayload(dataUris) {
  return {
    route: 'addNewMessage',
    args: [
      {
        folderId: 'folder-a',
        title: '大容量添付テスト',
        body: '本文',
        attachments: dataUris.map((dataUri, index) => ({
          name: `proof-${index}.bin`,
          dataUri,
        })),
      },
    ],
  };
}

test('添付Data URIはcanonical JSONへ複製せずdigest manifestへ縮約する', async () => {
  const dataUri = `data:application/octet-stream;base64,${'A'.repeat(1024 * 1024)}`;
  const payload = createAttachmentPayload(Array.from({ length: 5 }, () => dataUri));
  const manifest = await buildIdempotencyPayloadManifest(payload);
  const serialized = JSON.stringify(manifest);

  assert.ok(serialized.length < 4_000, `manifest is unexpectedly large: ${serialized.length}`);
  assert.equal(serialized.includes('data:application/octet-stream'), false);
  assert.equal((serialized.match(/string-sha256/g) || []).length, 5);
  assert.equal((serialized.match(/[0-9a-f]{64}/g) || []).length, 5);
});

test('payload hashはobject key順に依存せず添付内容の1文字差を識別する', async () => {
  const commonData = 'data:text/plain;base64,QUJD';
  const first = createAttachmentPayload([commonData]);
  const reordered = {
    args: [
      {
        attachments: [{ dataUri: commonData, name: 'proof-0.bin' }],
        body: '本文',
        title: '大容量添付テスト',
        folderId: 'folder-a',
      },
    ],
    route: 'addNewMessage',
  };
  const changed = createAttachmentPayload(['data:text/plain;base64,QUJE']);

  const [firstHash, reorderedHash, changedHash] = await Promise.all([
    computeCanonicalPayloadSha256(first),
    computeCanonicalPayloadSha256(reordered),
    computeCanonicalPayloadSha256(changed),
  ]);
  assert.equal(firstHash, reorderedHash);
  assert.notEqual(firstHash, changedHash);
  assert.match(firstHash, /^[0-9a-f]{64}$/);
});

test('巨大な通常文字列もfield値を保持せずdigestへ縮約する', async () => {
  const payload = { args: [{ body: 'x'.repeat(128 * 1024) }] };
  const serialized = JSON.stringify(await buildIdempotencyPayloadManifest(payload));
  assert.ok(serialized.length < 1_000);
  assert.equal(serialized.includes('x'.repeat(1_000)), false);
  assert.match(serialized, /string-sha256/);
});

test('深すぎるpayloadはstack overflowではなく安定した400用codeで拒否する', async () => {
  let payload = 'leaf';
  for (let depth = 0; depth < 70; depth += 1) {
    payload = [payload];
  }

  await assert.rejects(
    () => buildIdempotencyPayloadManifest(payload),
    (error) => error?.code === 'request_structure_too_complex'
  );
});

test('項目数が過剰なpayloadをidempotency manifest生成前に拒否する', async () => {
  const payload = Array.from({ length: 10_001 }, (_, index) => index);

  await assert.rejects(
    () => buildIdempotencyPayloadManifest(payload),
    (error) => error?.code === 'request_structure_too_complex'
  );
});
