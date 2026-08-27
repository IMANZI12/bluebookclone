// server/routes/questions.js
// Phase 3: per-question autosave. Frontend hits this every time the user
// selects/changes an answer. Keep it small and single-purpose.
// Phase 5: per-question image upload (POST /:id/image, multer).

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db/db');
const multer = require('multer');

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

// ---------------------------------------------------------------------------
// POST /api/questions/:id/image
// multipart/form-data, field name "image"
// Saves the uploaded file to server/uploads/<test_id>/<question_id>-<ts>.<ext>
// and updates questions.image_path to the public URL (e.g.
// "/uploads/3/12-1700000000.jpg").
//
// Why diskStorage with a dynamic destination: we need the file to land in a
// per-test folder so the static /uploads mount can serve it and so a future
// test rotation can wipe a test's images by deleting its folder. The exact
// filename includes a timestamp so re-uploads don't overwrite prior images.
// ---------------------------------------------------------------------------
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

// Whitelist of extensions we accept. Anything else gets rejected before the
// file is even written. multer by default uses the system's temp dir for
// rejected uploads, which is fine — we just won't copy them anywhere.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB cap per question image.

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    // Multer's destination callback is sync-ish in 2.x, but we need a DB
    // roundtrip to find the test_id. Resolving the folder before the file is
    // written means we can fail fast if the question doesn't exist. We
    // reach into req.params via the closure in the route below.
    try {
      const questionId = Number(_req.params.id);
      const { rows } = await pool.query(
        'SELECT test_id FROM questions WHERE id = $1',
        [questionId]
      );
      if (rows.length === 0) {
        return cb(new Error(`No question with id=${questionId}.`));
      }
      const dir = path.join(UPLOADS_ROOT, String(rows[0].test_id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Reuse the whitelisted extension from the original filename. We do NOT
    // trust the client-supplied basename — only the extension.
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : '.bin';
    const ts = Date.now();
    cb(null, `${req.params.id}-${ts}${safeExt}`);
  },
});

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return cb(new Error(`Unsupported image type "${ext}". Allowed: ${[...ALLOWED_EXT].join(', ')}`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_BYTES },
});

router.post('/:id/image', (req, res) => {
  // Multer runs first and populates req.file (or invokes next(err) on its
  // own). We wrap in a try/catch so a thrown error from the storage
  // destination lookup (e.g. question not found) returns 4xx/5xx instead of
  // hanging the request.
  upload.single('image')(req, res, async (err) => {
    if (err) {
      // Multer surfaces file-size errors with a `code` we can branch on.
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Image too large; max ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
        });
      }
      const msg = err.message || 'Upload failed';
      const status = /No question with id=/.test(msg) ? 404 : 400;
      return res.status(status).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded under field "image".' });
    }

    const questionId = Number(req.params.id);
    // Build the public URL the frontend will <img src="..."> against.
    // req.file.path looks like ".../uploads/<test_id>/<question_id>-<ts>.<ext>"
    // and we want "/uploads/<test_id>/<question_id>-<ts>.<ext>".
    const rel = path.relative(UPLOADS_ROOT, req.file.path).split(path.sep).join('/');
    const imagePath = `/uploads/${rel}`;

    try {
      const { rows } = await pool.query(
        `UPDATE questions
            SET image_path = $1
          WHERE id = $2
          RETURNING id, test_id, image_path`,
        [imagePath, questionId]
      );
      if (rows.length === 0) {
        // Shouldn't happen — destination lookup already verified existence —
        // but handle defensively. The orphan file on disk is harmless; the
        // next time the same id is uploaded it will be overwritten (different
        // timestamp) or left in place until the test row is deleted.
        return res.status(404).json({ error: `No question with id=${questionId}.` });
      }
      res.status(201).json({
        id: rows[0].id,
        image_path: rows[0].image_path,
      });
    } catch (dbErr) {
      console.error(`POST /api/questions/${questionId}/image DB write failed:`, dbErr.message);
      res.status(500).json({ error: 'Failed to save image_path', detail: dbErr.message });
    }
  });
});

module.exports = router;
