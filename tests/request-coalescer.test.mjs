import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createRequestCoalescer, stableSerialize } = require('../frontend/public/request-coalescer.js');

test('同じキーの同時readは1回だけ実行し、全呼び出しへ同じ結果を返す', async () => {
  const coalescer = createRequestCoalescer();
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const factory = async () => {
    executions += 1;
    await gate;
    return { ok: true };
  };

  const requests = Array.from({ length: 10 }, () => coalescer.run('GET:/api/templates?a=1', factory));
  assert.equal(executions, 0);
  await Promise.resolve();
  assert.equal(executions, 1);
  assert.equal(coalescer.size(), 1);
  release();
  const results = await Promise.all(requests);
  assert.equal(executions, 1);
  assert.ok(results.every((result) => result.ok === true));
  assert.equal(coalescer.size(), 0);
});

test('異なる引数は別実行し、失敗後は同じキーを再試行できる', async () => {
  const coalescer = createRequestCoalescer();
  let executions = 0;
  const failure = () => {
    executions += 1;
    throw new Error('temporary');
  };
  await assert.rejects(coalescer.run('read:a', failure), /temporary/);
  assert.equal(coalescer.size(), 0);
  const recovered = await coalescer.run('read:a', async () => {
    executions += 1;
    return 'ok';
  });
  const other = await coalescer.run('read:b', async () => {
    executions += 1;
    return 'other';
  });
  assert.equal(recovered, 'ok');
  assert.equal(other, 'other');
  assert.equal(executions, 3);
});

test('request keyはオブジェクトのキー順に依存しない', () => {
  assert.equal(
    stableSerialize([{ folderId: 'main', unreadOnly: true }]),
    stableSerialize([{ unreadOnly: true, folderId: 'main' }])
  );
});

test('連続clear後もreadは自分を無効化した世代の理由を保持する', async () => {
  const coalescer = createRequestCoalescer();
  let releaseBeforeLogout;
  let releaseBeforeMutation;
  const beforeLogoutGate = new Promise((resolve) => {
    releaseBeforeLogout = resolve;
  });
  const beforeMutationGate = new Promise((resolve) => {
    releaseBeforeMutation = resolve;
  });
  const staleBeforeLogout = coalescer.run('read:logout', async () => {
    await beforeLogoutGate;
    return 'stale';
  });
  await Promise.resolve();
  coalescer.clear('logout');
  const staleBeforeMutation = coalescer.run('read:mutation', async () => {
    await beforeMutationGate;
    return 'stale';
  });
  await Promise.resolve();
  coalescer.clear('mutation');
  releaseBeforeLogout();
  releaseBeforeMutation();
  await assert.rejects(
    staleBeforeLogout,
    (error) =>
      error?.code === 'REQUEST_COALESCER_CLEARED' && error?.reason === 'logout'
  );
  await assert.rejects(
    staleBeforeMutation,
    (error) =>
      error?.code === 'REQUEST_COALESCER_CLEARED' && error?.reason === 'mutation'
  );
  assert.equal(coalescer.size(), 0);
});
