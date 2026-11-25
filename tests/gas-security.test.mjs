import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const gasDir = new URL('../backend/gas/', import.meta.url);
const source = await readFile(new URL('code.js', gasDir), 'utf8');
const manifest = JSON.parse(await readFile(new URL('appsscript.json', gasDir), 'utf8'));

test('GASは退役entrypoint以外の公開server関数を持たない', () => {
  const publicFunctions = Array.from(source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm))
    .map((match) => match[1])
    .filter((name) => !name.endsWith('_'));
  assert.deepEqual(publicFunctions.sort(), ['doGet', 'doOptions', 'doPost']);
});

test('GASのGET/POST/OPTIONSは同じ退役応答だけを返す', () => {
  assert.match(source, /code:\s*'gas_runtime_retired'/);
  assert.match(source, /httpStatus:\s*410/);
  assert.match(source, /function doGet\(\) \{\s*return createRetiredResponse_\('doGet'\);/s);
  assert.match(source, /function doPost\(\) \{\s*return createRetiredResponse_\('doPost'\);/s);
  assert.match(source, /function doOptions\(\) \{\s*return createRetiredResponse_\('doOptions'\);/s);
});

test('GAS退役stubはrequest body・header・queryを読み取らず記録しない', () => {
  assert.doesNotMatch(source, /postData|parameter|headers|Logger|console\./);
  assert.doesNotMatch(source, /email|token|cookie|authorization/i);
});

test('GAS配布物からHtmlServiceサインイン画面と旧writer依存を除去する', async () => {
  const files = await readdir(gasDir);
  assert.equal(files.includes('signin.html'), false);
  assert.doesNotMatch(source, /HtmlService|google\.script\.run|SpreadsheetApp|DriveApp|UrlFetchApp|PropertiesService/);
});

test('GAS manifestは退役stubに不要なOAuth scopeとadvanced serviceを要求しない', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'oauthScopes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'dependencies'), false);
});
