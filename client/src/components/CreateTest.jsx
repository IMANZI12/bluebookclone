// Stub for the Create Test flow (Phase 5 in CLAUDE.md).
// Wired up to the /create route so the home page's "Create New Test" card
// navigates somewhere. The real form (4 modules × N questions, image upload,
// per-module durations, validation) lands later.
export default function CreateTest() {
  return (
    <div className="page">
      <h1>Create New Test</h1>
      <p className="subtitle">Phase 5 — full creation form lands later.</p>
      <p>
        This view will let you build a 4-module test (27 / 27 / 22 / 22
        questions), upload per-question images, and set per-module durations
        before saving it as the new <code>upcoming</code> test. (See README
        §3.)
      </p>
    </div>
  );
}
