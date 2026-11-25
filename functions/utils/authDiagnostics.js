import {
  createDiagnosticsPayload,
  persistOperationalDiagnostic,
} from './diagnostics.js';

function normalizeCode(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, 128);
  return normalized || fallback;
}

/**
 * 認証基盤の障害をraw例外なしでD1診断へbest-effort保存する。
 * D1自体が障害中でも認証handlerへ例外を戻さない。
 */
export async function recordAuthInfrastructureFailure(env, details = {}) {
  const reasonCode = normalizeCode(details.reasonCode, 'auth_infrastructure_failure');
  const event = normalizeCode(details.event, reasonCode);
  const payload = createDiagnosticsPayload(
    'error',
    reasonCode,
    {
      event,
      requestId: String(details.requestId || '').slice(0, 128),
      route: String(details.route || '').slice(0, 256),
      reasonCode,
      phase: normalizeCode(details.phase, 'auth'),
      httpStatus: Number(details.httpStatus) || 503,
    },
    Number.isFinite(Number(details.occurredAt)) ? Number(details.occurredAt) : Date.now()
  );
  if (!env?.DB || !payload) return { recorded: false, reason: 'db_unavailable' };
  try {
    return await persistOperationalDiagnostic(env.DB, payload);
  } catch (_error) {
    console.warn('[ShiftFlow][AuthDiagnostics] persistence failed', {
      event,
      requestId: payload.requestId,
      reasonCode: 'auth_diagnostic_persistence_failed',
    });
    return { recorded: false, reason: 'persistence_failed' };
  }
}
