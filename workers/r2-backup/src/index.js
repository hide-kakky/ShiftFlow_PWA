const DEFAULT_INCLUDE_PREFIXES = ['attachments/', 'profiles/', 'logs/'];
const STATE_KEY = 'r2-backup:state';
const MAX_OBJECTS_PER_RUN = 5000;
const MAX_PUT_OPERATIONS_PER_RUN = 1000;

export default {
  async scheduled(event, env, ctx) {
    const mode = resolveMode(event, env);
    const includePrefixes = parsePrefixes(env.BACKUP_INCLUDE_PREFIXES) ?? DEFAULT_INCLUDE_PREFIXES;
    const excludePrefixes = parsePrefixes(env.BACKUP_EXCLUDE_PREFIXES) ?? ['temp/', 'thumbnails/'];
    const state = (await env.BACKUP_STATE.get(STATE_KEY, { type: 'json' })) || {};
    const nowIso = new Date().toISOString();
    const stats = createEmptyStats(mode, event.cron);

    if (!Array.isArray(includePrefixes) || !includePrefixes.length) {
      console.warn('[r2-backup] include prefix list is empty; nothing to process.');
      return;
    }

    if (mode === 'full') {
      await runFullVerification(env, includePrefixes, excludePrefixes, stats);
      state.lastFullVerification = nowIso;
      state.lastIncrementalSync = nowIso;
    } else {
      const since = parseIsoDate(state.lastIncrementalSync);
      await runIncrementalSync(env, includePrefixes, excludePrefixes, since, stats);
      state.lastIncrementalSync = nowIso;
      if (!state.firstIncrementalSync) {
        state.firstIncrementalSync = nowIso;
      }
    }

    state.lastRunCron = event.cron;
    await env.BACKUP_STATE.put(STATE_KEY, JSON.stringify(state));
    console.info('[r2-backup] completed', {
      mode,
      cron: event.cron,
      ...stats,
      includePrefixes,
      excludePrefixes,
    });
  },
};

function resolveMode(event, env) {
  const cron = (event?.cron || '').trim();
  const fullCron = (env?.FULL_VERIFICATION_CRON || '').trim();
  if (fullCron && cron === fullCron) {
    return 'full';
  }
  return 'incremental';
}

function parsePrefixes(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function createEmptyStats(mode, cron) {
  return {
    mode,
    cron,
    scanned: 0,
    evaluated: 0,
    copied: 0,
    skipped: 0,
    verified: 0,
    missing: 0,
    errors: 0,
    aborted: false,
  };
}

async function runIncrementalSync(env, includePrefixes, excludePrefixes, since, stats) {
  const limit = resolveNumericEnv(env.MAX_OBJECTS_PER_RUN, MAX_OBJECTS_PER_RUN);
  const maxPuts = resolveNumericEnv(env.MAX_PUT_OPERATIONS_PER_RUN, MAX_PUT_OPERATIONS_PER_RUN);
  let totalProcessed = 0;
  let totalPuts = 0;

  for (const prefix of includePrefixes) {
    if (shouldSkipPrefix(prefix, excludePrefixes)) continue;
    let cursor = undefined;
    do {
      const page = await env.PRIMARY_BUCKET.list({
        prefix,
        cursor,
        limit: Math.min(1000, limit),
        include: ['customMetadata', 'httpMetadata'],
      });
      for (const object of page.objects) {
        stats.scanned += 1;
        if (shouldSkipObject(object.key, excludePrefixes)) {
          stats.skipped += 1;
          continue;
        }
        if (since && object.uploaded && object.uploaded <= since) {
          stats.skipped += 1;
          continue;
        }
        stats.evaluated += 1;
        totalProcessed += 1;
        if (await ensureBackedUp(env, object, stats)) {
          totalPuts += 1;
        }
        if (totalProcessed >= limit || totalPuts >= maxPuts) {
          stats.aborted = true;
          return;
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && !stats.aborted);
    if (stats.aborted) break;
  }
}

async function runFullVerification(env, includePrefixes, excludePrefixes, stats) {
  const limit = resolveNumericEnv(env.MAX_OBJECTS_PER_RUN, MAX_OBJECTS_PER_RUN);
  const maxPuts = resolveNumericEnv(env.MAX_PUT_OPERATIONS_PER_RUN, MAX_PUT_OPERATIONS_PER_RUN);
  let totalProcessed = 0;
  let totalPuts = 0;

  for (const prefix of includePrefixes) {
    if (shouldSkipPrefix(prefix, excludePrefixes)) continue;
    let cursor = undefined;
    do {
      const page = await env.PRIMARY_BUCKET.list({
        prefix,
        cursor,
        limit: Math.min(1000, limit),
        include: ['customMetadata', 'httpMetadata'],
      });
      for (const object of page.objects) {
        stats.scanned += 1;
        if (shouldSkipObject(object.key, excludePrefixes)) {
          stats.skipped += 1;
          continue;
        }
        stats.evaluated += 1;
        const copied = await ensureBackedUp(env, object, stats, { verifyOnly: true });
        if (copied) {
          totalPuts += 1;
        } else {
          stats.verified += 1;
        }
        totalProcessed += 1;
        if (totalProcessed >= limit || totalPuts >= maxPuts) {
          stats.aborted = true;
          return;
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && !stats.aborted);
    if (stats.aborted) break;
  }
}

function shouldSkipPrefix(prefix, excludePrefixes) {
  if (!Array.isArray(excludePrefixes) || !excludePrefixes.length) return false;
  return excludePrefixes.some((excluded) => prefix.startsWith(excluded));
}

function shouldSkipObject(key, excludePrefixes) {
  if (!Array.isArray(excludePrefixes) || !excludePrefixes.length) return false;
  return excludePrefixes.some((excluded) => key.startsWith(excluded));
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function ensureBackedUp(env, sourceObject, stats, options = {}) {
  const { verifyOnly = false } = options;
  try {
    const existing = await env.BACKUP_BUCKET.head(sourceObject.key);
    if (existing && existing.etag === sourceObject.etag) {
      stats.skipped += 1;
      return false;
    }
    if (verifyOnly && existing && existing.size === sourceObject.size) {
      stats.skipped += 1;
      return false;
    }
    const fresh = await env.PRIMARY_BUCKET.get(sourceObject.key);
    if (!fresh) {
      stats.missing += 1;
      console.warn('[r2-backup] primary object missing during copy', {
        key: sourceObject.key,
      });
      return false;
    }
    await env.BACKUP_BUCKET.put(sourceObject.key, fresh.body, buildPutOptions(fresh, sourceObject));
    stats.copied += 1;
    return true;
  } catch (err) {
    stats.errors += 1;
    console.error('[r2-backup] failed to copy object', {
      key: sourceObject.key,
      message: err && err.message ? err.message : String(err),
    });
    return false;
  }
}

function buildPutOptions(body, sourceObject) {
  const options = {
    httpMetadata: body.httpMetadata,
    customMetadata: body.customMetadata,
    storageClass: sourceObject.storageClass === 'InfrequentAccess' ? 'InfrequentAccess' : undefined,
  };
  if (!options.storageClass) {
    delete options.storageClass;
  }
  return options;
}

function resolveNumericEnv(raw, fallback) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
