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
const pool = require('../db/db');

const router = express.Router();

const ALLOWED_STATUSES = new Set(['upcoming', 'latest', 'oldest']);

// Expected question count per module, per README §3.
const EXPECTED_COUNTS = { 1: 27, 2: 27, 3: 22, 4: 22 };
const VALID_MODULES = Object.keys(EXPECTED_COUNTS).map(Number);
const VALID_ANSWERS = new Set(['A', 'B', 'C', 'D']);

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
  const { modules, questions } = req.body || {};

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
    if (!m || !Number.isInteger(m.duration_minutes) || m.duration_minutes <= 0) {
      return res.status(400).json({
        error: `Module ${moduleNum} is missing a positive integer duration_minutes.`,
      });
    }
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

    const { rows: [test] } = await client.query(
      `INSERT INTO tests (status) VALUES ('upcoming') RETURNING id, status, created_at`
    );
    const testId = test.id;

    // Insert 4 module rows. The migration makes (test_id, id) the PK with id
    // constrained to 1..4, so we hard-code those here.
    for (let i = 0; i < 4; i++) {
      const moduleNum = i + 1;
      const { duration_minutes } = modules[i];
      await client.query(
        `INSERT INTO modules (id, test_id, name, duration_minutes)
         VALUES ($1, $2, $3, $4)`,
        [moduleNum, testId, `Module ${moduleNum}`, duration_minutes]
      );
    }

    // Insert all questions. A single multi-row INSERT is faster than 98 round
    // trips, but the question count is small enough that even per-row inserts
    // would be fine. We do per-row so the SQL stays easy to read.
    for (const q of questions) {
      await client.query(
        `INSERT INTO questions
           (test_id, module, question_number, description, image_path,
            specific_requirement, option_a, option_b, option_c, option_d,
            correct_answer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      question_count: questions.length,
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
      `SELECT id, name, duration_minutes
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

    res.json({ ...test, modules, questions });
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

module.exports = router;
