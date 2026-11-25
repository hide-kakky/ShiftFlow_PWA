(function () {
  'use strict';
  var root = document.getElementById('push-settings');
  if (!root) return;
  var state = { loaded: false, ready: false, registration: null, subscription: null, registered: false, version: '0', dirty: false, busy: false, localBusy: false, owner: '', generation: 0, testAvailableAt: 0, cooldownTimer: null };
  var labels = { message_created: '新しいメッセージ', comment_created: 'コメントの追加', task_assigned: 'タスクの依頼', task_updated: 'タスクの更新・完了', task_overdue_reminder: '期限超過タスクの朝リマインダー' };
  var messageKinds = ['message_created', 'comment_created'];
  var taskKinds = ['task_assigned', 'task_updated', 'task_overdue_reminder'];
  function el(id) { return document.getElementById(id); }
  function status(text) { el('push-status').textContent = text; }
  function ios() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone() { return !!navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }
  function supported() { return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && window.crypto && crypto.subtle; }
  function request(route, method, body) { return window.apiRequest('/api/' + route, { method: method || 'GET', body: body, dedupe: false, expectedErrorCodes: route === 'testPushNotification' ? ['push_test_rate_limited'] : [] }); }
  function keyBytes(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), function (c) { return c.charCodeAt(0); }); }
  async function subscriptionId(subscription) {
    if (!subscription) return '';
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint))), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function updateButtons() {
    var usable = supported() && (!ios() || standalone());
    var waitSeconds = Math.max(0, Math.ceil((state.testAvailableAt - Date.now()) / 1000));
    var enabled = usable && state.ready && state.registered && Notification.permission === 'granted';
    var saved = state.loaded && state.version !== '0' && !state.dirty;
    el('push-enable').textContent = enabled ? 'この端末の通知は有効です' : 'この端末で通知を有効にする';
    el('push-save').textContent = saved ? '保存済み' : '通知設定を保存';
    el('push-enable').disabled = state.busy || state.dirty || !state.ready || !usable || !state.registration || state.registered || Notification.permission === 'denied';
    el('push-disable').disabled = state.busy || !state.registered;
    el('push-test').disabled = state.busy || state.dirty || !state.registered || !usable || Notification.permission !== 'granted' || waitSeconds > 0;
    el('push-test').textContent = waitSeconds > 0 && state.registered ? '再送まで ' + waitSeconds + '秒' : 'テスト通知';
    el('push-save').disabled = state.busy || !state.ready || !state.loaded || saved;
    el('push-reload').disabled = state.busy;
    el('push-local-test').disabled = state.localBusy || state.busy || !usable || Notification.permission !== 'granted' || !state.registration?.active || typeof state.registration.showNotification !== 'function';
    root.querySelectorAll('input').forEach(function (input) { input.disabled = state.busy || !state.ready; });
  }
  function setTestCooldown(seconds) {
    var duration = Math.max(0, Math.min(60, Number(seconds) || 0));
    state.testAvailableAt = Date.now() + duration * 1000;
    if (state.cooldownTimer !== null) clearTimeout(state.cooldownTimer);
    function tick() {
      state.cooldownTimer = null;
      updateButtons();
      if (state.testAvailableAt > Date.now()) state.cooldownTimer = setTimeout(tick, Math.min(1000, state.testAvailableAt - Date.now()));
    }
    tick();
  }
  function describeDevice() {
    el('push-ios-help').hidden = !ios();
    if (ios() && !standalone()) return 'iPhoneでは、ホーム画面に追加したShiftFlowのアイコンから開くと通知を有効にできます。';
    if (!supported()) return 'このブラウザーではプッシュ通知を利用できません。対応するブラウザーで開いてください。';
    if (!state.ready) return '通知サービスは準備中です。有効になった後、この端末を登録できます。';
    if (Notification.permission === 'denied') return ios() ? 'iPhone側で通知が許可されていません。下の変更方法をご確認ください。' : 'ブラウザー側で通知が許可されていません。サイトの通知設定で変更してください。';
    if (Notification.permission === 'granted' && state.registered) return 'この端末の通知：有効';
    if (Notification.permission === 'granted') return '端末の許可は済んでいます。「この端末で通知を有効にする」で登録を完了してください。';
    return 'この端末の通知：未設定。受け取る通知の内容を選び、通知を有効にしてください。';
  }
  function checkbox(container, kind, checked) {
    var label = document.createElement('label');
    label.className = 'push-option';
    var input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked; input.dataset.kind = kind;
    var text = document.createElement('span'); text.textContent = labels[kind];
    label.append(input, text); container.append(label);
    input.addEventListener('change', function () { state.dirty = true; el('push-save-note').textContent = '未保存の変更があります。変更を反映するには保存してください。'; updateButtons(); });
  }
  function renderPreferences(data) {
    var list = el('push-folder-list'); list.replaceChildren();
    (data.folders || []).forEach(function (folder) {
      var group = document.createElement('details'); group.className = 'push-folder'; group.dataset.folderId = folder.id;
      var summary = document.createElement('summary'); summary.textContent = folder.name;
      var fieldset = document.createElement('fieldset');
      var legend = document.createElement('legend'); legend.className = 'visually-hidden'; legend.textContent = folder.name + 'の通知';
      fieldset.append(legend);
      messageKinds.forEach(function (kind) { checkbox(fieldset, kind, !!folder[kind]); });
      group.append(summary, fieldset); list.append(group);
    });
    if (!data.folders || !data.folders.length) { var empty = document.createElement('p'); empty.textContent = '設定できるフォルダはありません。'; list.append(empty); }
    var tasks = el('push-task-options'); tasks.replaceChildren();
    var taskPreferences = data.taskPreferences || data.unfiledTasks || {};
    taskKinds.forEach(function (kind) { checkbox(tasks, kind, !!taskPreferences[kind]); });
    state.version = data.version; state.dirty = false;
    el('push-save-note').textContent = '通知設定はアカウントに保存されます。通知を受け取る端末は個別に登録してください。';
  }
  async function refresh(force) {
    if (state.busy) return;
    var generation = ++state.generation;
    try {
      var registration = supported() ? await navigator.serviceWorker.getRegistration('/') : null;
      if (generation !== state.generation || state.busy) return;
      state.registration = registration;
      updateButtons();
      var subscription = registration ? await registration.pushManager.getSubscription() : null;
      var id = await subscriptionId(subscription);
      var data = await request('getNotificationSettings' + (id ? '?subscriptionId=' + id : ''));
      if (generation !== state.generation || state.busy) return;
      state.registration = registration; state.subscription = subscription;
      state.ready = data.serverReady; state.publicKey = data.publicKey;
      state.registered = !!data.deviceRegistered && !!state.subscription;
      if (force || !state.dirty || state.owner !== data.owner) renderPreferences(data);
      if (state.owner && state.owner !== data.owner) {
        el('push-test-status').textContent = '';
        el('push-local-status').textContent = '';
      }
      state.owner = data.owner; state.loaded = true;
      setTestCooldown(data.testRetryAfterSeconds || 0);
      status(describeDevice()); updateButtons();
    } catch (_) { if (generation !== state.generation) return; status('通知設定を読み込めませんでした。「再読み込み」でお試しください。'); updateButtons(); }
  }
  async function enable() {
    if (state.busy || !state.ready || !state.registration || !supported()) return;
    if (Notification.permission === 'denied') { status(describeDevice()); return; }
    // 購読要求は本人のクリックから直接実行する。先に通信を挟まない。
    var pending = state.subscription ? Promise.resolve(state.subscription) : state.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.publicKey) });
    state.generation++; state.busy = true; updateButtons(); status('端末を登録しています…');
    var subscription;
    try {
      subscription = await pending;
      try { await request('registerPushSubscription', 'POST', { subscription: subscription.toJSON() }); }
      catch (error) {
        if (error.code !== 'push_subscription_conflict') throw error;
        // 共有端末で別アカウントの購読を引き継がない。
        await subscription.unsubscribe();
        subscription = await state.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.publicKey) });
        await request('registerPushSubscription', 'POST', { subscription: subscription.toJSON() });
      }
      state.subscription = subscription; state.registered = true; status(describeDevice());
    } catch (_) {
      if (subscription) { try { await subscription.unsubscribe(); } catch (_) {} }
      state.registered = false; state.subscription = null;
      status(Notification.permission === 'denied' ? describeDevice() : '端末を登録できませんでした。通信状態を確認して、もう一度お試しください。');
    } finally { state.busy = false; updateButtons(); }
  }
  async function disable() {
    if (state.busy || !state.subscription) return;
    state.generation++; state.busy = true; updateButtons();
    try {
      await request('removePushSubscription', 'POST', { subscriptionId: await subscriptionId(state.subscription) });
      await state.subscription.unsubscribe(); state.subscription = null; state.registered = false;
      status('この端末の通知を停止しました。フォルダ・タスクの通知設定は保存されています。');
    } catch (_) { status('停止結果を確認できませんでした。再読み込みして状態をご確認ください。'); }
    finally { state.busy = false; updateButtons(); }
  }
  async function save() {
    if (state.busy || !state.ready || (state.version !== '0' && !state.dirty)) return;
    state.generation++; state.busy = true; updateButtons();
    function read(group) { return Object.fromEntries(Array.from(group.querySelectorAll('input')).map(function (input) { return [input.dataset.kind, input.checked]; })); }
    var folders = Array.from(el('push-folder-list').querySelectorAll('[data-folder-id]')).map(function (group) { return Object.assign({ id: group.dataset.folderId }, read(group)); });
    var taskPreferences = read(el('push-task-options'));
    try {
      var result = await request('saveNotificationSettings', 'POST', { version: state.version, folders: folders, taskPreferences: taskPreferences,
        unfiledTasks: { task_assigned: taskPreferences.task_assigned, task_updated: taskPreferences.task_updated } });
      state.version = result.version; state.dirty = false; el('push-save-note').textContent = '通知設定を保存しました。';
    } catch (error) { el('push-save-note').textContent = error.code === 'notification_settings_conflict' ? '別の画面で設定が変更されました。入力は保持しています。再読み込み後に選び直してください。' : '保存できませんでした。入力は保持しています。もう一度お試しください。'; }
    finally { state.busy = false; updateButtons(); }
  }
  el('push-enable').addEventListener('click', enable);
  el('push-disable').addEventListener('click', disable);
  el('push-save').addEventListener('click', save);
  el('push-reload').addEventListener('click', function () { refresh(true); });
  el('push-local-test').addEventListener('click', async function () {
    if (state.localBusy || state.busy || !supported() || (ios() && !standalone()) || Notification.permission !== 'granted') return;
    var registration = state.registration;
    if (!registration?.active || typeof registration.showNotification !== 'function') return;
    var owner = state.owner;
    state.localBusy = true; updateButtons();
    try {
      await registration.showNotification('ShiftFlow', {
        body: '端末内の表示確認です。', tag: 'shiftflow-local-check',
        icon: '/icons/icon-192.png', data: { url: '/' },
      });
      if (owner === state.owner) el('push-local-status').textContent = '通知の表示処理を受け付けました。通知センターに「端末内の表示確認です。」があるかご確認ください。';
    } catch (_) {
      if (owner === state.owner) el('push-local-status').textContent = '端末内の通知表示に失敗しました。アプリを開き直して、もう一度お試しください。';
    } finally { state.localBusy = false; updateButtons(); }
  });
  el('push-test').addEventListener('click', async function () {
    if (state.busy || state.dirty || !state.registered || !state.subscription || !supported() || Notification.permission !== 'granted' || Date.now() < state.testAvailableAt) return;
    state.generation++; state.busy = true; updateButtons();
    try {
      var result = await request('testPushNotification', 'POST', { subscriptionId: await subscriptionId(state.subscription) });
      setTestCooldown(result.retryAfterSeconds || 60);
      el('push-test-status').textContent = 'テスト通知を送信待ちにしました。端末に届くかご確認ください。';
    } catch (error) {
      if (error.code === 'push_test_rate_limited') {
        setTestCooldown(error.retryAfterSeconds || 60);
        el('push-test-status').textContent = '前のテスト通知を受け付けています。再送までの残り時間はボタンに表示されます。';
      } else el('push-test-status').textContent = 'テスト通知を登録できませんでした。再読み込みして状態をご確認ください。';
    }
    finally { state.busy = false; updateButtons(); }
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && !document.getElementById('view-settings').hidden) refresh(false); });
  window.ShiftFlowPushSettings = { refresh: refresh };
})();
