// server/db/migrate.js
// Applies every .sql file in server/db/migrations/ in alphabetical order,
// once each, inside a single transaction per file. Records applied filenames
// in schema_migrations so re-runs are no-ops.
//
// Usage (from server/):  node db/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureBookkeepingTable() {
  // Done with a tiny ad-hoc query so the runner works even on a brand-new DB
  // before 001_init.sql has run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet() {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function applyFile(filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(fullPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    // Record only after the file's own SQL has succeeded. If anything in the
    // file throws, the tx rolls back and the filename is not recorded, so
    // re-running the script will try the file again.
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await ensureBookkeepingTable();
  const applied = await appliedSet();

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log(`No migrations directory at ${MIGRATIONS_DIR} - nothing to do.`);
    return;
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ranAny = false;
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`= skip  ${f} (already applied)`);
      continue;
    }
    console.log(`+ apply ${f}`);
    await applyFile(f);
    ranAny = true;
  }
  if (!ranAny) console.log('All migrations already applied.');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Migration failed:', err.message);
    pool.end().finally(() => process.exit(1));
  });
