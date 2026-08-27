// server/routes/modules.js
// Phase 6 pass 2: per-module timer endpoints.
//
// All three handlers are intentionally idempotent so the client can call
// them safely on a refresh without us having to track which call already
// happened. Specifically:
//
//   - start: only stamps module_started_at if it's currently NULL. This
//     means a refresh mid-module doesn't reset the clock.
//   - pause: only stamps paused_at if it's currently NULL. Repeated
//     clicks while already paused are no-ops.
//   - resume: only acts if paused_at is non-NULL. The arithmetic
//     (now - paused_at) is folded into accumulated_pause_seconds and
//     paused_at is cleared.
//
// Every handler returns the full module row (including all the timing
// columns) so the client can re-hydrate its state machine from the
// response without a separate GET.

const express = require('express');
const pool = require('../db/db');

const router = express.Router({ mergeParams: true });

// Validate the two URL params. We treat anything not a positive int as
// a 400 — module ids are constrained 1..4 by the schema, but the
// expression below is permissive on the upper bound.
function parseParams(testIdRaw, moduleIdRaw) {
  const testId = Number(testIdRaw);
  const moduleId = Number(moduleIdRaw);
  if (!Number.isInteger(testId) || testId <= 0) return { error: 'testId must be a positive integer.' };
  if (!Number.isInteger(moduleId) || moduleId < 1 || moduleId > 4) {
    return { error: 'moduleId must be an integer between 1 and 4.' };
  }
  return { testId, moduleId };
}

// POST /api/modules/:testId/:moduleId/start
// Idempotent: only sets module_started_at when it's currently NULL, so
// a refresh mid-module doesn't reset the clock. Also clears paused_at
// and zeros accumulated_pause_seconds on first start only — if the row
// already has a start time, we leave those alone.
router.post('/:testId/:moduleId/start', async (req, res) => {
  const { testId, moduleId, error } = parseParams(req.params.testId, req.params.moduleId);
  if (error) return res.status(400).json({ error });

  try {
    const { rows } = await pool.query(
      `UPDATE modules
          SET module_started_at = COALESCE(module_started_at, now()),
              paused_at         = CASE WHEN module_started_at IS NULL
                                        THEN NULL ELSE paused_at END,
              accumulated_pause_seconds = CASE WHEN module_started_at IS NULL
                                               THEN 0 ELSE accumulated_pause_seconds END
        WHERE test_id = $1 AND id = $2
        RETURNING id, test_id, name, duration_minutes,
                  module_started_at, paused_at, accumulated_pause_seconds`,
      [testId, moduleId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `No module id=${moduleId} for test id=${testId}.` });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(`POST /api/modules/${testId}/${moduleId}/start failed:`, err.message);
    res.status(500).json({ error: 'Failed to start module', detail: err.message });
  }
});

// PATCH /api/modules/:testId/:moduleId/pause
// Stamps paused_at = now() iff currently NULL. The "currently NULL"
// guard makes repeat clicks harmless.
router.patch('/:testId/:moduleId/pause', async (req, res) => {
  const { testId, moduleId, error } = parseParams(req.params.testId, req.params.moduleId);
  if (error) return res.status(400).json({ error });

  try {
    const { rows } = await pool.query(
      `UPDATE modules
          SET paused_at = COALESCE(paused_at, now())
        WHERE test_id = $1 AND id = $2
        RETURNING id, test_id, name, duration_minutes,
                  module_started_at, paused_at, accumulated_pause_seconds`,
      [testId, moduleId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `No module id=${moduleId} for test id=${testId}.` });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(`PATCH /api/modules/${testId}/${moduleId}/pause failed:`, err.message);
    res.status(500).json({ error: 'Failed to pause module', detail: err.message });
  }
});

// PATCH /api/modules/:testId/:moduleId/resume
// Adds (now - paused_at) seconds to accumulated_pause_seconds and clears
// paused_at. The CASE on paused_at keeps the update a no-op if the
// module isn't currently paused.
router.patch('/:testId/:moduleId/resume', async (req, res) => {
  const { testId, moduleId, error } = parseParams(req.params.testId, req.params.moduleId);
  if (error) return res.status(400).json({ error });

  try {
    const { rows } = await pool.query(
      `UPDATE modules
          SET accumulated_pause_seconds = accumulated_pause_seconds
              + CASE WHEN paused_at IS NULL THEN 0
                     ELSE EXTRACT(EPOCH FROM (now() - paused_at))::int END,
              paused_at = NULL
        WHERE test_id = $1 AND id = $2
        RETURNING id, test_id, name, duration_minutes,
                  module_started_at, paused_at, accumulated_pause_seconds`,
      [testId, moduleId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `No module id=${moduleId} for test id=${testId}.` });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(`PATCH /api/modules/${testId}/${moduleId}/resume failed:`, err.message);
    res.status(500).json({ error: 'Failed to resume module', detail: err.message });
  }
});

module.exports = router;
