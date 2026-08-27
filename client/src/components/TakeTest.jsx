// TakeTest — Phase 6 pass 1.
//
// What this pass covers:
//   - Preload on entry: the test is fetched and preloaded on the Home
//     page's "Take It" click, then passed in via router state, so by the
//     time this component mounts everything (questions, options, images)
//     is already in hand. We render a fallback fetch only if the user
//     lands on /take/:id directly (refresh, deep link).
//   - LHS/RHS layout for modules 1 & 2; single-column for 3 & 4.
//   - Footer: Back / Next buttons on the right; a "Question X of Y"
//     control that opens a drop-up grid for the current module, with
//     answered vs. unanswered cells styled differently.
//   - Answer autosave: every click on A/B/C/D PATCHes
//     /api/questions/:id with the new provided_answer, debounced by
//     ~500ms per question so a quick burst of clicks doesn't fire four
//     requests.
//
// What this pass DELIBERATELY does NOT cover (pass 2 next prompt):
//   - Header countdown timer
//   - Pause / resume with the yellow overlay
//   - Module auto-progression when a timer hits zero
//   - The 10-minute break between modules 2 and 3
//   - Rotation on module 4 completion
// Module switching for now is a manual "next module" button in the
// header so we can test the layout end-to-end.

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getUpcomingTest, updateAnswer } from '../api.js';

const MODULES = [1, 2, 3, 4];

// One debounced PATCH per question. We keep a single timer per question ID
// in a ref-map so concurrent clicks on the same question coalesce instead
// of stacking timers. The map lives outside the component so it persists
// across re-renders but resets whenever React unmounts the component
// (which is fine — we're done with it).
const debounceTimers = new Map();

// Fire-and-forget PATCH after a short delay. If another click on the same
// question lands before the timer expires, the previous call is cancelled
// and a new one is scheduled — only the final value in the burst is sent.
function scheduleAutosave(questionId, letter) {
  const existing = debounceTimers.get(questionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(questionId);
    updateAnswer(questionId, letter).catch((err) => {
      // Surface autosave failures in the console; the in-memory answer is
      // still correct, so we don't show a modal — the next save attempt
      // will overwrite or the user will see stale data on refresh.
      console.error(`Autosave for question ${questionId} failed:`, err.message);
    });
  }, 500);
  debounceTimers.set(questionId, timer);
}

export default function TakeTest() {
  const { testId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  // The test object passed from Home.jsx via router state. If absent (e.g.
  // user refreshed or hit the URL directly) we fetch it ourselves so the
  // route is still usable.
  const passedTest = location.state?.test;

  const [test, setTest] = useState(passedTest ?? null);
  const [loadError, setLoadError] = useState(passedTest ? null : null);

  // Current module + current question inside that module.
  const [moduleNum, setModuleNum] = useState(1);
  const [questionNum, setQuestionNum] = useState(1);

  // Whether the question-grid drop-up is open.
  const [gridOpen, setGridOpen] = useState(false);

  // In-memory answer map: { [questionId]: "A" | "B" | "C" | "D" | null }.
  // We seed it from the test payload (which carries any previously saved
  // provided_answer values) so the user can resume after a refresh.
  const [answers, setAnswers] = useState(() => {
    const out = {};
    const questions = passedTest?.questions ?? [];
    for (const q of questions) out[q.id] = q.provided_answer ?? null;
    return out;
  });

  // Fallback fetch: only when the user didn't come in via "Take It".
  useEffect(() => {
    if (test) return;
    let cancelled = false;
    (async () => {
      try {
        // We don't really know whether this test is the upcoming one or a
        // different one, but in practice the only entry to /take/:id is
        // via "Take It" on the Home page. If a future deep link points
        // somewhere else, this will be the right call site to extend.
        const t = await getUpcomingTest();
        if (cancelled) return;
        if (!t) {
          setLoadError('No upcoming test found.');
          return;
        }
        setTest(t);
        const seed = {};
        for (const q of t.questions ?? []) seed[q.id] = q.provided_answer ?? null;
        setAnswers(seed);
      } catch (e) {
        if (!cancelled) setLoadError(e.message || String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [test]);

  // When the test first loads (either via state or fallback), snap to
  // module 1, question 1. Re-clicking "Take It" creates a fresh mount
  // anyway, so this is mostly belt-and-suspenders.
  useEffect(() => {
    if (test) {
      setModuleNum(1);
      setQuestionNum(1);
    }
  }, [test]);

  if (loadError) {
    return (
      <div className="page">
        <h1>Take Test</h1>
        <p className="bad">Couldn't load test: {loadError}</p>
        <button className="secondary" onClick={() => navigate('/')}>
          ← Back to Home
        </button>
      </div>
    );
  }

  if (!test) {
    return (
      <div className="page">
        <h1>Take Test</h1>
        <p className="subtitle">Loading test…</p>
      </div>
    );
  }

  // Sorted list of question IDs for the current module, so the grid can
  // render "1, 2, 3 … 27" rather than whatever the DB happened to return.
  const moduleQuestions = useMemo(() => {
    return (test.questions ?? [])
      .filter((q) => q.module === moduleNum)
      .sort((a, b) => a.question_number - b.question_number);
  }, [test, moduleNum]);

  const totalInModule = moduleQuestions.length;
  const currentQuestion = moduleQuestions.find(
    (q) => q.question_number === questionNum
  ) ?? moduleQuestions[0];

  // Reset to question 1 whenever the module changes — otherwise jumping
  // from module 2 Q22 to module 3 would land on Q22 of module 3 (which
  // only has 22 questions; this would 404 visually).
  useEffect(() => {
    setQuestionNum(1);
  }, [moduleNum]);

  function goToQuestion(qNum) {
    setQuestionNum(qNum);
    setGridOpen(false);
  }

  function selectAnswer(questionId, letter) {
    setAnswers((prev) => ({ ...prev, [questionId]: letter }));
    scheduleAutosave(questionId, letter);
  }

  function next() {
    if (questionNum < totalInModule) {
      setQuestionNum(questionNum + 1);
    } else if (moduleNum < 4) {
      setModuleNum(moduleNum + 1);
    }
  }

  function back() {
    if (questionNum > 1) {
      setQuestionNum(questionNum - 1);
    } else if (moduleNum > 1) {
      // Step back into the last question of the previous module.
      const prevModuleTotal = (test.questions ?? []).filter(
        (q) => q.module === moduleNum - 1
      ).length;
      setModuleNum(moduleNum - 1);
      setQuestionNum(prevModuleTotal || 1);
    }
  }

  const canBack = moduleNum > 1 || questionNum > 1;
  const canNext = moduleNum < 4 || questionNum < totalInModule;

  return (
    <div className="take-test">
      <header className="tt-header">
        <div className="tt-module-tabs" role="tablist" aria-label="Module">
          {MODULES.map((m) => (
            <button
              key={m}
              className={'tt-module-tab' + (m === moduleNum ? ' is-active' : '')}
              onClick={() => setModuleNum(m)}
              role="tab"
              aria-selected={m === moduleNum}
            >
              Module {m}
            </button>
          ))}
        </div>
        <div className="tt-timer-placeholder">
          {/* Pass 2 will fill this in with the live countdown + pause.
           * For now there's a manual "next module" jump so we can test
           * the layout end-to-end without timers. */}
          <button
            type="button"
            className="tt-mod-next"
            onClick={() => setModuleNum((m) => Math.min(4, m + 1))}
            disabled={moduleNum === 4}
            title="Pass-1 only: jump to the next module manually. Pass 2 makes this timer-driven."
          >
            next module →
          </button>
        </div>
      </header>

      <div className="tt-body">
        {currentQuestion ? (
          moduleNum <= 2 ? (
            <SplitView
              question={currentQuestion}
              selected={answers[currentQuestion.id] ?? null}
              onSelect={(letter) => selectAnswer(currentQuestion.id, letter)}
            />
          ) : (
            <SingleColumnView
              question={currentQuestion}
              selected={answers[currentQuestion.id] ?? null}
              onSelect={(letter) => selectAnswer(currentQuestion.id, letter)}
            />
          )
        ) : (
          <p className="subtitle">This module has no questions.</p>
        )}
      </div>

      <footer className="tt-footer">
        <div className="tt-footer-meta">
          {/* Reserved for a future "answered: N / Y" summary. */}
        </div>
        <div className="tt-footer-right">
          <button className="secondary" onClick={back} disabled={!canBack}>
            ← Back
          </button>
          <QuestionPill
            current={questionNum}
            total={totalInModule}
            open={gridOpen}
            onToggle={() => setGridOpen((o) => !o)}
          />
          <button className="primary" onClick={next} disabled={!canNext}>
            Next →
          </button>
        </div>
        {gridOpen && (
          <>
            <div
              className="tt-grid-backdrop"
              onClick={() => setGridOpen(false)}
            />
            <QuestionGrid
              current={questionNum}
              total={totalInModule}
              answersById={answers}
              moduleQuestions={moduleQuestions}
              onPick={goToQuestion}
            />
          </>
        )}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Question X of Y" pill in the footer. Toggles the drop-up grid.
// ---------------------------------------------------------------------------
function QuestionPill({ current, total, open, onToggle }) {
  return (
    <button
      type="button"
      className={'tt-q-pill' + (open ? ' is-open' : '')}
      onClick={onToggle}
      aria-expanded={open}
    >
      Question {current} of {total} ▴
    </button>
  );
}

// ---------------------------------------------------------------------------
// Drop-up grid: one cell per question in the current module. Answered
// questions are tinted, the current question is filled. Clicking a cell
// jumps to that question and closes the grid.
// ---------------------------------------------------------------------------
function QuestionGrid({ current, total, answersById, moduleQuestions, onPick }) {
  return (
    <div className="tt-grid" role="dialog" aria-label="Jump to question">
      <div className="tt-grid-title">Jump to question</div>
      <div className="tt-grid-cells">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const q = moduleQuestions.find((mq) => mq.question_number === n);
          const answered = !!(q && answersById[q.id]);
          const isCurrent = n === current;
          return (
            <button
              key={n}
              className={
                'tt-grid-cell' +
                (isCurrent ? ' is-current' : '') +
                (answered ? ' is-answered' : '')
              }
              onClick={() => onPick(n)}
              aria-label={`Question ${n}${answered ? ', answered' : ''}`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="tt-grid-legend">
        <span>
          <span className="tt-grid-legend-swatch tt-grid-legend-current" />
          current
        </span>
        <span>
          <span className="tt-grid-legend-swatch tt-grid-legend-answered" />
          answered
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LHS/RHS layout for modules 1 & 2.
// ---------------------------------------------------------------------------
function SplitView({ question, selected, onSelect }) {
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
        <OptionList
          selected={selected}
          onSelect={onSelect}
          options={{
            a: question.option_a,
            b: question.option_b,
            c: question.option_c,
            d: question.option_d,
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-column layout for modules 3 & 4.
// ---------------------------------------------------------------------------
function SingleColumnView({ question, selected, onSelect }) {
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
      <OptionList
        selected={selected}
        onSelect={onSelect}
        options={{
          a: question.option_a,
          b: question.option_b,
          c: question.option_c,
          d: question.option_d,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The four A/B/C/D buttons. Highlighted when `selected` matches.
// ---------------------------------------------------------------------------
function OptionList({ selected, onSelect, options }) {
  const letters = ['a', 'b', 'c', 'd'];
  return (
    <ul className="tt-options" role="radiogroup" aria-label="Answer options">
      {letters.map((letter) => {
        const text = options[letter];
        const isSel = selected === letter.toUpperCase();
        return (
          <li key={letter}>
            <button
              type="button"
              role="radio"
              aria-checked={isSel}
              className={'tt-option' + (isSel ? ' is-selected' : '')}
              onClick={() => onSelect(letter.toUpperCase())}
            >
              <span className="tt-option-letter">{letter.toUpperCase()}</span>
              <span className="tt-option-text">{text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
