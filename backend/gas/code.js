/**
 * ShiftFlow v2 GAS retirement stub.
 *
 * 業務処理・認証・診断の正本はCloudflare Pages Functions + D1へ移行済み。
 * GAS Web Appは旧deploymentへ到達した利用者に退役を通知する以外の処理を行わない。
 * Apps ScriptのTextOutputはHTTP statusを変更できないため、bodyのhttpStatus=410を
 * 機械判定用に返す。実際の外部到達停止はdeployment失効をrelease gateとする。
 */

function createRetiredResponse_(entrypoint) {
  const payload = {
    ok: false,
    where: 'gas',
    code: 'gas_runtime_retired',
    reason: 'ShiftFlow v2 uses Cloudflare Pages Functions and D1.',
    httpStatus: 410,
    entrypoint: entrypoint,
    requestId: Utilities.getUuid(),
  };
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doGet() {
  return createRetiredResponse_('doGet');
}

function doPost() {
  return createRetiredResponse_('doPost');
}

function doOptions() {
  return createRetiredResponse_('doOptions');
}
