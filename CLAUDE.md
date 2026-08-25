# CLAUDE.md — Project Context for Claude Code

This file is read automatically by Claude Code at the start of every session in this project. Keep it accurate as the project evolves — if you correct Claude Code on something more than once, add the rule here.

## What this project is

A personal, single-user Bluebook-style (SAT-style) test-taking web app. Not built for scale — optimize for correctness and simplicity over performance or multi-user concerns.

**Full functional spec:** see `README.md` in this repo — it contains the complete feature spec, DB schema, and architecture decisions. Treat it as the source of truth for *what* to build. This file (`CLAUDE.md`) covers *how* to work in this codebase.

## Stack

- Frontend: React (JSX), no TypeScript
- Backend: Node.js + Express
- Database: PostgreSQL, running **locally** (not Docker, not a hosted service)
- No authentication needed — single local user

## Conventions

- REST API under `/api/...`, JSON request/response bodies
- DB access through a single `db.js` (or `pool.js`) using the `pg` package — no ORM unless explicitly asked for one
- Env vars for DB connection live in `.env` (see `.env.example`), loaded via `dotenv` — never hardcode credentials
- Keep frontend components in `src/components/`, one component per file
- Prefer explicit code over clever abstractions — this is a personal project that should stay easy to read months later

## Build order (work in this order, one phase per session where possible)

1. Project scaffold: folder structure, `package.json` for client + server, Postgres connection working (`SELECT 1` sanity check)
2. DB schema: `tests`, `modules`, `questions` tables + migration script (see README §5)
3. Backend API: CRUD endpoints for creating a test (questions + modules), fetching the upcoming/latest/oldest tests, updating an answer, completing a test (rotation logic)
4. Frontend: Home page (3 cards + upcoming card)
5. Frontend: Create Test flow (all 4 modules, image upload, duration inputs, validation before submit)
6. Frontend: Take Test flow (timers, pause/resume, module progression, break, navigation grid, autosave)
7. Frontend: Review view (green/red/orange highlighting)
8. Polish: error handling, edge cases (e.g. no upcoming test exists yet)

Do not jump ahead to later phases before earlier ones work end-to-end. At the end of each phase, run/build the project and confirm it works before moving on.

## Known non-obvious design decisions (don't relitigate these without asking)

- Test status is a `status` column (`upcoming` / `latest` / `oldest`) on the `tests` table — **not** encoded into primary keys
- Timers are server-anchored via `module_started_at` / `paused_at` / `accumulated_pause_seconds` columns, not purely client-side `setInterval` state
- Answers autosave per-question as the user selects them, not just at the end
- "Take It" fetches the entire test (all modules/questions/images) up front and preloads images into browser cache before the test view opens — no per-question or per-module fetching during the test (see README "Preload on Take It")
- Answer options are 4 explicit columns (`option_a`..`option_d`), not an array
- Module 4 completion triggers: save answers → delete `status='oldest'` row → promote `latest`→`oldest` → promote `upcoming`→`latest`

## What to ask me before doing

- Any change to the DB schema in README §5
- Adding new npm dependencies beyond `express`, `pg`, `dotenv`, `multer`, `cors`, `react`, `react-dom`
- Anything involving deployment, hosting, or exposing this beyond localhost
