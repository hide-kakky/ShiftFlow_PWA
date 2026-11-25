import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../frontend/public/push-settings.js',import.meta.url),'utf8');
const swSource = await readFile(new URL('../frontend/public/sw.js',import.meta.url),'utf8');
class Element {
  constructor(tag='div') { this.tagName=tag; this.children=[]; this.dataset={}; this.events={}; this.hidden=false; this.disabled=false; this.textContent=''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=nodes; }
  addEventListener(type,listener) { this.events[type]=listener; }
  async trigger(type) { return this.events[type]?.({target:this,currentTarget:this}); }
  querySelectorAll(selector) {
    const matches = node => selector==='input' ? node.tagName==='input' : selector==='[data-folder-id]' && 'folderId' in node.dataset;
    return this.children.flatMap(node=>[...(matches(node)?[node]:[]),...node.querySelectorAll(selector)]);
  }
}
function ui(options={}) {
  const ids=['push-settings','push-status','push-enable','push-disable','push-test','push-test-status','push-local-test','push-local-status','push-save','push-reload','push-folder-list','push-task-options','push-save-note','push-ios-help','view-settings'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
  ids.filter(id=>id!=='push-settings' && id!=='view-settings').forEach(id=>elements['push-settings'].append(elements[id]));
  elements['view-settings'].append(elements['push-settings']);
  const events={}; const calls=[]; const notification={permission:options.permission || 'default'};
  const subscription={endpoint:'https://web.push.apple.com/test-ui',toJSON(){return {endpoint:this.endpoint,keys:{}};},async unsubscribe(){calls.push('unsubscribe');return true;}};
  let currentSubscription=options.subscribed?subscription:null;
  const registration={active:options.active!==false,async showNotification(title,details){calls.push({localNotification:{title,details}});if(options.showNotification)return options.showNotification();},pushManager:{async getSubscription(){return currentSubscription;},subscribe(){calls.push('subscribe');notification.permission='granted';currentSubscription=subscription;return Promise.resolve(subscription);}}};
  const initial={owner:'owner',serverReady:true,publicKey:Buffer.from(new Uint8Array(65).fill(4)).toString('base64url'),version:'0',deviceRegistered:!!options.subscribed,
    folders:[{id:'a',name:'共有A',message_created:true,comment_created:true,task_assigned:true,task_updated:true}],
    taskPreferences:{task_assigned:true,task_updated:true,task_overdue_reminder:false},unfiledTasks:{task_assigned:true,task_updated:true}};
  const data=structuredClone(initial);
  const window={isSecureContext:true,Notification:notification,crypto,PushManager:class {},matchMedia(){return {matches:options.standalone!==false};},
    async apiRequest(path,request){calls.push({path,request}); if(options.request) return options.request(path,request,data);
      if(path.includes('getNotificationSettings')) return structuredClone(data);
      if(path.includes('saveNotificationSettings')) { data.version='11111111-1111-1111-1111-111111111111'; return {version:data.version}; }
      return {subscriptionId:'test'};
    }};
  const document={getElementById(id){return elements[id];},createElement(tag){return new Element(tag);},addEventListener(type,listener){events[type]=listener;},visibilityState:'visible'};
  const navigator={userAgent:'iPhone',platform:'iPhone',maxTouchPoints:1,standalone:options.standalone!==false,serviceWorker:{async getRegistration(){return registration;}}};
  let now=Date.now(), nextTimer=0; const timers=new Map();
  const Clock=class extends Date {static now(){return now;}};
  vm.runInNewContext(source,{window,document,navigator,Notification:notification,crypto,TextEncoder,Uint8Array,atob,URL,console,Promise,Date:Clock,
    setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){timers.delete(id);}});
  return {window,elements,calls,events,data,notification,async refresh(force=false){await window.ShiftFlowPushSettings.refresh(force);},
    advance(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}}};
}

test('フォルダ通知はメッセージとコメントのみ、タスク通知は共通欄の3項目へ分ける',async()=>{
  const page=ui();await page.refresh();
  const folder=page.elements['push-folder-list'].querySelectorAll('input');
  assert.deepEqual(folder.map(input=>input.dataset.kind),['message_created','comment_created']);
  const tasks=page.elements['push-task-options'].querySelectorAll('input');
  assert.deepEqual(tasks.map(input=>input.dataset.kind),['task_assigned','task_updated','task_overdue_reminder']);
  assert.equal(tasks.find(input=>input.dataset.kind==='task_overdue_reminder').checked,false);
  assert.match(page.elements['push-task-options'].children.at(-1).children.at(-1).textContent,/期限超過.*リマインダー/);
});
test('共通タスク通知は新APIの明示OFFを優先し、旧APIでも朝リマインダーを自動でONにしない',async()=>{
  const page=ui();page.data.taskPreferences={task_assigned:false,task_updated:false,task_overdue_reminder:true};
  await page.refresh();
  assert.deepEqual(page.elements['push-task-options'].querySelectorAll('input').map(input=>input.checked),[false,false,true]);
  const legacy=ui();delete legacy.data.taskPreferences;legacy.data.unfiledTasks.task_updated=false;
  await legacy.refresh();
  assert.deepEqual(legacy.elements['push-task-options'].querySelectorAll('input').map(input=>input.checked),[true,false,false]);
});
test('共通タスク通知の変更を保存し、旧API互換の2項目にも同じ選択を送る',async()=>{
  const page=ui();await page.refresh();
  const tasks=page.elements['push-task-options'].querySelectorAll('input');
  tasks[0].checked=false;await tasks[0].trigger('change');
  tasks[2].checked=true;await tasks[2].trigger('change');
  assert.equal(page.elements['push-enable'].disabled,true);assert.equal(page.elements['push-test'].disabled,true);
  await page.elements['push-save'].trigger('click');
  const body=JSON.parse(JSON.stringify(page.calls.find(call=>call.path?.includes('saveNotificationSettings')).request.body));
  assert.deepEqual(body.taskPreferences,{task_assigned:false,task_updated:true,task_overdue_reminder:true});
  assert.deepEqual(body.unfiledTasks,{task_assigned:false,task_updated:true});
  assert.deepEqual(body.folders,[{id:'a',message_created:true,comment_created:true}]);
  assert.equal(page.elements['push-save'].textContent,'保存済み');
});
test('共通タスク通知の未保存入力は通常再取得で保持し、本人が変わったら新本人の設定を表示する',async()=>{
  const page=ui();await page.refresh();
  const reminder=page.elements['push-task-options'].querySelectorAll('input').find(input=>input.dataset.kind==='task_overdue_reminder');
  reminder.checked=true;await reminder.trigger('change');await page.refresh();
  assert.equal(page.elements['push-task-options'].querySelectorAll('input').at(-1).checked,true);
  assert.equal(page.elements['push-save'].disabled,false);
  page.data.owner='other-owner';page.data.taskPreferences.task_assigned=false;await page.refresh();
  assert.deepEqual(page.elements['push-task-options'].querySelectorAll('input').map(input=>input.checked),[false,true,false]);
});
test('共通タスク通知の保存競合は入力と元versionを保持し、明示再読込後に新versionで保存する',async()=>{
  let conflict=true;const saves=[];
  const page=ui({request(path,request,data){
    if(path.includes('getNotificationSettings'))return structuredClone(data);
    if(path.includes('saveNotificationSettings')){
      saves.push(JSON.parse(JSON.stringify(request.body)));
      if(conflict)throw Object.assign(new Error('conflict'),{code:'notification_settings_conflict'});
      return {version:'saved-new'};
    }
  }});
  await page.refresh();let reminder=page.elements['push-task-options'].querySelectorAll('input').at(-1);
  reminder.checked=true;await reminder.trigger('change');await page.elements['push-save'].trigger('click');
  assert.equal(reminder.checked,true);assert.equal(page.elements['push-save'].disabled,false);
  assert.match(page.elements['push-save-note'].textContent,/入力は保持/);assert.equal(saves[0].version,'0');
  page.data.version='remote-new';await page.refresh(true);
  reminder=page.elements['push-task-options'].querySelectorAll('input').at(-1);
  assert.equal(reminder.checked,false);
  reminder.checked=true;await reminder.trigger('change');conflict=false;await page.elements['push-save'].trigger('click');
  assert.equal(saves[1].version,'remote-new');assert.equal(saves[1].taskPreferences.task_overdue_reminder,true);
});

test('テスト通知は連打を防ぎ、端末の有効状態と残り秒数を別々に表示する',async()=>{
  const page=ui({permission:'granted',subscribed:true,request(path,request,data){
    if(path.includes('getNotificationSettings'))return structuredClone(data);
    if(path.includes('testPushNotification'))return {queued:true,retryAfterSeconds:60};
  }});
  await page.refresh();
  await page.elements['push-test'].trigger('click');
  assert.equal(page.elements['push-status'].textContent,'この端末の通知：有効');
  assert.match(page.elements['push-test-status'].textContent,/送信待ち/);
  assert.equal(page.elements['push-test'].textContent,'再送まで 60秒');
  assert.equal(page.elements['push-test'].disabled,true);
  await page.elements['push-test'].trigger('click');
  assert.equal(page.calls.filter(c=>c.path?.includes('testPushNotification')).length,1);
  page.advance(1000);assert.equal(page.elements['push-test'].textContent,'再送まで 59秒');
  page.advance(59000);assert.equal(page.elements['push-test'].disabled,false);assert.equal(page.elements['push-test'].textContent,'テスト通知');
});
test('サーバーの残り秒数を再読込と429から引き継ぎ、回数制限を予期した応答として扱う',async()=>{
  const page=ui({permission:'granted',subscribed:true,request(path,request,data){
    if(path.includes('getNotificationSettings'))return {...structuredClone(data),testRetryAfterSeconds:20};
    if(path.includes('testPushNotification'))throw Object.assign(new Error('wait'),{code:'push_test_rate_limited',retryAfterSeconds:7});
  }});
  await page.refresh();assert.equal(page.elements['push-test'].textContent,'再送まで 20秒');
  page.advance(20000);await page.elements['push-test'].trigger('click');
  const call=page.calls.find(c=>c.path?.includes('testPushNotification'));
  assert.equal(call.request.expectedErrorCodes.join(','),'push_test_rate_limited');
  assert.equal(page.elements['push-test'].textContent,'再送まで 7秒');
  assert.equal(page.elements['push-status'].textContent,'この端末の通知：有効');
  assert.match(page.elements['push-test-status'].textContent,/受け付けています/);
});
test('再読込で期限を更新し、アカウントが変わったら以前の待ち時間と案内を残さない',async()=>{
  const page=ui({permission:'granted',subscribed:true});
  page.data.testRetryAfterSeconds=20;await page.refresh();page.advance(5000);
  page.data.testRetryAfterSeconds=15;await page.refresh();
  assert.equal(page.elements['push-test'].textContent,'再送まで 15秒');
  page.advance(15000);assert.equal(page.elements['push-test'].disabled,false);
  page.elements['push-test-status'].textContent='以前のアカウントの案内';
  page.data.owner='another-owner';page.data.deviceRegistered=false;page.data.testRetryAfterSeconds=0;await page.refresh();
  assert.equal(page.elements['push-test-status'].textContent,'');
  assert.equal(page.elements['push-test'].textContent,'テスト通知');
  assert.equal(page.elements['push-test'].disabled,true);
});
test('iPhoneホーム未追加・拒否済みの状態を分け、設定手順を表示する',async ()=>{
  const browser=ui({standalone:false}); await browser.refresh();
  assert.equal(browser.elements['push-enable'].disabled,true); assert.match(browser.elements['push-status'].textContent,/ホーム画面/); assert.equal(browser.elements['push-ios-help'].hidden,false);
  const denied=ui({permission:'denied'}); await denied.refresh();
  assert.equal(denied.elements['push-enable'].disabled,true); assert.match(denied.elements['push-status'].textContent,/許可されていません/);
});
test('端末内の表示確認は外部通信・購読変更を行わず、外部テストの待ち時間を保つ',async()=>{
  const page=ui({permission:'granted',subscribed:true});
  page.data.testRetryAfterSeconds=30; await page.refresh();page.calls.length=0;
  await page.elements['push-local-test'].trigger('click');
  assert.equal(page.calls.length,1);assert.equal(page.calls[0].localNotification.details.body,'端末内の表示確認です。');
  assert.match(page.elements['push-local-status'].textContent,/通知センター/);
  assert.equal(page.elements['push-status'].textContent,'この端末の通知：有効');
  assert.equal(page.elements['push-test'].textContent,'再送まで 30秒');
});
test('端末内の表示確認は未許可・ホーム未追加・active SWなしでは実行しない',async()=>{
  for(const options of [{permission:'default'},{permission:'denied'},{permission:'granted',active:false},{permission:'granted',standalone:false}]){
    const page=ui(options);await page.refresh();page.calls.length=0;
    assert.equal(page.elements['push-local-test'].disabled,true);
    await page.elements['push-local-test'].trigger('click');assert.equal(page.calls.length,0);
  }
});
test('端末内の表示確認はサーバー障害・購読未登録でも利用でき、失敗後に再操作できる',async()=>{
  const page=ui({permission:'granted',request(){throw new Error('offline');},showNotification(){throw new Error('local failure');}});
  await page.refresh();page.calls.length=0;
  assert.equal(page.elements['push-local-test'].disabled,false);
  await page.elements['push-local-test'].trigger('click');
  assert.match(page.elements['push-local-status'].textContent,/表示に失敗/);
  assert.equal(page.elements['push-local-test'].disabled,false);assert.equal(page.calls.length,1);
});
test('端末内表示の二重操作を防ぎ、アカウント変更後に古い結果を表示しない',async()=>{
  let resolve;
  const page=ui({permission:'granted',showNotification(){return new Promise(r=>{resolve=r;});}});
  await page.refresh();page.calls.length=0;
  const pending=page.elements['push-local-test'].trigger('click');
  await page.elements['push-local-test'].trigger('click');
  page.data.owner='other';await page.refresh();resolve();await pending;
  assert.equal(page.calls.filter(c=>c.localNotification).length,1);
  assert.equal(page.elements['push-local-status'].textContent,'');
});
test('本人のクリックで購読を先に要求し、サーバー保存後にだけ有効と表示する',async ()=>{
  const page=ui(); await page.refresh(); page.calls.length=0;
  await page.elements['push-enable'].trigger('click');
  assert.equal(page.calls[0],'subscribe'); assert.match(page.calls[1].path,/registerPushSubscription/);
  assert.equal(page.elements['push-enable'].disabled,true); assert.equal(page.elements['push-disable'].disabled,false); assert.equal(page.elements['push-status'].textContent,'この端末の通知：有効');
});
test('登録済みなら有効化ボタンにも有効と表示し、停止すると未登録表示へ戻る',async()=>{
  const page=ui({permission:'granted',subscribed:true});await page.refresh();
  assert.equal(page.elements['push-enable'].textContent,'この端末の通知は有効です');
  await page.elements['push-disable'].trigger('click');
  assert.equal(page.elements['push-enable'].textContent,'この端末で通知を有効にする');
});
test('端末許可だけでは登録済みにせず、初回登録の成功後にだけ有効表示する',async()=>{
  const page=ui({permission:'granted'});await page.refresh();
  assert.equal(page.elements['push-enable'].textContent,'この端末で通知を有効にする');
  await page.elements['push-enable'].trigger('click');
  assert.equal(page.elements['push-enable'].textContent,'この端末の通知は有効です');
});
test('保存成功をボタンへ反映し、次の変更があると保存できる表示へ戻る',async()=>{
  const page=ui();await page.refresh();
  assert.equal(page.elements['push-save'].textContent,'通知設定を保存');
  await page.elements['push-save'].trigger('click');
  assert.equal(page.elements['push-save'].textContent,'保存済み');assert.equal(page.elements['push-save'].disabled,true);
  const input=page.elements['push-folder-list'].querySelectorAll('input')[0];input.checked=false;await input.trigger('change');
  assert.equal(page.elements['push-save'].textContent,'通知設定を保存');assert.equal(page.elements['push-save'].disabled,false);
});
test('購読の保存に失敗した場合は成功扱いせず端末購読を解除する',async ()=>{
  const page=ui({request(path,request,data){if(path.includes('getNotificationSettings'))return structuredClone(data);throw new Error('offline');}}); await page.refresh();
  await page.elements['push-enable'].trigger('click');
  assert.ok(page.calls.includes('unsubscribe')); assert.equal(page.elements['push-disable'].disabled,true); assert.match(page.elements['push-status'].textContent,/登録できません/);
});
test('未保存フォルダ設定を通知登録へ混ぜず、遅延した取得が保存済み設定を巻き戻さない',async ()=>{
  let delayed; let hold=false; const saves=[];
  const page=ui({request(path,request,data){
    if(path.includes('getNotificationSettings')) return hold?new Promise(resolve=>{delayed=()=>resolve(structuredClone({...data,version:'0'}));}):structuredClone(data);
    if(path.includes('saveNotificationSettings')){saves.push(request.body);return {version:'11111111-1111-1111-1111-111111111111'};}
  }});
  await page.refresh(); hold=true; const pending=page.refresh();
  while(!delayed) await new Promise(resolve=>setImmediate(resolve));
  const input=page.elements['push-folder-list'].querySelectorAll('input')[0]; input.checked=false; await input.trigger('change');
  assert.equal(page.elements['push-enable'].disabled,true); await page.elements['push-save'].trigger('click');
  delayed(); await pending;
  assert.equal(page.elements['push-folder-list'].querySelectorAll('input')[0].checked,false);
  const nextInput=page.elements['push-folder-list'].querySelectorAll('input')[1];nextInput.checked=false;await nextInput.trigger('change');
  await page.elements['push-save'].trigger('click');
  assert.equal(saves[1].version,'11111111-1111-1111-1111-111111111111');
  assert.equal(saves[1].folders[0].message_created,false);
});
function worker() {
  const handlers={}; const shown=[]; const opened=[];
  const self={location:{origin:'https://shiftflow.pages.dev'},registration:{showNotification:async(title,options)=>shown.push({title,options})},
    addEventListener(type,listener){handlers[type]=listener;},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
  vm.runInNewContext(swSource,{self,URL,console,TextEncoder,Uint8Array});
  return {handlers,shown,opened,async push(data){let wait;handlers.push({data,waitUntil(p){wait=p;}});await wait;},async click(url){let wait;handlers.notificationclick({notification:{close(){},data:{url}},waitUntil(p){wait=p;}});await wait;}};
}
test('Service Workerは不正payloadや空pushでも可視通知を表示する',async ()=>{
  const sw=worker(); await sw.push(null); await sw.push({json(){throw new Error('invalid json');}});
  assert.equal(sw.shown.length,2); assert.match(sw.shown[0].options.body,/新しいお知らせ/);
});
test('通知クリックは同一originの対象へ進み、外部URLへの遷移を拒否する',async ()=>{
  const sw=worker(); await sw.click('/?view=messages&message=123'); await sw.click('https://evil.invalid/steal');
  assert.equal(sw.opened[0],'https://shiftflow.pages.dev/?view=messages&message=123'); assert.equal(sw.opened[1],'https://shiftflow.pages.dev/');
});
