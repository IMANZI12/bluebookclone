// server/db/check-schema.js
// Lists the tables currently in the database and their column counts.
// Usage (from server/):  node db/check-schema.js
require('dotenv').config();
const pool = require('./db');

async function main() {
  const { rows: tables } = await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name;
  `);

  console.log(`Found ${tables.length} table(s):`);
  for (const { table_name } of tables) {
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;`,
      [table_name]
    );
    console.log(`\n  ${table_name}  (${cols.length} column${cols.length === 1 ? '' : 's'})`);
    for (const c of cols) console.log(`    - ${c.column_name}  (${c.data_type})`);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('check-schema failed:', err.message);
    pool.end().finally(() => process.exit(1));
  });
