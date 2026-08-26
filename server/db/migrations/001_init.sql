-- 001_init.sql
-- Initial schema for mybluebook.
-- Creates: tests, modules, questions, plus a schema_migrations bookkeeping table.

-- Bookkeeping table for the Node migration runner (migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The three "live" test slots. status is constrained to the three values the
-- app actually uses; no CREATE TYPE so a DROP TABLE is enough to reset.
CREATE TABLE tests (
  id           serial PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('upcoming', 'latest', 'oldest')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Exactly one row per (test, module-position). id here is the module number
-- (1-4), not a synthetic key. ON DELETE CASCADE so dropping a test row pulls
-- its modules (and their questions) with it.
CREATE TABLE modules (
  id                          integer NOT NULL CHECK (id BETWEEN 1 AND 4),
  test_id                     integer NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  name                        text NOT NULL,
  duration_minutes            integer NOT NULL CHECK (duration_minutes > 0),
  module_started_at           timestamptz,
  paused_at                   timestamptz,
  accumulated_pause_seconds   integer NOT NULL DEFAULT 0 CHECK (accumulated_pause_seconds >= 0),
  PRIMARY KEY (test_id, id)
);

-- One row per question. question_number is position-within-module (1-27 or
-- 1-22). ON DELETE CASCADE for the same reason as modules.
CREATE TABLE questions (
  id                   serial PRIMARY KEY,
  test_id              integer NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  module               integer NOT NULL CHECK (module BETWEEN 1 AND 4),
  question_number      integer NOT NULL CHECK (question_number >= 1),
  description          text NOT NULL,
  image_path           text,
  specific_requirement text NOT NULL,
  option_a             text NOT NULL,
  option_b             text NOT NULL,
  option_c             text NOT NULL,
  option_d             text NOT NULL,
  correct_answer       char(1) NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
  provided_answer      char(1)     CHECK (provided_answer IN ('A','B','C','D') OR provided_answer IS NULL),
  UNIQUE (test_id, module, question_number)
);

-- Useful indexes for the queries the API will end up doing.
CREATE INDEX idx_modules_test_id         ON modules(test_id);
CREATE INDEX idx_questions_test_id       ON questions(test_id);
CREATE INDEX idx_questions_test_module   ON questions(test_id, module);
CREATE INDEX idx_tests_status            ON tests(status);
