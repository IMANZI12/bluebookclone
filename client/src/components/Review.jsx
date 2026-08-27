// Review — Phase 7. Read-only pass through a completed test (README §2).
//
// Route: /review/:status  where :status is 'latest' or 'oldest'.
// We re-use the same GET /api/tests/:status endpoint the Home page
// already uses (via getLatestTest() / getOldestTest() in api.js), so no
// new backend work is required.
//
// The view is intentionally read-only — no answers are written, no
// status is mutated. Clicking a 'latest' or 'oldest' card on Home
// just shows you what the user got right, wrong, and skipped.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getLatestTest, getOldestTest } from '../api.js';

const MODULES = [1, 2, 3, 4];
const LETTERS = ['A', 'B', 'C', 'D'];

// Friendly timestamp formatter, same shape as Home.jsx's helper.
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

// Compute the highlight class for one option, given a question row.
// `omit` means the question was left blank; otherwise compare the
// user's answer against the correct one.
function optionState(question, letter) {
  const correct = (question.correct_answer || '').toUpperCase();
  const provided = question.provided_answer ?? null;
  if (provided == null) {
    // Omitted: the correct option glows orange (you missed it).
    if (letter === correct) return 'is-omitted';
    return null;
  }
  const providedUpper = String(provided).toUpperCase();
  if (letter === correct) return 'is-correct';
  if (letter === providedUpper && providedUpper !== correct) return 'is-wrong';
  return null;
}

// Short label that appears inside an option (right-aligned). Returns
// null for options that aren't part of the highlight story.
function optionTag(question, letter) {
  const state = optionState(question, letter);
  if (state === 'is-correct') return '✓ correct';
  if (state === 'is-wrong') return '✗ your answer';
  if (state === 'is-omitted') return 'omitted';
  return null;
}

export default function Review() {
  const { status } = useParams();

  // Map the route param to the right api.js helper. 'latest' / 'oldest'
  // are the only valid values; anything else is treated as a 404 below.
  const fetcher =
    status === 'latest' ? getLatestTest :
    status === 'oldest' ? getOldestTest :
    null;

  // test === undefined  → still loading
  // test === null       → 404 from the API (no test with that status)
  // test has a row      → loaded
  // error is a string   → real network/server error
  const [test, setTest] = useState(undefined);
  const [error, setError] = useState(null);
  const [activeMod, setActiveMod] = useState(1);

  useEffect(() => {
    if (!fetcher) {
      // Invalid status — set test to null so the empty state renders.
      setTest(null);
      return;
    }
    let cancelled = false;
    setTest(undefined);
    setError(null);
    fetcher()
      .then((t) => {
        if (cancelled) return;
        setTest(t);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || String(e));
      });
    return () => { cancelled = true; };
  }, [fetcher]);

  // Once a test loads, make sure the active module is a real one.
  // (If the test somehow lacks module 1, fall back to the first
  // available module so we never render an empty tab pane.)
  useEffect(() => {
    if (!test?.questions) return;
    const present = new Set(test.questions.map((q) => q.module));
    if (!present.has(activeMod)) {
      const first = MODULES.find((m) => present.has(m));
      if (first) setActiveMod(first);
    }
  }, [test, activeMod]);

  // --- Render gates ----------------------------------------------------
  if (!fetcher) {
    return (
      <div className="page">
        <h1>Review</h1>
        <p className="bad">Unknown status: "{status}".</p>
        <Link className="secondary" to="/">← Back to Home</Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <h1>Review</h1>
        <p className="bad">Couldn't load test: {error}</p>
        <Link className="secondary" to="/">← Back to Home</Link>
      </div>
    );
  }

  if (test === undefined) {
    return (
      <div className="page">
        <h1>Review</h1>
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  if (test === null) {
    return (
      <div className="page">
        <h1>Review</h1>
        <p className="subtitle">
          No completed test with status="{status}" yet.
        </p>
        <Link className="secondary" to="/">← Back to Home</Link>
      </div>
    );
  }

  // Derived: count of questions in each module (for the tab labels) and
  // the questions for the active module (for the list below).
  const counts = useMemo(() => {
    const out = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const q of test.questions ?? []) {
      if (out[q.module] !== undefined) out[q.module]++;
    }
    return out;
  }, [test]);

  const modQuestions = useMemo(() => {
    return (test.questions ?? [])
      .filter((q) => q.module === activeMod)
      .sort((a, b) => a.question_number - b.question_number);
  }, [test, activeMod]);

  // Roll-up counts for the active module, surfaced in the header so the
  // user can see at a glance how they did.
  const modStats = useMemo(() => {
    let correct = 0, wrong = 0, omitted = 0;
    for (const q of modQuestions) {
      if (q.provided_answer == null) omitted++;
      else if (
        String(q.provided_answer).toUpperCase() ===
        String(q.correct_answer).toUpperCase()
      ) correct++;
      else wrong++;
    }
    return { correct, wrong, omitted, total: modQuestions.length };
  }, [modQuestions]);

  return (
    <div className="review">
      <header className="rv-header">
        <div>
          <h1>Test #{test.id}</h1>
          <p className="subtitle">Completed {formatDate(test.completed_at)}</p>
        </div>
        <Link className="secondary" to="/">← Back to Home</Link>
      </header>

      <nav className="rv-tabs" role="tablist" aria-label="Module">
        {MODULES.map((m) => (
          <button
            key={m}
            className={'rv-tab' + (m === activeMod ? ' is-active' : '')}
            onClick={() => setActiveMod(m)}
            role="tab"
            aria-selected={m === activeMod}
            disabled={counts[m] === 0}
          >
            Module {m}
            {counts[m] > 0 && <span className="rv-tab-count"> · {counts[m]}</span>}
          </button>
        ))}
      </nav>

      <div className="rv-mod-stats">
        <span className="rv-stat rv-stat-correct">
          ✓ {modStats.correct} correct
        </span>
        <span className="rv-stat rv-stat-wrong">
          ✗ {modStats.wrong} wrong
        </span>
        <span className="rv-stat rv-stat-omitted">
          ⊘ {modStats.omitted} omitted
        </span>
        <span className="rv-stat rv-stat-total">
          of {modStats.total} total
        </span>
      </div>

      {modQuestions.length === 0 ? (
        <p className="subtitle">This module has no questions.</p>
      ) : (
        <ol className="rv-module">
          {modQuestions.map((q, idx) => (
            <li key={q.id} className="rv-question">
              <div className="rv-q-num">
                Question {idx + 1} of {modQuestions.length}
              </div>
              {activeMod <= 2 ? (
                <ReviewSplit question={q} />
              ) : (
                <ReviewSingle question={q} />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modules 1 & 2: two-column LHS (description + image) / RHS (requirement +
// options) layout — same shape as the TakeTest split view, but read-only.
// ---------------------------------------------------------------------------
function ReviewSplit({ question }) {
  return (
    <div className="tt-split">
      <div className="tt-left">
        <div className="tt-question-text">{question.description}</div>
        {question.image_path && (
          <img
            className="tt-question-image"
            src={question.image_path}
            alt={`Question ${question.question_number}`}
          />
        )}
      </div>
      <div className="tt-right">
        {question.specific_requirement && (
          <p className="tt-requirement">{question.specific_requirement}</p>
        )}
        <ReviewOptionList question={question} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modules 3 & 4: single-column layout — same shape as TakeTest's
// single-column view, read-only.
// ---------------------------------------------------------------------------
function ReviewSingle({ question }) {
  return (
    <div className="tt-single">
      <div className="tt-question-text">{question.description}</div>
      {question.image_path && (
        <img
          className="tt-question-image"
          src={question.image_path}
          alt={`Question ${question.question_number}`}
        />
      )}
      {question.specific_requirement && (
        <p className="tt-requirement">{question.specific_requirement}</p>
      )}
      <ReviewOptionList question={question} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only option list. Reuses the .tt-options / .tt-option CSS from
// TakeTest so the layout stays consistent, but each option is a <div>
// (not a <button>) and gets a modifier class for the highlight.
// ---------------------------------------------------------------------------
function ReviewOptionList({ question }) {
  return (
    <ul className="tt-options" role="list" aria-label="Answer options">
      {LETTERS.map((letter) => {
        const text = question[`option_${letter.toLowerCase()}`];
        const state = optionState(question, letter);
        const tag = optionTag(question, letter);
        const className =
          'tt-option' + (state ? ` ${state}` : '');
        return (
          <li key={letter}>
            <div className={className} role="presentation">
              <span className="tt-option-letter">{letter}</span>
              <span className="tt-option-text">{text}</span>
              {tag && <span className="rv-tag">{tag}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
