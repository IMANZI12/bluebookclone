// Home page — README §1.
//
// Three cards in a row:
//   1. Most recent completed test (status='latest')   → Review view
//   2. Second most recent completed test (status='oldest') → Review view
//   3. "Create New Test"                              → Create flow
//
// Below them, if a test with status='upcoming' exists, an Upcoming card
// with a "Take It" button that launches the test-taking flow.
//
// All API calls go through src/api.js so later phases can reuse the same
// endpoints without rewriting fetch() boilerplate.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getLatestTest, getOldestTest, getUpcomingTest } from '../api.js';

// Format an ISO timestamp as a friendly "Mon DD, YYYY · h:mm AM/PM" string.
// Falls back to the raw input if Date can't parse it. Used on the
// latest/oldest cards to show when the test was completed.
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Home() {
  const navigate = useNavigate();

  // One entry per status we care about. `null` means "404, not found",
  // `undefined` means "still loading".
  const [latest, setLatest] = useState(undefined);
  const [oldest, setOldest] = useState(undefined);
  const [upcoming, setUpcoming] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Fire all three in parallel. The api.js helpers each return null on
    // 404, so we never have to try/catch individual "not found" cases —
    // the only thing that can throw here is a real network/server error.
    let cancelled = false;
    Promise.all([getLatestTest(), getOldestTest(), getUpcomingTest()])
      .then(([l, o, u]) => {
        if (cancelled) return;
        setLatest(l);
        setOldest(o);
        setUpcoming(u);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial render before any of the three have resolved. Show a soft
  // loading hint rather than flickering empty placeholders.
  const stillLoading =
    latest === undefined || oldest === undefined || upcoming === undefined;

  return (
    <div className="home">
      <header className="home-header">
        <h1>mybluebook</h1>
        <p className="subtitle">Personal SAT-style practice tests</p>
      </header>

      {error && <p className="bad">Couldn't load tests: {error}</p>}

      {/* The three primary cards. Empty-state placeholders stand in for
          'latest' / 'oldest' when those slots don't exist yet. */}
      <section className="cards-row">
        <CompletedTestCard
          label="Most recent"
          status="latest"
          test={latest}
          loading={latest === undefined}
        />
        <CompletedTestCard
          label="Previous"
          status="oldest"
          test={oldest}
          loading={oldest === undefined}
        />
        <CreateNewCard />
      </section>

      {/* Upcoming section. Per README §1 this is below the row of three.
          If no test currently has status='upcoming' (common on a fresh DB
          before the user has created one), just show a light hint. */}
      <section className="upcoming-section">
        <h2>Upcoming Test</h2>
        {upcoming === undefined && stillLoading && (
          <div className="upcoming-card loading">
            <p>Loading…</p>
          </div>
        )}
        {upcoming === null && (
          <div className="upcoming-card empty">
            <p>No upcoming test yet — create one to get started.</p>
          </div>
        )}
        {upcoming && (
          <UpcomingCard
            test={upcoming}
            onStart={(test) => navigate(`/take/${test.id}`, { state: { test } })}
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card for a completed test (latest or oldest).
//
//   - test === undefined  → still loading, show a muted placeholder
//   - test === null       → no test in this slot, show a friendly empty
//                           state (read-only, not a link)
//   - test has a row      → real card, clickable, links to /review/:testId
// ---------------------------------------------------------------------------
function CompletedTestCard({ label, status, test, loading }) {
  if (loading) {
    return (
      <div className="card card-loading">
        <div className="card-label">{label}</div>
        <div className="card-title">Loading…</div>
      </div>
    );
  }

  if (test === null) {
    return (
      <div className="card card-empty">
        <div className="card-label">{label}</div>
        <div className="card-title">No test yet</div>
        <div className="card-sub">
          Complete a test to populate this card.
        </div>
      </div>
    );
  }

  // Phase 7: link to /review/:status (latest|oldest) instead of the
  // test's numeric id, so Review can re-use the existing
  // getLatestTest() / getOldestTest() helpers without a new endpoint.
  return (
    <Link to={`/review/${status}`} className="card card-clickable">
      <div className="card-label">{label}</div>
      <div className="card-title">Test #{test.id}</div>
      <div className="card-sub">Completed {formatDate(test.completed_at)}</div>
    </Link>
  );
}

// The "Create New Test" card. Always present, always clickable, navigates
// to /create. Kept as its own component so the rendering rules above stay
// readable.
function CreateNewCard() {
  return (
    <Link to="/create" className="card card-create">
      <div className="card-label">New</div>
      <div className="card-title">Create New Test</div>
      <div className="card-sub">Build a 4-module practice test.</div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Upcoming card with the "Take It" button. The click handler implements
// README's "Preload on Take It" rule: fetch the full test, then preload
// every question's image into the browser cache, THEN navigate. While that
// work happens the button shows a loading label so the user can see why
// the screen hasn't changed yet (the data is small but image preloads on
// localhost are still not instant).
//
// `onStart(test)` is called with the fully-loaded test object, so the
// TakeTest route can pull it from location.state instead of refetching.
// ---------------------------------------------------------------------------
function UpcomingCard({ test, onStart }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleTakeIt() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      // The test fetched by the parent (status='upcoming') already has
      // modules + questions. We refetch to be defensive — this guarantees
      // we're using the freshest copy of the test (e.g. if the user has
      // been on the home page for a while).
      const fresh = await getUpcomingTest();
      if (!fresh) {
        throw new Error('No upcoming test found.');
      }
      await preloadImages(fresh);
      onStart(fresh);
      // Don't clear `loading` — the component unmounts on navigation, and
      // if the user navigates back here it'll be re-mounted with the
      // initial state.
    } catch (e) {
      setError(e.message || String(e));
      setLoading(false);
    }
  }

  return (
    <div className="upcoming-card">
      <div className="upcoming-meta">
        <div className="upcoming-title">Test #{test.id}</div>
        <div className="upcoming-sub">
          Created {formatDate(test.created_at)} ·{' '}
          {test.questions?.length ?? '?'} questions
        </div>
        {error && <div className="upcoming-error">Couldn't start: {error}</div>}
      </div>
      <button
        className="primary"
        onClick={handleTakeIt}
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Take It'}
      </button>
    </div>
  );
}

// Spin up an <img> for every question's image_path so the browser starts
// fetching them right now, before the user enters the test-taking view.
// We don't await the actual decode — we just want the requests in flight.
// (An image_path of null/empty is skipped, of course.)
function preloadImages(test) {
  const images = (test.questions ?? [])
    .map((q) => q.image_path)
    .filter(Boolean);
  if (images.length === 0) return Promise.resolve();
  return Promise.all(
    images.map(
      (src) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve(); // don't block the test on a bad image
          img.src = src;
        })
    )
  );
}
