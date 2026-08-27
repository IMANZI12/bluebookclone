// src/api.js
// Thin fetch wrapper for the backend API. Later phases reuse these
// helpers (create test, update answer, fetch for take-it, etc.) instead
// of sprinkling fetch() calls across components.
//
// All endpoints go through Vite's /api proxy in dev (see vite.config.js),
// so we just use relative paths.

const BASE = '/api';

// Internal: do a fetch and return parsed JSON, or null on 404. Throws on
// any other non-2xx so the caller can render an error. We treat 404 as
// "not found" rather than an error because the home page legitimately
// asks for tests that may not exist yet (e.g. fresh DB).
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    // Try to surface the server's error message, fall back to status.
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${path} failed: HTTP ${res.status} — ${detail}`);
  }
  return res.json();
}

// Internal: do a JSON POST and return parsed JSON. Throws on non-2xx.
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody.error || JSON.stringify(errBody);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`POST ${path} failed: HTTP ${res.status} — ${detail}`);
  }
  return res.json();
}

// Internal: do a JSON PATCH and return parsed JSON. Throws on non-2xx.
async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody.error || JSON.stringify(errBody);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`PATCH ${path} failed: HTTP ${res.status} — ${detail}`);
  }
  return res.json();
}

// GET /api/tests/latest
// Returns the test with status='latest' (the most recent completed test),
// or null if no test currently has that status.
export function getLatestTest() {
  return getJson('/tests/latest');
}

// GET /api/tests/oldest
// Returns the test with status='oldest' (the second-most-recent completed
// test), or null if no test currently has that status.
export function getOldestTest() {
  return getJson('/tests/oldest');
}

// GET /api/tests/upcoming
// Returns the test with status='upcoming' (the one to be taken next),
// or null if no test currently has that status.
export function getUpcomingTest() {
  return getJson('/tests/upcoming');
}

// POST /api/tests
// Body: { modules: [{ duration_minutes: int } x4], questions: [98 entries] }.
// Returns the created test row including a `questions` array of inserted
// { id, module, question_number } so the client can map picked files to
// question IDs for the follow-up image upload step.
export function createTest(payload) {
  return postJson('/tests', payload);
}

// PATCH /api/questions/:id
// Body: { provided_answer: "A" | "B" | "C" | "D" | null }
// Used by the Take Test flow's debounced autosave on every option click.
// Pass null to clear an answer.
export function updateAnswer(questionId, providedAnswer) {
  return patchJson(`/questions/${questionId}`, {
    provided_answer: providedAnswer,
  });
}

// POST /api/questions/:id/image
// multipart/form-data with the file under field name "image". Returns
// { id, image_path } on success.
export async function uploadQuestionImage(questionId, file) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch(`${BASE}/questions/${questionId}/image`, {
    method: 'POST',
    body: fd, // no Content-Type header — the browser sets the multipart boundary.
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody.error || JSON.stringify(errBody);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`POST /questions/${questionId}/image failed: HTTP ${res.status} — ${detail}`);
  }
  return res.json();
}

// Phase 6 pass 2: server-anchored module/break timer endpoints.
//
// All four wrappers return the full server row so the client can
// immediately re-hydrate its state machine without a follow-up GET.
// They are designed to be idempotent on the server side: calling start
// twice in a row doesn't reset the clock, calling pause when already
// paused is a no-op, etc. So callers don't have to be defensive about
// double-firing the same action.

// POST /api/modules/:testId/:moduleId/start
export function startModule(testId, moduleId) {
  return postJson(`/modules/${testId}/${moduleId}/start`);
}

// PATCH /api/modules/:testId/:moduleId/pause
export function pauseModule(testId, moduleId) {
  return patchJson(`/modules/${testId}/${moduleId}/pause`, {});
}

// PATCH /api/modules/:testId/:moduleId/resume
export function resumeModule(testId, moduleId) {
  return patchJson(`/modules/${testId}/${moduleId}/resume`, {});
}

// POST /api/tests/:testId/break/start
// The break is not pausable, so there is intentionally no pauseBreak
// or resumeBreak.
export function startBreak(testId) {
  return postJson(`/tests/${testId}/break/start`);
}
