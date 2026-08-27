// client/src/components/PauseOverlay.jsx
// Phase 6 pass 2: full-screen yellow pause overlay with a centered Play
// button. Renders only when the parent decides to (typically when the
// state machine's phase is 'paused'). The parent passes a `onResume`
// callback that fires the /api/modules/.../resume HTTP call and updates
// the state machine.
//
// We intentionally ignore backdrop clicks: hitting the overlay
// background is a common accidental gesture, and the user can also
// press the resume button at the top of the page. The only way to
// dismiss the overlay is to click the Play button, which is a fairly
// large target in the middle of the screen.

export default function PauseOverlay({ onResume }) {
  return (
    <div className="tt-pause-overlay" role="dialog" aria-label="Test paused">
      <button
        type="button"
        className="tt-pause-overlay-play"
        onClick={onResume}
        autoFocus
      >
        <span className="tt-pause-overlay-icon" aria-hidden="true">▶</span>
        <span className="tt-pause-overlay-text">Resume</span>
      </button>
    </div>
  );
}
