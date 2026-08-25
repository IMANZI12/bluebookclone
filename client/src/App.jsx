import { useEffect, useState } from 'react';

// Phase 1 placeholder home page. Replaced in Phase 4 with the real
// 3 cards + upcoming card UI from README §1.
//
// For now, this just proves the data path works end-to-end: the React app
// boots, fetches /api/health from the Express server (via Vite's proxy),
// and displays the response. If you see "Health: { ok: true, ... }" the
// scaffold is wired up correctly.
export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <h1>mybluebook</h1>
      <p className="subtitle">Phase 1 scaffold — real home page lands in Phase 4.</p>

      <section className="status">
        <h2>Backend health</h2>
        {error && <p className="bad">backend not reachable: {error}</p>}
        {!error && !health && <p>checking…</p>}
        {health && <pre>{JSON.stringify(health, null, 2)}</pre>}
      </section>
    </div>
  );
}
