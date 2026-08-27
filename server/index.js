// Express entry point. Phase 3 scope: CRUD + rotation for tests, autosave
// for individual question answers. Health check is the smoke endpoint.
require('dotenv').config();
const path = require('path');
const pool = require('./db/db')
const express = require('express');
const cors = require('cors');

const testsRouter = require('./routes/tests');
const questionsRouter = require('./routes/questions');
const modulesRouter = require('./routes/modules');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api/tests', testsRouter);
app.use('/api/questions', questionsRouter);
// Modules are addressed as /api/modules/:testId/:moduleId/{start|pause|resume}.
// The router uses mergeParams so it can read both URL params.
app.use('/api/modules', modulesRouter);

// Phase 5: serve uploaded question images as static files. Path stored in
// questions.image_path is something like "/uploads/3/12-1700000000.jpg", and
// the Take Test flow (Phase 6) will <img src="..."> against this URL. Keep
// the static mount AFTER the API routes so /api/* always wins.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`server listening on ${port}`);
});
