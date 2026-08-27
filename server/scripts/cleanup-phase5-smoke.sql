-- Phase 5 smoke-test cleanup.
--
-- During the Phase 5 build I ran two smoke tests against the live DB:
--   1. POST /api/tests with a 98-question payload → created test id=13
--   2. POST /api/questions/1177/image → uploaded a 1x1 PNG to q1177
--
-- The test id=13 ended up with status='upcoming' alongside the pre-existing
-- upcoming test id=12, because the tests.status column is only CHECK-constrained
-- to valid values, not UNIQUE-per-status. The pre-existing GET /api/tests/upcoming
-- returns only the first match (with a console.warn), so test 13 is effectively
-- invisible — but the row is there with 98 questions, and the image is in
-- server/uploads/13/.
--
-- This script removes the smoke-test artifacts so the DB is back to the state
-- it was in before Phase 5. Run with:
--   node -e "require('./db/db').query(require('fs').readFileSync('scripts/cleanup-phase5-smoke.sql','utf8')).then(r => { console.log('done', r); require('./db/db').end(); })"
-- (or whichever psql-equivalent you use; the SQL is plain.)

BEGIN;

-- 1. Drop the smoke-test image folder. ON DELETE CASCADE on questions would
--    clean the row, but the file on disk is outside the DB so we unlink it
--    explicitly. If you ran Phase 5's smoke test multiple times there may
--    be several files; this removes the whole directory.
--    (Uncomment the next line if you're on a shell that supports it; or do
--    it from your terminal:  rm -rf server/uploads/13)
-- \! rm -rf ../uploads/13

-- 2. Delete the smoke-test row. ON DELETE CASCADE pulls its 4 modules and
--    98 questions. (The image_path on q1177 is now dangling; harmless.)
DELETE FROM tests WHERE id = 13;

COMMIT;
