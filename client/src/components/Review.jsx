// Stub for the Review view (Phase 7 in CLAUDE.md).
// Renders just enough that the route works and we can navigate to it
// from the home page. The real highlighting logic comes later.
export default function Review() {
  return (
    <div className="page">
      <h1>Review</h1>
      <p className="subtitle">Phase 7 — review highlighting lands later.</p>
      <p>
        This view will show a completed test with each question's correct
        answer highlighted in green, the user's wrong answer (if any) in
        red, and omitted questions in orange. (See README §2.)
      </p>
    </div>
  );
}
