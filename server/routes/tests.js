// server/routes/tests.js
// Phase 3 test endpoints: create, fetch-by-status, complete-rotation.
//
// Notes on transactions:
//   - POST /api/tests and POST /api/tests/upcoming/complete both run their
//     multi-statement work in a single transaction. The pool's plain
//     .query() checks out a fresh connection per call, so for an atomic
//     sequence we have to grab a single client with pool.connect() and
//     run BEGIN / COMMIT / ROLLBACK on it ourselves. Same pattern as
//     server/db/migrate.js.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db/db');

const router = express.Router();

const ALLOWED_STATUSES = new Set(['upcoming', 'latest', 'oldest']);

// Expected question count per module, per README §3.
const EXPECTED_COUNTS = { 1: 27, 2: 27, 3: 22, 4: 22 };
const VALID_MODULES = Object.keys(EXPECTED_COUNTS).map(Number);
const VALID_ANSWERS = new Set(['A', 'B', 'C', 'D']);

// Phase 8: absolute path to the uploads root, used to wipe a replaced
// test's image folder when the create flow swaps in a new 'upcoming' row.
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

// ---------------------------------------------------------------------------
// POST /api/tests
// Body shape:
//   {
//     modules: [
//       { duration_minutes: <int> },
//       { duration_minutes: <int> },
//       { duration_minutes: <int> },
//       { duration_minutes: <int> }
//     ],
//     questions: [
//       {
//         module: 1..4,
//         question_number: 1..N,
//         description: "...",
//         image_path: "..." | null,
//         specific_requirement: "...",
//         option_a: "...", option_b: "...", option_c: "...", option_d: "...",
//         correct_answer: "A" | "B" | "C" | "D"
//       },
//       ...
//     ]
//   }
// Creates the test with status='upcoming', then its 4 module rows, then all
// question rows. Whole thing is one transaction.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { modules, questions, break_minutes } = req.body || {};

  // --- Pre-flight validation. We do this BEFORE opening a transaction so a
  // malformed payload never even starts a DB round-trip. -------------------
  if (!Array.isArray(modules) || modules.length !== 4) {
    return res.status(400).json({
      error: "Body must include a 'modules' array of length 4 (one entry per module 1-4).",
    });
  }
  for (let i = 0; i < 4; i++) {
    const m = modules[i];
    const moduleNum = i + 1;
    // duration_minutes is a positive number (any positive finite). The
    // column is numeric(8,3) so fractional minutes (e.g. 0.1 for testing)
    // are accepted. NaN/Infinity/0/negatives all fail.
    if (
      !m ||
      typeof m.duration_minutes !== 'number' ||
      !Number.isFinite(m.duration_minutes) ||
      m.duration_minutes <= 0
    ) {
      return res.status(400).json({
        error: `Module ${moduleNum} is missing a positive duration_minutes.`,
      });
    }
  }

  // break_minutes: optional. If present must be a positive finite number.
  // Default to 10 (the schema default) when absent.
  let breakMinutes = 10;
  if (break_minutes !== undefined) {
    if (
      typeof break_minutes !== 'number' ||
      !Number.isFinite(break_minutes) ||
      break_minutes <= 0
    ) {
      return res.status(400).json({
        error: 'break_minutes, if provided, must be a positive number.',
      });
    }
    breakMinutes = break_minutes;
  }

  if (!Array.isArray(questions)) {
    return res.status(400).json({ error: "Body must include a 'questions' array." });
  }

  // Group questions by module so we can check counts and per-module ordering.
  const byModule = { 1: [], 2: [], 3: [], 4: [] };
  for (const q of questions) {
    if (!q || !VALID_MODULES.includes(q.module)) {
      return res.status(400).json({
        error: `Question has invalid 'module' (must be 1-4): ${JSON.stringify(q)}`,
      });
    }
    byModule[q.module].push(q);
  }
  for (const moduleNum of VALID_MODULES) {
    if (byModule[moduleNum].length !== EXPECTED_COUNTS[moduleNum]) {
      return res.status(400).json({
        error: `Module ${moduleNum} must have exactly ${EXPECTED_COUNTS[moduleNum]} questions, got ${byModule[moduleNum].length}.`,
      });
    }
  }

  // Per-question validation: required fields, non-empty strings, valid answer letter.
  for (const q of questions) {
    const problems = [];
    if (!Number.isInteger(q.question_number) || q.question_number < 1) {
      problems.push('question_number must be a positive integer');
    }
    if (typeof q.description !== 'string' || q.description.trim() === '') {
      problems.push('description is required');
    }
    if (typeof q.specific_requirement !== 'string' || q.specific_requirement.trim() === '') {
      problems.push('specific_requirement is required');
    }
    for (const key of ['option_a', 'option_b', 'option_c', 'option_d']) {
      if (typeof q[key] !== 'string' || q[key].trim() === '') {
        problems.push(`${key} is required`);
      }
    }
    if (!VALID_ANSWERS.has(q.correct_answer)) {
      problems.push("correct_answer must be one of 'A', 'B', 'C', 'D'");
    }
    if (problems.length) {
      return res.status(400).json({
        error: `Module ${q.module} question ${q.question_number}: ${problems.join('; ')}.`,
      });
    }
    // image_path is optional but if present must be a string.
    if (q.image_path != null && typeof q.image_path !== 'string') {
      return res.status(400).json({
        error: `Module ${q.module} question ${q.question_number}: image_path must be a string or null.`,
      });
    }
  }

  // --- DB write. Everything below is in one transaction. -------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Phase 8: this app only ever has one 'upcoming' test at a time, and a
    // partial submit (test row created, image uploads interrupted) can leave
    // an abandoned 'upcoming' row that blocks the next create. To avoid
    // that AND the legacy "duplicate upcoming test" failure mode, drop any
    // existing 'upcoming' test before inserting the new one. ON DELETE
    // CASCADE pulls its modules/questions/breaks; we also wipe the on-disk
    // uploads folder for the replaced test id so the disk doesn't fill up
    // with orphan images. (The disk wipe is best-effort — the DB write
    // already commits at this point, and a leftover folder is harmless.)
    const { rows: existingUpcoming } = await client.query(
      `SELECT id FROM tests WHERE status = 'upcoming'`
    );
    for (const row of existingUpcoming) {
      await client.query(`DELETE FROM tests WHERE id = $1`, [row.id]);
      try {
        const dir = path.join(UPLOADS_ROOT, String(row.id));
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (fsErr) {
        console.warn(
          `Could not remove uploads folder for replaced test ${row.id}:`,
          fsErr.message
        );
      }
    }

    const { rows: [test] } = await client.query(
      `INSERT INTO tests (status) VALUES ('upcoming') RETURNING id, status, created_at`
    );
    const testId = test.id;

    // Insert 4 module rows. The migration makes (test_id, id) the PK with id
    // constrained to 1..4, so we hard-code those here. duration_minutes
    // is numeric(8,3); the $4::numeric cast makes pg accept a JS number
    // (pg would otherwise send it as int8 for integer-typed columns).
    for (let i = 0; i < 4; i++) {
      const moduleNum = i + 1;
      const { duration_minutes } = modules[i];
      await client.query(
        `INSERT INTO modules (id, test_id, name, duration_minutes)
         VALUES ($1, $2, $3, $4::numeric)`,
        [moduleNum, testId, `Module ${moduleNum}`, duration_minutes]
      );
    }

    // Insert the break row. There is exactly one break per test; its PK
    // is test_id. started_at stays NULL until the user reaches module 2's
    // end and the client posts to /api/tests/:id/break/start.
    await client.query(
      `INSERT INTO breaks (test_id, duration_minutes)
       VALUES ($1, $2::numeric)`,
      [testId, breakMinutes]
    );

    // Insert all questions. A single multi-row INSERT is faster than 98 round
    // trips, but the question count is small enough that even per-row inserts
    // would be fine. We do per-row so the SQL stays easy to read.
    // We also capture the inserted id+module+question_number from each row
    // so the Create Test UI can map picked files to question IDs for the
    // follow-up image-upload step (POST /api/questions/:id/image).
    const insertedQuestions = [];
    for (const q of questions) {
      const { rows: [inserted] } = await client.query(
        `INSERT INTO questions
           (test_id, module, question_number, description, image_path,
            specific_requirement, option_a, option_b, option_c, option_d,
            correct_answer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, module, question_number`,
        [
          testId,
          q.module,
          q.question_number,
          q.description,
          q.image_path ?? null,
          q.specific_requirement,
          q.option_a,
          q.option_b,
          q.option_c,
          q.option_d,
          q.correct_answer,
        ]
      );
      insertedQuestions.push(inserted);
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: testId,
      status: test.status,
      created_at: test.created_at,
      modules: modules.map((m, i) => ({
        id: i + 1,
        duration_minutes: m.duration_minutes,
      })),
      break_minutes: breakMinutes,
      question_count: questions.length,
      questions: insertedQuestions,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tests failed:', err.message);
    res.status(500).json({ error: 'Failed to create test', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/tests/:status
// Returns the full test (modules + questions, ordered) for the row currently
// holding the given status. 404 if no test has that status.
// ---------------------------------------------------------------------------
router.get('/:status', async (req, res) => {
  const { status } = req.params;
  if (!ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${[...ALLOWED_STATUSES].join(', ')}.`,
    });
  }

  try {
    const { rows: tests } = await pool.query(
      'SELECT id, status, created_at, completed_at FROM tests WHERE status = $1',
      [status]
    );
    if (tests.length === 0) {
      return res.status(404).json({ error: `No test currently has status='${status}'.` });
    }
    if (tests.length > 1) {
      // The CHECK constraint allows it but the app invariant is "exactly one".
      // Surface it loudly instead of silently picking one.
      console.warn(`Found ${tests.length} tests with status='${status}'; expected 1.`);
    }
    const test = tests[0];

    const { rows: modules } = await pool.query(
      `SELECT id, name, duration_minutes,
              module_started_at, paused_at, accumulated_pause_seconds
         FROM modules
        WHERE test_id = $1
        ORDER BY id ASC`,
      [test.id]
    );

    const { rows: questions } = await pool.query(
      `SELECT id, module, question_number, description, image_path,
              specific_requirement, option_a, option_b, option_c, option_d,
              correct_answer, provided_answer
         FROM questions
        WHERE test_id = $1
        ORDER BY module ASC, question_number ASC`,
      [test.id]
    );

    // Pull the break row too (or null if it doesn't exist). Phase 6 pass 2
    // uses this to compute break remaining time on a refresh mid-break.
    const { rows: breakRows } = await pool.query(
      `SELECT test_id, duration_minutes, started_at
         FROM breaks
        WHERE test_id = $1`,
      [test.id]
    );
    const breakRow = breakRows[0] ?? null;

    res.json({ ...test, modules, questions, break: breakRow });
  } catch (err) {
    console.error(`GET /api/tests/${status} failed:`, err.message);
    res.status(500).json({ error: 'Failed to fetch test', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tests/upcoming/complete
// Implements README §5 rotation exactly:
//   1) DELETE FROM tests WHERE status = 'oldest'
//   2) UPDATE tests SET status = 'oldest' WHERE status = 'latest'
//   3) UPDATE tests SET status = 'latest', completed_at = now()
//       WHERE status = 'upcoming'
// All in one transaction so a failure mid-rotation can't leave a gap.
// ---------------------------------------------------------------------------
router.post('/upcoming/complete', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Sanity-check the precondition. If 'upcoming' is missing we have nothing
    // to rotate, and rotating without it would just shift 'latest' -> 'oldest'
    // for no reason. Fail fast.
    const { rows: upcomingRows } = await client.query(
      `SELECT id FROM tests WHERE status = 'upcoming'`
    );
    if (upcomingRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No test currently has status=upcoming; nothing to complete.',
      });
    }
    const upcomingId = upcomingRows[0].id;

    // Step 1: drop the oldest. ON DELETE CASCADE on modules + questions
    // cleans up its child rows for us.
    const { rowCount: deletedCount } = await client.query(
      `DELETE FROM tests WHERE status = 'oldest'`
    );

    // Step 2: latest -> oldest.
    await client.query(
      `UPDATE tests SET status = 'oldest' WHERE status = 'latest'`
    );

    // Step 3: upcoming -> latest, stamp completed_at.
    const { rows: [newLatest] } = await client.query(
      `UPDATE tests
          SET status = 'latest', completed_at = now()
        WHERE status = 'upcoming'
        RETURNING id, status, completed_at`
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      completed_test_id: upcomingId,
      deleted_oldest_count: deletedCount,
      new_latest: newLatest,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/tests/upcoming/complete failed:', err.message);
    res.status(500).json({ error: 'Failed to complete test', detail: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/tests/:testId/break/start
// Phase 6 pass 2: stamps started_at on the test's break row. Idempotent —
// a repeat call (e.g. after a refresh mid-break) leaves started_at alone.
// The break is NOT pausable, so we don't ship pause/resume handlers for it.
// ---------------------------------------------------------------------------
router.post('/:testId/break/start', async (req, res) => {
  const testId = Number(req.params.testId);
  if (!Number.isInteger(testId) || testId <= 0) {
    return res.status(400).json({ error: 'testId must be a positive integer.' });
  }

  try {
    // Verify the test exists. The break row has a FK to tests(id), so an
    // INSERT would fail anyway with a constraint violation, but checking
    // first lets us return a cleaner 404 instead of a generic 500.
    const { rows: t } = await pool.query('SELECT id FROM tests WHERE id = $1', [testId]);
    if (t.length === 0) {
      return res.status(404).json({ error: `No test with id=${testId}.` });
    }

    // Upsert the break row. Like modules.start, only stamp started_at if
    // it's currently NULL — refreshes mid-break should not reset the clock.
    // The COALESCE in the DO UPDATE clause means an existing non-null
    // started_at is preserved; a NULL (or missing) row gets now().
    const { rows } = await pool.query(
      `INSERT INTO breaks (test_id, started_at)
       VALUES ($1, now())
       ON CONFLICT (test_id) DO UPDATE
         SET started_at = COALESCE(breaks.started_at, EXCLUDED.started_at)
       RETURNING test_id, duration_minutes, started_at`,
      [testId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(`POST /api/tests/${testId}/break/start failed:`, err.message);
    res.status(500).json({ error: 'Failed to start break', detail: err.message });
  }
});

module.exports = router;
