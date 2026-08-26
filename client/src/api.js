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
