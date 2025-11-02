#!/usr/bin/env node
'use strict';

/**
 * Minimal ETL scaffolding for ShiftFlow migration.
 *  - 正規化: メールを trim/lowercase、全角→半角
 *  - 時刻: JST 表記 (yyyy-mm-dd HH:MM) → UTC ミリ秒
 *  - ID: ULID を割り当て（lib なしで簡易実装）
 *
 * 使い方:
 *   node scripts/etl/normalize.js --kind users --input data/raw/users.csv
 * オプション:
 *   --kind     users|memberships|messages|message_reads|tasks
 *   --input    読み込む CSV パス
 *   --output   正規化済 JSON の出力先（省略時 data/processed/<kind>.json）
 *
 * CSV は単純なカンマ区切りを前提とします。複雑な構造の場合は RFC4180 対応 parser へ差し替えてください。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCODING = 'utf8';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function isUlid(value) {
  return typeof value === 'string' && value.length === 26 && /^[0-9A-HJKMNP-TV-Z]+$/.test(value);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function toHalfWidth(value) {
  if (!value) return '';
  return String(value)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function normalizeEmail(value) {
  const normalized = toHalfWidth(value).trim().toLowerCase();
  return normalized;
}

function sanitizeString(value) {
  if (value === undefined || value === null) return '';
  return toHalfWidth(String(value)).trim();
}

function buildLookup(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.__lookup && row.__lookup.__source === row) return row.__lookup.map;
  const map = new Map();
  Object.keys(row).forEach((key) => {
    map.set(key, row[key]);
    map.set(key.toLowerCase(), row[key]);
  });
  row.__lookup = { map, __source: row };
  return map;
}

function getField(row, ...aliases) {
  if (!row) return '';
  for (const alias of aliases) {
    if (!alias) continue;
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      return row[alias];
    }
  }
  const lookup = buildLookup(row);
  if (!lookup) return '';
  for (const alias of aliases) {
    if (!alias) continue;
    const lowered = alias.toLowerCase();
    if (lookup.has(lowered)) {
      return lookup.get(lowered);
    }
  }
  return '';
}

function coerceBoolean(value, fallback) {
  const raw = sanitizeString(value).toLowerCase();
  if (raw) {
    if (['1', 'true', 'yes', 'y', 'on', 'active', 'enabled'].includes(raw)) {
      return true;
    }
    if (['0', 'false', 'no', 'n', 'off', 'inactive', 'disabled', 'pending'].includes(raw)) {
      return false;
    }
  }
  const fb = sanitizeString(fallback).toLowerCase();
  if (fb === 'active') return true;
  if (fb && ['pending', 'suspended', 'inactive', 'disabled'].includes(fb)) {
    return false;
  }
  return Boolean(raw);
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCsvLine);
}

function parseJstDatetime(value) {
  const raw = sanitizeString(value);
  if (!raw) return null;
  let normalized = raw.replace('T', ' ');
  const parts = normalized.split(' ');
  if (parts.length === 1) {
    parts.push('00:00');
  }
  const [datePart, timePart] = parts;
  let iso = `${datePart.replace(/\//g, '-') }T${timePart}`;
  if (!/:\d{2}$/.test(iso)) {
    iso += ':00';
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    iso += '+09:00';
  }
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp);
}

function toUtcMillis(date, fallback) {
  if (!date || Number.isNaN(date.getTime())) return fallback;
  return date.getTime();
}

function encodeTime(time) {
  let value = time;
  let str = '';
  for (let i = 0; i < 10; i += 1) {
    const mod = value % 32;
    str = CROCKFORD[mod] + str;
    value = Math.floor(value / 32);
  }
  return str.padStart(10, '0');
}

function encodeRandom(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i += 1) {
    str += CROCKFORD[bytes[i] >> 3];
  }
  return str.slice(0, 16).padEnd(16, '0');
}

function generateUlid(time = Date.now()) {
  const timePart = encodeTime(time);
  const randomBytes = crypto.randomBytes(16);
  const randPart = encodeRandom(randomBytes);
  return (timePart + randPart).slice(0, 26);
}

function ensureUlid(value) {
  return value && value.length === 26 ? value : generateUlid();
}

function pickUlid(existingId, requestedId) {
  if (existingId && isUlid(existingId)) return existingId;
  if (requestedId && isUlid(requestedId)) return requestedId;
  return generateUlid();
}

function normalizeUsers(rows, context) {
  const now = Date.now();
  return rows.map((row) => {
    const email = normalizeEmail(getField(row, 'email', 'Email'));
    const existingId = email ? context.userMap.get(email) : null;
    const requestedId = sanitizeString(getField(row, 'user_id', 'UserID'));
    const userId = pickUlid(existingId, requestedId);
    const status = getField(row, 'status', 'Status');
    const createdAtSource =
      parseJstDatetime(getField(row, 'created_at_jst', 'created_at', 'FirstLoginAt')) || null;
    const updatedAtSource =
      parseJstDatetime(getField(row, 'updated_at_jst', 'updated_at', 'LastLoginAt')) ||
      createdAtSource ||
      null;
    return {
      user_id: userId,
      email,
      display_name: sanitizeString(getField(row, 'display_name', 'DisplayName')),
      auth_subject: sanitizeString(getField(row, 'auth_subject', 'AuthSubject')),
      is_active: coerceBoolean(getField(row, 'is_active', 'IsActive'), status) ? 1 : 0,
      created_at_ms: createdAtSource ? createdAtSource.getTime() : now,
      updated_at_ms: updatedAtSource ? updatedAtSource.getTime() : now,
    };
  });
}

function normalizeMemberships(rows, context) {
  const now = Date.now();
  return rows.map((row) => {
    const email = normalizeEmail(getField(row, 'email', 'Email'));
    const userId = context.userMap.get(email) || null;
    if (!userId) {
      context.warnings.push(`Unresolved membership email: ${email}`);
    }
    const existingId = email ? context.membershipMap.get(email) : null;
    const requestedId = sanitizeString(getField(row, 'membership_id', 'MembershipID'));
    const membershipId = pickUlid(existingId, requestedId);
    const membership = {
      membership_id: membershipId,
      org_id: row.org_id || context.defaultOrgId,
      user_id: userId,
      role: sanitizeString(getField(row, 'role', 'Role') || 'member') || 'member',
      status: sanitizeString(getField(row, 'status', 'Status') || 'active') || 'active',
      created_at_ms: row.created_at_ms ? Number(row.created_at_ms) : now,
    };
    return { ...membership, email };
  });
}

function normalizeMessages(rows, context) {
  return rows.map((row) => {
    const createdAt =
      parseJstDatetime(getField(row, 'created_at_jst', 'created_at', 'CreatedAt')) || null;
    const updatedAt =
      parseJstDatetime(getField(row, 'updated_at_jst', 'updated_at', 'UpdatedAt')) ||
      createdAt ||
      null;
    const authorEmail = normalizeEmail(getField(row, 'author_email', 'AuthorEmail'));
    const authorMembershipId = context.membershipMap.get(authorEmail) || null;
    if (!authorMembershipId) {
      context.warnings.push(`Unresolved author email: ${authorEmail}`);
    }
    const titleKey = sanitizeString(getField(row, 'title', 'Title'));
    const idKey = sanitizeString(getField(row, 'message_id', 'MessageID'));
    const existingId =
      (titleKey && context.messageMap.get(titleKey)) ||
      (idKey && context.messageMap.get(idKey)) ||
      null;
    const messageId = pickUlid(existingId, idKey);
    return {
      message_id: messageId,
      org_id: row.org_id || context.defaultOrgId,
      folder_id: sanitizeString(
        getField(row, 'folder_name', 'folder_id', 'FolderName', 'FolderID') || ''
      ),
      author_membership_id: authorMembershipId,
      title: titleKey,
      body: sanitizeString(getField(row, 'body', 'Body')),
      created_at_ms: toUtcMillis(createdAt, Date.now()),
      updated_at_ms: toUtcMillis(updatedAt, Date.now()),
    };
  });
}

function normalizeMessageReads(rows, context) {
  return rows.map((row) => {
    const messageTitleKey = sanitizeString(getField(row, 'message_title', 'MessageTitle') || '');
    const messageIdKey = sanitizeString(getField(row, 'message_id', 'MessageID') || '');
    const messageId =
      (messageTitleKey && context.messageMap.get(messageTitleKey)) ||
      (messageIdKey && context.messageMap.get(messageIdKey)) ||
      null;
    if (!messageId) {
      context.warnings.push(
        `Unresolved message reference: ${messageTitleKey || messageIdKey || '(unknown)'}`
      );
    }
    const readerEmail = normalizeEmail(getField(row, 'user_email', 'Email'));
    const membershipId = context.membershipMap.get(readerEmail);
    if (!membershipId) {
      context.warnings.push(`Unresolved reader email: ${readerEmail}`);
    }
    const readAt = parseJstDatetime(getField(row, 'read_at_jst', 'read_at', 'ReadAt'));
    return {
      message_read_id: pickUlid(
        null,
        sanitizeString(getField(row, 'message_read_id', 'MessageReadID'))
      ),
      message_id: messageId,
      membership_id: membershipId,
      read_at_ms: toUtcMillis(readAt, Date.now()),
    };
  });
}

function normalizeTasks(rows, context) {
  return rows.map((row) => {
    const createdAt = parseJstDatetime(
      getField(row, 'created_at_jst', 'created_at', 'CreatedAt')
    );
    const assigneeEmails = sanitizeString(
      getField(row, 'assignee_emails', 'AssigneeEmails') || ''
    )
      .split(/[,;、]/)
      .map(normalizeEmail)
      .filter(Boolean);
    const assignees = assigneeEmails.map((email) => {
      const membershipId = context.membershipMap.get(email);
      if (!membershipId) {
        context.warnings.push(`Unresolved task assignee email: ${email}`);
      }
      return { membership_id: membershipId, email };
    });
    return {
      task_id: pickUlid(
        null,
        sanitizeString(getField(row, 'task_id', 'TaskID'))
      ),
      title: sanitizeString(getField(row, 'title', 'Title')),
      status: sanitizeString(getField(row, 'status', 'Status') || 'open') || 'open',
      priority: sanitizeString(getField(row, 'priority', 'Priority') || 'medium') || 'medium',
      created_by_email: normalizeEmail(getField(row, 'created_by_email', 'CreatedByEmail')),
      created_at_ms: toUtcMillis(createdAt, Date.now()),
      assignees,
    };
  });
}

function mapRows(rows) {
  if (!rows.length) return { header: [], data: [] };
  const [header, ...records] = rows;
  const data = records.map((cols) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cols[idx] !== undefined ? cols[idx] : '';
    });
    return obj;
  });
  return { header, data };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main() {
  const args = parseArgs(process.argv);
  const kind = args.kind;
  if (!kind) {
    console.error('Error: --kind is required (users|memberships|messages|message_reads|tasks)');
    process.exit(1);
  }
  const inputPath = args.input || path.join('data', 'raw', `${kind}.csv`);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: input not found -> ${inputPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(inputPath, ENCODING);
  const rows = parseCsv(raw);
  const { data } = mapRows(rows);

  const context = {
    defaultOrgId: '01H00000000000000000000000',
    userMap: new Map(),
    membershipMap: new Map(),
    messageMap: new Map(),
    warnings: [],
  };

  function hydrateMap(kindName, keyField, valueField, targetMap, keyTransform = (v) => v) {
    const processedPath = path.join('data', 'processed', `${kindName}.json`);
    if (!fs.existsSync(processedPath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(processedPath, ENCODING));
      const rows = Array.isArray(saved.rows) ? saved.rows : [];
      rows.forEach((item) => {
        if (!item) return;
        const key = keyTransform(item[keyField]);
        const value = item[valueField];
        if (key) targetMap.set(key, value);
      });
    } catch (err) {
      console.warn(`⚠ Failed to hydrate map from ${processedPath}: ${err.message}`);
    }
  }

  hydrateMap('users', 'email', 'user_id', context.userMap, normalizeEmail);
  hydrateMap('memberships', 'email', 'membership_id', context.membershipMap, normalizeEmail);
  hydrateMap('messages', 'title', 'message_id', context.messageMap, sanitizeString);
  hydrateMap('messages', 'message_id', 'message_id', context.messageMap, sanitizeString);

  let normalized;
  switch (kind) {
    case 'users':
      normalized = normalizeUsers(data, context);
      normalized.forEach((item) => {
        if (item.email) context.userMap.set(item.email, item.user_id);
      });
      break;
    case 'memberships':
      normalized = normalizeMemberships(data, context);
      normalized.forEach((item) => {
        const email = normalizeEmail(item.email || '');
        if (email && item.membership_id) {
          context.membershipMap.set(email, item.membership_id);
        }
      });
      break;
    case 'messages':
      normalized = normalizeMessages(data, context);
      normalized.forEach((item) => {
        if (item.title && item.message_id) {
          context.messageMap.set(item.title, item.message_id);
        }
        if (item.message_id) {
          context.messageMap.set(item.message_id, item.message_id);
        }
      });
      break;
    case 'message_reads':
      normalized = normalizeMessageReads(data, context);
      break;
    case 'tasks':
      normalized = normalizeTasks(data, context);
      break;
    default:
      console.error(`Error: unsupported kind "${kind}"`);
      process.exit(1);
  }

  const outputDir = args.output
    ? path.dirname(args.output)
    : path.join('data', 'processed');
  ensureDir(outputDir);
  const outputPath = args.output || path.join(outputDir, `${kind}.json`);

  const payload = {
    kind,
    generated_at: new Date().toISOString(),
    rows: normalized,
    warnings: context.warnings,
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), ENCODING);
  console.log(`✔ Normalized ${normalized.length} records → ${outputPath}`);
  if (context.warnings.length) {
    console.warn('Warnings:');
    context.warnings.forEach((msg) => console.warn(`  - ${msg}`));
  }
}

if (require.main === module) {
  main();
}
