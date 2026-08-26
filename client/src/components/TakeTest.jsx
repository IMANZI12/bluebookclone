// Stub for the Take Test flow (Phase 6 in CLAUDE.md).
// Wired up to the /take/:testId route so the home page's "Take It" button
// navigates somewhere. The real flow (preload, timers, pause/resume, module
// progression, navigation grid, autosave) lands later.
import { useParams } from 'react-router-dom';

export default function TakeTest() {
  const { testId } = useParams();
  return (
    <div className="page">
      <h1>Take Test</h1>
      <p className="subtitle">Phase 6 — full test-taking flow lands later.</p>
      <p>
        Test ID: <code>{testId}</code>. This view will fetch the entire test
        up front, preload images, then walk through Modules 1–4 with timers,
        pause/resume, and per-question answer autosave. (See README §4.)
      </p>
    </div>
  );
}
