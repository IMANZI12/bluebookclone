// server/routes/questions.js
// Phase 3: per-question autosave. Frontend hits this every time the user
// selects/changes an answer. Keep it small and single-purpose.

const express = require('express');
const pool = require('../db/db');

const router = express.Router();

const VALID_ANSWERS = new Set(['A', 'B', 'C', 'D']);

// PATCH /api/questions/:id
// Body: { provided_answer: "A" | "B" | "C" | "D" | null }
//   - non-null letter: sets the answer
//   - null: clears the answer (lets the frontend "undo" a selection)
//
// We use COALESCE on the RETURNING so the response always reflects the new
// value (null when cleared, the letter when set).
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const questionId = Number(id);
  if (!Number.isInteger(questionId) || questionId <= 0) {
    return res.status(400).json({ error: 'Question id must be a positive integer.' });
  }

  const { provided_answer } = req.body || {};
  if (provided_answer !== null && !VALID_ANSWERS.has(provided_answer)) {
    return res.status(400).json({
      error: "provided_answer must be 'A', 'B', 'C', 'D', or null.",
    });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE questions
          SET provided_answer = $1
        WHERE id = $2
        RETURNING id, provided_answer`,
      [provided_answer, questionId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `No question with id=${questionId}.` });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(`PATCH /api/questions/${questionId} failed:`, err.message);
    res.status(500).json({ error: 'Failed to update answer', detail: err.message });
  }
});

module.exports = router;
