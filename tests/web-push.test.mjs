import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { onRequest } from '../functions/api/[[route]].js';
import { createSession, destroySession } from '../functions/utils/session.js';
import { SqliteD1, FakeKv } from './helpers/d1-test-utils.mjs';
import { encode64, decode64, encryptPush, vapidAuthorization, validateSubscription, validatePushEndpoint, sha256 } from '../functions/utils/webPush.js';
import { drainNotifications, notificationPayload, renewNotificationSession } from '../functions/utils/notifications.js';
import { enqueueTaskReminders } from '../functions/utils/taskReminders.js';
import pushWorker from '../workers/push-dispatch/src/index.js';

const ORIGIN = 'https://shiftflow.pages.dev';
const migrationNames = (await readdir(new URL('../migrations/',import.meta.url))).filter(n => /^\d{3}_/.test(n) && !n.startsWith('999')).sort();
const migrations = await Promise.all(migrationNames.map(n => readFile(new URL('../migrations/'+n,import.meta.url),'utf8')));
async function keys() {
  const pair = await crypto.subtle.generateKey({ name:'ECDSA',namedCurve:'P-256' },true,['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk',pair.privateKey);
  return { VAPID_PUBLIC_KEY:encode64(await crypto.subtle.exportKey('raw',pair.publicKey)), VAPID_PRIVATE_KEY:jwk.d, VAPID_SUBJECT:'mailto:push@example.invalid' };
}
async function fixture(t) {
  const DB = new SqliteD1(); t.after(() => DB.close()); migrations.forEach(sql => DB.exec(sql));
  const now = Date.now();
  DB.exec(`INSERT INTO organizations(org_id,name,created_at_ms) VALUES('org-a','A',${now}),('org-b','B',${now});
    INSERT INTO users(user_id,email,auth_subject,status,is_active,created_at_ms,updated_at_ms) VALUES
      ('a','a@example.invalid','subject-a','active',1,${now},${now}),('b','b@example.invalid','subject-b','active',1,${now},${now}),
      ('other','other@example.invalid','subject-other','active',1,${now},${now});
    INSERT INTO memberships(membership_id,org_id,user_id,role,status,created_at_ms) VALUES
      ('ma','org-a','a','member','active',${now}),('mb','org-a','b','member','active',${now}),('mo','org-b','other','member','active',${now});
    INSERT INTO folders(id,org_id,name,is_active,is_public,created_at_ms,updated_at_ms) VALUES
      ('folder-a','org-a','共有A',1,1,${now},${now}),('folder-b','org-a','共有B',1,1,${now},${now}),
      ('private','org-a','限定',1,0,${now},${now}),('inactive','org-a','停止',0,1,${now},${now}),('other-folder','org-b','別組織',1,1,${now},${now});`);
  const env = { DB,APP_KV:new FakeKv(),CF_ORIGIN:ORIGIN,GOOGLE_OAUTH_CLIENT_ID:'test.apps.googleusercontent.com',WEB_PUSH_ENABLED:'true',...await keys() };
  const actors = {};
  for (const id of ['a','b','other']) {
    const session = await createSession(env,{user:{sub:'subject-'+id,email:id+'@example.invalid',name:id,emailVerified:true}});
    actors[id] = {...session,cookie:`SESSION=${session.sessionId}.${session.sessionKey}`};
  }
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url,init) => { sent.push({url,init}); return new Response(null,{status:201}); };
  t.after(() => { globalThis.fetch = originalFetch; });
  return {DB,env,actors,sent};
}
async function api(f,actor,route,body,requestId) {
  const background = [];
  const response = await onRequest({ request:new Request(ORIGIN+'/api/'+route,{method:body === undefined?'GET':'POST',
    headers:{origin:ORIGIN,cookie:f.actors[actor].cookie,'Content-Type':'application/json','X-ShiftFlow-Request-Id':requestId || crypto.randomUUID()},
    body:body === undefined?undefined:JSON.stringify(body)}),params:{route:route.split('?')[0].split('/')},env:f.env,
    waitUntil(promise) { background.push(promise); } });
  const json = await response.json();
  const results = await Promise.allSettled(background);
  for (const result of results) if (result.status==='rejected') throw result.reason;
  return {status:response.status,headers:response.headers,json,data:json.result || json};
}
async function subscription(token='device') {
  const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  return {endpoint:'https://web.push.apple.com/'+token,keys:{p256dh:encode64(await crypto.subtle.exportKey('raw',pair.publicKey)),auth:encode64(crypto.getRandomValues(new Uint8Array(16)))}};
}
async function register(f,actor='b',token='device') {
  const value = await subscription(token);
  const result = await api(f,actor,'registerPushSubscription',{subscription:value});
  assert.equal(result.status,200,JSON.stringify(result.json));
  return result.data.subscriptionId;
}
async function save(f,actor,change) {
  const current = await api(f,actor,'getNotificationSettings');
  const body = {version:current.data.version,folders:current.data.folders,unfiledTasks:current.data.unfiledTasks};
  change(body);
  return api(f,actor,'saveNotificationSettings',body);
}
async function message(f,folder='folder-a',requestId) {
  const result = await api(f,'a','addNewMessage',{args:[{title:'内部件名',body:'非公開の本文',folderId:folder}]},requestId);
  assert.equal(result.status,200,JSON.stringify(result.json));
  return result.json.memoId;
}

test('アイコン件数APIは閲覧可能な本人分だけを返し、通知OFF/購読なしでも取得できる',async t=>{
  const f=await fixture(t);await message(f);
  const result=await api(f,'b','getAppBadge?orgId=org-b&userId=other');
  assert.equal(result.status,200,JSON.stringify(result.json));
  assert.equal(result.data.owner,await sha256('org-a:b'));
  assert.equal(result.data.messageUnread,1);assert.equal(result.data.taskOverdue,0);assert.equal(result.data.total,1);
  assert.ok(result.data.computedAt>0);assert.ok(result.data.sessionExpiresAt>Date.now());
  assert.match(result.headers.get('Cache-Control'),/no-store/);
  assert.equal((await api(f,'b','getAppBadge',{})).status,405);
  f.DB.exec("UPDATE memberships SET role='guest' WHERE membership_id='mb'");
  assert.equal((await api(f,'b','getAppBadge')).status,403);
});

test('期限超過リマインダーは初期OFF、設定時刻を保ち、旧画面の保存ではONを消さない',async t=>{
  const f=await fixture(t);const current=await api(f,'b','getNotificationSettings');
  assert.equal(current.data.taskPreferences.task_overdue_reminder,false);
  const saved=await api(f,'b','saveNotificationSettings',{version:current.data.version,folders:current.data.folders,
    taskPreferences:{...current.data.taskPreferences,task_overdue_reminder:true}});
  assert.equal(saved.status,200,JSON.stringify(saved.json));
  const row=f.DB.get("SELECT * FROM push_preferences WHERE user_id='b'");
  assert.equal(row.task_overdue_reminder,1);assert.ok(row.task_reminder_enabled_at_ms>0);
  await save(f,'b',body=>{body.unfiledTasks.task_updated=false;});
  const after=f.DB.get("SELECT * FROM push_preferences WHERE user_id='b'");
  assert.equal(after.task_overdue_reminder,1);assert.equal(after.task_reminder_enabled_at_ms,row.task_reminder_enabled_at_ms);
});

test('RFC 8291 Appendix Aの既知ベクトルと暗号文が一致する',async () => {
  // 公開された標準のテスト専用値。実際の購読・鍵ではない。
  const pub = decode64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const privateKey = await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:encode64(pub.slice(1,33)),y:encode64(pub.slice(33)),d:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},true,[]);
  const body = await encryptPush({p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'},
    'When I grow up, I want to be a watermelon',{keyPair:{publicKey,privateKey},salt:decode64('DGv6ra1nlYgDCS1FRnbzlw')});
  assert.equal(encode64(body),'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
test('VAPID署名を公開鍵で検証でき、audienceと期限が正しい',async () => {
  const env = await keys(); const now=Date.now();
  const header=await vapidAuthorization('https://web.push.apple.com/test',env,now);
  const token=header.match(/t=([^,]+)/)[1]; const parts=token.split('.');
  const claims=JSON.parse(new TextDecoder().decode(decode64(parts[1])));
  assert.equal(claims.aud,'https://web.push.apple.com'); assert.ok(claims.exp*1000>now && claims.exp*1000<now+86400000);
  const key=await crypto.subtle.importKey('raw',decode64(env.VAPID_PUBLIC_KEY),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])),true);
});
test('購読の外部送信先・鍵を検証し任意URLや不正点を拒否する',async () => {
  for (const url of ['http://web.push.apple.com/id','https://web.push.apple.com.evil.invalid/id','https://127.0.0.1/id','https://web.push.apple.com:8443/id','https://user@web.push.apple.com/id']) assert.throws(() => validatePushEndpoint(url));
  const valid=await subscription(); assert.ok((await validateSubscription(valid)).id);
  await assert.rejects(validateSubscription({...valid,keys:{...valid.keys,p256dh:encode64(new Uint8Array(65))}}));
});
test('フォルダ別の設定を保存し、他組織・非公開未参加・停止フォルダを拒否する',async t => {
  const f=await fixture(t); const current=await api(f,'b','getNotificationSettings');
  assert.deepEqual(current.data.folders.map(row=>row.id).sort(),['folder-a','folder-b']);
  for (const id of ['private','inactive','other-folder']) {
    const result=await api(f,'b','saveNotificationSettings',{version:'0',folders:[{id,message_created:true,comment_created:true,task_assigned:true,task_updated:true}],unfiledTasks:{task_assigned:true,task_updated:true}});
    assert.equal(result.status,403,JSON.stringify(result.json));
  }
  const saved=await save(f,'b',body=>{body.folders[0].message_created=false;}); assert.equal(saved.status,200,JSON.stringify(saved.json));
  const next=await api(f,'b','getNotificationSettings'); assert.equal(next.data.folders[0].message_created,false);
  const conflict=await api(f,'b','saveNotificationSettings',{version:'0',folders:next.data.folders,unfiledTasks:next.data.unfiledTasks}); assert.equal(conflict.status,409);
  const invalid=await save(f,'b',body=>{body.folders[0].message_created='false';}); assert.equal(invalid.status,400);
  f.DB.exec("UPDATE memberships SET role='guest' WHERE user_id='b'");
  assert.equal((await api(f,'b','getNotificationSettings')).status,403);
});
test('新しい全体タスク設定とメッセージ専用folder payloadを保存し旧aliasも同じ値で返す',async t => {
  const f=await fixture(t); const current=await api(f,'b','getNotificationSettings');
  assert.deepEqual(current.data.taskPreferences,{task_assigned:true,task_updated:true,task_overdue_reminder:false});
  const saved=await api(f,'b','saveNotificationSettings',{version:current.data.version,
    taskPreferences:{task_assigned:false,task_updated:true},unfiledTasks:{task_assigned:true,task_updated:false},
    folders:[{id:'folder-a',message_created:false,comment_created:true}]});
  assert.equal(saved.status,200,JSON.stringify(saved.json));
  const next=await api(f,'b','getNotificationSettings');
  assert.deepEqual(next.data.taskPreferences,{task_assigned:false,task_updated:true,task_overdue_reminder:false});
  assert.deepEqual(next.data.unfiledTasks,{task_assigned:false,task_updated:true});
  for (const folder of next.data.folders) {
    assert.equal(folder.task_assigned,false); assert.equal(folder.task_updated,true);
  }
  assert.equal(next.data.folders.find(row=>row.id==='folder-a').message_created,false);
  const conflict=await api(f,'b','saveNotificationSettings',{version:current.data.version,
    taskPreferences:{task_assigned:true,task_updated:false},folders:[{id:'folder-a',message_created:true,comment_created:false}]});
  assert.equal(conflict.status,409);
  const unchanged=await api(f,'b','getNotificationSettings');
  assert.equal(unchanged.data.version,next.data.version);
  assert.deepEqual(unchanged.data.taskPreferences,next.data.taskPreferences);
  assert.deepEqual(unchanged.data.folders,next.data.folders);
  assert.deepEqual((await api(f,'other','getNotificationSettings')).data.taskPreferences,{task_assigned:true,task_updated:true,task_overdue_reminder:false});
});
test('旧folder task OFFは無視し、メッセージOFFと全体タスクONを独立して配信する',async t => {
  const f=await fixture(t); await register(f);
  const saved=await save(f,'b',body=>{
    const folder=body.folders.find(row=>row.id==='folder-a');
    folder.message_created=false; folder.task_assigned=false; folder.task_updated=false;
  });
  assert.equal(saved.status,200,JSON.stringify(saved.json));
  await message(f,'folder-a'); assert.equal(f.sent.length,0);
  const created=await api(f,'a','addNewTask',{args:[{title:'全体設定を使う依頼',folderId:'folder-a',assignees:['b@example.invalid']}]});
  assert.equal(created.status,200,JSON.stringify(created.json)); assert.equal(f.sent.length,1);
  const updated=await api(f,'a','updateTask',{args:[{id:created.json.taskId,title:'全体設定を使う更新'}]});
  assert.equal(updated.status,200,JSON.stringify(updated.json)); assert.equal(f.sent.length,2);
  const settings=await api(f,'b','getNotificationSettings');
  assert.deepEqual(settings.data.taskPreferences,{task_assigned:true,task_updated:true,task_overdue_reminder:false});
  assert.equal(settings.data.folders.find(row=>row.id==='folder-a').task_assigned,true);
  assert.equal(settings.data.folders.find(row=>row.id==='folder-a').task_updated,true);
});
test('全体task設定の不正値は旧aliasへfallbackせず拒否して既存値を保持する',async t => {
  const f=await fixture(t);
  const saved=await api(f,'b','saveNotificationSettings',{version:'0',taskPreferences:{task_assigned:false,task_updated:true},folders:[]});
  assert.equal(saved.status,200,JSON.stringify(saved.json));
  const invalid=await api(f,'b','saveNotificationSettings',{version:saved.data.version,
    taskPreferences:{task_assigned:'true',task_updated:false},unfiledTasks:{task_assigned:true,task_updated:true},folders:[]});
  assert.equal(invalid.status,400);
  const current=await api(f,'b','getNotificationSettings');
  assert.equal(current.data.version,saved.data.version);
  assert.deepEqual(current.data.taskPreferences,{task_assigned:false,task_updated:true,task_overdue_reminder:false});
});
test('購読の所有者を固定し他ユーザーからの登録・解除を拒否する',async t => {
  const f=await fixture(t); const value=await subscription();
  const first=await api(f,'b','registerPushSubscription',{subscription:value}); assert.equal(first.status,200);
  assert.equal((await api(f,'a','registerPushSubscription',{subscription:value})).status,409);
  assert.equal((await api(f,'a','removePushSubscription',{subscriptionId:first.data.subscriptionId})).status,404);
  const current=await api(f,'b','getNotificationSettings?subscriptionId='+first.data.subscriptionId); assert.equal(current.data.deviceRegistered,true);
  assert.equal(JSON.stringify(current.json).includes(value.endpoint),false); assert.equal(JSON.stringify(current.json).includes(value.keys.auth),false);
  assert.equal((await api(f,'b','removePushSubscription',{subscriptionId:first.data.subscriptionId})).status,200);
});
test('フォルダAをOFF・BをONにするとBだけ配信し、自己通知と再送重複を除外する',async t => {
  const f=await fixture(t); await register(f); await register(f,'a','author-device');
  assert.equal((await save(f,'b',body=>{body.folders.find(row=>row.id==='folder-a').message_created=false;})).status,200);
  await message(f,'folder-a'); assert.equal(f.sent.length,0);
  const id=await message(f,'folder-b','same-message-request'); assert.equal(f.sent.length,1);
  await message(f,'folder-b','same-message-request'); assert.equal(f.sent.length,1);
  assert.equal(f.DB.get("SELECT COUNT(*) AS count FROM push_events WHERE resource_id=?1",id).count,1);
  const event=f.DB.get('SELECT * FROM push_events WHERE resource_id=?1',id); const payload=notificationPayload(event);
  assert.equal(JSON.stringify(payload).includes('内部件名'),false); assert.equal(JSON.stringify(payload).includes('非公開の本文'),false);
  assert.ok(payload.url.includes('message='+id));
});
test('コメントのフォルダ別OFFとタスクの依頼・更新・完了hookを検証する',async t => {
  const f=await fixture(t); await register(f);
  await save(f,'b',body=>{body.folders.find(row=>row.id==='folder-a').comment_created=false;});
  const id=await message(f); const before=f.sent.length;
  assert.equal((await api(f,'a','addNewComment',{args:[{memoId:id,body:'コメント'}]})).status,200); assert.equal(f.sent.length,before);
  const task=await api(f,'a','addNewTask',{args:[{title:'担当タスク',folderId:'folder-b',assignees:['b@example.invalid']}]}); assert.equal(task.status,200,JSON.stringify(task.json));
  assert.equal(f.sent.length,before+1);
  const updated=await api(f,'a','updateTask',{args:[{id:task.json.taskId,title:'更新後'}]}); assert.equal(updated.status,200,JSON.stringify(updated.json));
  assert.equal(f.sent.length,before+2);
  const completed=await api(f,'a','completeTask',{args:[task.json.taskId]}); assert.equal(completed.status,200,JSON.stringify(completed.json));
  assert.equal(f.sent.length,before+3);
});
test('送信待ち中のフォルダ権限・ユーザー無効化・logoutを再確認する',async t => {
  const f=await fixture(t); const id=await register(f);
  f.DB.exec("INSERT INTO messages(message_id,org_id,folder_id,title,created_at_ms,updated_at_ms) VALUES('queued-message','org-a','folder-a','見せない',1,1)");
  async function queue(event) {
    const now=Date.now(); f.DB.prepare("INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,folder_id,created_at_ms,expires_at_ms,expanded) VALUES(?1,'org-a','a','message_created','queued-message','folder-a',?2,?3,1)").bind(event,now+1,now+86400000).run();
    await f.DB.prepare('INSERT INTO push_deliveries(event_id,subscription_id,next_attempt_at_ms) VALUES(?1,?2,0)').bind(event,id).run();
  }
  await queue('private-now'); f.DB.exec("UPDATE folders SET is_public=0 WHERE id='folder-a'"); await drainNotifications(f.env); assert.equal(f.sent.length,0);
  f.DB.exec("UPDATE folders SET is_public=1 WHERE id='folder-a'; UPDATE users SET is_active=0 WHERE user_id='b'"); await queue('inactive-now'); await drainNotifications(f.env); assert.equal(f.sent.length,0);
  f.DB.exec("UPDATE users SET is_active=1 WHERE user_id='b'"); await queue('logged-out'); await destroySession(f.env,f.actors.b.sessionId); await drainNotifications(f.env); assert.equal(f.sent.length,0);
  assert.equal(f.DB.get("SELECT status FROM push_deliveries WHERE event_id='logged-out'").status,'skipped');
});
test('アカウントのタスク通知OFFはフォルダ付きとフォルダなしの両方へ適用する',async t => {
  const f=await fixture(t); await register(f);
  await save(f,'b',body=>{body.unfiledTasks={task_assigned:false,task_updated:false};body.folders=[];});
  const created=await api(f,'a','addNewTask',{args:[{title:'フォルダ付き',folderId:'folder-a',assignees:['b@example.invalid']}]});
  assert.equal(created.status,200,JSON.stringify(created.json)); assert.equal(f.sent.length,0);
  const unfiled=await api(f,'a','addNewTask',{args:[{title:'フォルダなし',assignees:['b@example.invalid']}]});
  assert.equal(unfiled.status,200,JSON.stringify(unfiled.json)); assert.equal(f.sent.length,0);
});
test('更新通知OFFでも、後から担当者に追加された新しい依頼は1回通知する',async t => {
  const f=await fixture(t); await register(f);
  await save(f,'b',body=>{body.unfiledTasks.task_updated=false;});
  const created=await api(f,'a','addNewTask',{args:[{title:'担当変更',folderId:'folder-a',assignees:['a@example.invalid']}]});
  assert.equal(created.status,200,JSON.stringify(created.json)); assert.equal(f.sent.length,0);
  const assigned=await api(f,'a','updateTask',{args:[{id:created.json.taskId,assignees:['a@example.invalid','b@example.invalid']}]});
  assert.equal(assigned.status,200,JSON.stringify(assigned.json)); assert.equal(f.sent.length,1);
  const changed=await api(f,'a','updateTask',{args:[{id:created.json.taskId,title:'本文だけ変更'}]});
  assert.equal(changed.status,200,JSON.stringify(changed.json)); assert.equal(f.sent.length,1);
});
test('認証済みの継続利用で購読期限を延長し、失効セッションは延長しない',async t => {
  const f=await fixture(t); const id=await register(f); const now=Date.now();
  const fingerprint=await sha256(f.actors.b.sessionId);
  f.DB.prepare('UPDATE push_subscriptions SET session_expires_at_ms=?2 WHERE subscription_id=?1').bind(id,now+86400000).run();
  await renewNotificationSession(f.DB,{orgId:'org-a',userId:'b'},{fingerprint,expiresAt:now+30*86400000},now);
  assert.equal(f.DB.get('SELECT session_expires_at_ms FROM push_subscriptions').session_expires_at_ms,now+30*86400000);
  await destroySession(f.env,f.actors.b.sessionId);
  await renewNotificationSession(f.DB,{orgId:'org-a',userId:'b'},{fingerprint,expiresAt:now+60*86400000},now);
  assert.equal(f.DB.get('SELECT session_expires_at_ms FROM push_subscriptions').session_expires_at_ms,now+30*86400000);
});
test('送信直前にフォルダ設定OFF・購読解除・所属停止を反映する',async t => {
  const f=await fixture(t); const id=await register(f); const now=Date.now();
  f.DB.exec(`INSERT INTO messages(message_id,org_id,folder_id,title,created_at_ms,updated_at_ms) VALUES('pending','org-a','folder-a','本文は送らない',1,1)`);
  async function queue(event) {
    await f.DB.prepare("INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,folder_id,created_at_ms,expires_at_ms,expanded) VALUES(?1,'org-a','a','message_created','pending','folder-a',?2,?3,1)").bind(event,now+100,now+86400000).run();
    await f.DB.prepare('INSERT INTO push_deliveries(event_id,subscription_id,next_attempt_at_ms) VALUES(?1,?2,0)').bind(event,id).run();
  }
  await queue('turn-off'); await save(f,'b',body=>{body.folders.find(row=>row.id==='folder-a').message_created=false;}); await drainNotifications(f.env); assert.equal(f.sent.length,0);
  await save(f,'b',body=>{body.folders.find(row=>row.id==='folder-a').message_created=true;});
  await queue('leave-org'); f.DB.exec("UPDATE memberships SET status='inactive' WHERE user_id='b'"); await drainNotifications(f.env); assert.equal(f.sent.length,0);
  f.DB.exec("UPDATE memberships SET status='active' WHERE user_id='b'");
  await queue('unsubscribe'); await api(f,'b','removePushSubscription',{subscriptionId:id}); await drainNotifications(f.env); assert.equal(f.sent.length,0);
});
test('provider一時障害を再試行し、送信先へのリダイレクトを禁止する',async t => {
  const f=await fixture(t); const id=await register(f); const now=Date.now();
  f.DB.exec(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms) VALUES('retry','org-a','b','test','','${id}',${now},${now+86400000})`);
  let calls=0; const fetchImpl=async(_url,init)=>{assert.equal(init.redirect,'manual');calls++;return new Response(null,{status:calls===1?503:201});};
  await drainNotifications(f.env,{fetchImpl,now}); assert.equal(calls,1); assert.equal(f.DB.get("SELECT status FROM push_deliveries WHERE event_id='retry'").status,'pending');
  await drainNotifications(f.env,{fetchImpl,now:now+60001}); assert.equal(calls,2); assert.equal(f.DB.get("SELECT status FROM push_deliveries WHERE event_id='retry'").status,'sent');
  f.DB.exec(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms) VALUES('redirect','org-a','b','test','','${id}',${now},${now+86400000})`);
  let redirectCalls=0;
  await drainNotifications(f.env,{now:now+60002,fetchImpl:async(_url,init)=>{assert.equal(init.redirect,'manual');redirectCalls++;return new Response(null,{status:307,headers:{Location:'https://example.invalid/must-not-follow'}});}});
  assert.equal(redirectCalls,1);
  assert.equal(f.DB.get("SELECT status FROM push_deliveries WHERE event_id='redirect'").status,'failed');
});
test('通知outboxの保存失敗は業務保存と監査も同時にrollbackする',async t => {
  const f=await fixture(t);
  f.DB.exec("CREATE TRIGGER fixture_push_failure BEFORE INSERT ON push_events BEGIN SELECT RAISE(ABORT,'fixture_push_failed'); END");
  const result=await api(f,'a','addNewMessage',{args:[{title:'rollback対象',body:'本文',folderId:'folder-a'}]});
  assert.ok(result.status>=500);
  assert.equal(f.DB.get("SELECT COUNT(*) AS count FROM messages WHERE title='rollback対象'").count,0);
  assert.equal(f.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='message.create'").count,0);
  assert.equal(f.DB.get('SELECT COUNT(*) AS count FROM push_events').count,0);
});
test('通知サービス未設定では準備中を返し、テスト通知の回数を制限する',async t => {
  const f=await fixture(t); f.env.WEB_PUSH_ENABLED='false';
  const disabled=await api(f,'b','getNotificationSettings'); assert.equal(disabled.status,200); assert.equal(disabled.data.serverReady,false);
  f.env.WEB_PUSH_ENABLED='true'; const id=await register(f);
  const first=await api(f,'b','testPushNotification',{subscriptionId:id}); assert.equal(first.status,200);
  const again=await api(f,'b','testPushNotification',{subscriptionId:id}); assert.equal(again.status,429); assert.equal(f.sent.length,1);
  assert.equal(first.data.retryAfterSeconds,60);
  assert.ok(again.data.retryAfterSeconds>0 && again.data.retryAfterSeconds<=60);
  assert.equal(again.headers.get('Retry-After'),String(again.data.retryAfterSeconds));
  const settings=await api(f,'b','getNotificationSettings');
  assert.ok(settings.data.testRetryAfterSeconds>0 && settings.data.testRetryAfterSeconds<=60);
  f.DB.exec("UPDATE push_events SET created_at_ms=created_at_ms-61000 WHERE kind='test'");
  assert.equal((await api(f,'b','getNotificationSettings')).data.testRetryAfterSeconds,0);
  assert.equal((await api(f,'b','testPushNotification',{subscriptionId:id})).status,200);
});
test('同時drainはleaseで1回だけ配信し、410で失効購読を除去する',async t => {
  const f=await fixture(t); const id=await register(f); const now=Date.now();
  f.DB.exec(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms)
    VALUES('concurrent','org-a','b','test','','${id}',${now},${now+86400000})`);
  await Promise.all([drainNotifications(f.env),drainNotifications(f.env)]); assert.equal(f.sent.length,1);
  globalThis.fetch=async ()=>new Response(null,{status:410});
  f.DB.exec(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms)
    VALUES('expired','org-a','b','test','','${id}',${now},${now+86400000})`);
  await drainNotifications(f.env); assert.equal(f.DB.get('SELECT COUNT(*) AS count FROM push_subscriptions').count,0);
});

const REMINDER_NOW = Date.parse('2026-11-13T01:00:00Z');
const REMINDER_TODAY = Date.parse('2026-11-12T15:00:00Z');
async function receiver(f, actor = 'b') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const result = await api(f, actor, 'registerPushSubscription', { subscription: {
    endpoint: 'https://web.push.apple.com/receiver-' + actor, keys: { p256dh: encode64(pub), auth: encode64(auth) },
  } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  f.DB.prepare('UPDATE push_subscriptions SET created_at_ms=?1,session_expires_at_ms=?2 WHERE subscription_id=?3')
    .bind(REMINDER_NOW - 1, REMINDER_NOW + 3 * 86400000, result.data.subscriptionId).run();
  async function decode(sent) {
    const bytes = new Uint8Array(sent.init.body);
    const sender = bytes.slice(21, 21 + bytes[20]);
    const publicKey = await crypto.subtle.importKey('raw', sender, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, pair.privateKey, 256);
    async function derive(input, salt, info, bits) {
      const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
      return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, material, bits);
    }
    const prefix = new TextEncoder().encode('WebPush: info\0');
    const context = new Uint8Array(prefix.length + pub.length + sender.length);
    context.set(prefix); context.set(pub, prefix.length); context.set(sender, prefix.length + pub.length);
    const ikm = await derive(shared, auth, context, 256);
    const key = await derive(ikm, bytes.slice(0, 16), new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 128);
    const nonce = await derive(ikm, bytes.slice(0, 16), new TextEncoder().encode('Content-Encoding: nonce\0'), 96);
    const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, bytes.slice(21 + bytes[20])));
    assert.equal(plain.at(-1), 2);
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
  }
  return { id: result.data.subscriptionId, decode };
}
async function reminderDeliveryFixture(t) {
  const f = await fixture(t); const device = await receiver(f);
  f.DB.prepare(`INSERT INTO push_preferences(org_id,user_id,task_assigned,task_updated,task_overdue_reminder,task_reminder_enabled_at_ms,updated_at_ms)
    VALUES('org-a','b',0,0,1,?1,1)`).bind(REMINDER_NOW - 86400000).run();
  f.DB.prepare(`INSERT INTO tasks(task_id,org_id,title,status,due_at_ms,created_at_ms,updated_at_ms)
    VALUES('overdue','org-a','返さないタスク件名','open',?1,1,1)`).bind(REMINDER_TODAY - 1).run();
  f.DB.exec("INSERT INTO task_assignees(task_id,email,membership_id,assigned_at_ms) VALUES('overdue','b@example.invalid','mb',1)");
  return { ...f, device };
}
async function queueTestDelivery(f, id, now = REMINDER_NOW) {
  await f.DB.prepare(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms)
    VALUES(?1,'org-a','b','test','',?2,?3,?4)`).bind(id, f.device.id, now, now + 86400000).run();
}
async function queueReminderDelivery(f) {
  assert.deepEqual(await enqueueTaskReminders(f.env, { now: REMINDER_NOW }), { queued: 1 });
  const event = f.DB.get('SELECT * FROM push_events WHERE reminder_day IS NOT NULL');
  await f.DB.prepare('UPDATE push_events SET expanded=1 WHERE event_id=?1').bind(event.event_id).run();
  await f.DB.prepare('INSERT INTO push_deliveries(event_id,subscription_id,next_attempt_at_ms) VALUES(?1,?2,0)')
    .bind(event.event_id, f.device.id).run();
  return event;
}

test('配信payloadは本人の絶対件数を含み、閲覧権限・既読・完了による減少とテスト通知の0件も反映する', async t => {
  const f = await reminderDeliveryFixture(t);
  for (const [id, folder, org] of [['visible', 'folder-a', 'org-a'], ['commented', 'folder-a', 'org-a'],
    ['hidden', 'private', 'org-a'], ['inactive', 'inactive', 'org-a'], ['other', 'other-folder', 'org-b']]) {
    await f.DB.prepare('INSERT INTO messages(message_id,org_id,folder_id,title,body,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,1,1)')
      .bind(id, org, folder, '返さない件名', '返さない本文').run();
  }
  f.DB.exec(`INSERT INTO message_reads(message_read_id,message_id,membership_id,read_at_ms) VALUES('read-commented','commented','mb',100);
    INSERT INTO message_comments(comment_id,message_id,org_id,body,created_at_ms,updated_at_ms) VALUES('new-comment','commented','org-a','返さないコメント',101,101);
    INSERT INTO push_folder_preferences(org_id,user_id,folder_id,message_created,comment_created,task_assigned,task_updated) VALUES('org-a','b','folder-a',0,0,0,0);`);
  await queueTestDelivery(f, 'badge-before');
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW }), { sent: 1 });
  const first = await f.device.decode(f.sent[0]);
  assert.deepEqual(first.appBadge, { messageUnread: 2, taskOverdue: 1, total: 3, computedAt: REMINDER_NOW,
    owner: await sha256('org-a:b'), sessionExpiresAt: REMINDER_NOW + 3 * 86400000 });
  assert.equal(JSON.stringify(first).includes('返さない'), false);
  assert.equal(JSON.stringify(first).includes('@example.invalid'), false);
  f.DB.exec(`INSERT INTO message_reads(message_read_id,message_id,membership_id,read_at_ms) VALUES('read-visible','visible','mb',200);
    UPDATE message_reads SET read_at_ms=200 WHERE message_id='commented'; UPDATE tasks SET status='completed';`);
  await queueTestDelivery(f, 'badge-after', REMINDER_NOW + 60000);
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW + 60000 }), { sent: 1 });
  const second = await f.device.decode(f.sent[1]);
  assert.deepEqual(second.appBadge, { messageUnread: 0, taskOverdue: 0, total: 0, computedAt: REMINDER_NOW + 60000,
    owner: await sha256('org-a:b'), sessionExpiresAt: REMINDER_NOW + 3 * 86400000 });
  f.DB.exec("UPDATE users SET status=' ACTIVE ' WHERE user_id='b'; UPDATE memberships SET role=' ADMINISTRATOR ',status=' ACTIVE ' WHERE user_id='b'");
  await queueTestDelivery(f, 'badge-admin', REMINDER_NOW + 120000);
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW + 120000 }), { sent: 1 });
  assert.equal((await f.device.decode(f.sent[2])).appBadge.messageUnread, 1);
});

test('リマインダーだけ本人へ配信し、通常タスク通知OFFでも期限超過通知と現在件数を送る', async t => {
  const f = await reminderDeliveryFixture(t); await register(f, 'a', 'other-user');
  f.DB.exec("UPDATE push_preferences SET task_updated=1 WHERE user_id='b'");
  f.DB.prepare(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,created_at_ms,expires_at_ms)
    VALUES('ordinary-self','org-a','b','task_updated','overdue',?1,?2)`).bind(REMINDER_NOW, REMINDER_NOW + 86400000).run();
  await drainNotifications(f.env, { now: REMINDER_NOW }); assert.equal(f.sent.length, 0);
  f.DB.exec("UPDATE push_preferences SET task_updated=0 WHERE user_id='b'");
  assert.deepEqual(await enqueueTaskReminders(f.env, { now: REMINDER_NOW }), { queued: 1 });
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW }), { sent: 1 });
  const payload = await f.device.decode(f.sent[0]);
  assert.equal(payload.url, '/?view=tasks'); assert.match(payload.body, /期限.*未完了/);
  assert.equal(payload.appBadge.taskOverdue, 1); assert.equal(payload.appBadge.owner, await sha256('org-a:b'));
  await drainNotifications(f.env, { now: REMINDER_NOW + 60000 }); assert.equal(f.sent.length, 1);
});

test('日次通知も送信直前にOFF・再有効化時刻・期限変更・完了取消・担当権限・購読を再検証する', async t => {
  const changes = [
    'UPDATE push_preferences SET task_overdue_reminder=0',
    `UPDATE push_preferences SET task_reminder_enabled_at_ms=${REMINDER_NOW + 1}`,
    `UPDATE tasks SET due_at_ms=${REMINDER_TODAY}`, "UPDATE tasks SET status='completed'", "UPDATE tasks SET status='cancelled'",
    'DELETE FROM task_assignees', "UPDATE tasks SET org_id='org-b'", "UPDATE users SET is_active=0 WHERE user_id='b'",
    "UPDATE memberships SET status='inactive' WHERE user_id='b'", "UPDATE memberships SET role='guest' WHERE user_id='b'",
    'DELETE FROM push_subscriptions', `UPDATE push_subscriptions SET session_expires_at_ms=${REMINDER_NOW}`,
    "UPDATE push_events SET reminder_day='2026-11-12'",
  ];
  for (const change of changes) {
    const f = await reminderDeliveryFixture(t); const event = await queueReminderDelivery(f); f.DB.exec(change);
    assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW }), { sent: 0 }, change);
    assert.equal(f.DB.get('SELECT status FROM push_deliveries WHERE event_id=?1', event.event_id).status, 'skipped', change);
    assert.equal(f.sent.length, 0);
  }
});

test('件数の取得失敗は0件として送らず既存retryを使い、復旧後に再計算する', async t => {
  const f = await reminderDeliveryFixture(t); await queueTestDelivery(f, 'badge-unavailable');
  f.DB.exec('ALTER TABLE message_reads RENAME TO fixture_message_reads_unavailable');
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW }), { sent: 0 });
  assert.equal(f.sent.length, 0);
  const failed = f.DB.get("SELECT * FROM push_deliveries WHERE event_id='badge-unavailable'");
  assert.equal(failed.status, 'pending'); assert.equal(failed.result_code, 'badge_unavailable'); assert.equal(failed.attempts, 1);
  f.DB.exec('ALTER TABLE fixture_message_reads_unavailable RENAME TO message_reads');
  assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW + 60001 }), { sent: 1 });
  assert.equal((await f.device.decode(f.sent[0])).appBadge.taskOverdue, 1);
});

test('件数を取得する間にOFF・完了になった日次通知も最終確認で止める', async t => {
  for (const change of ['UPDATE push_preferences SET task_overdue_reminder=0', "UPDATE tasks SET status='completed'"]) {
    const f = await reminderDeliveryFixture(t); const event = await queueReminderDelivery(f);
    const prepare = f.DB.prepare.bind(f.DB); let changed = false;
    f.DB.prepare = sql => {
      if (!changed && sql.includes('WITH viewer AS')) { changed = true; f.DB.exec(change); }
      return prepare(sql);
    };
    assert.deepEqual(await drainNotifications(f.env, { now: REMINDER_NOW }), { sent: 0 });
    assert.equal(changed, true); assert.equal(f.sent.length, 0);
    assert.equal(f.DB.get('SELECT status FROM push_deliveries WHERE event_id=?1', event.event_id).status, 'skipped');
  }
});

test('cronは日次enqueue後に配信し、enqueue失敗時も既存通知の再試行を止めない', async t => {
  for (const failEnqueue of [false, true]) {
    const f = await reminderDeliveryFixture(t);
    if (failEnqueue) {
      f.DB.exec("CREATE TRIGGER fixture_reminder_failure BEFORE INSERT ON push_events WHEN NEW.reminder_day IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture_reminder_failure'); END");
      await queueTestDelivery(f, 'existing-test');
    }
    const originalNow = Date.now; Date.now = () => REMINDER_NOW;
    try {
      const background = [];
      await pushWorker.scheduled({}, f.env, { waitUntil(promise) { background.push(promise); } });
      await Promise.all(background);
    } finally { Date.now = originalNow; }
    assert.equal(f.sent.length, 1, failEnqueue ? '既存通知を送る' : '日次通知を同じcronで送る');
    const payload = await f.device.decode(f.sent[0]);
    assert.equal(payload.appBadge.taskOverdue, 1);
    assert.equal(payload.url, failEnqueue ? '/?view=settings' : '/?view=tasks');
  }
});

test('即時配信では期限切れの定期回収を実行せず、定期処理で回収する', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  await f.DB.prepare(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,created_at_ms,expires_at_ms)
    VALUES('older-expired','org-a','b','test','',?1,?2)`).bind(now - 3 * 86400000, now - 2 * 86400000).run();
  assert.equal((await drainNotifications(f.env, { now, maintenance: false })).sent, 0);
  assert.ok(f.DB.get("SELECT event_id FROM push_events WHERE event_id = 'older-expired'"));
  assert.equal((await drainNotifications(f.env, { now })).sent, 0);
  assert.equal(f.DB.get("SELECT event_id FROM push_events WHERE event_id = 'older-expired'"), null);
});
