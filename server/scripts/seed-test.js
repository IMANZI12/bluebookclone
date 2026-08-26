// server/scripts/seed-test.js
//
// One-off Phase 4 helper: generates a fully-valid POST /api/tests body
// (4 modules × correct question counts, no images) and POSTs it to the
// running server. Used to seed the DB so the home page has real data to
// render against. Not part of the long-term backend — delete after Phase 4.
//
// Usage (from server/):
//   node scripts/seed-test.js [label]
// where [label] is just an identifier echoed in the console so you can
// tell multiple seed runs apart in the output.

const http = require('http');

// Per README §3.
const COUNTS = { 1: 27, 2: 27, 3: 22, 4: 22 };
// Some plausible per-module durations in minutes.
const DURATIONS = { 1: 32, 2: 32, 3: 35, 4: 35 };

function buildBody(label = 'seed') {
  const modules = [1, 2, 3, 4].map((m) => ({ duration_minutes: DURATIONS[m] }));
  const questions = [];
  for (const m of [1, 2, 3, 4]) {
    for (let n = 1; n <= COUNTS[m]; n++) {
      questions.push({
        module: m,
        question_number: n,
        description: `[${label}] Module ${m} Q${n} description text.`,
        image_path: null,
        specific_requirement: 'Which of the following is most appropriate?',
        option_a: 'Option A text',
        option_b: 'Option B text',
        option_c: 'Option C text',
        option_d: 'Option D text',
        // Cycle through A-D so the answer varies question-to-question.
        correct_answer: ['A', 'B', 'C', 'D'][n % 4],
      });
    }
  }
  return { modules, questions };
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: 'localhost',
        port: 4000,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const label = process.argv[2] || `seed-${Date.now()}`;
  const body = buildBody(label);
  console.log(
    `Posting test "${label}" (${body.questions.length} questions across ` +
      `${body.modules.length} modules) to /api/tests ...`
  );
  const res = await postJson('/api/tests', body);
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2));
  if (res.status >= 400) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
