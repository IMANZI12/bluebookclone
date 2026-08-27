-- 002_timers.sql
-- Phase 6 pass 2: server-anchored module timers, 10-minute break.
--
-- Two changes:
--   1. Widen modules.duration_minutes from integer to numeric(8,3) so the
--      Create Test wizard can accept fractional minutes. This is what lets
--      us set "0.1 minutes" (6 seconds) to verify the full flow without
--      sitting through real durations.
--   2. Add a per-test 'breaks' row holding the break duration and its
--      started_at timestamp. PK on test_id because there is exactly one
--      break per test, between module 2 and module 3. Intentionally NO
--      paused_at / accumulated_pause_seconds columns: the break is not
--      pausable in this app.
--
-- Like 001_init.sql this is wrapped in a single transaction by migrate.js
-- when it applies the file; the SQL itself doesn't BEGIN/COMMIT.

-- 1. Widen duration_minutes. ALTER TYPE with USING cast keeps existing
--    integer rows valid (they round-trip to the same numeric value).
ALTER TABLE modules
  ALTER COLUMN duration_minutes TYPE numeric(8,3);

-- 2. New breaks table. ON DELETE CASCADE so dropping a test row pulls
--    its break with it (mirrors the existing modules/questions pattern).
CREATE TABLE breaks (
  test_id          integer     PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
  duration_minutes numeric(8,3) NOT NULL DEFAULT 10 CHECK (duration_minutes > 0),
  started_at       timestamptz
);
