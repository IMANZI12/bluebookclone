// TakeTest — Phase 6 pass 2.
//
// What this pass adds on top of pass 1:
//   - Header countdown + pause button, both server-anchored via the
//     /api/modules/:testId/:moduleId/{start,pause,resume} endpoints.
//   - Auto-progression: when a module's timer hits 0, we POST to start
//     the next module (or the break) and dispatch MODULE_DONE / BREAK_DONE.
//   - A 10-minute (configurable per-test) break between module 2 and 3.
//     The break is NOT pausable.
//   - On module 4 completion: a brief "Saving…" view, then
//     POST /api/tests/upcoming/complete to run the rotation, then
//     navigate to "/" so the user lands on the rotated Home page.
//
// What drives all of this is the useReducer state machine in
// client/src/lib/testMachine.js. The component is otherwise the same as
// pass 1 (preload-on-entry, layout, question grid, autosave).

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  getUpcomingTest,
  updateAnswer,
  startModule,
  pauseModule,
  resumeModule,
  startBreak,
} from '../api.js';
import {
  initialMachineState,
  testMachineReducer,
  computeRemaining,
  formatMmSs,
} from '../lib/testMachine.js';
import TakeTestTimer from './TakeTestTimer.jsx';
import PauseOverlay from './PauseOverlay.jsx';

const MODULES = [1, 2, 3, 4];

// How often we re-derive "remaining" from server timestamps and re-render
// the header. 500ms is enough granularity to look smooth (the displayed
// MM:SS only changes at whole-second boundaries anyway) and cheap.
const TICK_MS = 500;

// ---------------------------------------------------------------------------
// Per-question debounced autosave. Same as pass 1 — kept outside the
// component so the timer map survives re-renders.
// ---------------------------------------------------------------------------
const debounceTimers = new Map();
function scheduleAutosave(questionId, letter) {
  const existing = debounceTimers.get(questionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(questionId);
    updateAnswer(questionId, letter).catch((err) => {
      console.error(`Autosave for question ${questionId} failed:`, err.message);
    });
  }, 500);
  debounceTimers.set(questionId, timer);
}

// Flush all pending autosaves immediately is handled inline in
// runCompletion below — we need access to the latest answers map,
// which is held in a ref there.

export default function TakeTest() {
  const { testId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  // Test payload passed via router state from Home. Fall back to a fetch
  // if the user refreshed or deep-linked into /take/:testId.
  const passedTest = location.state?.test;
  const [test, setTest] = useState(passedTest ?? null);
  const [loadError, setLoadError] = useState(null);

  // Answer map, seeded from the test payload so refresh resumes cleanly.
  const [answers, setAnswers] = useState(() => {
    const out = {};
    for (const q of passedTest?.questions ?? []) out[q.id] = q.provided_answer ?? null;
    return out;
  });

  // Reducer-driven state machine. Lazy init so we don't recompute the
  // initial state on every render.
  const [machine, dispatch] = useReducer(testMachineReducer, undefined, initialMachineState);

  // Used to compute "remaining" — re-rendered every TICK_MS. We store it
  // as state (not derived in render) so React schedules a re-render each
  // tick. The reducer stays pure.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // --- Fallback fetch when the user didn't come in via "Take It" --------
  useEffect(() => {
    if (test) return;
    let cancelled = false;
    (async () => {
      try {
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
    return () => { cancelled = true; };
  }, [test]);

  // --- Hydrate the state machine once the test (and its modules + break
  // row) are in hand. On a fresh "Take It" entry we POST to /start for
  // module 1 (idempotent — the server preserves module_started_at if
  // already set). On a refresh mid-test we figure out which module is
  // currently active from the timestamps on the test payload itself,
  // so a refresh in module 3 doesn't restart the clock.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!test || hydratedRef.current) return;
    hydratedRef.current = true;

    (async () => {
      try {
        const mods = (test.modules ?? []).slice().sort((a, b) => a.id - b.id);
        const breakDurationSec = Math.round(Number(test.break?.duration_minutes ?? 10) * 60);

        // Find the first module that doesn't yet have a module_started_at
        // set. That's the "current" module — the one we should resume on.
        // If every module has started_at set, fall back to the first
        // module that hasn't had its duration expire (computed against
        // a synthetic now). If ALL have expired, the test is essentially
        // done and we fall through to the runCompletion path on the
        // first tick.
        let activeIdx = mods.findIndex((m) => !m.module_started_at);
        if (activeIdx === -1) {
          // All started. Find one whose remaining is still > 0.
          const now = Date.now();
          activeIdx = mods.findIndex((m) => {
            const durSec = Math.round(Number(m.duration_minutes) * 60);
            const startedMs = Date.parse(m.module_started_at);
            const elapsed = Math.floor((now - startedMs) / 1000) - (m.accumulated_pause_seconds || 0);
            return elapsed < durSec;
          });
          if (activeIdx === -1) {
            // Everything expired; show the saving view and let the tick
            // finish things off. (Edge case — usually we'd just trigger
            // completion immediately.)
            dispatch({
              type: 'HYDRATE',
              machine: {
                phase: 'saving',
                module: null,
                breakDurationSeconds: breakDurationSec,
              },
            });
            void runCompletion();
            return;
          }
        }

        const activeMod = mods[activeIdx];
        const moduleNum = activeMod.id;
        const durSec = Math.round(Number(activeMod.duration_minutes) * 60);

        // If this module hasn't been started yet, POST /start to stamp
        // module_started_at. Otherwise just use the timestamps we
        // already have on the test payload.
        let startedAt = activeMod.module_started_at;
        let pausedAt = activeMod.paused_at;
        let accumulatedPause = activeMod.accumulated_pause_seconds || 0;
        if (!startedAt) {
          const started = await startModule(test.id, moduleNum);
          startedAt = started.module_started_at;
          pausedAt = started.paused_at;
          accumulatedPause = started.accumulated_pause_seconds || 0;
        }

        const phase = pausedAt ? 'paused' : 'running';
        dispatch({
          type: 'HYDRATE',
          machine: {
            phase,
            module: moduleNum,
            startedAt,
            pausedAt,
            accumulatedPause,
            durationSeconds: durSec,
            breakDurationSeconds: breakDurationSec,
            startedAtBreak: test.break?.started_at ?? null,
            saveError: null,
          },
        });
      } catch (err) {
        setLoadError(err.message || String(err));
      }
    })();
  }, [test]);

  // --- Tick: re-derive remaining from server timestamps every TICK_MS. --
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // --- Auto-progression on timer expiry -------------------------------
  // Separate effect so the "what to do on expiry" logic lives in one
  // place and we don't tangle it with the tick itself. We compare a
  // computed remaining to a threshold of 0 and trigger transitions.
  useEffect(() => {
    if (machine.phase === 'running' || machine.phase === 'break') {
      const remaining = computeRemaining(machine, nowMs);
      if (remaining > 0) return;

      if (machine.phase === 'running') {
        // Decide where to go based on which module just ended.
        if (machine.module === 1) {
          // Start module 2
          (async () => {
            try {
              const started = await startModule(test.id, 2);
              const m2 = test.modules?.find((m) => m.id === 2);
              dispatch({
                type: 'MODULE_DONE',
                nextStartedAt: started.module_started_at,
                nextDurationSeconds: Math.round(Number(m2?.duration_minutes ?? 0) * 60),
              });
            } catch (err) {
              console.error('Failed to start module 2:', err);
            }
          })();
        } else if (machine.module === 2) {
          // Start the break
          (async () => {
            try {
              const started = await startBreak(test.id);
              dispatch({
                type: 'MODULE_DONE',
                nextStartedAt: started.started_at,
              });
            } catch (err) {
              console.error('Failed to start break:', err);
            }
          })();
        } else if (machine.module === 3) {
          // Start module 4
          (async () => {
            try {
              const started = await startModule(test.id, 4);
              const m4 = test.modules?.find((m) => m.id === 4);
              dispatch({
                type: 'MODULE_DONE',
                nextStartedAt: started.module_started_at,
                nextDurationSeconds: Math.round(Number(m4?.duration_minutes ?? 0) * 60),
              });
            } catch (err) {
              console.error('Failed to start module 4:', err);
            }
          })();
        } else if (machine.module === 4) {
          // Complete the test.
          dispatch({ type: 'MODULE_DONE' });
          void runCompletion();
        }
      } else if (machine.phase === 'break') {
        // Start module 3
        (async () => {
          try {
            const started = await startModule(test.id, 3);
            const m3 = test.modules?.find((m) => m.id === 3);
            dispatch({
              type: 'BREAK_DONE',
              nextStartedAt: started.module_started_at,
              nextDurationSeconds: Math.round(Number(m3?.duration_minutes ?? 0) * 60),
            });
          } catch (err) {
            console.error('Failed to start module 3:', err);
          }
        })();
      }
    }
    // runCompletion closes over the latest machine + test, declared below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.phase, nowMs, machine.module]);

  // --- Completion -----------------------------------------------------
  // The state machine is a reducer so it can't be invoked from within an
  // effect above without causing lints. We define it as a ref-based
  // helper that we call directly. It does:
  //   1. flush all pending debounced autosaves (best effort)
  //   2. POST /api/tests/upcoming/complete
  //   3. on success: dispatch COMPLETE, then navigate to /
  //   4. on failure: dispatch SAVE_ERROR so the user can retry
  const answersRef = useRef(answers);
  answersRef.current = answers;
  async function runCompletion() {
    // 1. Flush pending debounced autosaves. The debounceTimers map only
    // holds the questionId of pending saves — we don't have the latest
    // letter in the closure. Re-read from the latest answers map and
    // PATCH directly (bypassing the debounce).
    for (const [qid, timer] of debounceTimers.entries()) {
      clearTimeout(timer);
      debounceTimers.delete(qid);
      const letter = answersRef.current[qid] ?? null;
      try {
        await updateAnswer(qid, letter);
      } catch (err) {
        console.error(`Final autosave for q${qid} failed:`, err);
      }
    }
    // 2. Run the rotation.
    try {
      const res = await fetch('/api/tests/upcoming/complete', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      dispatch({ type: 'COMPLETE' });
      navigate('/');
    } catch (err) {
      dispatch({ type: 'SAVE_ERROR', error: err.message || String(err) });
    }
  }

  // --- Pause / resume handlers ----------------------------------------
  async function handlePause() {
    if (machine.phase !== 'running') return;
    try {
      const updated = await pauseModule(test.id, machine.module);
      dispatch({ type: 'PAUSE', pausedAt: updated.paused_at });
    } catch (err) {
      console.error('Pause failed:', err);
    }
  }
  async function handleResume() {
    if (machine.phase !== 'paused') return;
    try {
      const updated = await resumeModule(test.id, machine.module);
      dispatch({
        type: 'RESUME',
        accumulatedPause: updated.accumulated_pause_seconds,
      });
    } catch (err) {
      console.error('Resume failed:', err);
    }
  }

  // --- Question navigation (pass 1, unchanged) ------------------------
  const [moduleNum, setModuleNum] = useState(1);
  const [questionNum, setQuestionNum] = useState(1);
  const [gridOpen, setGridOpen] = useState(false);

  const moduleQuestions = useMemo(() => {
    return (test?.questions ?? [])
      .filter((q) => q.module === moduleNum)
      .sort((a, b) => a.question_number - b.question_number);
  }, [test, moduleNum]);

  const totalInModule = moduleQuestions.length;
  const currentQuestion = moduleQuestions.find(
    (q) => q.question_number === questionNum
  ) ?? moduleQuestions[0];

  // When the state machine advances modules, keep the visible question
  // number in sync. We map machine.module -> local moduleNum.
  useEffect(() => {
    if (machine.phase === 'running' || machine.phase === 'paused') {
      if (machine.module && machine.module !== moduleNum) {
        setModuleNum(machine.module);
      }
    }
  }, [machine.phase, machine.module]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // --- Render gates ---------------------------------------------------
  if (loadError) {
    return (
      <div className="page">
        <h1>Take Test</h1>
        <p className="bad">Couldn't load test: {loadError}</p>
        <button className="secondary" onClick={() => navigate('/')}>← Back to Home</button>
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

  // Derived display values
  const remaining = computeRemaining(machine, nowMs);
  const moduleLabel =
    machine.phase === 'break' ? 'Break' :
    machine.phase === 'saving' ? 'Saving…' :
    machine.phase === 'complete' ? 'Done' :
    `Module ${machine.module}`;

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
              // Tabs are dimmed but still clickable so the user can jump
              // back to fill in earlier questions mid-test.
            >
              Module {m}
            </button>
          ))}
        </div>
        <TakeTestTimer
          phase={machine.phase}
          remaining={remaining}
          moduleLabel={moduleLabel}
          onPause={handlePause}
          onResume={handleResume}
        />
      </header>

      <div className="tt-body">
        {machine.phase === 'break' ? (
          <BreakView remaining={remaining} breakDurationSeconds={machine.breakDurationSeconds} />
        ) : machine.phase === 'saving' || machine.phase === 'complete' ? (
          <SavingView
            error={machine.saveError}
            onRetry={runCompletion}
          />
        ) : currentQuestion ? (
          (moduleNum <= 2) ? (
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

      {/* Footer only meaningful while a module is on screen. */}
      {(machine.phase === 'running' || machine.phase === 'paused') && (
        <footer className="tt-footer">
          <div className="tt-footer-meta" />
          <div className="tt-footer-right">
            <button
              className="secondary"
              onClick={() => {
                if (questionNum > 1) setQuestionNum(questionNum - 1);
                else if (moduleNum > 1) {
                  const prevTotal = (test.questions ?? []).filter(
                    (q) => q.module === moduleNum - 1
                  ).length;
                  setModuleNum(moduleNum - 1);
                  setQuestionNum(prevTotal || 1);
                }
              }}
              disabled={moduleNum === 1 && questionNum === 1}
            >
              ← Back
            </button>
            <QuestionPill
              current={questionNum}
              total={totalInModule}
              open={gridOpen}
              onToggle={() => setGridOpen((o) => !o)}
            />
            <button
              className="primary"
              onClick={() => {
                if (questionNum < totalInModule) setQuestionNum(questionNum + 1);
                else if (moduleNum < 4) {
                  setModuleNum(moduleNum + 1);
                  setQuestionNum(1);
                } else {
                  // On the last question of module 4: manual "Finish"
                  // triggers the same completion flow as the timer.
                  dispatch({ type: 'MODULE_DONE' });
                  void runCompletion();
                }
              }}
            >
              {moduleNum === 4 && questionNum === totalInModule ? 'Finish' : 'Next →'}
            </button>
          </div>
          {gridOpen && (
            <>
              <div className="tt-grid-backdrop" onClick={() => setGridOpen(false)} />
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
      )}

      {machine.phase === 'paused' && <PauseOverlay onResume={handleResume} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Break view. Big clock in the middle, a calm message. The break is not
// pausable so there's no Pause button — the TakeTestTimer's "Break" chip
// (disabled) is the only header control visible.
// ---------------------------------------------------------------------------
function BreakView({ remaining, breakDurationSeconds }) {
  return (
    <div className="tt-break-view">
      <h2 className="tt-break-title">Break</h2>
      <div className="tt-break-clock">{formatMmSs(remaining)}</div>
      <p className="tt-break-hint">
        Module 3 will start automatically when the timer reaches zero.
        The break cannot be paused.
      </p>
      <p className="subtitle">
        (Total break length: {formatMmSs(breakDurationSeconds)})
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saving view. Shown once module 4's timer has hit 0. We POST the rotation,
// then either navigate to home (on success) or show a Retry button (on
// failure).
// ---------------------------------------------------------------------------
function SavingView({ error, onRetry }) {
  if (error) {
    return (
      <div className="tt-saving-view">
        <h2 className="tt-saving-title">Couldn't finish the test</h2>
        <p className="tt-saving-error">{error}</p>
        <button className="tt-saving-retry" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return (
    <div className="tt-saving-view">
      <h2 className="tt-saving-title">Saving your test…</h2>
      <p className="tt-saving-sub">One moment.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// (pass 1 sub-components — unchanged)
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
        <span><span className="tt-grid-legend-swatch tt-grid-legend-current" /> current</span>
        <span><span className="tt-grid-legend-swatch tt-grid-legend-answered" /> answered</span>
      </div>
    </div>
  );
}

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
