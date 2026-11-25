import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { onRequest as handleApiRequest } from '../functions/api/[[route]].js';
import { createSession } from '../functions/utils/session.js';
import { FakeKv, SqliteD1 } from './helpers/d1-test-utils.mjs';

const ORIGIN = 'https://shiftflow.pages.dev';
const NOW = 1_750_000_000_000;
const PERSONAL_PINS_MIGRATION = await readFile(
  new URL('../migrations/008_add_personal_message_pins.sql', import.meta.url),
  'utf8'
);
const STAGED_ATTACHMENTS_MIGRATION = await readFile(
  new URL('../migrations/013_add_staged_attachments.sql', import.meta.url),
  'utf8'
);
const SESSION_REVOCATIONS_MIGRATION = await readFile(
  new URL('../migrations/014_add_session_revocations.sql', import.meta.url),
  'utf8'
);

const IDS = {
  orgA: 'org-a',
  orgB: 'org-b',
  userA: 'user-a',
  userB: 'user-b',
  userOther: 'user-other',
  memberA: 'membership-a',
  memberB: 'membership-b',
  memberOther: 'membership-other',
  publicFolder: 'folder-public',
  privateFolder: 'folder-private',
  otherFolder: 'folder-other',
  publicMessage: 'message-public',
  privateMessage: 'message-private',
  otherMessage: 'message-other',
};

const TEST_SCHEMA = `
  CREATE TABLE organizations (
    org_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT,
    display_color TEXT,
    timezone TEXT,
    notification_email TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER
  );

  CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    auth_subject TEXT,
    status TEXT DEFAULT 'active',
    is_active INTEGER NOT NULL DEFAULT 1,
    approved_by TEXT,
    approved_at_ms INTEGER,
    profile_image_url TEXT,
    theme TEXT,
    language TEXT,
    settings_version TEXT NOT NULL DEFAULT '0',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE memberships (
    membership_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    created_at_ms INTEGER NOT NULL,
    UNIQUE (org_id, user_id),
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );

  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    color TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_public INTEGER NOT NULL DEFAULT 1,
    is_system INTEGER NOT NULL DEFAULT 0,
    archived_at_ms INTEGER,
    archive_year INTEGER,
    archive_category TEXT,
    notes TEXT,
    meta_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id)
  );

  CREATE TABLE folder_members (
    folder_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    added_at_ms INTEGER NOT NULL,
    PRIMARY KEY (folder_id, user_id),
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
  );

  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title_format TEXT,
    body_format TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (folder_id) REFERENCES folders(id)
  );

  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    author_membership_id TEXT,
    title TEXT,
    body TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (folder_id) REFERENCES folders(id),
    FOREIGN KEY (author_membership_id) REFERENCES memberships(membership_id)
  );

  CREATE TABLE message_reads (
    message_read_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    read_at_ms INTEGER NOT NULL,
    UNIQUE (message_id, membership_id),
    FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
    FOREIGN KEY (membership_id) REFERENCES memberships(membership_id) ON DELETE CASCADE
  );

  CREATE TABLE message_comments (
    comment_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    membership_id TEXT,
    author_email TEXT,
    author_display_name TEXT,
    body TEXT NOT NULL,
    mentions TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE CASCADE,
    FOREIGN KEY (membership_id) REFERENCES memberships(membership_id) ON DELETE SET NULL
  );

  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    folder_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT,
    created_by_email TEXT,
    created_by_membership_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    due_at_ms INTEGER,
    legacy_task_id TEXT,
    meta_json TEXT,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (created_by_membership_id) REFERENCES memberships(membership_id)
  );

  CREATE TABLE task_assignees (
    task_id TEXT NOT NULL,
    email TEXT NOT NULL,
    membership_id TEXT,
    assigned_at_ms INTEGER NOT NULL,
    PRIMARY KEY (task_id, email),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (membership_id) REFERENCES memberships(membership_id)
  );

  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    file_name TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    storage_path TEXT,
    checksum TEXT,
    created_at_ms INTEGER NOT NULL,
    created_by_membership_id TEXT,
    extra_json TEXT,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (created_by_membership_id) REFERENCES memberships(membership_id)
  );

  CREATE TABLE task_attachments (
    task_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (task_id, attachment_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (attachment_id) REFERENCES attachments(attachment_id)
  );

  CREATE TABLE message_attachments (
    message_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    PRIMARY KEY (message_id, attachment_id),
    FOREIGN KEY (message_id) REFERENCES messages(message_id),
    FOREIGN KEY (attachment_id) REFERENCES attachments(attachment_id)
  );

  CREATE TABLE audit_logs (
    audit_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    actor_membership_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT,
    action TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    payload_json TEXT,
    request_id TEXT,
    request_payload_sha256 TEXT,
    request_generation_ms INTEGER,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (actor_membership_id) REFERENCES memberships(membership_id)
  );

  CREATE UNIQUE INDEX idx_audit_logs_request_action_target
    ON audit_logs(
      org_id,
      COALESCE(actor_membership_id, ''),
      request_id,
      action,
      COALESCE(target_id, ''),
      COALESCE(request_payload_sha256, ''),
      COALESCE(request_generation_ms, 0)
    )
    WHERE request_id IS NOT NULL AND request_id <> '';

  CREATE TABLE api_idempotency_keys (
    idempotency_key_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    route TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    UNIQUE (org_id, actor_user_id, request_id, route),
    CHECK (
      LENGTH(payload_sha256) = 64
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
  );

  CREATE TABLE storage_cleanup_jobs (
    job_id TEXT PRIMARY KEY,
    r2_key TEXT NOT NULL UNIQUE,
    org_id TEXT,
    target_type TEXT,
    target_id TEXT,
    reason TEXT NOT NULL,
    request_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    lease_token TEXT,
    lease_expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TRIGGER prevent_attachment_insert_during_cleanup_lease
  BEFORE INSERT ON attachments
  WHEN JSON_VALID(COALESCE(NEW.extra_json, '')) = 1
   AND EXISTS (
     SELECT 1
       FROM storage_cleanup_jobs cleanup_guard
      WHERE cleanup_guard.r2_key = JSON_EXTRACT(NEW.extra_json, '$.r2Key')
        AND cleanup_guard.org_id = NEW.org_id
        AND cleanup_guard.lease_token IS NOT NULL
   )
  BEGIN
    SELECT RAISE(ABORT, 'storage_cleanup_lease_active');
  END;

  CREATE TRIGGER prevent_attachment_update_during_cleanup_lease
  BEFORE UPDATE OF org_id, extra_json ON attachments
  WHEN JSON_VALID(COALESCE(NEW.extra_json, '')) = 1
   AND EXISTS (
     SELECT 1
       FROM storage_cleanup_jobs cleanup_guard
      WHERE cleanup_guard.r2_key = JSON_EXTRACT(NEW.extra_json, '$.r2Key')
        AND cleanup_guard.org_id = NEW.org_id
        AND cleanup_guard.lease_token IS NOT NULL
   )
  BEGIN
    SELECT RAISE(ABORT, 'storage_cleanup_lease_active');
  END;

  CREATE TABLE login_audits (
    login_id TEXT PRIMARY KEY,
    org_id TEXT,
    user_email TEXT,
    user_sub TEXT,
    status TEXT,
    reason TEXT,
    request_id TEXT,
    token_iat_ms INTEGER,
    attempted_at_ms INTEGER NOT NULL,
    client_ip TEXT,
    user_agent TEXT,
    role TEXT
  );

  CREATE TABLE auth_proxy_logs (
    log_id TEXT PRIMARY KEY,
    level TEXT,
    event TEXT,
    message TEXT,
    request_id TEXT,
    route TEXT,
    email TEXT,
    status TEXT,
    meta_json TEXT,
    source TEXT,
    client_ip TEXT,
    user_agent TEXT,
    cf_ray TEXT,
    created_at_ms INTEGER NOT NULL,
    org_id TEXT,
    user_id TEXT
  );

  CREATE TABLE auth_events (
    event_id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason_code TEXT,
    org_id TEXT,
    user_id TEXT,
    user_email TEXT,
    user_sub TEXT,
    status TEXT,
    role TEXT,
    request_id TEXT,
    route TEXT,
    source TEXT NOT NULL,
    session_fingerprint TEXT,
    occurred_at_ms INTEGER NOT NULL
  );
`;

function seedCollaborationFixture(db) {
  db.exec(`
    INSERT INTO organizations (org_id, name, created_at_ms) VALUES
      ('${IDS.orgA}', '組織A', ${NOW - 10_000}),
      ('${IDS.orgB}', '組織B', ${NOW - 9_000});

    INSERT INTO users (
      user_id, email, display_name, auth_subject, status, is_active, created_at_ms, updated_at_ms
    ) VALUES
      ('${IDS.userA}', 'user-a@example.com', 'ユーザーA', 'subject-a', 'active', 1, ${NOW - 8_000}, ${NOW - 8_000}),
      ('${IDS.userB}', 'user-b@example.com', 'ユーザーB', 'subject-b', 'active', 1, ${NOW - 7_000}, ${NOW - 7_000}),
      ('${IDS.userOther}', 'other@example.com', '別組織ユーザー', 'subject-other', 'active', 1, ${NOW - 6_000}, ${NOW - 6_000});

    INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES
      ('${IDS.memberA}', '${IDS.orgA}', '${IDS.userA}', 'manager', 'active', ${NOW - 5_000}),
      ('${IDS.memberB}', '${IDS.orgA}', '${IDS.userB}', 'member', 'active', ${NOW - 4_000}),
      ('${IDS.memberOther}', '${IDS.orgB}', '${IDS.userOther}', 'member', 'active', ${NOW - 3_000});

    INSERT INTO folders (
      id, org_id, name, sort_order, color, is_active, is_public, is_system, created_at_ms, updated_at_ms
    ) VALUES
      ('${IDS.publicFolder}', '${IDS.orgA}', '共有', 0, '#517CB2', 1, 1, 1, ${NOW - 3_000}, ${NOW - 3_000}),
      ('${IDS.privateFolder}', '${IDS.orgA}', '限定', 1, '#517CB2', 1, 0, 0, ${NOW - 2_000}, ${NOW - 2_000}),
      ('${IDS.otherFolder}', '${IDS.orgB}', '別組織', 0, '#517CB2', 1, 1, 1, ${NOW - 1_000}, ${NOW - 1_000});

    INSERT INTO folder_members (folder_id, user_id, added_at_ms)
      VALUES ('${IDS.privateFolder}', '${IDS.userA}', ${NOW - 1_000});

    INSERT INTO messages (
      message_id, org_id, folder_id, author_membership_id, title, body, priority,
      is_pinned, created_at_ms, updated_at_ms
    ) VALUES
      ('${IDS.publicMessage}', '${IDS.orgA}', '${IDS.publicFolder}', '${IDS.memberA}', '共有メッセージ', '本文', 'medium', 0, ${NOW - 900}, ${NOW - 900}),
      ('${IDS.privateMessage}', '${IDS.orgA}', '${IDS.privateFolder}', '${IDS.memberA}', '限定メッセージ', '本文', 'medium', 0, ${NOW - 800}, ${NOW - 800}),
      ('${IDS.otherMessage}', '${IDS.orgB}', '${IDS.otherFolder}', '${IDS.memberOther}', '別組織メッセージ', '本文', 'medium', 0, ${NOW - 700}, ${NOW - 700});
  `);
}

async function createFixture() {
  const DB = new SqliteD1();
  DB.exec(TEST_SCHEMA);
  DB.exec(PERSONAL_PINS_MIGRATION);
  DB.exec(STAGED_ATTACHMENTS_MIGRATION);
  DB.exec(SESSION_REVOCATIONS_MIGRATION);
  seedCollaborationFixture(DB);
  const APP_KV = new FakeKv();
  const env = {
    DB,
    APP_KV,
    CF_ORIGIN: ORIGIN,
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const actors = {};
  for (const [key, user] of Object.entries({
    userA: {
      sub: 'subject-a',
      email: 'user-a@example.com',
      name: 'ユーザーA',
    },
    userB: {
      sub: 'subject-b',
      email: 'user-b@example.com',
      name: 'ユーザーB',
    },
    other: {
      sub: 'subject-other',
      email: 'other@example.com',
      name: '別組織ユーザー',
    },
  })) {
    const created = await createSession(env, {
      user: { ...user, emailVerified: true },
    });
    actors[key] = {
      ...user,
      cookie: `SESSION=${created.sessionId}.${created.sessionKey}`,
    };
  }
  return { DB, env, actors };
}

async function installUntrackedSession(fixture, actor) {
  const sessionId = crypto.randomUUID();
  const sessionKey = 'B'.repeat(43);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionKey));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const now = Date.now();
  fixture.env.APP_KV.values.set(
    `sf:sessions:${sessionId}`,
    JSON.stringify({
      sessionVersion: 2,
      id: sessionId,
      hash,
      user: {
        sub: actor.sub,
        email: actor.email,
        emailVerified: true,
        name: actor.name,
      },
      createdAt: now - 60 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      lastAccessAt: now - 10 * 60 * 1000,
    })
  );
  actor.cookie = `SESSION=${sessionId}.${sessionKey}`;
}

async function apiRequest(fixture, actor, route, options = {}) {
  const method = options.method || 'GET';
  const search = typeof options.search === 'string' ? options.search : '';
  const headers = {
    origin: ORIGIN,
    cookie: actor.cookie,
  };
  if (options.requestId) {
    headers['x-shiftflow-request-id'] = options.requestId;
  }
  const requestOptions = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }
  const backgroundTasks = [];
  const response = await handleApiRequest({
    request: new Request(`${ORIGIN}/api/${route}${search}`, requestOptions),
    params: { route: route.split('/') },
    env: fixture.env,
    waitUntil(task) {
      backgroundTasks.push(Promise.resolve(task));
    },
  });
  const payload = await response.json();
  await Promise.allSettled(backgroundTasks);
  return { response, payload };
}

async function apiBinaryRequest(fixture, actor, route, options = {}) {
  const bytes =
    options.bytes instanceof Uint8Array ? options.bytes : new TextEncoder().encode('image-bytes');
  const headers = {
    origin: ORIGIN,
    cookie: actor.cookie,
    'content-type': options.mimeType || 'image/png',
    'x-shiftflow-request-id': options.requestId || crypto.randomUUID(),
    'x-shiftflow-file-name': encodeURIComponent(options.fileName || 'attachment.png'),
    'x-shiftflow-attachment-purpose': options.purpose || 'message',
  };
  if (options.includeContentLength !== false) {
    headers['content-length'] = String(options.contentLength ?? bytes.byteLength);
  }
  if (options.checksum) {
    headers['x-shiftflow-content-sha256'] = options.checksum;
  }
  const backgroundTasks = [];
  const response = await handleApiRequest({
    request: new Request(`${ORIGIN}/api/${route}`, {
      method: 'POST',
      headers,
      body: options.body ?? bytes,
      ...(options.duplex ? { duplex: options.duplex } : {}),
    }),
    params: { route: route.split('/') },
    env: fixture.env,
    waitUntil(task) {
      backgroundTasks.push(Promise.resolve(task));
    },
  });
  const payload = await response.json();
  await Promise.allSettled(backgroundTasks);
  return { response, payload };
}

async function stageTestAttachment(fixture, actor, options = {}) {
  const response = await apiBinaryRequest(fixture, actor, 'stageAttachment', {
    purpose: options.purpose || 'message',
    requestId: options.requestId || crypto.randomUUID(),
    fileName: options.fileName || 'attachment.png',
    mimeType: options.mimeType || 'image/png',
    bytes:
      options.bytes instanceof Uint8Array
        ? options.bytes
        : new TextEncoder().encode(options.text || 'image-bytes'),
    includeContentLength: options.includeContentLength,
    contentLength: options.contentLength,
    checksum: options.checksum,
    body: options.body,
    duplex: options.duplex,
  });
  assert.ok(
    response.response.status === 201 || response.response.status === 200,
    `staged upload failed: ${response.response.status} ${JSON.stringify(response.payload)}`
  );
  assert.ok(response.payload?.result?.stagedAttachmentId);
  return response.payload.result;
}

function findMessage(payload, messageId) {
  const rows = Array.isArray(payload?.result) ? payload.result : [];
  return rows.find((row) => row.id === messageId) || null;
}

function delayForDistinctTimestamp() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function insertStorageCleanupJob(db, options) {
  const createdAtMs = options.createdAtMs ?? NOW;
  const updatedAtMs = options.updatedAtMs ?? createdAtMs;
  await db
    .prepare(
      `
      INSERT INTO storage_cleanup_jobs (
        job_id, r2_key, org_id, target_type, target_id, reason, request_id,
        attempts, last_error, lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `
    )
    .bind(
      options.jobId,
      options.r2Key,
      options.orgId ?? null,
      options.targetType || 'attachment',
      options.targetId || null,
      options.reason || 'test_cleanup',
      options.requestId || null,
      options.attempts || 0,
      options.lastError || null,
      options.leaseToken || null,
      options.leaseExpiresAtMs ?? null,
      createdAtMs,
      updatedAtMs
    )
    .run();
}

test('個人ピンは本人だけに見え、明示的なpin=trueを再送しても冪等である', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const firstPin = await apiRequest(fixture, fixture.actors.userA, `messages/${IDS.publicMessage}/pin`, {
    method: 'POST',
    body: { pin: true },
  });
  assert.equal(firstPin.response.status, 200);
  assert.equal(firstPin.payload.result.isPinned, true);

  const repeatedPin = await apiRequest(
    fixture,
    fixture.actors.userA,
    `messages/${IDS.publicMessage}/pin`,
    { method: 'POST', body: { pin: true } }
  );
  assert.equal(repeatedPin.response.status, 200);
  assert.equal(repeatedPin.payload.result.isPinned, true);
  assert.equal(repeatedPin.payload.result.changed, false);

  const pins = fixture.DB.all(
    'SELECT message_id, membership_id, org_id FROM message_pins WHERE message_id = ?1',
    IDS.publicMessage
  );
  assert.equal(pins.length, 1);
  assert.equal(pins[0].membership_id, IDS.memberA);
  assert.equal(pins[0].org_id, IDS.orgA);

  const listA = await apiRequest(fixture, fixture.actors.userA, 'messages');
  const listB = await apiRequest(fixture, fixture.actors.userB, 'messages');
  assert.equal(listA.response.status, 200);
  assert.equal(listB.response.status, 200);
  assert.equal(findMessage(listA.payload, IDS.publicMessage)?.isPinned, true);
  assert.equal(findMessage(listB.payload, IDS.publicMessage)?.isPinned, false);

  const audits = fixture.DB.all(
    "SELECT action FROM audit_logs WHERE target_id = ?1 AND action = 'message.pin'",
    IDS.publicMessage
  );
  assert.equal(audits.length, 1);

  const unpin = await apiRequest(fixture, fixture.actors.userA, `messages/${IDS.publicMessage}/pin`, {
    method: 'POST',
    body: { pin: false },
  });
  assert.equal(unpin.response.status, 200);
  assert.equal(unpin.payload.result.isPinned, false);
  assert.equal(unpin.payload.result.changed, true);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_pins WHERE message_id = ?1 AND membership_id = ?2',
      IDS.publicMessage,
      IDS.memberA
    ).count,
    0
  );
});

test('private folderの非メンバーは個人ピンを作成できない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const denied = await apiRequest(
    fixture,
    fixture.actors.userB,
    `messages/${IDS.privateMessage}/pin`,
    { method: 'POST', body: { pin: true } }
  );
  assert.equal(denied.response.status, 403);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_pins WHERE message_id = ?1 AND membership_id = ?2',
      IDS.privateMessage,
      IDS.memberB
    ).count,
    0
  );
});

test('他組織のメッセージには個人ピンを作成できない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const denied = await apiRequest(
    fixture,
    fixture.actors.userA,
    `messages/${IDS.otherMessage}/pin`,
    { method: 'POST', body: { pin: true } }
  );
  assert.equal(denied.response.status, 404);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_pins WHERE message_id = ?1',
      IDS.otherMessage
    ).count,
    0
  );
});

test('既読更新はmessage orgとprivate folder権限を必須化しbulk混在を全件rollbackする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const privateMark = await apiRequest(fixture, fixture.actors.userB, 'markMemoAsRead', {
    method: 'POST',
    requestId: 'memo-private-mark-denied',
    body: { args: [IDS.privateMessage] },
  });
  const privateToggle = await apiRequest(fixture, fixture.actors.userB, 'toggleMemoRead', {
    method: 'POST',
    requestId: 'memo-private-toggle-denied',
    body: { args: [IDS.privateMessage, true] },
  });
  assert.deepEqual(
    [privateMark.response.status, privateToggle.response.status],
    [403, 403]
  );
  assert.equal(privateMark.payload.code, 'folder_access_denied');
  assert.equal(privateToggle.payload.code, 'folder_access_denied');

  const crossMark = await apiRequest(fixture, fixture.actors.userB, 'markMemoAsRead', {
    method: 'POST',
    requestId: 'memo-cross-mark-denied',
    body: { args: [IDS.otherMessage] },
  });
  const crossToggle = await apiRequest(fixture, fixture.actors.userB, 'toggleMemoRead', {
    method: 'POST',
    requestId: 'memo-cross-toggle-denied',
    body: { args: [IDS.otherMessage, true] },
  });
  assert.deepEqual(
    [crossMark.response.status, crossToggle.response.status],
    [404, 404]
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE membership_id = ?1',
      IDS.memberB
    ).count,
    0
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id LIKE 'memo-%-denied'"
    ).count,
    0
  );

  const mixedPrivate = await apiRequest(
    fixture,
    fixture.actors.userB,
    'markMemosReadBulk',
    {
      method: 'POST',
      requestId: 'memo-bulk-private-denied',
      body: { args: [[IDS.publicMessage, IDS.privateMessage]] },
    }
  );
  assert.equal(mixedPrivate.response.status, 403);
  assert.equal(mixedPrivate.payload.code, 'folder_access_denied');
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE membership_id = ?1',
      IDS.memberB
    ).count,
    0
  );

  const mixedCrossOrg = await apiRequest(
    fixture,
    fixture.actors.userB,
    'markMemosReadBulk',
    {
      method: 'POST',
      requestId: 'memo-bulk-cross-denied',
      body: { args: [[IDS.publicMessage, IDS.otherMessage]] },
    }
  );
  assert.equal(mixedCrossOrg.response.status, 404);
  assert.equal(mixedCrossOrg.payload.code, 'message_not_found');
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE membership_id = ?1',
      IDS.memberB
    ).count,
    0
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id LIKE 'memo-%-denied'"
    ).count,
    0
  );

  // managerはprivate folderの明示メンバーでなくても既読更新できる。
  await fixture.DB
    .prepare('DELETE FROM folder_members WHERE folder_id = ?1 AND user_id = ?2')
    .bind(IDS.privateFolder, IDS.userA)
    .run();
  const managerAllowed = await apiRequest(fixture, fixture.actors.userA, 'markMemoAsRead', {
    method: 'POST',
    requestId: 'memo-private-manager-allowed',
    body: { args: [IDS.privateMessage] },
  });
  assert.equal(managerAllowed.response.status, 200);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE message_id = ?1 AND membership_id = ?2',
      IDS.privateMessage,
      IDS.memberA
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      'memo-private-manager-allowed'
    ).count,
    1
  );
});

test('既読時刻は古い更新要求でも巻き戻らない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const firstRead = await apiRequest(fixture, fixture.actors.userA, 'markMemoAsRead', {
    method: 'POST',
    body: { args: [IDS.publicMessage] },
  });
  assert.equal(firstRead.response.status, 200);

  const futureReadAt = Date.now() + 60_000;
  fixture.DB.exec(
    `UPDATE message_reads SET read_at_ms = ${futureReadAt} ` +
      `WHERE message_id = '${IDS.publicMessage}' AND membership_id = '${IDS.memberA}';`
  );
  fixture.DB.exec(`
    CREATE TABLE read_write_probe (message_id TEXT);
    CREATE TRIGGER probe_read_update AFTER UPDATE ON message_reads
    BEGIN INSERT INTO read_write_probe VALUES (NEW.message_id); END;
  `);
  const repeatedRead = await apiRequest(fixture, fixture.actors.userA, 'markMemoAsRead', {
    method: 'POST',
    body: { args: [IDS.publicMessage] },
  });
  assert.equal(repeatedRead.response.status, 200);
  assert.equal(
    fixture.DB.get(
      'SELECT read_at_ms FROM message_reads WHERE message_id = ?1 AND membership_id = ?2',
      IDS.publicMessage,
      IDS.memberA
    ).read_at_ms,
    futureReadAt
  );
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM read_write_probe').count, 0);
});

test('他ユーザーのコメント更新を一覧へ返し、閲覧後は新着状態を解除する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const contenders = Array.from({ length: 30 }, (_, ix) => `competing-message-${ix}`);
  for (const [ix, id] of contenders.entries()) {
    await fixture.DB.prepare(`
      INSERT INTO messages(message_id, org_id, folder_id, title, body, created_at_ms, updated_at_ms)
      VALUES (?1, ?2, ?3, '先に表示される投稿', '', ?4, ?4)
    `).bind(id, IDS.orgA, IDS.publicFolder, NOW + 60000 + ix).run();
  }
  const beforeComment = await apiRequest(fixture, fixture.actors.userA, 'messages');
  const topBefore = beforeComment.payload.result.slice(0, 20);
  assert.ok(!topBefore.some((row) => row.id === IDS.publicMessage || row.memoId === IDS.publicMessage));
  const initialRead = await apiRequest(fixture, fixture.actors.userA, 'markMemoAsRead', {
    method: 'POST',
    body: { args: [IDS.publicMessage] },
  });
  assert.equal(initialRead.response.status, 200);

  await delayForDistinctTimestamp();
  const comment = await apiRequest(fixture, fixture.actors.userB, 'addNewComment', {
    method: 'POST',
    body: {
      args: [{ memoId: IDS.publicMessage, body: 'ユーザーBからのコメント' }],
    },
  });
  assert.equal(comment.response.status, 200);
  assert.equal(comment.payload.success, true);

  const afterComment = await apiRequest(fixture, fixture.actors.userA, 'messages');
  assert.equal(afterComment.response.status, 200);
  const updatedForA = findMessage(afterComment.payload, IDS.publicMessage);
  assert.ok(updatedForA);
  assert.deepEqual(afterComment.payload.result[0], updatedForA);
  assert.equal(updatedForA.commentCount, 1);
  assert.ok(Number(updatedForA.lastCommentAt) > 0);
  assert.equal(updatedForA.hasNewComment, true);

  const unreadAfterComment = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    search: '?unreadOnly=1',
  });
  assert.ok(findMessage(unreadAfterComment.payload, IDS.publicMessage));

  await delayForDistinctTimestamp();
  const readAgain = await apiRequest(fixture, fixture.actors.userA, 'markMemoAsRead', {
    method: 'POST',
    body: { args: [IDS.publicMessage] },
  });
  assert.equal(readAgain.response.status, 200);

  const afterRead = await apiRequest(fixture, fixture.actors.userA, 'messages');
  const clearedForA = findMessage(afterRead.payload, IDS.publicMessage);
  assert.equal(clearedForA.commentCount, 1);
  assert.equal(clearedForA.lastCommentAt, updatedForA.lastCommentAt);
  assert.equal(clearedForA.hasNewComment, false);

  const unreadAfterRead = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    search: '?unreadOnly=1',
  });
  assert.equal(findMessage(unreadAfterRead.payload, IDS.publicMessage), null);
});

test('フォルダCRUDは再送を重複させず本体と業務監査を同じbatchで保存する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const createOptions = {
    method: 'POST',
    requestId: 'folder-create-1',
    body: { name: 'v2フォルダ', color: '#123456', isPublic: true },
  };
  const created = await apiRequest(fixture, fixture.actors.userA, 'folders', createOptions);
  const replayed = await apiRequest(fixture, fixture.actors.userA, 'folders', createOptions);
  assert.equal(created.response.status, 201);
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.payload.result.idempotentReplay, true);
  const folderId = created.payload.result.id;
  assert.equal(replayed.payload.result.id, folderId);

  const updated = await apiRequest(fixture, fixture.actors.userA, `folders/${folderId}`, {
    method: 'PATCH',
    requestId: 'folder-update-1',
    body: { name: 'v2フォルダ更新' },
  });
  assert.equal(updated.response.status, 200);
  const archived = await apiRequest(fixture, fixture.actors.userA, `folders/${folderId}`, {
    method: 'DELETE',
    requestId: 'folder-archive-1',
  });
  assert.equal(archived.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM folders WHERE id = ?1', folderId).count,
    1
  );
  assert.equal(fixture.DB.get('SELECT is_active FROM folders WHERE id = ?1', folderId).is_active, 0);
  assert.deepEqual(
    fixture.DB
      .all('SELECT action FROM audit_logs WHERE target_id = ?1 ORDER BY action', folderId)
      .map((row) => row.action),
    ['folder.archive', 'folder.create', 'folder.update']
  );
  const auditView = await apiRequest(fixture, fixture.actors.userA, 'getAuditLogs', {
    method: 'POST',
    body: { args: [150, { range: '24h', eventType: 'admin', orgId: IDS.orgA }] },
  });
  const folderLabels = (auditView.payload?.result?.rows || [])
    .filter((row) => row.meta?.targetId === folderId)
    .map((row) => row.eventLabel)
    .sort();
  assert.deepEqual(folderLabels, ['フォルダアーカイブ', 'フォルダ作成', 'フォルダ更新']);
});

test('フォルダ更新batchの失敗は本体と監査をともにrollbackする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let injectFailure = true;
  fixture.DB.batch = async (statements) => {
    if (!injectFailure) return originalBatch(statements);
    injectFailure = false;
    const duplicateOrg = fixture.DB
      .prepare('INSERT INTO organizations (org_id, name, created_at_ms) VALUES (?1, ?2, ?3)')
      .bind(IDS.orgA, '重複', NOW);
    return originalBatch([...statements, duplicateOrg]);
  };
  const failed = await apiRequest(
    fixture,
    fixture.actors.userA,
    `folders/${IDS.privateFolder}`,
    {
      method: 'PATCH',
      requestId: 'folder-update-failure',
      body: { name: '保存されない名前', memberUserIds: [IDS.userB] },
    }
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.code, 'folder_update_failed');
  assert.equal(
    fixture.DB.get('SELECT name FROM folders WHERE id = ?1', IDS.privateFolder).name,
    '限定'
  );
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'folder-update-failure'")
      .count,
    0
  );
});

test('組織・ユーザー管理更新は対応する業務監査と同時に保存する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const orgUpdate = await apiRequest(fixture, fixture.actors.userA, 'adminUpdateOrganization', {
    method: 'POST',
    requestId: 'admin-org-update-1',
    body: {
      args: [
        {
          orgId: IDS.orgA,
          name: '組織A v2',
          shortName: 'A2',
          displayColor: '#234567',
          timezone: 'Asia/Tokyo',
        },
      ],
    },
  });
  assert.equal(orgUpdate.response.status, 200);
  assert.equal(fixture.DB.get('SELECT name FROM organizations WHERE org_id = ?1', IDS.orgA).name, '組織A v2');
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'admin-org-update-1'")
      .count,
    1
  );

  const userUpdate = await apiRequest(fixture, fixture.actors.userA, 'adminUpdateUser', {
    method: 'POST',
    requestId: 'admin-user-update-1',
    body: { args: [{ userId: IDS.userB, role: 'manager' }] },
  });
  assert.equal(userUpdate.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT role FROM memberships WHERE membership_id = ?1', IDS.memberB).role,
    'manager'
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'admin-user-update-1' AND action = 'user_role_update'"
    ).count,
    1
  );
});

test('メッセージ作成は本体・既読・業務監査を同一transactionで保存する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const beforeMessages = fixture.DB.get('SELECT COUNT(*) AS count FROM messages').count;

  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    body: {
      args: [
        {
          title: '原子的な投稿',
          body: '監査行まで一括保存する',
          folderId: IDS.publicFolder,
        },
      ],
    },
  });
  assert.equal(created.response.status, 200);
  const messageId = created.payload.memoId;
  assert.ok(messageId);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM messages WHERE message_id = ?1', messageId).count,
    1
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE message_id = ?1 AND membership_id = ?2',
      messageId,
      IDS.memberA
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?1 AND action = 'message.create'",
      messageId
    ).count,
    1
  );
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM messages').count, beforeMessages + 1);
});

test('同じrequest idの作成再送はメッセージ・タスク・監査を重複させない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const messageOptions = {
    method: 'POST',
    requestId: 'idem-message-1',
    body: {
      args: [{ title: '冪等メッセージ', body: '同じ要求', folderId: IDS.publicFolder }],
    },
  };
  const firstMessage = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewMessage',
    messageOptions
  );
  const replayedMessage = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewMessage',
    messageOptions
  );
  assert.equal(firstMessage.response.status, 200);
  assert.equal(replayedMessage.response.status, 200);
  assert.equal(replayedMessage.payload.memoId, firstMessage.payload.memoId);
  assert.equal(replayedMessage.payload.idempotentReplay, true);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM messages WHERE message_id = ?1', firstMessage.payload.memoId)
      .count,
    1
  );
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'idem-message-1'")
      .count,
    1
  );

  const taskOptions = {
    method: 'POST',
    requestId: 'idem-task-1',
    body: { args: [{ title: '冪等タスク', assignees: ['user-b@example.com'] }] },
  };
  const firstTask = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', taskOptions);
  const replayedTask = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', taskOptions);
  assert.equal(firstTask.response.status, 200);
  assert.equal(replayedTask.response.status, 200);
  assert.equal(replayedTask.payload.taskId, firstTask.payload.taskId);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?1', firstTask.payload.taskId)
      .count,
    1
  );
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'idem-task-1'").count,
    1
  );

  const commentOptions = {
    method: 'POST',
    requestId: 'idem-comment-1',
    body: { args: [{ memoId: IDS.publicMessage, body: '一度だけ保存するコメント' }] },
  };
  const firstComment = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewComment',
    commentOptions
  );
  const replayedComment = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewComment',
    commentOptions
  );
  assert.equal(firstComment.response.status, 200);
  assert.equal(replayedComment.response.status, 200);
  assert.equal(replayedComment.payload.result.commentId, firstComment.payload.result.commentId);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_comments WHERE comment_id = ?1',
      firstComment.payload.result.commentId
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'idem-comment-1'")
      .count,
    1
  );
});

test('同一orgの別actorが同じrequest idを使ってもtask・message・commentを混同しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const taskRequestId = 'shared-actor-task';
  const taskA = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: taskRequestId,
    body: { args: [{ title: 'Aのタスク', assignees: ['user-a@example.com'] }] },
  });
  const taskB = await apiRequest(fixture, fixture.actors.userB, 'addNewTask', {
    method: 'POST',
    requestId: taskRequestId,
    body: { args: [{ title: 'Bのタスク', assignees: ['user-b@example.com'] }] },
  });
  assert.equal(taskA.response.status, 200);
  assert.equal(taskB.response.status, 200);
  assert.notEqual(taskA.payload.taskId, taskB.payload.taskId);
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT task_id, created_by_membership_id, title
           FROM tasks
          WHERE task_id IN (?1, ?2)
          ORDER BY title`,
        taskA.payload.taskId,
        taskB.payload.taskId
      )
      .map((row) => [row.title, row.created_by_membership_id]),
    [
      ['Aのタスク', IDS.memberA],
      ['Bのタスク', IDS.memberB],
    ]
  );
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT task_id, email
           FROM task_assignees
          WHERE task_id IN (?1, ?2)
          ORDER BY task_id`,
        taskA.payload.taskId,
        taskB.payload.taskId
      )
      .map((row) => [row.task_id, row.email])
      .sort((a, b) => a[1].localeCompare(b[1])),
    [
      [taskA.payload.taskId, 'user-a@example.com'],
      [taskB.payload.taskId, 'user-b@example.com'],
    ]
  );

  const messageRequestId = 'shared-actor-message';
  const messageA = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: messageRequestId,
    body: { args: [{ title: 'Aの投稿', body: 'A', folderId: IDS.publicFolder }] },
  });
  const messageB = await apiRequest(fixture, fixture.actors.userB, 'addNewMessage', {
    method: 'POST',
    requestId: messageRequestId,
    body: { args: [{ title: 'Bの投稿', body: 'B', folderId: IDS.publicFolder }] },
  });
  assert.equal(messageA.response.status, 200);
  assert.equal(messageB.response.status, 200);
  assert.notEqual(messageA.payload.memoId, messageB.payload.memoId);
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT title, author_membership_id
           FROM messages
          WHERE message_id IN (?1, ?2)
          ORDER BY title`,
        messageA.payload.memoId,
        messageB.payload.memoId
      )
      .map((row) => [row.title, row.author_membership_id]),
    [
      ['Aの投稿', IDS.memberA],
      ['Bの投稿', IDS.memberB],
    ]
  );

  const commentRequestId = 'shared-actor-comment';
  const commentA = await apiRequest(fixture, fixture.actors.userA, 'addNewComment', {
    method: 'POST',
    requestId: commentRequestId,
    body: { args: [{ memoId: IDS.publicMessage, body: 'Aのコメント' }] },
  });
  const commentB = await apiRequest(fixture, fixture.actors.userB, 'addNewComment', {
    method: 'POST',
    requestId: commentRequestId,
    body: { args: [{ memoId: IDS.publicMessage, body: 'Bのコメント' }] },
  });
  assert.equal(commentA.response.status, 200);
  assert.equal(commentB.response.status, 200);
  assert.notEqual(commentA.payload.result.commentId, commentB.payload.result.commentId);
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT body, membership_id
           FROM message_comments
          WHERE comment_id IN (?1, ?2)
          ORDER BY body`,
        commentA.payload.result.commentId,
        commentB.payload.result.commentId
      )
      .map((row) => [row.body, row.membership_id]),
    [
      ['Aのコメント', IDS.memberA],
      ['Bのコメント', IDS.memberB],
    ]
  );

  for (const [requestId, action] of [
    [taskRequestId, 'task.create'],
    [messageRequestId, 'message.create'],
    [commentRequestId, 'message.comment'],
  ]) {
    assert.deepEqual(
      fixture.DB
        .all(
          'SELECT actor_membership_id FROM audit_logs WHERE request_id = ?1 AND action = ?2 ORDER BY actor_membership_id',
          requestId,
          action
        )
        .map((row) => row.actor_membership_id),
      [IDS.memberA, IDS.memberB]
    );
  }
});

test('actor別監査indexは同一message・request idの個人pinを2件とも保持する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const requestId = 'shared-actor-pin';
  const pinA = await apiRequest(fixture, fixture.actors.userA, `messages/${IDS.publicMessage}/pin`, {
    method: 'POST',
    requestId,
    body: { pin: true },
  });
  const pinB = await apiRequest(fixture, fixture.actors.userB, `messages/${IDS.publicMessage}/pin`, {
    method: 'POST',
    requestId,
    body: { pin: true },
  });
  assert.equal(pinA.response.status, 200);
  assert.equal(pinB.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM message_pins WHERE message_id = ?1', IDS.publicMessage)
      .count,
    2
  );
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT actor_membership_id
           FROM audit_logs
          WHERE request_id = ?1
            AND action = 'message.pin'
          ORDER BY actor_membership_id`,
        requestId
      )
      .map((row) => row.actor_membership_id),
    [IDS.memberA, IDS.memberB]
  );
});

test('別actorの同一request idはfolder member・template・R2添付・profile画像を分離する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'manager' WHERE membership_id = ?1")
    .bind(IDS.memberB)
    .run();
  const objects = new Map();
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => objects.delete(key));
    },
  };

  const folderRequestId = 'shared-actor-folder';
  const folderA = await apiRequest(fixture, fixture.actors.userA, 'folders', {
    method: 'POST',
    requestId: folderRequestId,
    body: { name: 'A限定', isPublic: false, memberUserIds: [IDS.userA] },
  });
  const folderB = await apiRequest(fixture, fixture.actors.userB, 'folders', {
    method: 'POST',
    requestId: folderRequestId,
    body: { name: 'B限定', isPublic: false, memberUserIds: [IDS.userB] },
  });
  assert.equal(folderA.response.status, 201);
  assert.equal(folderB.response.status, 201);
  assert.notEqual(folderA.payload.result.id, folderB.payload.result.id);
  assert.deepEqual(
    fixture.DB
      .all(
        'SELECT folder_id, user_id FROM folder_members WHERE folder_id IN (?1, ?2) ORDER BY user_id',
        folderA.payload.result.id,
        folderB.payload.result.id
      )
      .map((row) => [row.folder_id, row.user_id]),
    [
      [folderA.payload.result.id, IDS.userA],
      [folderB.payload.result.id, IDS.userB],
    ]
  );

  const templateRequestId = 'shared-actor-template';
  const templateA = await apiRequest(fixture, fixture.actors.userA, 'templates', {
    method: 'POST',
    requestId: templateRequestId,
    body: { folderId: IDS.publicFolder, name: 'Aテンプレート', titleFormat: 'A' },
  });
  const templateB = await apiRequest(fixture, fixture.actors.userB, 'templates', {
    method: 'POST',
    requestId: templateRequestId,
    body: { folderId: IDS.publicFolder, name: 'Bテンプレート', titleFormat: 'B' },
  });
  assert.equal(templateA.response.status, 201);
  assert.equal(templateB.response.status, 201);
  assert.notEqual(templateA.payload.result.id, templateB.payload.result.id);
  assert.deepEqual(
    fixture.DB
      .all('SELECT name, title_format FROM templates ORDER BY name')
      .map((row) => [row.name, row.title_format]),
    [
      ['Aテンプレート', 'A'],
      ['Bテンプレート', 'B'],
    ]
  );

  const attachmentRequestId = 'shared-actor-attachment';
  const stagedA = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'shared-actor-stage',
    fileName: 'proof.png',
    text: 'hello',
  });
  const stagedB = await stageTestAttachment(fixture, fixture.actors.userB, {
    purpose: 'message',
    requestId: 'shared-actor-stage',
    fileName: 'proof.png',
    text: 'world',
  });
  const messageA = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: attachmentRequestId,
    body: {
      args: [
        {
          title: 'A添付',
          body: 'A',
          folderId: IDS.publicFolder,
          attachments: [{ stagedAttachmentId: stagedA.stagedAttachmentId }],
        },
      ],
    },
  });
  const messageB = await apiRequest(fixture, fixture.actors.userB, 'addNewMessage', {
    method: 'POST',
    requestId: attachmentRequestId,
    body: {
      args: [
        {
          title: 'B添付',
          body: 'B',
          folderId: IDS.publicFolder,
          attachments: [{ stagedAttachmentId: stagedB.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(messageA.response.status, 200);
  assert.equal(messageB.response.status, 200);
  const attachmentRows = fixture.DB.all(
    `SELECT ma.message_id,
            a.attachment_id,
            a.created_by_membership_id,
            a.checksum,
            a.extra_json
       FROM message_attachments ma
       JOIN attachments a ON a.attachment_id = ma.attachment_id
      WHERE ma.message_id IN (?1, ?2)
      ORDER BY ma.message_id`,
    messageA.payload.memoId,
    messageB.payload.memoId
  );
  assert.equal(attachmentRows.length, 2);
  assert.notEqual(attachmentRows[0].attachment_id, attachmentRows[1].attachment_id);
  assert.notEqual(attachmentRows[0].checksum, attachmentRows[1].checksum);
  assert.deepEqual(
    attachmentRows.map((row) => row.created_by_membership_id).sort(),
    [IDS.memberA, IDS.memberB]
  );
  const attachmentKeys = attachmentRows.map((row) => JSON.parse(row.extra_json).r2Key);
  assert.notEqual(attachmentKeys[0], attachmentKeys[1]);
  attachmentKeys.forEach((key) => assert.equal(objects.has(key), true));

  const rowForA = attachmentRows.find((row) => row.created_by_membership_id === IDS.memberA);
  const rowForB = attachmentRows.find((row) => row.created_by_membership_id === IDS.memberB);
  const keyForA = JSON.parse(rowForA.extra_json).r2Key;
  const keyForB = JSON.parse(rowForB.extra_json).r2Key;
  const deletedA = await apiRequest(fixture, fixture.actors.userA, 'deleteMessageById', {
    method: 'POST',
    requestId: 'delete-a-attachment',
    body: { args: [messageA.payload.memoId] },
  });
  assert.equal(deletedA.response.status, 200);
  assert.equal(objects.has(keyForA), false);
  assert.equal(objects.has(keyForB), true);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1', rowForB.attachment_id)
      .count,
    1
  );

  const profileRequestId = 'shared-actor-profile';
  const profileStageA = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'shared-actor-profile-stage',
    fileName: 'profile-a.png',
    text: 'profile-a',
  });
  const profileStageB = await stageTestAttachment(fixture, fixture.actors.userB, {
    purpose: 'profile',
    requestId: 'shared-actor-profile-stage',
    fileName: 'profile-b.png',
    text: 'profile-b',
  });
  const profileA = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: profileRequestId,
    body: { args: [{ stagedAttachmentId: profileStageA.stagedAttachmentId, expectedSettingsVersion: '0' }] },
  });
  const profileB = await apiRequest(fixture, fixture.actors.userB, 'saveUserSettings', {
    method: 'POST',
    requestId: profileRequestId,
    body: { args: [{ stagedAttachmentId: profileStageB.stagedAttachmentId, expectedSettingsVersion: '0' }] },
  });
  assert.equal(profileA.response.status, 200);
  assert.equal(profileB.response.status, 200);
  const profileRows = fixture.DB.all(
    `SELECT attachment_id, created_by_membership_id, extra_json
       FROM attachments
      WHERE JSON_EXTRACT(extra_json, '$.category') = 'profile_image'
      ORDER BY created_by_membership_id`
  );
  assert.equal(profileRows.length, 2);
  assert.notEqual(profileRows[0].attachment_id, profileRows[1].attachment_id);
  const profileKeys = profileRows.map((row) => JSON.parse(row.extra_json).r2Key);
  assert.notEqual(profileKeys[0], profileKeys[1]);
  profileKeys.forEach((key) => assert.equal(objects.has(key), true));
  assert.deepEqual(
    fixture.DB
      .all(
        `SELECT actor_membership_id
           FROM audit_logs
          WHERE request_id = ?1
            AND action = 'user_settings.update'
          ORDER BY actor_membership_id`,
        profileRequestId
      )
      .map((row) => row.actor_membership_id),
    [IDS.memberA, IDS.memberB]
  );
});

test('同一stage/message requestの同時再送は同じR2 objectとmessageへ収束する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const putKeys = [];
  const deletedKeys = [];
  const arrivals = [createDeferred(), createDeferred()];
  const releases = [createDeferred(), createDeferred()];
  fixture.env.R2 = {
    async put(key, value) {
      const index = putKeys.length;
      putKeys.push(key);
      objects.set(key, value);
      arrivals[index]?.resolve();
      await releases[index]?.promise;
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const stageRequestId = 'concurrent-message-stage';
  const stageBytes = new TextEncoder().encode('hello');
  const firstStagePromise = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: stageRequestId,
    fileName: 'same.png',
    bytes: stageBytes,
  });
  await arrivals[0].promise;
  const secondStagePromise = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: stageRequestId,
    fileName: 'same.png',
    bytes: stageBytes,
  });
  await arrivals[1].promise;
  releases[0].resolve();
  const firstStage = await firstStagePromise;
  releases[1].resolve();
  const secondStage = await secondStagePromise;
  assert.deepEqual([firstStage.response.status, secondStage.response.status], [201, 200]);
  const stagedAttachmentId = firstStage.payload.result.stagedAttachmentId;
  assert.equal(secondStage.payload.result.stagedAttachmentId, stagedAttachmentId);

  const options = {
    method: 'POST',
    requestId: 'concurrent-message-generation',
    body: {
      args: [
        {
          title: '同時再送',
          body: '同じ内容',
          folderId: IDS.publicFolder,
          attachments: [{ stagedAttachmentId }],
        },
      ],
    },
  };

  const [first, second] = await Promise.all([
    apiRequest(fixture, fixture.actors.userA, 'addNewMessage', options),
    apiRequest(fixture, fixture.actors.userA, 'addNewMessage', options),
  ]);

  assert.deepEqual(
    [first.response.status, second.response.status],
    [200, 200],
    JSON.stringify([first.payload, second.payload])
  );
  assert.equal(first.payload.memoId, second.payload.memoId);
  assert.equal(putKeys.length, 2);
  assert.equal(putKeys[0], putKeys[1]);
  const canonical = fixture.DB.get(
    `SELECT a.extra_json
       FROM message_attachments ma
       JOIN attachments a ON a.attachment_id = ma.attachment_id
      WHERE ma.message_id = ?1`,
    first.payload.memoId
  );
  assert.equal(JSON.parse(canonical.extra_json).r2Key, putKeys[0]);
  assert.equal(objects.has(putKeys[0]), true);
  assert.deepEqual(deletedKeys, []);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count,
    0
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'message.create' AND request_id = ?1",
      options.requestId
    ).count,
    1
  );

  const replay = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', options);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(putKeys.length, 2);
});

test('同一profile stage/save requestの同時再送は同じR2 objectと設定versionへ収束する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const putKeys = [];
  const deletedKeys = [];
  const arrivals = [createDeferred(), createDeferred()];
  const releases = [createDeferred(), createDeferred()];
  fixture.env.R2 = {
    async put(key, value) {
      const index = putKeys.length;
      putKeys.push(key);
      objects.set(key, value);
      arrivals[index]?.resolve();
      await releases[index]?.promise;
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const stageRequestId = 'concurrent-profile-stage';
  const stageBytes = new TextEncoder().encode('profile');
  const firstStagePromise = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'profile',
    requestId: stageRequestId,
    fileName: 'profile.png',
    bytes: stageBytes,
  });
  await arrivals[0].promise;
  const secondStagePromise = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'profile',
    requestId: stageRequestId,
    fileName: 'profile.png',
    bytes: stageBytes,
  });
  await arrivals[1].promise;
  releases[0].resolve();
  const firstStage = await firstStagePromise;
  releases[1].resolve();
  const secondStage = await secondStagePromise;
  assert.deepEqual([firstStage.response.status, secondStage.response.status], [201, 200]);
  const stagedAttachmentId = firstStage.payload.result.stagedAttachmentId;
  assert.equal(secondStage.payload.result.stagedAttachmentId, stagedAttachmentId);

  const options = {
    method: 'POST',
    requestId: 'concurrent-profile-generation',
    body: {
      args: [
        {
          name: '同時プロフィール',
          theme: 'dark',
          language: 'ja',
          stagedAttachmentId,
          expectedSettingsVersion: '0',
        },
      ],
    },
  };

  const [first, second] = await Promise.all([
    apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', options),
    apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', options),
  ]);

  assert.deepEqual(
    [first.response.status, second.response.status],
    [200, 200],
    JSON.stringify([first.payload, second.payload])
  );
  assert.equal(putKeys.length, 2);
  assert.equal(putKeys[0], putKeys[1]);
  const user = fixture.DB.get(
    'SELECT profile_image_url, settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  );
  const attachmentId = new URL(user.profile_image_url, ORIGIN).searchParams.get('attachmentId');
  const canonical = fixture.DB.get(
    'SELECT extra_json FROM attachments WHERE attachment_id = ?1',
    attachmentId
  );
  assert.equal(JSON.parse(canonical.extra_json).r2Key, putKeys[0]);
  assert.equal(user.settings_version, first.payload.result.settingsVersion);
  // 同時処理ではどちらのrequestが先に確定するかは固定されない。
  assert.equal(
    [first, second].filter((packet) => packet.payload.result.idempotentReplay === true).length,
    1
  );
  assert.equal(first.payload.result.settingsVersion, second.payload.result.settingsVersion);
  assert.equal(objects.has(putKeys[0]), true);
  assert.deepEqual(deletedKeys, []);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count, 0);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'user_settings.update' AND request_id = ?1",
      options.requestId
    ).count,
    1
  );

  const replay = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', options);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.result.idempotentReplay, true);
  assert.equal(putKeys.length, 2);
});

test('profile stage中のログイン時刻更新は設定version競合にしない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const arrived = createDeferred();
  const release = createDeferred();
  const objects = new Map();
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
      arrived.resolve();
      await release.promise;
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const authUpdatedAt = Date.now() + 60_000;
  const stageRequest = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'profile',
    requestId: 'profile-login-timestamp-race',
    fileName: 'login.png',
    bytes: new TextEncoder().encode('login'),
  });
  await arrived.promise;
  fixture.DB
    .prepare('UPDATE users SET updated_at_ms = ?1 WHERE user_id = ?2')
    .bind(authUpdatedAt, IDS.userA)
    .run();
  release.resolve();
  const stageResponse = await stageRequest;
  assert.equal(stageResponse.response.status, 201);
  const response = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-login-settings-save',
    body: {
      args: [
        {
          name: 'ログイン競合なし',
          theme: 'dark',
          language: 'ja',
          stagedAttachmentId: stageResponse.payload.result.stagedAttachmentId,
          expectedSettingsVersion: '0',
        },
      ],
    },
  });
  assert.equal(response.response.status, 200);
  const user = fixture.DB.get(
    'SELECT display_name, settings_version, updated_at_ms FROM users WHERE user_id = ?1',
    IDS.userA
  );
  assert.equal(user.display_name, 'ログイン競合なし');
  assert.equal(user.settings_version, response.payload.result.settingsVersion);
  assert.ok(user.updated_at_ms > authUpdatedAt);
});

test('異なるprofile requestの同時更新はwinner一式だけを保存しloserを409にする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const putKeys = [];
  fixture.env.R2 = {
    async put(key, value) {
      putKeys.push(key);
      objects.set(key, value);
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'profile-race-stage',
    fileName: 'race.png',
    text: 'race-profile',
  });
  const payloads = [
    {
      name: '競合A',
      theme: 'dark',
      language: 'ja',
      stagedAttachmentId: staged.stagedAttachmentId,
      expectedSettingsVersion: '0',
    },
    {
      name: '競合B',
      theme: 'system',
      language: 'en',
      stagedAttachmentId: staged.stagedAttachmentId,
      expectedSettingsVersion: '0',
    },
  ];
  const responses = await Promise.all(
    payloads.map((payload, index) =>
      apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
        method: 'POST',
        requestId: `profile-race-${index}`,
        body: { args: [payload] },
      })
    )
  );
  assert.deepEqual(
    responses.map((entry) => entry.response.status).sort(),
    [200, 409]
  );
  const winnerIndex = responses.findIndex((entry) => entry.response.status === 200);
  const expected = payloads[winnerIndex];
  const user = fixture.DB.get(
    'SELECT display_name, theme, language, profile_image_url FROM users WHERE user_id = ?1',
    IDS.userA
  );
  assert.deepEqual(
    [user.display_name, user.theme, user.language],
    [expected.name, expected.theme, expected.language]
  );
  assert.equal(
    new URL(user.profile_image_url, ORIGIN).searchParams.get('attachmentId'),
    staged.stagedAttachmentId
  );
  const canonical = fixture.DB.get(
    'SELECT extra_json FROM attachments WHERE attachment_id = ?1',
    staged.stagedAttachmentId
  );
  assert.equal(JSON.parse(canonical.extra_json).r2Key, putKeys[0]);
  assert.equal(objects.has(putKeys[0]), true);
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'user_settings.update'")
      .count,
    1
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM attachments WHERE JSON_EXTRACT(extra_json, '$.category') = 'profile_image'"
    ).count,
    1
  );
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count, 0);
});

test('D1 message batchがcommit後に応答喪失しても採用済みR2 objectを削除しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const deletedKeys = [];
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'message-commit-unknown-stage',
    fileName: 'kept.png',
    text: 'kept',
  });
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let batchCall = 0;
  fixture.DB.batch = async (statements) => {
    const result = await originalBatch(statements);
    batchCall += 1;
    if (batchCall === 1) {
      throw new Error('simulated response loss after commit');
    }
    return result;
  };
  const saved = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-commit-unknown-recovered',
    body: {
      args: [
        {
          title: 'commit済み',
          body: '応答だけ喪失',
          folderId: IDS.publicFolder,
          attachments: [{ stagedAttachmentId: staged.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(saved.response.status, 200);
  const row = fixture.DB.get(
    `SELECT a.extra_json
       FROM message_attachments ma
       JOIN attachments a ON a.attachment_id = ma.attachment_id
      WHERE ma.message_id = ?1`,
    saved.payload.memoId
  );
  const adoptedKey = JSON.parse(row.extra_json).r2Key;
  assert.equal(objects.has(adoptedKey), true);
  assert.deepEqual(deletedKeys, []);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count, 0);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'message.create' AND request_id = ?1",
      'message-commit-unknown-recovered'
    ).count,
    1
  );
});

test('画像なしの設定保存は既存profile attachmentを削除せずversionだけを進める', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'profile-image-before-scalar-stage',
    fileName: 'preserve.png',
    text: 'preserve',
  });
  const image = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-image-before-scalar-save',
    body: {
      args: [
        {
          stagedAttachmentId: staged.stagedAttachmentId,
          expectedSettingsVersion: '0',
        },
      ],
    },
  });
  assert.equal(image.response.status, 200);
  const before = fixture.DB.get(
    'SELECT profile_image_url, settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  );
  const attachmentId = new URL(before.profile_image_url, ORIGIN).searchParams.get('attachmentId');
  const attachment = fixture.DB.get(
    'SELECT extra_json FROM attachments WHERE attachment_id = ?1',
    attachmentId
  );
  const key = JSON.parse(attachment.extra_json).r2Key;

  const scalar = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-scalar-save',
    body: {
      args: [
        {
          name: '画像を保持',
          theme: 'dark',
          language: 'en',
          expectedSettingsVersion: before.settings_version,
        },
      ],
    },
  });
  assert.equal(scalar.response.status, 200);
  const after = fixture.DB.get(
    'SELECT profile_image_url, settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  );
  assert.equal(after.profile_image_url, before.profile_image_url);
  assert.notEqual(after.settings_version, before.settings_version);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1', attachmentId)
      .count,
    1
  );
  assert.equal(objects.has(key), true);
});

test('D1 profile batchがcommit後に応答喪失しても採用済みR2 objectを削除しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const deletedKeys = [];
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'profile-commit-unknown-stage',
    fileName: 'kept-profile.png',
    text: 'kept-profile',
  });
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let batchCall = 0;
  fixture.DB.batch = async (statements) => {
    const result = await originalBatch(statements);
    batchCall += 1;
    if (batchCall === 1) {
      throw new Error('simulated profile response loss after commit');
    }
    return result;
  };
  const saved = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-commit-unknown-recovered',
    body: {
      args: [
        {
          name: 'commit済み設定',
          stagedAttachmentId: staged.stagedAttachmentId,
          expectedSettingsVersion: '0',
        },
      ],
    },
  });
  assert.equal(saved.response.status, 200);
  const user = fixture.DB.get(
    'SELECT profile_image_url FROM users WHERE user_id = ?1',
    IDS.userA
  );
  const attachmentId = new URL(user.profile_image_url, ORIGIN).searchParams.get('attachmentId');
  const row = fixture.DB.get('SELECT extra_json FROM attachments WHERE attachment_id = ?1', attachmentId);
  const adoptedKey = JSON.parse(row.extra_json).r2Key;
  assert.equal(objects.has(adoptedKey), true);
  assert.deepEqual(deletedKeys, []);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count, 0);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'user_settings.update' AND request_id = ?1",
      'profile-commit-unknown-recovered'
    ).count,
    1
  );
});

test('D1 claim非commitでも段階uploadの事前cleanup台帳を保持する', async (t) => {
  for (const kind of ['message', 'profile']) {
    await t.test(kind, async () => {
      const fixture = await createFixture();
      try {
        const objects = new Map();
        fixture.env.R2 = {
          async put(key, value) {
            objects.set(key, value);
          },
          async delete(keys) {
            const normalized = Array.isArray(keys) ? keys : [keys];
            normalized.forEach((key) => objects.delete(key));
          },
        };
        const stageRequestId = `${kind}-prequeued-upload`;
        const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
          purpose: kind,
          requestId: stageRequestId,
          fileName: 'pending.png',
          text: 'pending',
        });
        fixture.DB.batch = async () => {
          throw new Error('simulated D1 claim batch failure');
        };
        const requestId = `${kind}-prequeued-commit-unknown`;
        const response =
          kind === 'message'
            ? await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
                method: 'POST',
                requestId,
                body: {
                  args: [
                    {
                      title: '非commit添付',
                      body: '事前台帳を保持',
                      folderId: IDS.publicFolder,
                      attachments: [{ stagedAttachmentId: staged.stagedAttachmentId }],
                    },
                  ],
                },
              })
            : await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
                method: 'POST',
                requestId,
                body: {
                  args: [
                    {
                      name: '非commitプロフィール',
                      stagedAttachmentId: staged.stagedAttachmentId,
                      expectedSettingsVersion: '0',
                    },
                  ],
                },
              });

        assert.equal(response.response.status, 500);
        assert.equal(objects.size, 1);
        const jobs = fixture.DB.all(
          'SELECT r2_key, reason, request_id FROM storage_cleanup_jobs WHERE request_id = ?1',
          stageRequestId
        );
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].reason, 'upload_uncommitted');
        assert.equal(objects.has(jobs[0].r2_key), true);
      } finally {
        fixture.DB.close();
      }
    });
  }
});

test('同一actorのrequest id再利用はcanonical payloadが異なる場合409で変更しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const requestId = 'payload-reuse-task';
  const first = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId,
    body: { args: [{ title: '正本タスク', assignees: ['user-a@example.com'] }] },
  });
  const canonicalReplay = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId,
    body: { args: [{ assignees: ['user-a@example.com'], title: '正本タスク' }] },
  });
  const conflicting = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId,
    body: { args: [{ title: '上書き試行', assignees: ['user-b@example.com'] }] },
  });
  assert.equal(first.response.status, 200);
  assert.equal(canonicalReplay.response.status, 200);
  assert.equal(canonicalReplay.payload.taskId, first.payload.taskId);
  assert.equal(conflicting.response.status, 409);
  assert.equal(conflicting.payload.code, 'idempotency_key_reused');
  assert.equal(fixture.DB.get('SELECT title FROM tasks WHERE task_id = ?1', first.payload.taskId).title, '正本タスク');
  assert.deepEqual(
    fixture.DB
      .all('SELECT email FROM task_assignees WHERE task_id = ?1 ORDER BY email', first.payload.taskId)
      .map((row) => row.email),
    ['user-a@example.com']
  );
  const keyRow = fixture.DB.get(
    `SELECT payload_sha256,
            created_at_ms,
            expires_at_ms
       FROM api_idempotency_keys
      WHERE org_id = ?1
        AND actor_user_id = ?2
        AND request_id = ?3
        AND route = 'addNewTask'`,
    IDS.orgA,
    IDS.userA,
    requestId
  );
  assert.match(keyRow.payload_sha256, /^[0-9a-f]{64}$/);
  assert.equal(keyRow.expires_at_ms - keyRow.created_at_ms, 7 * 24 * 60 * 60 * 1000);
  assert.equal(JSON.stringify(keyRow).includes('正本タスク'), false);
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?1 AND action = 'task.create'", requestId)
      .count,
    1
  );
});

test('更新requestのA→B→A遅延再送は409で止まりBの状態を巻き戻さない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'replay-order-create',
    body: { args: [{ title: '初期状態', assignees: ['user-a@example.com'] }] },
  });
  assert.equal(created.response.status, 200);

  const updateA = {
    method: 'POST',
    requestId: 'replay-order-a',
    body: { args: [{ id: created.payload.taskId, title: '状態A' }] },
  };
  const firstA = await apiRequest(
    fixture,
    fixture.actors.userA,
    'updateTask',
    updateA
  );
  const updateB = await apiRequest(fixture, fixture.actors.userA, 'updateTask', {
    method: 'POST',
    requestId: 'replay-order-b',
    body: { args: [{ id: created.payload.taskId, title: '状態B' }] },
  });
  const delayedA = await apiRequest(
    fixture,
    fixture.actors.userA,
    'updateTask',
    updateA
  );

  assert.equal(firstA.response.status, 200);
  assert.equal(updateB.response.status, 200);
  assert.equal(delayedA.response.status, 409);
  assert.equal(delayedA.payload.code, 'idempotency_replay');
  assert.equal(
    fixture.DB.get('SELECT title FROM tasks WHERE task_id = ?1', created.payload.taskId).title,
    '状態B'
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'task.update' AND target_id = ?1",
      created.payload.taskId
    ).count,
    2
  );
});

test('削除済みmessageとtaskは古い作成requestの再送で復活しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const messageOptions = {
    method: 'POST',
    requestId: 'deleted-message-create-request',
    body: {
      args: [
        {
          title: '削除予定メッセージ',
          body: '復活させない',
          folderId: IDS.publicFolder,
        },
      ],
    },
  };
  const message = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewMessage',
    messageOptions
  );
  assert.equal(message.response.status, 200);
  const deletedMessage = await apiRequest(fixture, fixture.actors.userA, 'deleteMessageById', {
    method: 'POST',
    requestId: 'deleted-message-delete-request',
    body: { args: [message.payload.memoId] },
  });
  assert.equal(deletedMessage.response.status, 200);
  const messageReplay = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewMessage',
    messageOptions
  );
  assert.equal(messageReplay.response.status, 409);
  assert.equal(messageReplay.payload.code, 'idempotency_replay');
  fixture.DB
    .prepare('UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1')
    .bind(messageOptions.requestId)
    .run();
  const messageReplayAfterTtl = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewMessage',
    messageOptions
  );
  assert.equal(messageReplayAfterTtl.response.status, 409);
  assert.equal(messageReplayAfterTtl.payload.code, 'idempotency_replay');
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM messages WHERE message_id = ?1', message.payload.memoId)
      .count,
    0
  );

  const taskOptions = {
    method: 'POST',
    requestId: 'deleted-task-create-request',
    body: { args: [{ title: '削除予定タスク', assignees: ['user-a@example.com'] }] },
  };
  const task = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', taskOptions);
  assert.equal(task.response.status, 200);
  const deletedTask = await apiRequest(fixture, fixture.actors.userA, 'deleteTaskById', {
    method: 'POST',
    requestId: 'deleted-task-delete-request',
    body: { args: [task.payload.taskId] },
  });
  assert.equal(deletedTask.response.status, 200);
  const taskReplay = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', taskOptions);
  assert.equal(taskReplay.response.status, 409);
  assert.equal(taskReplay.payload.code, 'idempotency_replay');
  fixture.DB
    .prepare('UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1')
    .bind(taskOptions.requestId)
    .run();
  const taskReplayAfterTtl = await apiRequest(
    fixture,
    fixture.actors.userA,
    'addNewTask',
    taskOptions
  );
  assert.equal(taskReplayAfterTtl.response.status, 409);
  assert.equal(taskReplayAfterTtl.payload.code, 'idempotency_replay');
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?1', task.payload.taskId).count,
    0
  );
});

test('7日TTL後の同一request idと異なるpayloadは別resource idを生成する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const requestId = 'expired-request-new-payload';
  const first = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId,
    body: { args: [{ title: '期限前', assignees: ['user-a@example.com'] }] },
  });
  assert.equal(first.response.status, 200);
  fixture.DB
    .prepare('UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1')
    .bind(requestId)
    .run();
  const second = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId,
    body: { args: [{ title: '期限後', assignees: ['user-a@example.com'] }] },
  });
  assert.equal(second.response.status, 200);
  assert.notEqual(first.payload.taskId, second.payload.taskId);
  assert.deepEqual(
    fixture.DB
      .all('SELECT title FROM tasks WHERE task_id IN (?1, ?2) ORDER BY title', first.payload.taskId, second.payload.taskId)
      .map((row) => row.title),
    ['期限前', '期限後']
  );
});

test('7日TTL後のprofile request再利用は新しい監査世代を作り旧画像を回収する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const putKeys = [];
  const deletedKeys = [];
  fixture.env.R2 = {
    async put(key, value) {
      putKeys.push(key);
      objects.set(key, value);
    },
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const requestId = 'expired-profile-request-new-payload';
  const firstStage = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'expired-profile-stage-a',
    fileName: 'a.png',
    text: 'A',
  });
  const first = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId,
    body: {
      args: [
        {
          name: '期限前プロフィール',
          theme: 'dark',
          language: 'ja',
          stagedAttachmentId: firstStage.stagedAttachmentId,
          expectedSettingsVersion: '0',
        },
      ],
    },
  });
  assert.equal(first.response.status, 200);
  assert.equal(putKeys.length, 1);

  fixture.DB
    .prepare(
      "UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1 AND route = 'saveUserSettings'"
    )
    .bind(requestId)
    .run();
  const secondStage = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'expired-profile-stage-b',
    fileName: 'b.png',
    text: 'B',
  });
  const second = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId,
    body: {
      args: [
        {
          name: '期限後プロフィール',
          theme: 'system',
          language: 'en',
          stagedAttachmentId: secondStage.stagedAttachmentId,
          expectedSettingsVersion: first.payload.result.settingsVersion,
        },
      ],
    },
  });
  assert.equal(second.response.status, 200);
  assert.equal(putKeys.length, 2);
  assert.deepEqual(deletedKeys, [putKeys[0]]);
  assert.equal(objects.has(putKeys[0]), false);
  assert.equal(objects.has(putKeys[1]), true);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM attachments WHERE JSON_EXTRACT(extra_json, '$.category') = 'profile_image'"
    ).count,
    1
  );
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').count, 0);
  const auditRows = fixture.DB.all(
    `SELECT request_payload_sha256, request_generation_ms
       FROM audit_logs
      WHERE request_id = ?1
        AND action = 'user_settings.update'
      ORDER BY created_at_ms`,
    requestId
  );
  assert.equal(auditRows.length, 2);
  assert.notEqual(auditRows[0].request_payload_sha256, auditRows[1].request_payload_sha256);
  assert.notEqual(auditRows[0].request_generation_ms, auditRows[1].request_generation_ms);
});

test('profile新世代が監査前に失敗しても再送時に旧世代監査を成功扱いしない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const requestId = 'profile-generation-failure-retry';
  const first = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId,
    body: {
      args: [
        {
          name: '世代A',
          theme: 'dark',
          expectedSettingsVersion: '0',
        },
      ],
    },
  });
  assert.equal(first.response.status, 200);
  const generationAVersion = first.payload.result.settingsVersion;
  fixture.DB
    .prepare('UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1')
    .bind(requestId)
    .run();

  const generationBOptions = {
    method: 'POST',
    requestId,
    body: {
      args: [
        {
          name: '世代B',
          theme: 'system',
          expectedSettingsVersion: generationAVersion,
        },
      ],
    },
  };
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let failGenerationB = true;
  fixture.DB.batch = async (statements) => {
    if (failGenerationB) {
      failGenerationB = false;
      throw new Error('simulated profile generation B failure before commit');
    }
    return originalBatch(statements);
  };
  const failed = await apiRequest(
    fixture,
    fixture.actors.userA,
    'saveUserSettings',
    generationBOptions
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.code, 'save_failed');
  assert.equal(
    fixture.DB.get('SELECT display_name FROM users WHERE user_id = ?1', IDS.userA).display_name,
    '世代A'
  );

  const replayed = await apiRequest(
    fixture,
    fixture.actors.userA,
    'saveUserSettings',
    generationBOptions
  );
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.payload.result.name, undefined);
  assert.equal(
    fixture.DB.get('SELECT display_name FROM users WHERE user_id = ?1', IDS.userA).display_name,
    '世代B'
  );
  const audits = fixture.DB.all(
    `SELECT request_payload_sha256, request_generation_ms
       FROM audit_logs
      WHERE request_id = ?1
        AND action = 'user_settings.update'
      ORDER BY request_generation_ms`,
    requestId
  );
  assert.equal(audits.length, 2);
  assert.notEqual(audits[0].request_payload_sha256, audits[1].request_payload_sha256);
  assert.notEqual(audits[0].request_generation_ms, audits[1].request_generation_ms);
});

test('過去のprofile save再送は新しい設定を巻き戻さない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const firstOptions = {
    method: 'POST',
    requestId: 'stale-profile-save-a',
    body: {
      args: [
        {
          name: '古い設定',
          theme: 'dark',
          language: 'ja',
          expectedSettingsVersion: '0',
        },
      ],
    },
  };
  const first = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', firstOptions);
  assert.equal(first.response.status, 200);
  const second = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'stale-profile-save-b',
    body: {
      args: [
        {
          name: '新しい設定',
          theme: 'system',
          language: 'en',
          expectedSettingsVersion: first.payload.result.settingsVersion,
        },
      ],
    },
  });
  assert.equal(second.response.status, 200);
  const replay = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', firstOptions);
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, 'settings_version_conflict');
  const current = fixture.DB.get(
    'SELECT display_name, theme, language FROM users WHERE user_id = ?1',
    IDS.userA
  );
  assert.deepEqual(
    [current.display_name, current.theme, current.language],
    ['新しい設定', 'system', 'en']
  );
});

test('通常4xxは新規idempotency keyを解放し期限切れkeyは全actorから最大100件pruneする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const invalidRequestId = 'idempotency-invalid-400';
  const invalid = await apiRequest(fixture, fixture.actors.userA, 'updateTask', {
    method: 'POST',
    requestId: invalidRequestId,
    body: { args: [{}] },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, 'task_id_required');
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      invalidRequestId
    ).count,
    0
  );
  await fixture.DB
    .prepare(
      `
      INSERT INTO tasks (
        task_id, org_id, title, status, created_by_email, created_by_membership_id,
        created_at_ms, updated_at_ms
      ) VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?6)
    `
    )
    .bind(
      'idempotency-corrected-task',
      IDS.orgA,
      '修正前',
      'user-a@example.com',
      IDS.memberA,
      NOW
    )
    .run();
  const corrected = await apiRequest(fixture, fixture.actors.userA, 'updateTask', {
    method: 'POST',
    requestId: invalidRequestId,
    body: { args: [{ id: 'idempotency-corrected-task', title: '修正後' }] },
  });
  assert.equal(corrected.response.status, 200);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      invalidRequestId
    ).count,
    1
  );

  const ordinaryConflict = await apiRequest(fixture, fixture.actors.userA, 'folders', {
    method: 'POST',
    requestId: 'idempotency-ordinary-409',
    body: { name: '共有' },
  });
  assert.equal(ordinaryConflict.response.status, 409);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      'idempotency-ordinary-409'
    ).count,
    0
  );

  const expiredAt = Date.now() - 1;
  const createdAt = expiredAt - 7 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 101; index += 1) {
    const exactCurrentScope = index === 100;
    await fixture.DB
      .prepare(
        `
        INSERT INTO api_idempotency_keys (
          idempotency_key_id, org_id, actor_user_id, request_id, route,
          payload_sha256, created_at_ms, expires_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `
      )
      .bind(
        `expired-key-${String(index).padStart(3, '0')}`,
        IDS.orgA,
        IDS.userA,
        exactCurrentScope ? 'idempotency-prune-current' : `expired-request-${index}`,
        exactCurrentScope ? 'addNewTask' : 'updateTask',
        'a'.repeat(64),
        createdAt + index,
        expiredAt
      )
      .run();
  }
  await fixture.DB
    .prepare(
      `
      INSERT INTO api_idempotency_keys (
        idempotency_key_id, org_id, actor_user_id, request_id, route,
        payload_sha256, created_at_ms, expires_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
    )
    .bind(
      'expired-other-actor',
      IDS.orgA,
      IDS.userB,
      'expired-other-request',
      'updateTask',
      'b'.repeat(64),
      createdAt,
      expiredAt - 1000
    )
    .run();

  const pruned = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'idempotency-prune-current',
    body: { args: [{ title: '期限切れ台帳の整理後に作成' }] },
  });
  assert.equal(pruned.response.status, 200);
  assert.equal(
    fixture.DB.get(
      `SELECT COUNT(*) AS count
         FROM api_idempotency_keys
        WHERE expires_at_ms <= ?1`,
      Date.now()
    ).count,
    2
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE idempotency_key_id = ?1',
      'expired-other-actor'
    ).count,
    0
  );
  const retained = fixture.DB.get(
    `SELECT created_at_ms, expires_at_ms
       FROM api_idempotency_keys
      WHERE org_id = ?1
        AND actor_user_id = ?2
        AND request_id = ?3
        AND route = 'addNewTask'`,
    IDS.orgA,
    IDS.userA,
    'idempotency-prune-current'
  );
  assert.ok(retained);
  assert.equal(retained.expires_at_ms - retained.created_at_ms, 7 * 24 * 60 * 60 * 1000);
});

test('完了APIの再送は実変更がない監査行を追加しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'complete-create-1',
    body: { args: [{ title: '一度だけ完了する' }] },
  });
  const taskId = created.payload.taskId;
  const first = await apiRequest(fixture, fixture.actors.userA, 'completeTask', {
    method: 'POST',
    requestId: 'complete-1',
    body: { args: [taskId] },
  });
  const replay = await apiRequest(fixture, fixture.actors.userA, 'completeTask', {
    method: 'POST',
    requestId: 'complete-2',
    body: { args: [taskId] },
  });
  assert.equal(first.response.status, 200);
  assert.equal(replay.response.status, 200);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?1 AND action = 'task.complete'",
      taskId
    ).count,
    1
  );
});

test('R2削除失敗はD1の永続cleanup台帳へobject keyを残す', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  fixture.env.R2 = {
    async delete() {
      throw new Error('forced cleanup failure');
    },
  };
  fixture.DB.prepare(
    `INSERT INTO attachments (
      attachment_id, org_id, file_name, created_at_ms, extra_json
    ) VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind('attachment-cleanup', IDS.orgA, 'cleanup.png', NOW, JSON.stringify({ r2Key: 'orgs/org-a/messages/object' }))
    .run();
  fixture.DB.prepare(
    'INSERT INTO message_attachments (message_id, attachment_id) VALUES (?1, ?2)'
  )
    .bind(IDS.publicMessage, 'attachment-cleanup')
    .run();

  const deleted = await apiRequest(fixture, fixture.actors.userA, 'deleteMessageById', {
    method: 'POST',
    requestId: 'delete-with-r2-failure',
    body: { args: [IDS.publicMessage] },
  });
  assert.equal(deleted.response.status, 200);
  const job = fixture.DB.get(
    'SELECT r2_key, reason, attempts, request_id, last_error FROM storage_cleanup_jobs WHERE r2_key = ?1',
    'orgs/org-a/messages/object'
  );
  assert.deepEqual({ ...job }, {
    r2_key: 'orgs/org-a/messages/object',
    reason: 'message_deleted',
    attempts: 1,
    request_id: 'delete-with-r2-failure',
    last_error: 'r2_delete_failed',
  });
});

test('不正なcross-org添付リンクがあっても親削除で別組織のD1/R2を削除しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map([
    ['orgs/org-b/messages/cross-message-object', new Uint8Array([1])],
    ['orgs/org-b/tasks/cross-task-object', new Uint8Array([2])],
  ]);
  const deletedKeys = [];
  fixture.env.R2 = {
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deletedKeys.push(...normalized);
      normalized.forEach((key) => objects.delete(key));
    },
  };

  const createdTask = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'cross-org-task-create',
    body: { args: [{ title: '削除対象タスク' }] },
  });
  assert.equal(createdTask.response.status, 200);
  const taskId = createdTask.payload.taskId;

  fixture.DB.exec(`
    INSERT INTO attachments (
      attachment_id, org_id, file_name, created_at_ms, created_by_membership_id, extra_json
    ) VALUES
      ('cross-org-message-attachment', '${IDS.orgB}', 'message.png', ${NOW}, '${IDS.memberOther}',
       '{"r2Key":"orgs/org-b/messages/cross-message-object"}'),
      ('cross-org-task-attachment', '${IDS.orgB}', 'task.png', ${NOW}, '${IDS.memberOther}',
       '{"r2Key":"orgs/org-b/tasks/cross-task-object"}');
    INSERT INTO message_attachments (message_id, attachment_id)
      VALUES ('${IDS.publicMessage}', 'cross-org-message-attachment');
    INSERT INTO task_attachments (task_id, attachment_id)
      VALUES ('${taskId}', 'cross-org-task-attachment');
  `);

  const deletedMessage = await apiRequest(fixture, fixture.actors.userA, 'deleteMessageById', {
    method: 'POST',
    requestId: 'cross-org-message-delete',
    body: { args: [IDS.publicMessage] },
  });
  const deletedTask = await apiRequest(fixture, fixture.actors.userA, 'deleteTaskById', {
    method: 'POST',
    requestId: 'cross-org-task-delete',
    body: { args: [taskId] },
  });

  assert.equal(deletedMessage.response.status, 200);
  assert.equal(deletedTask.response.status, 200);
  assert.deepEqual(deletedKeys, []);
  assert.equal(objects.size, 2);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM attachments WHERE attachment_id IN ('cross-org-message-attachment', 'cross-org-task-attachment')"
    ).count,
    2
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key LIKE 'orgs/org-b/%/cross-%'"
    ).count,
    0
  );
});

test('mutationのGET実行とD1 write kill-switchは保存前に拒否する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const getMutation = await apiRequest(fixture, fixture.actors.userA, 'addNewTask');
  assert.equal(getMutation.response.status, 405);
  assert.equal(getMutation.payload.code, 'method_not_allowed');

  fixture.env.CFG_D1_WRITE = 'false';
  const unknownSession = await createSession(fixture.env, {
    user: {
      sub: 'subject-unknown',
      email: 'unknown@example.com',
      emailVerified: true,
      name: '未登録ユーザー',
    },
  });
  const unknownActor = {
    cookie: `SESSION=${unknownSession.sessionId}.${unknownSession.sessionKey}`,
  };
  const beforeUsers = fixture.DB.get('SELECT COUNT(*) AS count FROM users').count;
  const beforeMemberships = fixture.DB.get('SELECT COUNT(*) AS count FROM memberships').count;

  const unknownMutation = await apiRequest(fixture, unknownActor, 'addNewTask', {
    method: 'POST',
    body: { args: [{ title: '未登録ユーザーから保存されない' }] },
  });
  assert.equal(unknownMutation.response.status, 503);
  assert.equal(unknownMutation.payload.code, 'd1_write_disabled');

  const unknownRead = await apiRequest(fixture, unknownActor, 'messages');
  assert.equal(unknownRead.response.status, 403);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM users').count, beforeUsers);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM memberships').count,
    beforeMemberships
  );
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM users WHERE email = 'unknown@example.com'").count,
    0
  );

  const disabled = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    body: { args: [{ title: '保存されない' }] },
  });
  assert.equal(disabled.response.status, 503);
  assert.equal(disabled.payload.code, 'd1_write_disabled');
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM tasks').count, 0);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM api_idempotency_keys').count, 0);
});

test('メッセージ作成batchの途中失敗は本体・既読・監査をすべてrollbackする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const beforeMessages = fixture.DB.get('SELECT COUNT(*) AS count FROM messages').count;
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let injectFailure = true;
  fixture.DB.batch = async (statements) => {
    if (!injectFailure) return originalBatch(statements);
    injectFailure = false;
    const duplicateOrg = fixture.DB
      .prepare('INSERT INTO organizations (org_id, name, created_at_ms) VALUES (?1, ?2, ?3)')
      .bind(IDS.orgA, '重複', NOW);
    return originalBatch([...statements, duplicateOrg]);
  };

  const failed = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-create-failure-retained',
    body: {
      args: [
        {
          title: '保存されない投稿',
          body: '途中失敗を注入する',
          folderId: IDS.publicFolder,
        },
      ],
    },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.code, 'message_create_failed');
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM messages').count, beforeMessages);
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'message.create'").count,
    0
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_reads WHERE membership_id = ?1',
      IDS.memberA
    ).count,
    0
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      'message-create-failure-retained'
    ).count,
    1
  );
});

test('タスクCRUDは各操作と業務監査を対応付ける', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    body: {
      args: [
        {
          title: '監査対象タスク',
          assignees: ['user-b@example.com'],
          priority: 'high',
        },
      ],
    },
  });
  assert.equal(created.response.status, 200);
  const taskId = created.payload.taskId;
  assert.ok(taskId);

  const updated = await apiRequest(fixture, fixture.actors.userA, 'updateTask', {
    method: 'POST',
    body: { args: [{ id: taskId, title: '更新後タスク', assignees: ['user-a@example.com'] }] },
  });
  assert.equal(updated.response.status, 200);

  const completed = await apiRequest(fixture, fixture.actors.userA, 'completeTask', {
    method: 'POST',
    body: { args: [taskId] },
  });
  assert.equal(completed.response.status, 200);

  const deleted = await apiRequest(fixture, fixture.actors.userA, 'deleteTaskById', {
    method: 'POST',
    body: { args: [taskId] },
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?1', taskId).count, 0);
  assert.deepEqual(
    fixture.DB
      .all('SELECT action FROM audit_logs WHERE target_id = ?1 ORDER BY created_at_ms, action', taskId)
      .map((row) => row.action)
      .sort(),
    ['task.complete', 'task.create', 'task.delete', 'task.update']
  );
});

test('タスク作成・更新は別tenantまたは閲覧不可folder参照を保存しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const crossTenantCreate = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'task-cross-folder-create',
    body: { args: [{ title: '不正folder', folderId: IDS.otherFolder }] },
  });
  assert.equal(crossTenantCreate.response.status, 403);
  assert.equal(crossTenantCreate.payload.code, 'task_folder_access_denied');
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM tasks WHERE title = '不正folder'").count,
    0
  );

  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    requestId: 'task-safe-folder-create',
    body: { args: [{ title: '安全folder', folderId: IDS.publicFolder }] },
  });
  assert.equal(created.response.status, 200);
  const crossTenantUpdate = await apiRequest(fixture, fixture.actors.userA, 'updateTask', {
    method: 'POST',
    requestId: 'task-cross-folder-update',
    body: { args: [{ id: created.payload.taskId, folderId: IDS.otherFolder }] },
  });
  assert.equal(crossTenantUpdate.response.status, 403);
  assert.equal(crossTenantUpdate.payload.code, 'task_folder_access_denied');
  assert.equal(
    fixture.DB.get('SELECT folder_id FROM tasks WHERE task_id = ?1', created.payload.taskId)
      .folder_id,
    IDS.publicFolder
  );
});

test('タスク作成batchの途中失敗は本体と業務監査をともにrollbackする', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const originalBatch = fixture.DB.batch.bind(fixture.DB);
  let injectFailure = true;
  fixture.DB.batch = async (statements) => {
    if (!injectFailure) return originalBatch(statements);
    injectFailure = false;
    const duplicateOrg = fixture.DB
      .prepare('INSERT INTO organizations (org_id, name, created_at_ms) VALUES (?1, ?2, ?3)')
      .bind(IDS.orgA, '重複', NOW);
    return originalBatch([...statements, duplicateOrg]);
  };

  const failed = await apiRequest(fixture, fixture.actors.userA, 'addNewTask', {
    method: 'POST',
    body: { args: [{ title: '保存されないタスク', assignees: ['user-b@example.com'] }] },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.payload.code, 'd1_route_failed');
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM tasks').count, 0);
  assert.equal(
    fixture.DB.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'task.create'").count,
    0
  );
});

test('タスク詳細・更新・完了・削除はmanagerまたは作成者・担当者だけに限定する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  fixture.DB.exec(`
    INSERT INTO tasks (
      task_id, org_id, title, status, created_by_email, created_by_membership_id,
      created_at_ms, updated_at_ms
    ) VALUES
      ('task-protected', '${IDS.orgA}', '非担当者は操作不可', 'open',
       'user-a@example.com', '${IDS.memberA}', ${NOW}, ${NOW}),
      ('task-assigned-b', '${IDS.orgA}', '担当者は操作可', 'open',
       'user-a@example.com', '${IDS.memberA}', ${NOW}, ${NOW}),
      ('task-legacy-ownerless', '${IDS.orgA}', '作成者欠損', 'open',
       NULL, NULL, ${NOW}, ${NOW});

    INSERT INTO task_assignees (task_id, email, membership_id, assigned_at_ms) VALUES
      ('task-protected', 'user-a@example.com', '${IDS.memberA}', ${NOW}),
      ('task-assigned-b', 'user-b@example.com', '${IDS.memberB}', ${NOW});
  `);

  const deniedGet = await apiRequest(fixture, fixture.actors.userB, 'getTaskById', {
    method: 'POST',
    body: { args: ['task-protected'] },
  });
  const deniedUpdate = await apiRequest(fixture, fixture.actors.userB, 'updateTask', {
    method: 'POST',
    requestId: 'task-object-denied-update',
    body: { args: [{ id: 'task-protected', title: '不正更新' }] },
  });
  const deniedUpdateReplay = await apiRequest(fixture, fixture.actors.userB, 'updateTask', {
    method: 'POST',
    requestId: 'task-object-denied-update',
    body: { args: [{ id: 'task-protected', title: '不正更新' }] },
  });
  const deniedComplete = await apiRequest(fixture, fixture.actors.userB, 'completeTask', {
    method: 'POST',
    body: { args: ['task-protected'] },
  });
  const deniedDelete = await apiRequest(fixture, fixture.actors.userB, 'deleteTaskById', {
    method: 'POST',
    body: { args: ['task-protected'] },
  });
  assert.deepEqual(
    [deniedGet, deniedUpdate, deniedUpdateReplay, deniedComplete, deniedDelete].map(
      ({ response }) => response.status
    ),
    [403, 403, 403, 403, 403]
  );
  const deniedEvent = fixture.DB.get(
    `
    SELECT event_type, reason_code, route, source, COUNT(*) AS count
      FROM auth_events
     WHERE request_id = ?1
     GROUP BY event_type, reason_code, route, source
    `,
    'task-object-denied-update'
  );
  assert.deepEqual({ ...deniedEvent }, {
    event_type: 'authorization.denied',
    reason_code: 'task_access_denied',
    route: 'updateTask',
    source: 'api_resource_authorization',
    count: 2,
  });
  assert.deepEqual(
    { ...fixture.DB.get('SELECT title, status FROM tasks WHERE task_id = ?1', 'task-protected') },
    { title: '非担当者は操作不可', status: 'open' }
  );

  const assignedGet = await apiRequest(fixture, fixture.actors.userB, 'getTaskById', {
    method: 'POST',
    body: { args: ['task-assigned-b'] },
  });
  const assignedUpdate = await apiRequest(fixture, fixture.actors.userB, 'updateTask', {
    method: 'POST',
    body: { args: [{ id: 'task-assigned-b', title: '担当者更新' }] },
  });
  const assignedComplete = await apiRequest(fixture, fixture.actors.userB, 'completeTask', {
    method: 'POST',
    body: { args: ['task-assigned-b'] },
  });
  const assignedDelete = await apiRequest(fixture, fixture.actors.userB, 'deleteTaskById', {
    method: 'POST',
    body: { args: ['task-assigned-b'] },
  });
  assert.deepEqual(
    [assignedGet, assignedUpdate, assignedComplete, assignedDelete].map(({ response }) => response.status),
    [200, 200, 200, 403]
  );
  assert.deepEqual(
    { ...fixture.DB.get('SELECT title, status FROM tasks WHERE task_id = ?1', 'task-assigned-b') },
    { title: '担当者更新', status: 'completed' }
  );

  const legacyDeleteDenied = await apiRequest(
    fixture,
    fixture.actors.userB,
    'deleteTaskById',
    { method: 'POST', body: { args: ['task-legacy-ownerless'] } }
  );
  assert.equal(legacyDeleteDenied.response.status, 403);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?1', 'task-legacy-ownerless').count,
    1
  );

  const crossTenantUpdate = await apiRequest(fixture, fixture.actors.other, 'updateTask', {
    method: 'POST',
    body: { args: [{ id: 'task-protected', title: '別組織更新' }] },
  });
  const crossTenantDelete = await apiRequest(fixture, fixture.actors.other, 'deleteTaskById', {
    method: 'POST',
    body: { args: ['task-protected'] },
  });
  assert.deepEqual(
    [crossTenantUpdate.response.status, crossTenantDelete.response.status],
    [404, 404]
  );

  const managerDeleteLegacy = await apiRequest(
    fixture,
    fixture.actors.userA,
    'deleteTaskById',
    { method: 'POST', body: { args: ['task-legacy-ownerless'] } }
  );
  assert.equal(managerDeleteLegacy.response.status, 200);
});

test('プロフィール画像は本人所有scopeだけを参照・削除し設定監査を冪等保存する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  const victimKey = 'orgs/org-b/profiles/victim/profile.png';
  objects.set(victimKey, new Uint8Array([1, 2, 3]));
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => objects.delete(key));
    },
  };
  fixture.DB
    .prepare(
      `
      INSERT INTO attachments (
        attachment_id, org_id, file_name, content_type, size_bytes, storage_path,
        created_at_ms, created_by_membership_id, extra_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `
    )
    .bind(
      'victim-profile',
      IDS.orgB,
      'profile.png',
      'image/png',
      3,
      '/api/downloadAttachment?attachmentId=victim-profile',
      NOW,
      IDS.memberOther,
      JSON.stringify({ r2Key: victimKey, category: 'profile_image', ownerUserId: IDS.userOther })
    )
    .run();
  fixture.DB
    .prepare('UPDATE users SET profile_image_url = ?1 WHERE user_id = ?2')
    .bind('/api/downloadAttachment?attachmentId=victim-profile', IDS.userOther)
    .run();

  const poisoned = await apiRequest(fixture, fixture.actors.userB, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-poison-attempt',
    body: { args: [{ imageUrl: '/api/downloadAttachment?attachmentId=victim-profile' }] },
  });
  assert.equal(poisoned.response.status, 400);
  assert.equal(poisoned.payload.code, 'invalid_profile_image');
  assert.equal(
    fixture.DB.get('SELECT profile_image_url FROM users WHERE user_id = ?1', IDS.userB)
      .profile_image_url,
    null
  );

  // 旧版で既に汚染URLが保存されていた場合も、そのIDを削除対象として信用しない。
  fixture.DB
    .prepare('UPDATE users SET profile_image_url = ?1 WHERE user_id = ?2')
    .bind('/api/downloadAttachment?attachmentId=victim-profile', IDS.userB)
    .run();
  const ownStage = await stageTestAttachment(fixture, fixture.actors.userB, {
    purpose: 'profile',
    requestId: 'profile-safe-stage-1',
    fileName: 'hello.png',
    text: 'hello',
  });
  const options = {
    method: 'POST',
    requestId: 'profile-safe-update-1',
    body: {
      args: [
        {
          name: '新しい表示名',
          theme: 'dark',
          language: 'ja',
          stagedAttachmentId: ownStage.stagedAttachmentId,
        },
      ],
    },
  };
  const saved = await apiRequest(fixture, fixture.actors.userB, 'saveUserSettings', options);
  const replayed = await apiRequest(fixture, fixture.actors.userB, 'saveUserSettings', options);
  assert.equal(saved.response.status, 200);
  assert.equal(replayed.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1', 'victim-profile')
      .count,
    1
  );
  assert.equal(objects.has(victimKey), true);

  const ownProfile = fixture.DB.get(
    `
    SELECT a.attachment_id, a.file_name, a.extra_json
      FROM attachments a
     WHERE a.org_id = ?1
       AND a.created_by_membership_id = ?2
       AND JSON_EXTRACT(a.extra_json, '$.category') = 'profile_image'
    `,
    IDS.orgA,
    IDS.memberB
  );
  assert.ok(ownProfile);
  assert.equal(ownProfile.file_name, 'hello.png');
  const ownExtra = JSON.parse(ownProfile.extra_json);
  assert.equal(ownExtra.ownerUserId, IDS.userB);
  assert.equal(ownExtra.r2Key.includes('user-b'), false);
  assert.equal(ownExtra.r2Key.includes('example.com'), false);

  const audits = fixture.DB.all(
    `
    SELECT payload_json
      FROM audit_logs
     WHERE request_id = ?1
       AND action = 'user_settings.update'
    `,
    'profile-safe-update-1'
  );
  assert.equal(audits.length, 1);
  const auditPayload = JSON.parse(audits[0].payload_json);
  assert.deepEqual(Object.keys(auditPayload), ['fields']);
  assert.deepEqual(auditPayload.fields.sort(), ['language', 'name', 'profileImage', 'theme']);
  assert.equal(audits[0].payload_json.includes('新しい表示名'), false);
  assert.equal(audits[0].payload_json.includes('user-b@example.com'), false);
});

test('通常APIを繰り返しても認証イベントや旧ログイン監査を増やさない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

  const responses = await Promise.all(
    Array.from({ length: 12 }, () => apiRequest(fixture, fixture.actors.userA, 'messages'))
  );
  responses.forEach(({ response }) => assert.equal(response.status, 200));
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 0);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM login_audits').count, 0);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
});

test('設定画面のroleは別tenantの古い停止済みmembershipではなく現在の認可snapshotを使う', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  fixture.DB.exec(`
    INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES (
      'membership-user-b-old-org', '${IDS.orgB}', '${IDS.userB}', 'admin', 'suspended', ${NOW - 20_000}
    );
  `);

  const settings = await apiRequest(fixture, fixture.actors.userB, 'getUserSettings', {
    method: 'POST',
    body: { args: [] },
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.payload.result.role, 'member');
});

test('通常APIのsession KV障害はCookieを消さずstable 503へ収束する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const originalGet = fixture.env.APP_KV.get.bind(fixture.env.APP_KV);
  fixture.env.APP_KV.get = async (key) => {
    if (String(key).startsWith('sf:sessions:')) {
      throw new Error('forced session KV failure with user-a@example.com secret-token');
    }
    return originalGet(key);
  };
  const result = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    requestId: 'api-session-kv-failure',
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.code, 'session_verification_unavailable');
  assert.equal(result.response.headers.get('set-cookie'), null);
  const diagnostic = fixture.DB.get(
    "SELECT event, request_id, meta_json FROM auth_proxy_logs WHERE request_id = 'api-session-kv-failure'"
  );
  assert.equal(diagnostic.event, 'session_verification_unavailable');
  assert.doesNotMatch(JSON.stringify(diagnostic), /user-a@example\.com|secret-token/);
});

test('通常APIのsession更新失敗は未処理500にせずstable 503へ収束する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await installUntrackedSession(fixture, fixture.actors.userA);
  const originalPut = fixture.env.APP_KV.put.bind(fixture.env.APP_KV);
  fixture.env.APP_KV.put = async (key, value, options) => {
    if (String(key).startsWith('sf:sessions:')) {
      throw new Error('forced session touch failure with user-a@example.com secret-token');
    }
    return originalPut(key, value, options);
  };
  const result = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    requestId: 'api-session-touch-failure',
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.code, 'session_refresh_unavailable');
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'session_refresh_unavailable' AND request_id = 'api-session-touch-failure'"
    ).count,
    1
  );
});

test('アクセス拒否はauth eventだけへHTTP試行単位で記録する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  fixture.DB.exec(
    `UPDATE users SET status = 'suspended', is_active = 0 WHERE user_id = '${IDS.userA}';`
  );
  const first = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    requestId: 'denied-request-1',
  });
  const sameRequestReplay = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    requestId: 'denied-request-1',
  });
  const nextRequest = await apiRequest(fixture, fixture.actors.userA, 'messages', {
    requestId: 'denied-request-2',
  });
  assert.equal(first.response.status, 403);
  assert.equal(sameRequestReplay.response.status, 403);
  assert.equal(nextRequest.response.status, 403);
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'authorization.denied'"
    ).count,
    3
  );
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM login_audits').count, 0);
});

test('ロール拒否は通常API診断へ誤分類せずauth eventへ記録する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const denied = await apiRequest(fixture, fixture.actors.userB, 'listAllTasks', {
    method: 'POST',
    requestId: 'role-denied-1',
    body: { args: [] },
  });
  assert.equal(denied.response.status, 403);
  const event = fixture.DB.get(
    "SELECT event_type, reason_code, request_id FROM auth_events WHERE event_type = 'authorization.role_denied'"
  );
  assert.deepEqual({ ...event }, {
    event_type: 'authorization.role_denied',
    reason_code: 'role_not_allowed',
    request_id: 'role-denied-1',
  });
  assert.equal(fixture.DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
});

test('監査取得は新しい正本だけを分類し、別組織と旧誤分類を混ぜない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const now = Date.now();

  fixture.DB.exec(`
    INSERT INTO login_audits (
      login_id, org_id, user_email, status, request_id, attempted_at_ms, role
    ) VALUES (
      'legacy-login', '${IDS.orgA}', 'user-a@example.com', 'active', 'legacy-request', ${now}, 'manager'
    );

    INSERT INTO auth_events (
      event_id, event_key, event_type, outcome, reason_code, org_id, user_id,
      user_email, status, role, request_id, route, source, session_fingerprint, occurred_at_ms
    ) VALUES
      ('auth-a', 'auth-key-a', 'authentication.succeeded', 'success', 'google_oauth_verified',
       '${IDS.orgA}', '${IDS.userA}', NULL, 'active', 'manager',
       'auth-request-a', '/auth/callback', 'oauth_callback', 'fingerprint-a', ${now - 10}),
      ('auth-b', 'auth-key-b', 'authentication.succeeded', 'success', 'google_oauth_verified',
       '${IDS.orgB}', '${IDS.userOther}', NULL, 'active', 'member',
       'auth-request-b', '/auth/callback', 'oauth_callback', 'fingerprint-b', ${now - 20}),
      ('auth-user-scope', 'auth-key-user-scope', 'session.logged_out', 'success', 'user_requested',
       NULL, '${IDS.userA}', NULL, 'active', NULL,
       'auth-request-user-scope', '/auth/logout', 'auth_logout', 'fingerprint-user-scope', ${now - 12}),
      ('auth-fail-a', 'auth-key-fail-a', 'authentication.failed', 'failure',
       'token_exchange_rejected', '${IDS.orgA}', NULL, NULL, NULL, NULL,
       'auth-request-fail-a', '/auth/callback', 'oauth_callback', NULL, ${now - 15});

    INSERT INTO auth_proxy_logs (
      log_id, level, event, message, request_id, route, email, status, meta_json,
      source, cf_ray, created_at_ms, org_id, user_id
    ) VALUES
      ('legacy-proxy', 'info', 'login_attempt', 'login_allowed', 'legacy-request',
       'messages', 'user-a@example.com', 'active', '{}', 'cf-auth', '', ${now - 30}, NULL, NULL),
      ('diag-a', 'error', 'd1_route_failed', 'd1_route_failed', 'diag-request-a',
       'getMessages', 'user-a@example.com', 'error', '{}', 'cf-api', 'ray-a', ${now - 5},
       '${IDS.orgA}', '${IDS.userA}');
  `);

  const result = await apiRequest(fixture, fixture.actors.userA, 'getAuditLogs', {
    method: 'POST',
    body: { args: [150, { range: '24h', eventType: 'all', orgId: IDS.orgA }] },
  });
  assert.equal(result.response.status, 200);
  const rows = result.payload?.result?.rows || [];
  assert.deepEqual(
    rows.map((row) => row.meta?.source).sort(),
    ['auth_events', 'auth_events', 'auth_events', 'auth_proxy_logs']
  );
  assert.ok(rows.some((row) => row.type === 'auth' && row.eventLabel === 'ログイン成功'));
  assert.ok(
    rows.some(
      (row) =>
        row.type === 'auth' &&
        row.eventLabel === 'ログイン失敗' &&
        row.statusLabel === '失敗' &&
        row.severity === 'danger'
    )
  );
  assert.ok(rows.some((row) => row.type === 'api' && row.eventLabel === 'd1_route_failed'));
  assert.ok(
    rows.some(
      (row) =>
        row.type === 'auth' &&
        row.eventLabel === 'ログアウト' &&
        row.userEmail === 'user-a@example.com'
    )
  );
  assert.ok(rows.every((row) => row.meta?.orgId !== IDS.orgB));
  assert.deepEqual(result.payload.result.meta.stats, { admin: 0, auth: 3, api: 1 });
});

test('storage cleanup再試行はadmin POSTだけを許可しkill-switchとR2欠落時にattemptを変えない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-auth-job',
    r2Key: 'orgs/org-a/orphans/auth-object',
    orgId: IDS.orgA,
    updatedAtMs: NOW - 100,
  });

  const managerDenied = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-manager-denied',
      body: { args: [{ limit: 1 }] },
    }
  );
  const memberDenied = await apiRequest(
    fixture,
    fixture.actors.userB,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-member-denied',
      body: { args: [{ limit: 1 }] },
    }
  );
  const getDenied = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup'
  );
  assert.deepEqual(
    [managerDenied.response.status, memberDenied.response.status, getDenied.response.status],
    [403, 403, 405]
  );

  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  let deleteCalls = 0;
  fixture.env.R2 = {
    async delete() {
      deleteCalls += 1;
    },
  };
  fixture.env.CFG_D1_WRITE = 'false';
  const writeDisabled = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-write-disabled',
      body: { args: [{ limit: 1 }] },
    }
  );
  assert.equal(writeDisabled.response.status, 503);
  assert.equal(writeDisabled.payload.code, 'd1_write_disabled');
  assert.equal(deleteCalls, 0);

  fixture.env.CFG_D1_WRITE = 'true';
  delete fixture.env.R2;
  const unavailable = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-r2-unavailable',
      body: { args: [{ limit: 1 }] },
    }
  );
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.payload.code, 'r2_unavailable');
  assert.equal(
    fixture.DB.get(
      'SELECT attempts FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-auth-job'
    ).attempts,
    0
  );
  const unavailableAudits = fixture.DB.all(
    "SELECT payload_json FROM audit_logs WHERE action = 'storage_cleanup.retry' AND request_id = ?1",
    'cleanup-r2-unavailable'
  );
  assert.equal(unavailableAudits.length, 1);
  assert.deepEqual(JSON.parse(unavailableAudits[0].payload_json), {
    status: 'unavailable',
    count: { selected: 0, deleted: 0, resolved: 0, pending: 0, blocked: 0 },
    errorCode: 'r2_unavailable',
  });
});

test('進行中uploadのcleanup候補はgrace期間中にR2削除しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const activeKey = 'orgs/org-a/uploads/active';
  const staleKey = 'orgs/org-a/uploads/stale';
  const now = Date.now();
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'upload-active-job',
    r2Key: activeKey,
    orgId: IDS.orgA,
    reason: 'upload_uncommitted',
    createdAtMs: now,
    updatedAtMs: now,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'upload-stale-job',
    r2Key: staleKey,
    orgId: IDS.orgA,
    reason: 'upload_uncommitted',
    createdAtMs: now - 16 * 60 * 1000,
    updatedAtMs: now - 16 * 60 * 1000,
  });
  const deletedKeys = [];
  fixture.env.R2 = {
    async delete(keys) {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  const result = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'upload-grace-cleanup',
      body: { args: [{ limit: 5 }] },
    }
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(deletedKeys, [staleKey]);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', activeKey)
      .count,
    1
  );
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', staleKey)
      .count,
    0
  );
});

test('7日TTL後の同一cleanup requestは新しい監査世代として記録する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-generation-a',
    r2Key: 'orgs/org-a/orphans/generation-a',
    orgId: IDS.orgA,
    createdAtMs: NOW - 200,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-generation-b',
    r2Key: 'orgs/org-a/orphans/generation-b',
    orgId: IDS.orgA,
    createdAtMs: NOW - 100,
  });
  fixture.env.R2 = { async delete() {} };
  const requestId = 'cleanup-request-generation';
  const options = {
    method: 'POST',
    requestId,
    body: { args: [{ limit: 1 }] },
  };
  const first = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    options
  );
  assert.equal(first.response.status, 200);
  fixture.DB
    .prepare('UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1')
    .bind(requestId)
    .run();
  const second = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    options
  );
  assert.equal(second.response.status, 200);
  const audits = fixture.DB.all(
    `SELECT request_payload_sha256, request_generation_ms
       FROM audit_logs
      WHERE request_id = ?1
        AND action = 'storage_cleanup.retry'
      ORDER BY created_at_ms`,
    requestId
  );
  assert.equal(audits.length, 2);
  assert.equal(audits[0].request_payload_sha256, audits[1].request_payload_sha256);
  assert.notEqual(audits[0].request_generation_ms, audits[1].request_generation_ms);
});

test('storage cleanup再試行は自組織のorphanだけを削除しlive参照jobを解決してreplayを止める', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();

  const successKey = 'orgs/org-a/orphans/success-object';
  const liveKey = 'orgs/org-a/orphans/live-object';
  const nextKey = 'orgs/org-a/orphans/next-object';
  const crossOrgKey = 'orgs/org-b/orphans/cross-object';
  const nullOrgKey = 'legacy/orphans/null-org-object';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-success',
    r2Key: successKey,
    orgId: IDS.orgA,
    targetId: 'sensitive-target-success',
    updatedAtMs: NOW - 500,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-live',
    r2Key: liveKey,
    orgId: IDS.orgA,
    targetId: 'sensitive-target-live',
    updatedAtMs: NOW - 400,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-next',
    r2Key: nextKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW - 300,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-cross-org',
    r2Key: crossOrgKey,
    orgId: IDS.orgB,
    updatedAtMs: NOW - 700,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-null-org',
    r2Key: nullOrgKey,
    orgId: null,
    updatedAtMs: NOW - 800,
  });
  await fixture.DB
    .prepare(
      `
      INSERT INTO attachments (
        attachment_id, org_id, file_name, created_at_ms, created_by_membership_id, extra_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `
    )
    .bind(
      'cleanup-live-attachment',
      IDS.orgA,
      'live.bin',
      NOW,
      IDS.memberA,
      JSON.stringify({ r2Key: liveKey })
    )
    .run();

  const objects = new Set([successKey, liveKey, nextKey, crossOrgKey, nullOrgKey]);
  const deleteCalls = [];
  fixture.env.R2 = {
    async delete(keys) {
      const normalized = Array.isArray(keys) ? keys : [keys];
      deleteCalls.push([...normalized]);
      normalized.forEach((key) => objects.delete(key));
    },
  };
  const requestOptions = {
    method: 'POST',
    requestId: 'cleanup-safe-batch',
    body: { args: [{ limit: 2 }] },
  };
  const first = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    requestOptions
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.result.status, 'completed');
  assert.deepEqual(first.payload.result.count, {
    selected: 2,
    deleted: 1,
    resolved: 1,
    pending: 0,
    blocked: 0,
  });
  assert.deepEqual(first.payload.result.jobs, [
    { jobId: 'cleanup-success', status: 'deleted' },
    {
      jobId: 'cleanup-live',
      status: 'resolved_live_reference',
      errorCode: 'live_attachment_reference',
    },
  ]);
  assert.deepEqual(deleteCalls, [[successKey]]);
  assert.equal(objects.has(successKey), false);
  assert.equal(objects.has(liveKey), true);
  assert.deepEqual(
    fixture.DB
      .all('SELECT job_id FROM storage_cleanup_jobs ORDER BY job_id')
      .map((row) => row.job_id),
    ['cleanup-cross-org', 'cleanup-next', 'cleanup-null-org']
  );

  const audit = fixture.DB.get(
    "SELECT payload_json FROM audit_logs WHERE action = 'storage_cleanup.retry' AND request_id = ?1",
    'cleanup-safe-batch'
  );
  const serializedAudit = audit.payload_json;
  assert.equal(serializedAudit.includes('r2Key'), false);
  assert.equal(serializedAudit.includes(successKey), false);
  assert.equal(serializedAudit.includes('sensitive-target'), false);

  const replay = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    requestOptions
  );
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, 'idempotency_replay');
  assert.deepEqual(deleteCalls, [[successKey]]);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-next'
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'storage_cleanup.retry' AND request_id = ?1",
      'cleanup-safe-batch'
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM api_idempotency_keys WHERE request_id = ?1',
      'cleanup-safe-batch'
    ).count,
    1
  );
});

test('cleanupはorg不一致keyを遮断し、別requestの同時再試行もD1 leaseで一度だけ削除する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();

  const corruptKey = 'orgs/org-b/orphans/corrupt-org-a-job';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-corrupt-prefix',
    r2Key: corruptKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW - 1_000,
  });
  const deletedKeys = [];
  fixture.env.R2 = {
    async delete(keys) {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  const blocked = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'cleanup-corrupt-prefix-request',
    body: { args: [{ limit: 1 }] },
  });
  assert.equal(blocked.response.status, 200);
  assert.deepEqual(blocked.payload.result.jobs, [
    {
      jobId: 'cleanup-corrupt-prefix',
      status: 'blocked_scope_mismatch',
      errorCode: 'cleanup_scope_mismatch',
    },
  ]);
  assert.deepEqual(deletedKeys, []);
  assert.equal(
    fixture.DB.get(
      'SELECT last_error FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-corrupt-prefix'
    ).last_error,
    'cleanup_scope_mismatch'
  );

  const safeKey = 'orgs/org-a/orphans/lease-once';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-lease-once',
    r2Key: safeKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW,
  });
  const deleteArrived = createDeferred();
  const releaseDelete = createDeferred();
  fixture.env.R2 = {
    async delete(keys) {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      deleteArrived.resolve();
      await releaseDelete.promise;
    },
  };
  const firstPromise = apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-lease-first',
      body: { args: [{ limit: 1 }] },
    }
  );
  await deleteArrived.promise;
  const second = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-lease-second',
      body: { args: [{ limit: 1 }] },
    }
  );
  releaseDelete.resolve();
  const first = await firstPromise;

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.deepEqual(deletedKeys, [safeKey]);
  assert.equal(first.payload.result.count.deleted, 1);
  assert.equal(second.payload.result.count.selected, 0);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-lease-once'
    ).count,
    0
  );

  const adoptionRaceKey = 'orgs/org-a/orphans/adoption-race';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-adoption-race',
    r2Key: adoptionRaceKey,
    orgId: IDS.orgA,
    updatedAtMs: Date.now() - 1_000,
  });
  fixture.env.R2 = {
    async delete() {
      // retry側の最終live check後にattachment採用を試みるraceを再現する。
      // D1 triggerがこのINSERTを拒否するため、object deleteは成功扱いにならない。
      await fixture.DB
        .prepare(
          `INSERT INTO attachments (
             attachment_id, org_id, file_name, created_at_ms,
             created_by_membership_id, extra_json
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(
          'cleanup-adoption-race-attachment',
          IDS.orgA,
          'race.bin',
          Date.now(),
          IDS.memberA,
          JSON.stringify({ r2Key: adoptionRaceKey })
        )
        .run();
      deletedKeys.push(adoptionRaceKey);
    },
  };
  const adoptionRace = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-adoption-race-request',
      body: { args: [{ limit: 1 }] },
    }
  );
  assert.equal(adoptionRace.response.status, 200);
  assert.deepEqual(adoptionRace.payload.result.jobs, [
    {
      jobId: 'cleanup-adoption-race',
      status: 'retry_pending',
      errorCode: 'r2_delete_failed',
    },
  ]);
  assert.deepEqual(deletedKeys, [safeKey]);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1',
      'cleanup-adoption-race-attachment'
    ).count,
    0
  );
});

test('期限切れleaseでも旧worker tokenが残る間はattachment採用を拒否し、retryだけが再claimできる', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();

  const expiredLeaseKey = 'orgs/org-a/orphans/expired-slow-worker';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-expired-slow-worker',
    r2Key: expiredLeaseKey,
    orgId: IDS.orgA,
    leaseToken: 'expired-worker-token',
    leaseExpiresAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 60_000,
  });

  await assert.rejects(
    fixture.DB
      .prepare(
        `INSERT INTO attachments (
           attachment_id, org_id, file_name, created_at_ms, created_by_membership_id, extra_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        'expired-lease-adoption',
        IDS.orgA,
        'expired.bin',
        Date.now(),
        IDS.memberA,
        JSON.stringify({ r2Key: expiredLeaseKey })
      )
      .run(),
    /storage_cleanup_lease_active/
  );

  const deletedKeys = [];
  fixture.env.R2 = {
    async delete(keys) {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  const retried = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-expired-lease-reclaim',
      body: { args: [{ limit: 1 }] },
    }
  );

  assert.equal(retried.response.status, 200);
  assert.deepEqual(deletedKeys, [expiredLeaseKey]);
  assert.deepEqual(retried.payload.result.jobs, [
    { jobId: 'cleanup-expired-slow-worker', status: 'deleted' },
  ]);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-expired-slow-worker'
    ).count,
    0
  );
});

test('live参照cleanupはlimit 1でも解決して後続を飢餓させずCAS競合時はjobを保持する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const liveKey = 'orgs/org-a/orphans/fair-live';
  const orphanKey = 'orgs/org-a/orphans/fair-orphan';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-fair-live',
    r2Key: liveKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW - 200,
  });
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-fair-orphan',
    r2Key: orphanKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW - 100,
  });
  await fixture.DB
    .prepare(
      `INSERT INTO attachments (
         attachment_id, org_id, file_name, created_at_ms, created_by_membership_id, extra_json
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      'cleanup-fair-live-attachment',
      IDS.orgA,
      'live.bin',
      NOW,
      IDS.memberA,
      JSON.stringify({ r2Key: liveKey })
    )
    .run();
  const deletedKeys = [];
  fixture.env.R2 = {
    async delete(keys) {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };

  const first = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'cleanup-fair-first',
    body: { args: [{ limit: 1 }] },
  });
  assert.deepEqual(first.payload.result.jobs, [
    {
      jobId: 'cleanup-fair-live',
      status: 'resolved_live_reference',
      errorCode: 'live_attachment_reference',
    },
  ]);
  assert.deepEqual(deletedKeys, []);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-fair-live'
    ).count,
    0
  );

  const second = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'cleanup-fair-second',
    body: { args: [{ limit: 1 }] },
  });
  assert.deepEqual(second.payload.result.jobs, [
    { jobId: 'cleanup-fair-orphan', status: 'deleted' },
  ]);
  assert.deepEqual(deletedKeys, [orphanKey]);

  const casKey = 'orgs/org-a/orphans/live-cas';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-live-cas',
    r2Key: casKey,
    orgId: IDS.orgA,
    updatedAtMs: NOW,
  });
  await fixture.DB
    .prepare(
      `INSERT INTO attachments (
         attachment_id, org_id, file_name, created_at_ms, created_by_membership_id, extra_json
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      'cleanup-live-cas-attachment',
      IDS.orgA,
      'live-cas.bin',
      NOW,
      IDS.memberA,
      JSON.stringify({ r2Key: casKey })
    )
    .run();
  fixture.DB.exec(`
    CREATE TRIGGER cleanup_live_cas_conflict
    BEFORE DELETE ON storage_cleanup_jobs
    WHEN OLD.job_id = 'cleanup-live-cas'
    BEGIN
      UPDATE storage_cleanup_jobs
         SET updated_at_ms = updated_at_ms + 1
       WHERE job_id = OLD.job_id;
      SELECT RAISE(IGNORE);
    END;
  `);
  const cas = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'cleanup-live-cas-request',
    body: { args: [{ limit: 1 }] },
  });
  assert.deepEqual(cas.payload.result.jobs, [
    {
      jobId: 'cleanup-live-cas',
      status: 'retry_pending',
      errorCode: 'retry_state_changed',
    },
  ]);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE job_id = ?1',
      'cleanup-live-cas'
    ).count,
    1
  );
  assert.deepEqual(deletedKeys, [orphanKey]);
});

test('storage cleanup失敗はmetadataを保ったCAS更新だけを行いraw errorを公開しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const failureKey = 'orgs/org-a/orphans/failure-object';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-failure',
    r2Key: failureKey,
    orgId: IDS.orgA,
    targetType: 'message',
    targetId: 'message-private-target',
    reason: 'message_deleted',
    requestId: 'original-delete-request',
    attempts: 2,
    updatedAtMs: NOW - 200,
  });
  fixture.env.R2 = {
    async delete() {
      throw new Error('raw-secret-storage-failure');
    },
  };
  const failed = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-failure-request',
      body: { args: [{ limit: 1 }] },
    }
  );
  assert.equal(failed.response.status, 200);
  assert.deepEqual(failed.payload.result.jobs, [
    {
      jobId: 'cleanup-failure',
      status: 'retry_pending',
      errorCode: 'r2_delete_failed',
    },
  ]);
  const failedRow = fixture.DB.get(
    `SELECT target_type, target_id, reason, request_id, attempts, last_error
       FROM storage_cleanup_jobs
      WHERE job_id = ?1`,
    'cleanup-failure'
  );
  assert.deepEqual({ ...failedRow }, {
    target_type: 'message',
    target_id: 'message-private-target',
    reason: 'message_deleted',
    request_id: 'original-delete-request',
    attempts: 3,
    last_error: 'r2_delete_failed',
  });
  assert.equal(JSON.stringify(failed.payload).includes('raw-secret-storage-failure'), false);
  assert.equal(
    fixture.DB.get(
      "SELECT payload_json FROM audit_logs WHERE action = 'storage_cleanup.retry' AND request_id = ?1",
      'cleanup-failure-request'
    ).payload_json.includes('raw-secret-storage-failure'),
    false
  );

  const casKey = 'orgs/org-a/orphans/cas-object';
  await insertStorageCleanupJob(fixture.DB, {
    jobId: 'cleanup-cas',
    r2Key: casKey,
    orgId: IDS.orgA,
    targetType: 'profile',
    targetId: 'profile-private-target',
    reason: 'profile_replaced',
    attempts: 0,
    updatedAtMs: NOW - 100,
  });
  fixture.env.R2 = {
    async delete() {
      await fixture.DB
        .prepare(
          'UPDATE storage_cleanup_jobs SET updated_at_ms = updated_at_ms + 1 WHERE job_id = ?1'
        )
        .bind('cleanup-cas')
        .run();
      throw new Error('concurrent-r2-failure');
    },
  };
  const casResult = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-cas-request',
      body: { args: [{ limit: 1 }] },
    }
  );
  assert.equal(casResult.response.status, 200);
  assert.deepEqual(casResult.payload.result.jobs, [
    {
      jobId: 'cleanup-cas',
      status: 'retry_pending',
      errorCode: 'retry_state_changed',
    },
  ]);
  const casRow = fixture.DB.get(
    `SELECT target_type, target_id, reason, attempts
       FROM storage_cleanup_jobs
      WHERE job_id = ?1`,
    'cleanup-cas'
  );
  assert.deepEqual({ ...casRow }, {
    target_type: 'profile',
    target_id: 'profile-private-target',
    reason: 'profile_replaced',
    attempts: 0,
  });
});

test('storage cleanup再試行のdefaultは10件でhard limit 25を越えない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  for (let index = 0; index < 36; index += 1) {
    await insertStorageCleanupJob(fixture.DB, {
      jobId: `cleanup-limit-${String(index).padStart(2, '0')}`,
      r2Key: `orgs/org-a/orphans/limit-${String(index).padStart(2, '0')}`,
      orgId: IDS.orgA,
      updatedAtMs: NOW - 1_000 + index,
    });
  }
  let deleteCalls = 0;
  fixture.env.R2 = {
    async delete() {
      deleteCalls += 1;
    },
  };

  const invalidLow = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-limit-low',
      body: { args: [{ limit: 0 }] },
    }
  );
  const invalidHigh = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-limit-high',
      body: { args: [{ limit: 26 }] },
    }
  );
  assert.deepEqual([invalidLow.response.status, invalidHigh.response.status], [400, 400]);
  assert.equal(deleteCalls, 0);

  const defaultBatch = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-limit-default',
      body: { args: [{}] },
    }
  );
  assert.equal(defaultBatch.response.status, 200);
  assert.equal(defaultBatch.payload.result.count.selected, 10);
  assert.equal(deleteCalls, 10);

  const maximumBatch = await apiRequest(
    fixture,
    fixture.actors.userA,
    'adminRetryStorageCleanup',
    {
      method: 'POST',
      requestId: 'cleanup-limit-maximum',
      body: { args: [{ limit: 25 }] },
    }
  );
  assert.equal(maximumBatch.response.status, 200);
  assert.equal(maximumBatch.payload.result.count.selected, 25);
  assert.equal(deleteCalls, 35);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE org_id = ?1', IDS.orgA)
      .count,
    1
  );
});

test('段階uploadはowner scopeで一度だけmessageへclaimし旧Data URIを拒否する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  let putCalls = 0;
  fixture.env.R2 = {
    async put(key, value) {
      putCalls += 1;
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };

  const bytes = new TextEncoder().encode('message-image');
  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'stage-message-owner-once',
    fileName: '証跡.png',
    bytes,
  });
  assert.equal(staged.purpose, 'message');
  assert.equal(staged.status, 'ready');
  assert.equal(putCalls, 1);
  const stagedRow = fixture.DB.get(
    'SELECT * FROM staged_attachments WHERE staged_attachment_id = ?1',
    staged.stagedAttachmentId
  );
  assert.equal(stagedRow.owner_user_id, IDS.userA);
  assert.equal(stagedRow.org_id, IDS.orgA);
  assert.match(stagedRow.r2_key, /^orgs\/org-a\/messages\/objects\/[0-9a-f]{32}\//);
  assert.equal(stagedRow.r2_key.includes('user-a'), false);
  assert.equal(objects.has(stagedRow.r2_key), true);

  const replay = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'stage-message-owner-once',
    fileName: '証跡.png',
    bytes,
  });
  assert.equal(replay.stagedAttachmentId, staged.stagedAttachmentId);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(putCalls, 1);

  const hiddenBeforeClaim = await apiRequest(fixture, fixture.actors.userA, 'downloadAttachment', {
    search: `?attachmentId=${encodeURIComponent(staged.stagedAttachmentId)}`,
  });
  assert.equal(hiddenBeforeClaim.response.status, 404);

  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-claim-stage-once',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: '段階添付',
          attachments: [{ stagedAttachmentId: staged.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(created.response.status, 200);
  const messageId = created.payload.memoId;
  assert.ok(messageId);
  const claimed = fixture.DB.get(
    'SELECT status, claimed_target_type, claimed_target_id FROM staged_attachments WHERE staged_attachment_id = ?1',
    staged.stagedAttachmentId
  );
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimed_target_type, 'message');
  assert.equal(claimed.claimed_target_id, messageId);
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?1 AND attachment_id = ?2',
      messageId,
      staged.stagedAttachmentId
    ).count,
    1
  );
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', stagedRow.r2_key)
      .count,
    0
  );

  const reused = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-reuse-consumed-stage',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: '再利用不可',
          attachments: [{ stagedAttachmentId: staged.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.code, 'staged_attachment_unavailable');

  const crossOwner = await apiRequest(fixture, fixture.actors.userB, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-cross-owner-stage',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: '別所有者不可',
          attachments: [{ stagedAttachmentId: staged.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(crossOwner.response.status, 409);

  const legacy = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'message-inline-data-rejected',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: '旧添付拒否',
          attachments: [{ name: 'old.png', dataUri: 'data:image/png;base64,aGVsbG8=' }],
        },
      ],
    },
  });
  assert.equal(legacy.response.status, 400);
  assert.equal(legacy.payload.code, 'staged_attachment_required');
});

test('profile stageは設定競合で消費せず、置換後は別requestから再利用できない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };

  const first = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'profile-stage-first',
    fileName: 'first.png',
    text: 'first-profile',
  });
  const firstRow = fixture.DB.get(
    'SELECT r2_key FROM staged_attachments WHERE staged_attachment_id = ?1',
    first.stagedAttachmentId
  );
  const staleVersion = fixture.DB.get(
    'SELECT settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  ).settings_version;
  await fixture.DB
    .prepare('UPDATE users SET settings_version = ?2 WHERE user_id = ?1')
    .bind(IDS.userA, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    .run();
  const conflict = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-stage-conflict',
    body: {
      args: [
        {
          name: '競合保持',
          expectedSettingsVersion: staleVersion,
          stagedAttachmentId: first.stagedAttachmentId,
        },
      ],
    },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(
    fixture.DB.get(
      'SELECT status FROM staged_attachments WHERE staged_attachment_id = ?1',
      first.stagedAttachmentId
    ).status,
    'ready'
  );
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1', first.stagedAttachmentId)
      .count,
    0
  );
  assert.equal(objects.has(firstRow.r2_key), true);

  const replacement = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'profile-stage-replacement',
    fileName: 'replacement.png',
    text: 'replacement-profile',
  });
  assert.equal(
    fixture.DB.get(
      "SELECT COUNT(*) AS count FROM staged_attachments WHERE staged_attachment_id = ?1 AND status = 'superseded'",
      first.stagedAttachmentId
    ).count,
    1
  );
  assert.equal(objects.has(firstRow.r2_key), false);

  const currentVersion = fixture.DB.get(
    'SELECT settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  ).settings_version;
  const saved = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-stage-save',
    body: {
      args: [
        {
          name: '段階画像',
          expectedSettingsVersion: currentVersion,
          stagedAttachmentId: replacement.stagedAttachmentId,
        },
      ],
    },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const replacementRow = fixture.DB.get(
    'SELECT * FROM staged_attachments WHERE staged_attachment_id = ?1',
    replacement.stagedAttachmentId
  );
  assert.equal(replacementRow.status, 'claimed');
  assert.equal(replacementRow.claimed_target_type, 'user_settings');
  assert.notEqual(replacementRow.claimed_target_id, IDS.userA);
  const user = fixture.DB.get(
    'SELECT profile_image_url, settings_version FROM users WHERE user_id = ?1',
    IDS.userA
  );
  assert.equal(
    user.profile_image_url,
    `/api/downloadAttachment?attachmentId=${encodeURIComponent(replacement.stagedAttachmentId)}`
  );
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM attachments WHERE attachment_id = ?1', replacement.stagedAttachmentId)
      .count,
    1
  );
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', replacementRow.r2_key)
      .count,
    0
  );

  const reused = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-stage-reuse-other-request',
    body: {
      args: [
        {
          expectedSettingsVersion: user.settings_version,
          stagedAttachmentId: replacement.stagedAttachmentId,
        },
      ],
    },
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.code, 'staged_attachment_unavailable');

  const legacy = await apiRequest(fixture, fixture.actors.userA, 'saveUserSettings', {
    method: 'POST',
    requestId: 'profile-inline-data-rejected',
    body: { args: [{ expectedSettingsVersion: user.settings_version, imageData: 'data:image/png;base64,QQ==' }] },
  });
  assert.equal(legacy.response.status, 400);
  assert.equal(legacy.payload.code, 'staged_attachment_required');
});

test('body hard capとcleanup leaseは巨大JSON・偽装長・有効stageの誤削除を防ぐ', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const objects = new Map();
  let deleteCalls = 0;
  fixture.env.R2 = {
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      deleteCalls += 1;
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };

  const hugeJson = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'huge-json-rejected',
    body: { args: [{ title: 'x'.repeat(1024 * 1024 + 1) }] },
  });
  assert.equal(hugeJson.response.status, 413);
  assert.equal(hugeJson.payload.code, 'request_body_too_large');

  const tooLarge = await apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: 'binary-length-too-large',
    bytes: new Uint8Array(1),
    contentLength: 10 * 1024 * 1024 + 1,
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.payload.code, 'request_body_too_large');

  const liedLength = await apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: 'binary-length-mismatch',
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentLength: 2,
  });
  assert.equal(liedLength.response.status, 400);
  assert.equal(liedLength.payload.code, 'content_length_mismatch');

  const staged = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'cleanup-active-stage',
    includeContentLength: false,
    text: 'active-stage',
  });
  const stageRow = fixture.DB.get(
    'SELECT r2_key FROM staged_attachments WHERE staged_attachment_id = ?1',
    staged.stagedAttachmentId
  );
  await fixture.DB
    .prepare('UPDATE storage_cleanup_jobs SET created_at_ms = ?2, updated_at_ms = ?2 WHERE r2_key = ?1')
    .bind(stageRow.r2_key, Date.now() - 60 * 60 * 1000)
    .run();
  const deferred = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'cleanup-active-stage-deferred',
    body: { args: [{ limit: 1 }] },
  });
  assert.equal(deferred.response.status, 200);
  assert.equal(deferred.payload.result.jobs[0].status, 'deferred_active_stage');
  assert.equal(deleteCalls, 0);
  assert.equal(objects.has(stageRow.r2_key), true);
  const job = fixture.DB.get(
    'SELECT lease_token, last_error FROM storage_cleanup_jobs WHERE r2_key = ?1',
    stageRow.r2_key
  );
  assert.equal(job.lease_token, null);
  assert.equal(job.last_error, 'staged_attachment_unexpired');
});

test('段階uploadはR2確定まで同時2件に制限し3件目を429で拒否する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const arrivals = [createDeferred(), createDeferred()];
  const releases = [createDeferred(), createDeferred()];
  let putCalls = 0;
  fixture.env.R2 = {
    async put() {
      const index = putCalls;
      putCalls += 1;
      arrivals[index]?.resolve();
      await releases[index]?.promise;
    },
    async delete() {},
  };

  const first = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: 'upload-slot-1',
    fileName: 'one.png',
    bytes: new Uint8Array([1]),
  });
  const second = apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: 'upload-slot-2',
    fileName: 'two.png',
    bytes: new Uint8Array([2]),
  });
  await Promise.all(arrivals.map((entry) => entry.promise));

  const rejected = await apiBinaryRequest(fixture, fixture.actors.userA, 'stageAttachment', {
    purpose: 'message',
    requestId: 'upload-slot-3',
    fileName: 'three.png',
    bytes: new Uint8Array([3]),
  });
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.payload.code, 'staged_upload_busy');
  assert.equal(putCalls, 2);

  releases.forEach((entry) => entry.resolve());
  const completed = await Promise.all([first, second]);
  assert.deepEqual(
    completed.map((entry) => entry.response.status).sort(),
    [201, 201]
  );
});

test('古いstage replayはprofile置換・期限切れcleanup後も復活せずTTL新世代は別IDになる', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const objects = new Map();
  const putKeys = [];
  fixture.env.R2 = {
    async put(key, value) {
      putKeys.push(key);
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };

  const profileAOptions = {
    purpose: 'profile',
    requestId: 'stale-profile-stage-a',
    fileName: 'a.png',
    bytes: new TextEncoder().encode('profile-a'),
  };
  const profileA = await stageTestAttachment(fixture, fixture.actors.userA, profileAOptions);
  const profileB = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'profile',
    requestId: 'stale-profile-stage-b',
    fileName: 'b.png',
    text: 'profile-b',
  });
  const putsAfterB = putKeys.length;
  const staleProfileReplay = await apiBinaryRequest(
    fixture,
    fixture.actors.userA,
    'stageAttachment',
    profileAOptions
  );
  assert.equal(staleProfileReplay.response.status, 410);
  assert.equal(staleProfileReplay.payload.code, 'staged_attachment_superseded');
  assert.equal(putKeys.length, putsAfterB);
  assert.equal(
    fixture.DB.get(
      'SELECT status FROM staged_attachments WHERE staged_attachment_id = ?1',
      profileA.stagedAttachmentId
    ).status,
    'superseded'
  );
  assert.equal(
    fixture.DB.get(
      'SELECT status FROM staged_attachments WHERE staged_attachment_id = ?1',
      profileB.stagedAttachmentId
    ).status,
    'ready'
  );

  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  try {
    const expiringOptions = {
      purpose: 'message',
      requestId: 'expired-stage-replay',
      fileName: 'expired.png',
      bytes: new TextEncoder().encode('expired'),
    };
    const expiring = await stageTestAttachment(fixture, fixture.actors.userA, expiringOptions);
    const expiringRow = fixture.DB.get(
      'SELECT r2_key FROM staged_attachments WHERE staged_attachment_id = ?1',
      expiring.stagedAttachmentId
    );
    fakeNow += 31 * 60 * 1000;
    const cleanup = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
      method: 'POST',
      requestId: 'expired-stage-cleanup',
      body: { args: [{ limit: 10 }] },
    });
    assert.equal(cleanup.response.status, 200);
    assert.equal(objects.has(expiringRow.r2_key), false);
    const putsAfterCleanup = putKeys.length;
    const expiredReplay = await apiBinaryRequest(
      fixture,
      fixture.actors.userA,
      'stageAttachment',
      expiringOptions
    );
    assert.equal(expiredReplay.response.status, 410);
    assert.equal(expiredReplay.payload.code, 'staged_attachment_expired');
    assert.equal(putKeys.length, putsAfterCleanup);
    assert.equal(
      fixture.DB.get(
        'SELECT COUNT(*) AS count FROM staged_attachments WHERE staged_attachment_id = ?1',
        expiring.stagedAttachmentId
      ).count,
      1
    );
  } finally {
    Date.now = realDateNow;
  }

  const generationOptions = {
    purpose: 'message',
    requestId: 'stage-generation-after-idempotency-ttl',
    fileName: 'generation.png',
    bytes: new TextEncoder().encode('same-file'),
  };
  const generationA = await stageTestAttachment(fixture, fixture.actors.userA, generationOptions);
  fixture.DB
    .prepare(
      "UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1 AND route = 'stageAttachment'"
    )
    .bind(generationOptions.requestId)
    .run();
  const generationB = await stageTestAttachment(fixture, fixture.actors.userA, generationOptions);
  assert.notEqual(generationA.stagedAttachmentId, generationB.stagedAttachmentId);
});

test('削除済みclaimed stageはidempotency期限後にpruneし、missing replayは再生成しない', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  const objects = new Map();
  let putCalls = 0;
  fixture.env.R2 = {
    async put(key, value) {
      putCalls += 1;
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };

  const claimedStageRequestId = 'claimed-stage-prune-source';
  const claimed = await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: claimedStageRequestId,
    fileName: 'claimed.png',
    text: 'claimed',
  });
  const created = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'claimed-stage-message-create',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: 'prune対象',
          attachments: [{ stagedAttachmentId: claimed.stagedAttachmentId }],
        },
      ],
    },
  });
  assert.equal(created.response.status, 200);
  const deleted = await apiRequest(fixture, fixture.actors.userA, 'deleteMessageById', {
    method: 'POST',
    requestId: 'claimed-stage-message-delete',
    body: { args: [created.payload.memoId] },
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(
    fixture.DB.get(
      'SELECT status FROM staged_attachments WHERE staged_attachment_id = ?1',
      claimed.stagedAttachmentId
    ).status,
    'claimed'
  );
  fixture.DB
    .prepare(
      "UPDATE api_idempotency_keys SET expires_at_ms = 0 WHERE request_id = ?1 AND route = 'stageAttachment'"
    )
    .bind(claimedStageRequestId)
    .run();
  await stageTestAttachment(fixture, fixture.actors.userA, {
    purpose: 'message',
    requestId: 'claimed-stage-prune-trigger',
    fileName: 'next.png',
    text: 'next',
  });
  assert.equal(
    fixture.DB.get(
      'SELECT COUNT(*) AS count FROM staged_attachments WHERE staged_attachment_id = ?1',
      claimed.stagedAttachmentId
    ).count,
    0
  );

  const missingOptions = {
    purpose: 'message',
    requestId: 'stage-replay-metadata-missing',
    fileName: 'missing.png',
    bytes: new TextEncoder().encode('missing'),
  };
  const missing = await stageTestAttachment(fixture, fixture.actors.userA, missingOptions);
  fixture.DB
    .prepare('DELETE FROM staged_attachments WHERE staged_attachment_id = ?1')
    .bind(missing.stagedAttachmentId)
    .run();
  const putCallsBeforeReplay = putCalls;
  const replay = await apiBinaryRequest(
    fixture,
    fixture.actors.userA,
    'stageAttachment',
    missingOptions
  );
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, 'staged_attachment_replay_missing');
  assert.equal(putCalls, putCallsBeforeReplay);
});

test('failed stageをcleanup後に再送してもoutboxを再作成しclaimで解消する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());
  await fixture.DB
    .prepare("UPDATE memberships SET role = 'admin' WHERE membership_id = ?1")
    .bind(IDS.memberA)
    .run();
  const objects = new Map();
  let putCalls = 0;
  fixture.env.R2 = {
    async put(key, value) {
      putCalls += 1;
      if (putCalls === 1) throw new Error('simulated R2 put failure');
      objects.set(key, new Uint8Array(value));
    },
    async delete(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => objects.delete(key));
    },
  };
  const stageOptions = {
    purpose: 'message',
    requestId: 'failed-stage-retry-after-cleanup',
    fileName: 'retry.png',
    bytes: new TextEncoder().encode('retry'),
  };
  const failed = await apiBinaryRequest(
    fixture,
    fixture.actors.userA,
    'stageAttachment',
    stageOptions
  );
  assert.equal(failed.response.status, 502);
  const failedRow = fixture.DB.get(
    "SELECT staged_attachment_id, r2_key, status FROM staged_attachments WHERE request_id = ?1",
    stageOptions.requestId
  );
  assert.equal(failedRow.status, 'failed');
  fixture.DB
    .prepare('UPDATE storage_cleanup_jobs SET created_at_ms = ?2, updated_at_ms = ?2 WHERE r2_key = ?1')
    .bind(failedRow.r2_key, Date.now() - 60 * 60 * 1000)
    .run();
  const cleanup = await apiRequest(fixture, fixture.actors.userA, 'adminRetryStorageCleanup', {
    method: 'POST',
    requestId: 'failed-stage-admin-cleanup',
    body: { args: [{ limit: 1 }] },
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', failedRow.r2_key)
      .count,
    0
  );

  const retried = await apiBinaryRequest(
    fixture,
    fixture.actors.userA,
    'stageAttachment',
    stageOptions
  );
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.equal(retried.payload.result.stagedAttachmentId, failedRow.staged_attachment_id);
  assert.equal(
    fixture.DB.get('SELECT status FROM staged_attachments WHERE staged_attachment_id = ?1', failedRow.staged_attachment_id)
      .status,
    'ready'
  );
  assert.equal(
    fixture.DB.get('SELECT reason FROM storage_cleanup_jobs WHERE r2_key = ?1', failedRow.r2_key)
      .reason,
    'upload_uncommitted'
  );

  const claimed = await apiRequest(fixture, fixture.actors.userA, 'addNewMessage', {
    method: 'POST',
    requestId: 'failed-stage-claim-after-retry',
    body: {
      args: [
        {
          folderId: IDS.publicFolder,
          title: 'retry claim',
          attachments: [{ stagedAttachmentId: failedRow.staged_attachment_id }],
        },
      ],
    },
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(
    fixture.DB.get('SELECT COUNT(*) AS count FROM storage_cleanup_jobs WHERE r2_key = ?1', failedRow.r2_key)
      .count,
    0
  );
});
