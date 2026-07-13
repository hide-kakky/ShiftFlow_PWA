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
    created_at_ms INTEGER NOT NULL
  );

  CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    auth_subject TEXT,
    status TEXT DEFAULT 'active',
    is_active INTEGER NOT NULL DEFAULT 1,
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

  CREATE TABLE audit_logs (
    audit_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    actor_membership_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT,
    action TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    payload_json TEXT,
    FOREIGN KEY (org_id) REFERENCES organizations(org_id),
    FOREIGN KEY (actor_membership_id) REFERENCES memberships(membership_id)
  );

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
    created_at_ms INTEGER NOT NULL
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
      ('${IDS.memberA}', '${IDS.orgA}', '${IDS.userA}', 'member', 'active', ${NOW - 5_000}),
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

async function apiRequest(fixture, actor, route, options = {}) {
  const method = options.method || 'GET';
  const search = typeof options.search === 'string' ? options.search : '';
  const headers = {
    origin: ORIGIN,
    cookie: actor.cookie,
  };
  const requestOptions = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }
  const response = await handleApiRequest({
    request: new Request(`${ORIGIN}/api/${route}${search}`, requestOptions),
    params: { route: route.split('/') },
    env: fixture.env,
    waitUntil() {},
  });
  const payload = await response.json();
  return { response, payload };
}

function findMessage(payload, messageId) {
  const rows = Array.isArray(payload?.result) ? payload.result : [];
  return rows.find((row) => row.id === messageId) || null;
}

function delayForDistinctTimestamp() {
  return new Promise((resolve) => setTimeout(resolve, 5));
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
});

test('他ユーザーのコメント更新を一覧へ返し、閲覧後は新着状態を解除する', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.DB.close());

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
