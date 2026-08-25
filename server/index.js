// Express entry point. Phase 1 scope: just enough to confirm the server runs
// and is reachable from the client. Real API routes land in Phase 3.
require('dotenv').config();
const pool = require('./db/db')
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`server listening on ${port}`);
});
