// server/scripts/reset-and-seed.js
//
// One-off Phase 4 helper. Wipes the tests table and seeds four valid
// tests (alpha, beta, gamma, delta), then promotes them into the three
// slots with full data so we end up with the canonical populated state:
//
//   upcoming = delta    (most recently created, no completed_at)
//   latest   = gamma    (most recently completed)
//   oldest   = beta     (the one before that)
//
// (alpha gets dropped by the rotation, mirroring what /upcoming/complete
// does when the oldest slot is full.)
//
// Why we rotate by direct UPDATE rather than POST /upcoming/complete:
// as of Phase 3 there's a known invariant issue where POST /api/tests
// doesn't enforce "at most one row per status" — see Phase 4 chat for
// details. Until that's fixed, going through the API can leave the DB
// in odd states. Direct DB rotation via the same pg pool the server uses
// is the simplest way to set up a clean demo state without touching the
// Phase 3 endpoints.
//
// Usage (from server/, server must be running on :4000):
//   node scripts/reset-and-seed.js
//
// Destructive — wipes the tests table. Single-user local project, so OK.

const http = require('http');
const { Pool } = require('pg');
require('dotenv').config();

const COUNTS = { 1: 27, 2: 27, 3: 22, 4: 22 };
const DURATIONS = { 1: 32, 2: 32, 3: 35, 4: 35 };

function buildBody(label) {
  const modules = [1, 2, 3, 4].map((m) => ({ duration_minutes: DURATIONS[m] }));
  const questions = [];
  for (const m of [1, 2, 3, 4]) {
    for (let n = 1; n <= COUNTS[m]; n++) {
      questions.push({
        module: m,
        question_number: n,
        description: `[${label}] Module ${m} Q${n}`,
        image_path: null,
        specific_requirement: 'Which of the following is most appropriate?',
        option_a: 'Option A',
        option_b: 'Option B',
        option_c: 'Option C',
        option_d: 'Option D',
        correct_answer: ['A', 'B', 'C', 'D'][n % 4],
      });
    }
  }
  return { modules, questions };
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: 'localhost',
        port: 4000,
        path,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
  });

  // 1. Wipe.
  const { rowCount: deleted } = await pool.query('DELETE FROM tests');
  console.log(`Reset: deleted ${deleted} test row(s).`);

  // 2. Seed four tests. We need four so we can rotate out the alpha
  //    (the "would-be oldest") and still have three fully populated
  //    rows in the live slots.
  const ids = [];
  for (const label of ['alpha', 'beta', 'gamma', 'delta']) {
    const res = await request('POST', '/api/tests', buildBody(label));
    if (res.status !== 201) {
      console.error(`Failed to seed ${label}:`, res);
      process.exit(1);
    }
    ids.push(res.body.id);
    console.log(`Seeded ${label} → test #${res.body.id}`);
  }
  // ids[0] = alpha (will be deleted to make room)
  // ids[1] = beta  → becomes 'oldest'
  // ids[2] = gamma → becomes 'latest'
  // ids[3] = delta → becomes 'upcoming'
  const [alphaId, betaId, gammaId, deltaId] = ids;

  // 3. Drop alpha (mirrors what /upcoming/complete does).
  await pool.query('DELETE FROM tests WHERE id = $1', [alphaId]);

  // 4. Set the three remaining rows into their slots with realistic
  //    completed_at timestamps so the home page shows a useful date.
  await pool.query(
    `UPDATE tests
        SET status = 'oldest', completed_at = now() - interval '10 days'
      WHERE id = $1`,
    [betaId]
  );
  await pool.query(
    `UPDATE tests
        SET status = 'latest', completed_at = now() - interval '5 days'
      WHERE id = $1`,
    [gammaId]
  );
  await pool.query(
    `UPDATE tests
        SET status = 'upcoming', completed_at = NULL
      WHERE id = $1`,
    [deltaId]
  );

  console.log(
    `Rotated: oldest=#${betaId}  latest=#${gammaId}  upcoming=#${deltaId}  (alpha=#${alphaId} dropped)`
  );

  // 5. Show the final state via the API so the user can confirm the
  //    home page will see what we expect.
  for (const status of ['latest', 'oldest', 'upcoming']) {
    const res = await request('GET', `/api/tests/${status}`);
    if (res.status === 200) {
      const { id, completed_at, questions } = res.body;
      console.log(
        `${status.padEnd(8)} → test #${id}  completed=${completed_at}  ` +
          `questions=${questions.length}`
      );
    } else {
      console.log(`${status.padEnd(8)} → ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
