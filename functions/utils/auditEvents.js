const AUTH_EVENT_TYPES = new Set([
  'authentication.succeeded',
  'authentication.failed',
  'session.logged_out',
  'session.expired',
  'authorization.denied',
  'authorization.role_denied',
]);

function normalizeText(value, maxLength = 256) {
  if (value === null || value === undefined) return '';
  const normalized = String(value).trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeEmail(value) {
  return normalizeText(value, 320).toLowerCase();
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const input = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(digest);
}

export async function fingerprintSessionId(sessionId) {
  const normalized = normalizeText(sessionId, 128);
  if (!normalized) return '';
  return (await sha256Hex(normalized)).slice(0, 32);
}

function createEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `auth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

async function resolveIdentitySnapshot(db, user) {
  if (!db) return null;
  const email = normalizeEmail(user?.email);
  if (!email) return null;
  try {
    const row = await db
      .prepare(
        `
        SELECT
          u.user_id,
          u.email,
          u.display_name,
          u.auth_subject,
          u.status AS user_status,
          (
            SELECT COUNT(*)
              FROM memberships active_membership
             WHERE active_membership.user_id = u.user_id
               AND LOWER(COALESCE(active_membership.status, '')) = 'active'
          ) AS active_membership_count,
          (
            SELECT active_membership.org_id
              FROM memberships active_membership
             WHERE active_membership.user_id = u.user_id
               AND LOWER(COALESCE(active_membership.status, '')) = 'active'
             ORDER BY active_membership.created_at_ms ASC,
                      active_membership.membership_id ASC
             LIMIT 1
          ) AS sole_org_id,
          (
            SELECT active_membership.role
              FROM memberships active_membership
             WHERE active_membership.user_id = u.user_id
               AND LOWER(COALESCE(active_membership.status, '')) = 'active'
             ORDER BY active_membership.created_at_ms ASC,
                      active_membership.membership_id ASC
             LIMIT 1
          ) AS sole_role,
          (
            SELECT active_membership.status
              FROM memberships active_membership
             WHERE active_membership.user_id = u.user_id
               AND LOWER(COALESCE(active_membership.status, '')) = 'active'
             ORDER BY active_membership.created_at_ms ASC,
                      active_membership.membership_id ASC
             LIMIT 1
          ) AS sole_membership_status
        FROM users u
        WHERE LOWER(u.email) = ?1
        LIMIT 1
      `
      )
      .bind(email)
      .first();
    return row || null;
  } catch (_error) {
    console.warn('[ShiftFlow][AuthEvent] identity lookup failed', {
      reasonCode: 'identity_lookup_failed',
    });
    return null;
  }
}

async function resolveEventKey(details, identityScope = {}) {
  const eventType = normalizeText(details?.eventType, 64);
  const requestId = normalizeText(details?.requestId, 128);
  const authAttemptId = normalizeText(details?.authAttemptId, 128);
  const sessionFingerprint = normalizeText(identityScope.sessionFingerprint, 64);
  const isAuthorizationAttempt = eventType.startsWith('authorization.');
  // 認可拒否はclient supplied request IDで抑制しない。同じrequest IDを再利用した
  // 別HTTP要求も、server生成attempt IDが異なれば別のセキュリティ事実として残す。
  const discriminator = isAuthorizationAttempt
    ? authAttemptId || createEventId()
    : authAttemptId || sessionFingerprint || requestId;
  if (!discriminator) return '';
  const scope = normalizeText(details?.idempotencyScope, 128).replace(/[^A-Za-z0-9._:-]/g, '_');
  const material = isAuthorizationAttempt
    ? [
        eventType,
        discriminator,
        sessionFingerprint,
        normalizeText(identityScope.orgId, 128),
        normalizeText(identityScope.userId, 128),
        normalizeText(details?.route, 256),
        scope,
      ]
    : [eventType, discriminator];
  return `auth:${await sha256Hex(material.join('\u0000'))}`;
}

/**
 * 認証・セッション・認可イベントの正本へ冪等記録する。
 * ログ障害でログインやログアウト自体を失敗させないため、例外は外へ投げない。
 */
export async function recordAuthEvent(env, details = {}) {
  const db = env?.DB;
  const eventType = normalizeText(details.eventType, 64);
  if (!db) return { recorded: false, reason: 'db_unavailable' };
  if (!AUTH_EVENT_TYPES.has(eventType)) {
    return { recorded: false, reason: 'unsupported_event_type' };
  }

  try {
    const identity =
      details.identity && typeof details.identity === 'object'
        ? details.identity
        : await resolveIdentitySnapshot(db, details.user || {});
    const sessionFingerprint =
      normalizeText(details.sessionFingerprint, 64) ||
      (details.sessionId ? await fingerprintSessionId(details.sessionId) : '');
    const occurredAt = Number.isFinite(Number(details.occurredAt))
      ? Math.floor(Number(details.occurredAt))
      : Date.now();
    const userId = normalizeText(details.userId || identity?.user_id, 128) || null;
    const activeMembershipCount = Number(identity?.active_membership_count || 0);
    const useSoleMembership = activeMembershipCount === 1;
    const orgId =
      normalizeText(details.orgId || (useSoleMembership ? identity?.sole_org_id : ''), 128) ||
      null;
    const eventKey = await resolveEventKey(details, {
      sessionFingerprint,
      orgId,
      userId,
    });
    if (!eventKey) return { recorded: false, reason: 'event_key_unavailable' };

    const status = normalizeText(
      details.status ||
        (useSoleMembership ? identity?.sole_membership_status : '') ||
        identity?.user_status,
      64
    );
    const role = normalizeText(details.role || (useSoleMembership ? identity?.sole_role : ''), 64);
    const statements = [
      db
        .prepare(
          `
          INSERT OR IGNORE INTO auth_events (
            event_id,
            event_key,
            event_type,
            outcome,
            reason_code,
            org_id,
            user_id,
            user_email,
            user_sub,
            status,
            role,
            request_id,
            route,
            source,
            session_fingerprint,
            occurred_at_ms
          )
          VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
          )
        `
        )
        .bind(
          createEventId(),
          eventKey,
          eventType,
          normalizeText(details.outcome, 32) || 'success',
          normalizeText(details.reasonCode, 128),
          orgId,
          userId,
          null,
          null,
          status,
          role,
          normalizeText(details.requestId, 128),
          normalizeText(details.route, 256),
          normalizeText(details.source, 64) || 'cloudflare',
          sessionFingerprint || null,
          occurredAt
        ),
    ];

    if (eventType === 'authentication.succeeded' && userId) {
      statements.push(
        db
          .prepare(
            `
            UPDATE users
               SET first_login_at_ms = COALESCE(first_login_at_ms, ?2),
                   last_login_at_ms = CASE
                     WHEN last_login_at_ms IS NULL OR last_login_at_ms < ?2 THEN ?2
                     ELSE last_login_at_ms
                   END,
                   updated_at_ms = CASE
                     WHEN updated_at_ms < ?2 THEN ?2
                     ELSE updated_at_ms
                   END
             WHERE user_id = ?1
               AND EXISTS (
                 SELECT 1
                   FROM auth_events
                  WHERE event_key = ?3
                    AND occurred_at_ms = ?2
               )
          `
          )
          .bind(userId, occurredAt, eventKey)
      );
    }

    const results = await db.batch(statements);
    const changes = Number(results?.[0]?.meta?.changes || 0);
    return {
      recorded: changes > 0,
      duplicate: changes === 0,
      eventKey,
      orgId: orgId || '',
      userId: userId || '',
    };
  } catch (_error) {
    console.warn('[ShiftFlow][AuthEvent] persistence failed', {
      eventType,
      requestId: normalizeText(details.requestId, 128),
      reasonCode: 'auth_event_persistence_failed',
    });
    return { recorded: false, reason: 'persistence_failed' };
  }
}
