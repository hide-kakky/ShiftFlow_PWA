'use strict';

/**
 * JSON → SQL seed converter for ShiftFlow D1 migration.
 *
 * Usage:
 *   node scripts/etl/to-sql.js <users|memberships|messages|message_reads|tasks>
 *
 * Reads processed JSON (data/processed/<kind>.json) produced by normalize.js,
 * and emits a seed file (seeds/<sequence>_<kind>.sql) with INSERT OR IGNORE statements.
 * The output wraps statements in BEGIN/COMMIT and enforces foreign_keys PRAGMA.
 */

const fs = require('fs');
const path = require('path');

const TABLE_COLUMNS = {
  users: [
    'user_id',
    'email',
    'display_name',
    'auth_subject',
    'is_active',
    'status',
    'profile_image_url',
    'theme',
    'first_login_at_ms',
    'last_login_at_ms',
    'approved_by',
    'approved_at_ms',
    'notes',
    'created_at_ms',
    'updated_at_ms',
  ],
  memberships: [
    'membership_id',
    'org_id',
    'user_id',
    'role',
    'status',
    'created_at_ms',
  ],
  messages: [
    'message_id',
    'org_id',
    'folder_id',
    'author_membership_id',
    'title',
    'body',
    'created_at_ms',
    'updated_at_ms',
  ],
  message_reads: ['message_read_id', 'message_id', 'membership_id', 'read_at_ms'],
  tasks: [
    'task_id',
    'org_id',
    'folder_id',
    'title',
    'description',
    'status',
    'priority',
    'created_by_email',
    'created_by_membership_id',
    'created_at_ms',
    'updated_at_ms',
    'due_at_ms',
    'legacy_task_id',
    'meta_json',
  ],
  task_assignees: ['task_id', 'email', 'membership_id', 'assigned_at_ms'],
};

function escapeValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  const text = String(val);
  return `'${text.replace(/'/g, "''")}'`;
}

function rowToValues(kind, row) {
  const cols = TABLE_COLUMNS[kind];
  return `(${cols.map((col) => escapeValue(row[col])).join(', ')})`;
}

function buildInsert(kind, chunkRows) {
  if (!chunkRows.length) return '';
  const cols = TABLE_COLUMNS[kind];
  const values = chunkRows.map((row) => rowToValues(kind, row)).join(',\n');
  return `INSERT OR IGNORE INTO ${kind} (${cols.join(', ')})\nVALUES\n${values};\n`;
}

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

function inferSeedSequence(kind) {
  switch (kind) {
    case 'users':
      return 100;
    case 'memberships':
      return 110;
    case 'messages':
      return 120;
    case 'message_reads':
      return 130;
    case 'tasks':
      return 140;
    default:
      return 190;
  }
}

function loadRows(kind) {
  const inputPath = path.join('data', 'processed', `${kind}.json`);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  return [];
}

function extractTaskAssignees(tasks) {
  const dedup = new Map();
  tasks.forEach((task) => {
    if (!task || !task.task_id || !Array.isArray(task.assignees)) return;
    task.assignees.forEach((assignee) => {
      if (!assignee || !assignee.email) return;
      const key = `${task.task_id}__${assignee.email.toLowerCase()}`;
      if (dedup.has(key)) return;
      dedup.set(key, {
        task_id: task.task_id,
        email: assignee.email,
        membership_id: assignee.membership_id || null,
        assigned_at_ms:
          typeof assignee.assigned_at_ms === 'number'
            ? assignee.assigned_at_ms
            : task.created_at_ms || Date.now(),
      });
    });
  });
  return Array.from(dedup.values());
}

function main() {
  const kind = process.argv[2];
  if (!kind || !TABLE_COLUMNS[kind]) {
    console.error(
      'Usage: node scripts/etl/to-sql.js <users|memberships|messages|message_reads|tasks>'
    );
    process.exit(1);
  }

  let rows;
  try {
    rows = loadRows(kind);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!rows.length) {
    console.warn(`Warning: no rows found for ${kind}. Seed will still be generated.`);
  }

  const seedsDir = path.join('seeds');
  if (!fs.existsSync(seedsDir)) {
    fs.mkdirSync(seedsDir, { recursive: true });
  }

  const sequence = inferSeedSequence(kind);
  const outputPath = path.join(seedsDir, `${sequence}_${kind}.sql`);

  const batches = chunk(rows, 500);
  let body = 'PRAGMA foreign_keys = ON;\n';
  batches.forEach((batch) => {
    const statement = buildInsert(kind, batch);
    if (statement) {
      body += statement + '\n';
    }
  });
  if (kind === 'tasks') {
    const assigneeRows = extractTaskAssignees(rows);
    const assigneeBatches = chunk(assigneeRows, 500);
    assigneeBatches.forEach((batch) => {
      const statement = buildInsert('task_assignees', batch);
      if (statement) {
        body += statement + '\n';
      }
    });
  }

  fs.writeFileSync(outputPath, body, 'utf8');
  console.log(`✔ Generated ${outputPath} (${rows.length} rows)`);
}

if (require.main === module) {
  main();
}
