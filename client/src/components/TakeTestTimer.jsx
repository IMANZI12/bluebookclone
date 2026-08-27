// client/src/components/TakeTestTimer.jsx
// Phase 6 pass 2: header countdown + pause button.
//
// Pure presentational component. The parent (TakeTest.jsx) owns the
// state machine, calls the start/pause/resume HTTP endpoints, and hands
// us the current `remaining` seconds + the right callbacks. We just
// render.
//
// We display:
//   - "MM:SS" countdown
//   - A label for the current phase: "Module 2" / "Break" / "Saving…"
//   - A pause/resume button (hidden during the break — it's not
//     pausable — and during the saving/complete phases)

import { formatMmSs } from '../lib/testMachine.js';

export default function TakeTestTimer({
  phase,         // 'running' | 'paused' | 'break' | 'saving' | 'complete'
  remaining,     // seconds remaining, >= 0
  onPause,       // () => void
  onResume,      // () => void
  moduleLabel,   // string: "Module 1" .. "Module 4", or "Break", or ""
}) {
  // Decide what the right-hand control is in this phase.
  //   - 'running'      → Pause button
  //   - 'paused'       → Resume button (clicking it is the same as Play)
  //   - 'break'        → "Break in progress" (not pausable)
  //   - 'saving'       → disabled "Saving…"
  //   - 'complete'     → no control
  let control;
  if (phase === 'running') {
    control = (
      <button type="button" className="tt-pause-btn" onClick={onPause}>
        ⏸ Pause
      </button>
    );
  } else if (phase === 'paused') {
    control = (
      <button type="button" className="tt-pause-btn is-paused" onClick={onResume}>
        ▶ Resume
      </button>
    );
  } else if (phase === 'break') {
    control = (
      <span className="tt-pause-btn is-disabled" title="The break cannot be paused.">
        Break
      </span>
    );
  } else if (phase === 'saving') {
    control = (
      <span className="tt-pause-btn is-disabled">Saving…</span>
    );
  } else {
    control = null;
  }

  return (
    <div className="tt-timer">
      <div className="tt-timer-meta">
        <span className="tt-timer-label">{moduleLabel}</span>
        <span className="tt-timer-clock" aria-live="polite">{formatMmSs(remaining)}</span>
      </div>
      {control}
    </div>
  );
}
