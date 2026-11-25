const OAUTH_CALLBACK_CLAIM_TTL_MS = 10 * 60 * 1000;
const OAUTH_CALLBACK_CLAIM_PRUNE_LIMIT = 100;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function fingerprintOAuthState(state) {
  const normalized = typeof state === 'string' ? state.trim() : '';
  if (!normalized || normalized.length > 2048) {
    const error = new Error('OAuth callback state is invalid.');
    error.code = 'oauth_callback_state_invalid';
    throw error;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return toHex(digest);
}

/**
 * OAuth callbackのstateをD1で一度だけclaimする。
 * raw stateは保存せず、INSERT OR IGNOREの一意制約をisolate横断の境界にする。
 */
export async function claimOAuthCallback(env, state, now = Date.now()) {
  const db = env?.DB;
  if (!db) {
    const error = new Error('D1 is required to claim an OAuth callback.');
    error.code = 'oauth_callback_claim_unavailable';
    throw error;
  }
  const stateFingerprint = await fingerprintOAuthState(state);
  const claimedAtMs = Number.isFinite(now) ? Math.floor(now) : Date.now();
  const expiresAtMs = claimedAtMs + OAUTH_CALLBACK_CLAIM_TTL_MS;

  await db
    .prepare(
      `
      DELETE FROM oauth_callback_claims
       WHERE state_fingerprint IN (
         SELECT state_fingerprint
           FROM oauth_callback_claims
          WHERE expires_at_ms <= ?1
          ORDER BY expires_at_ms ASC
          LIMIT ?2
       )
    `
    )
    .bind(claimedAtMs, OAUTH_CALLBACK_CLAIM_PRUNE_LIMIT)
    .run();

  const result = await db
    .prepare(
      `
      INSERT OR IGNORE INTO oauth_callback_claims (
        state_fingerprint,
        claimed_at_ms,
        expires_at_ms
      )
      VALUES (?1, ?2, ?3)
    `
    )
    .bind(stateFingerprint, claimedAtMs, expiresAtMs)
    .run();

  return {
    claimed: Number(result?.meta?.changes || 0) > 0,
    stateFingerprint,
    claimedAtMs,
    expiresAtMs,
  };
}

export { OAUTH_CALLBACK_CLAIM_TTL_MS };
