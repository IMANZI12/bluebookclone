import { Routes, Route } from 'react-router-dom';
import Home from './components/Home.jsx';
import Review from './components/Review.jsx';
import CreateTest from './components/CreateTest.jsx';
import TakeTest from './components/TakeTest.jsx';

// Phase 4: route table. Home is the real implementation; Create
// / Take are stubs for now — the real content lands in phases 5, 6, and 7.
// Phase 7: Review now reads :status ('latest' | 'oldest') instead of
// :testId so it can reuse getLatestTest() / getOldestTest() from api.js.
export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/review/:status" element={<Review />} />
        <Route path="/create" element={<CreateTest />} />
        <Route path="/take/:testId" element={<TakeTest />} />
      </Routes>
    </div>
  );
}
