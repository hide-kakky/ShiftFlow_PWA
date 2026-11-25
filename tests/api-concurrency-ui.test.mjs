import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');

function block(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `開始位置が見つかりません: ${start}`);
  assert.notEqual(endIndex, -1, `終了位置が見つかりません: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('通知UIが扱う429はエラーtoastを重ねず、認証・権限・サーバー障害は隠さない', async () => {
  const apiSource = block('async function apiRequest', 'async function stageAttachmentFile');
  for (const [status, handled, announced] of [[429,true,0],[429,false,1],[401,true,1],[403,true,1],[500,true,1]]) {
    const notices=[], overlays=[], requests=[];
    const sandbox={Headers,FormData,Blob,ArrayBuffer,URLSearchParams,ReadableStream,URL,
      window:{location:{origin:'https://example.invalid'}},isTestModeActive:()=>false,
      createRequestId:()=> 'fixture-id',awaitAuthIdentityGate:async()=>{},syncAuthSession:async()=>({authenticated:true}),
      clearAuthToken(){},showAuthOverlay(value){overlays.push(value);},invalidateReadRequests(){},
      extractRequestIdFromPayload:payload=>payload?.requestId,announceRequestId:id=>notices.push(id),
      fetch:async(_url,init)=>{requests.push(init);return new Response(JSON.stringify({ok:false,code:'push_test_rate_limited',requestId:'fixture-id',retryAfterSeconds:12}),{status,headers:{'Retry-After':'12'}});},
    };
    runInNewContext(apiSource,sandbox);
    await assert.rejects(sandbox.apiRequest('/api/testPushNotification',{method:'POST',dedupe:false,expectedErrorCodes:handled?['push_test_rate_limited']:[]}),
      error=>error.status===status && error.requestId==='fixture-id' && error.retryAfterSeconds===12);
    assert.equal(notices.length,announced,`HTTP ${status}`);
    assert.equal(overlays.length,status===401?1:0);
    assert.equal(requests.length,1);
    assert.equal('expectedErrorCodes' in requests[0],false);
  }
});

test('認証確認とread APIはsingle-flightを使い、mutationはread allowlistに入れない', () => {
  const authBlock = block('async function syncAuthSession', 'function handleTestApiRequest');
  const bridgeBlock = block('// === Helpers ===', 'var runProxy = new Proxy');
  const apiBlock = block('async function apiRequest', 'function normalizeReturnTo');
  assert.match(authBlock, /if \(opts\.force && !AUTH_FORCE_INFLIGHT\)/);
  assert.match(authBlock, /!AUTH_FORCE_INFLIGHT/);
  assert.match(authBlock, /LAST_AUTH_SESSION = null/);
  assert.match(authBlock, /AUTH_SESSION_COALESCER\.clear\('auth-force'\)/);
  assert.match(authBlock, /AUTH_SESSION_COALESCER\.run\('auth-session'/);
  assert.match(authBlock, /AUTH_FORCE_INFLIGHT = sessionPromise/);
  assert.doesNotMatch(authBlock, /auth-session:force/);
  assert.match(bridgeBlock, /remoteReadCoalescer\.run/);
  assert.match(bridgeBlock, /'getMessages'/);
  assert.doesNotMatch(bridgeBlock.match(/REMOTE_READ_ROUTES = new Set\(\[[\s\S]*?\]\)/)?.[0] || '', /addNewMessage/);
  assert.match(apiBlock, /DIRECT_API_READ_COALESCER\.run/);
  assert.match(apiBlock, /method === 'GET'/);
});

test('mutation・logoutは古いreadと認証結果を無効化し、401を画面へ通知する', () => {
  const authBlock = block('async function syncAuthSession', 'function handleTestApiRequest');
  const bridgeBlock = block('// === Helpers ===', 'var runProxy = new Proxy');
  const apiBlock = block('async function apiRequest', 'function normalizeReturnTo');
  const logoutBlock = block('function performLogout', 'function confirmLogoutAction');
  assert.match(authBlock, /requestEpoch !== AUTH_SESSION_EPOCH/);
  assert.match(bridgeBlock, /syncAuthSession\(\{ silent: false, force: true \}\)/);
  assert.match(bridgeBlock, /__SHIFT_FLOW_INVALIDATE_READ_REQUESTS__\('mutation'\)/);
  assert.match(apiBlock, /suppliedHeaders\.set\('X-ShiftFlow-Request-Id', requestId\)/);
  assert.match(apiBlock, /packet\.response\.status === 401/);
  assert.match(apiBlock, /method === 'GET' && refreshedSession && refreshedSession\.authenticated/);
  assert.match(apiBlock, /showAuthOverlay\(\{/);
  assert.match(apiBlock, /invalidateReadRequests\('mutation'\)/);
  assert.match(logoutBlock, /if \(LOGOUT_INFLIGHT\) return LOGOUT_INFLIGHT/);
  assert.match(logoutBlock, /setLogoutBusy\(true\)/);
  assert.match(logoutBlock, /AUTH_SESSION_EPOCH \+= 1/);
  assert.match(logoutBlock, /if \(!response\.ok\)/);
  assert.ok(
    logoutBlock.indexOf('return false;') <
      logoutBlock.indexOf("await purgePrivateClientState('logout')")
  );
  assert.match(logoutBlock, /AUTH_SESSION_COALESCER\.clear\('logout'\)/);
  assert.match(logoutBlock, /invalidateReadRequests\('logout'\)/);
  assert.match(logoutBlock, /await purgePrivateClientState\('logout'\)/);
  assert.match(logoutBlock, /LOGOUT_INFLIGHT = operation/);
});

test('画面復帰時は認証identityを強制同期してからだけ保留refreshを実行する', () => {
  const returnBlock = block(
    'function syncIdentityBeforeRefreshOnReturn',
    'window.__SHIFT_FLOW_TRIGGER_REFRESH__'
  );
  const authBlock = block('async function syncAuthSession', 'function handleTestApiRequest');
  const bridgeBlock = block('// === Helpers ===', 'var runProxy = new Proxy');
  const apiBlock = block('async function apiRequest', 'function normalizeReturnTo');
  const remotePacketBlock = block(
    'async function _requestPacket',
    'async function _coalescedReadPacket'
  );
  assert.match(returnBlock, /syncAuthSession\(\{ silent: true, force: true \}\)/);
  assert.ok(
    returnBlock.indexOf("syncAuthSession({ silent: true, force: true })") <
      returnBlock.indexOf('flushPendingApiRefreshes()')
  );
  assert.ok(
    returnBlock.indexOf("syncAuthSession({ silent: true, force: true })") <
      returnBlock.indexOf('refreshCollaborationViewOnReturn()')
  );
  assert.match(returnBlock, /visibilitychange[\s\S]*syncIdentityBeforeRefreshOnReturn\(\)/);
  assert.match(returnBlock, /addEventListener\('focus'[\s\S]*syncIdentityBeforeRefreshOnReturn\(\)/);
  assert.doesNotMatch(
    returnBlock.match(/visibilitychange[\s\S]*?\}\);/)?.[0] || '',
    /flushPendingApiRefreshes\(\)/
  );
  assert.match(authBlock, /enforceSessionIdentityBoundary\(previousIdentity, payload\)/);
  assert.match(bridgeBlock, /await awaitAuthIdentityGate\(\)/);
  assert.match(apiBlock, /await awaitAuthIdentityGate\(\)/);
  assert.ok(
    remotePacketBlock.indexOf('await _doFetch(false)') <
      remotePacketBlock.lastIndexOf('await awaitAuthIdentityGate()')
  );
  assert.ok((apiBlock.match(/await awaitAuthIdentityGate\(\)/g) || []).length >= 3);
});

test('identity変更時はshell・private stateを閉じてからreloadする', () => {
  const identityBlock = block('function resolveSessionIdentity', 'function invalidateReadRequests');
  const purgeBlock = block('function purgePrivateInMemoryState', 'function formatDateLabel');
  const bootstrapBlock = block('function applyBootstrapState', 'function hydrateBootstrap');
  assert.match(identityBlock, /setAppShellHidden\(true\)/);
  assert.match(identityBlock, /await purgePrivateClientState\(next \? 'identity-change' : 'session-ended'\)/);
  assert.ok(
    identityBlock.indexOf('setAppShellHidden(true)') <
      identityBlock.indexOf("await purgePrivateClientState(next ? 'identity-change' : 'session-ended')")
  );
  assert.ok(
    identityBlock.indexOf("await purgePrivateClientState(next ? 'identity-change' : 'session-ended')") <
      identityBlock.indexOf('window.location.reload()')
  );
  assert.match(purgeBlock, /PRIVATE_STORAGE_BLOCKED = true/);
  assert.match(purgeBlock, /CURRENT_USER_EMAIL = ''/);
  assert.match(purgeBlock, /CURRENT_USER_ROLE = ''/);
  assert.match(purgeBlock, /IS_ADMIN = false/);
  assert.match(source, /let CURRENT_USER_ROLE =/);
  assert.match(source, /let IS_ADMIN =/);
  assert.match(bootstrapBlock, /CURRENT_USER_ROLE = String\(userInfo\.role \|\| ''\)/);
  assert.match(bootstrapBlock, /IS_ADMIN = CURRENT_USER_ROLE\.toLowerCase\(\) === 'admin'/);
  assert.match(purgeBlock, /MessageDraftController\.clearPrivateDrafts\(\)/);
  assert.match(purgeBlock, /await clearPrivateDatasetCache\(\)/);
  assert.doesNotMatch(purgeBlock, /caches\.(?:keys|delete)/);
});

test('ログイン開始は60秒のpending guardで多重popupを防ぎGASへfallbackしない', () => {
  const pendingBlock = block('function setAuthStartBusy', 'function activateTestUserLogin');
  const startBlock = block('function startAuthFlow', 'function activateTestUserLogin');
  assert.match(startBlock, /if \(isAuthPending\(\)\)/);
  assert.ok(startBlock.indexOf('if (isAuthPending())') < startBlock.indexOf('window.open('));
  assert.match(startBlock, /markAuthPending\(\)/);
  assert.match(pendingBlock, /60 \* 1000/);
  assert.match(pendingBlock, /!Number\.isFinite\(timestamp\)/);
  assert.match(pendingBlock, /timestamp > Date\.now\(\)/);
  assert.match(pendingBlock, /setAuthStartBusy\(true\)/);
  assert.match(pendingBlock, /setAuthStartBusy\(false\)/);
  assert.doesNotMatch(source, /GAS_WEB_APP_URL|HAS_GAS_WEB_APP_URL|buildGasAuthUrl|fallbackTarget/);
});

test('下書きとIndexedDB業務キャッシュは利用者scope・TTL・明示削除を持つ', () => {
  const draftBlock = block('const MessageDraftController', 'const TemplateController');
  const cacheBlock = block("var CACHE_DB_NAME = 'shiftflow-cache'", 'function formatDateLabel');
  assert.match(draftBlock, /shiftflow:message-draft:v2:/);
  assert.match(draftBlock, /resolveDraftNamespace/);
  assert.match(draftBlock, /encodeURIComponent\(namespace\)/);
  assert.match(draftBlock, /DRAFT_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(draftBlock, /Date\.now\(\) - savedAt > DRAFT_MAX_AGE_MS/);
  assert.match(draftBlock, /LEGACY_STORAGE_PREFIX = 'shiftflow_draft_'/);
  assert.match(draftBlock, /clearLegacyDrafts\(\)/);
  assert.match(cacheBlock, /USER_CACHE_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(cacheBlock, /function deleteCacheEntry/);
  assert.match(cacheBlock, /function clearPrivateDatasetCache/);
  assert.match(cacheBlock, /store\.clear\(\)/);
  assert.match(cacheBlock, /Date\.now\(\) - updatedAt > USER_CACHE_MAX_AGE_MS/);
  assert.match(cacheBlock, /deleteCacheEntry\(key\)/);
});

test('添付とプロフィール画像はBase64化せず1件ずつ段階アップロードする', () => {
  const apiBlock = block('async function apiRequest', 'function normalizeReturnTo');
  const profileBlock = block('const ProfileImageController', 'const MessageAttachmentController');
  const attachmentBlock = block('const MessageAttachmentController', 'const TaskFormController');
  const messageBlock = block('const MessageFormController', '// ===== 設定 =====');
  const settingsBlock = block("on('btn-settings-save'", '// ===== 担当者選択（複数） =====');

  assert.match(apiBlock, /body instanceof Blob/);
  assert.match(apiBlock, /shouldSerializeJsonBody \? JSON\.stringify\(body\) : body/);
  assert.match(apiBlock, /\/stageAttachment/);
  assert.match(apiBlock, /invalidateReads: false/);
  assert.match(apiBlock, /options\.invalidateReads !== false/);
  assert.match(apiBlock, /X-ShiftFlow-Attachment-Purpose/);
  assert.match(apiBlock, /X-ShiftFlow-File-Name/);
  assert.match(apiBlock, /expiresAtMs > Date\.now\(\)/);
  assert.doesNotMatch(apiBlock, /expiresAtMs > Date\.now\(\) \+ 60 \* 1000/);
  assert.doesNotMatch(apiBlock, /readFileAsDataUrl/);

  assert.match(profileBlock, /URL\.createObjectURL\(file\)/);
  assert.match(profileBlock, /file: file/);
  assert.doesNotMatch(profileBlock, /readFileAsDataUrl|dataUri/);
  assert.match(attachmentBlock, /stageAll: async function/);
  assert.match(attachmentBlock, /const selection = pendingMessageAttachments\.slice\(\)/);
  assert.match(attachmentBlock, /for \(const attachment of selection\)/);
  assert.match(attachmentBlock, /attachment_selection_changed/);
  assert.match(attachmentBlock, /stageAttachmentFile\(attachment, 'message'\)/);
  assert.doesNotMatch(attachmentBlock, /readFileAsDataUrl|dataUri|Promise\.all/);
  assert.match(messageBlock, /MessageAttachmentController\.stageAll\(\)/);
  assert.match(messageBlock, /payload\.attachments = attachments/);
  assert.doesNotMatch(messageBlock, /pendingMessageAttachments\.slice\(\)/);
  assert.match(settingsBlock, /stageAttachmentFile\(profileImageForSave, 'profile'\)/);
  assert.match(settingsBlock, /profile_image_selection_changed/);
  assert.match(settingsBlock, /payload\.stagedAttachmentId/);
  assert.match(settingsBlock, /submittedStateIsCurrent/);
  assert.match(settingsBlock, /ProfileImageController\.applySaveResult\(current\)/);
  assert.match(settingsBlock, /設定は既に保存されています/);
  assert.doesNotMatch(settingsBlock, /imageData|dataUri/);
});

test('組織管理は共通bridgeと応答世代ガードを使う', () => {
  const bridgeBlock = block('// === Helpers ===', 'var runProxy = new Proxy');
  const orgBlock = block('const AdminOrgController', '// ===== ビューナビゲーション・フォーム初期化 =====');
  const callOrgBlock = block('function callOrgApi', 'function renderTimezoneOptions');
  assert.match(bridgeBlock, /'adminListOrganizations'/);
  assert.match(bridgeBlock, /'adminGetOrganization'/);
  assert.match(callOrgBlock, /google\.script\.run\.withSuccessHandler/);
  assert.doesNotMatch(callOrgBlock, /fetch\(/);
  assert.match(orgBlock, /requestToken !== state\.listRequestToken/);
  assert.match(orgBlock, /requestToken !== state\.detailRequestToken \|\| orgId !== state\.activeOrgId/);
});

test('既知の二重発火と空一覧再取得ループを除去している', () => {
  const shiftNavigation = block('function navigateToShiftFolder', "on('home-shift-view-all'");
  const messageForm = block('const MessageFormController', '// ===== 設定 =====');
  const commentPost = block("on('btnCommentPost'", "on('btnMsgToTask'");
  assert.doesNotMatch(shiftNavigation, /dispatchEvent/);
  assert.doesNotMatch(messageForm, /bindTemplateRefresh/);
  assert.doesNotMatch(source, /loaded && hasRows && shouldThrottleFetch/);
  assert.match(source, /staleRetryCount < 3/);
  assert.match(commentPost, /postBtn\.disabled/);
  assert.match(commentPost, /setButtonLoading\(postBtn, true\)/);
  assert.match(commentPost, /withFailureHandler/);
});

test('認証済みAPIをService Worker cacheへ入れない境界を維持する', async () => {
  const sw = await readFile(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/auth\/'\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /'\/request-coalescer\.js'/);
});

test('テスト用監査データも認証・業務・API障害の分類契約に従う', () => {
  const authFixture = block("id: 'AUD-2'", "id: 'AUD-3'");
  const businessFixture = block("id: 'AUD-3'", "id: 'AUD-4'");
  assert.match(authFixture, /type: 'auth'/);
  assert.match(authFixture, /route: '\/auth\/callback'/);
  assert.match(businessFixture, /type: 'admin'/);
  assert.match(businessFixture, /typeLabel: '業務操作'/);
  assert.doesNotMatch(businessFixture, /type: 'api'/);
});

test('テストmutationは共通helperで業務監査を1件だけ追加し、本文・メールを保存しない', () => {
  const specBlock = block('var TEST_BUSINESS_MUTATION_SPECS', 'function normalizeTestAuditIdentifier');
  const controllerBlock = block('function createTestModeController', 'function ensureTestModeController');
  const routeBlock = block('function executeTestRoute', 'function updateMessageReadState');
  const directApiBlock = block('function handleTestApiRequest', 'async function apiRequest');
  const directReadBlock = block('var readMatch = pathname.match', 'return null;');
  for (const route of [
    'addNewTask',
    'updateTask',
    'completeTask',
    'deleteTaskById',
    'toggleMemoRead',
    'markMemoAsRead',
    'markMemosReadBulk',
    'addNewMessage',
    'deleteMessageById',
    'addNewComment',
    'saveUserSettings',
    'adminUpdateUser',
    'adminUpdateOrganization',
  ]) {
    assert.match(specBlock, new RegExp(`${route}:`), `業務mutation定義がありません: ${route}`);
  }
  assert.match(controllerBlock, /appendTestBusinessAudit\(controller, auditDetails, result\)/);
  assert.doesNotMatch(routeBlock, /auditLogs\.unshift/);
  assert.match(directApiBlock, /completeTestApiMutation\(/);
  assert.doesNotMatch(directReadBlock, /completeTestApiMutation\(/);

  const helperStart = source.indexOf('function normalizeTestAuditIdentifier');
  const helperEnd = source.indexOf('function describeTestBusinessMutation', helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = source.slice(helperStart, helperEnd);
  const sandbox = {};
  runInNewContext(
    `${helperSource}\nthis.appendTestBusinessAudit = appendTestBusinessAudit;`,
    sandbox
  );
  const state = {
    data: {
      auditLogs: [],
      counters: { audit: 0 },
      userInfo: { name: 'テスト担当', email: 'secret@example.com' },
    },
  };
  const details = {
    route: 'addNewMessage',
    action: 'message.create',
    eventLabel: 'メッセージ作成',
    targetType: 'message',
    targetId: 'MSG-1',
    requestId: 'REQ-1',
  };
  sandbox.appendTestBusinessAudit(state, details, { success: true, body: '保存禁止本文' });
  sandbox.appendTestBusinessAudit(state, details, { success: true, body: '保存禁止本文' });
  sandbox.appendTestBusinessAudit(
    state,
    { ...details, requestId: 'REQ-FAILED' },
    { success: false }
  );

  assert.equal(state.data.auditLogs.length, 1);
  const row = state.data.auditLogs[0];
  assert.equal(row.type, 'admin');
  assert.equal(row.typeLabel, '業務操作');
  assert.deepEqual(Object.keys(row.meta).sort(), [
    'action',
    'requestId',
    'route',
    'targetId',
    'targetType',
  ]);
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /secret@example\.com|保存禁止本文|payload|body/);
});
