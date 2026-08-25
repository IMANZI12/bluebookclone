# Bluebook Clone — App Specification (Revised)

Personal-use test-taking web app. Stack: **React (JSX)** frontend, **Node.js + Express** backend, **PostgreSQL** database.

---

## 1. Home Page

- Shows 3 cards:
  1. Most recent completed test (by date)
  2. Second most recent completed test (by date)
  3. "Create New Test" card
- Clicking either of the two completed-test cards opens the **Review view** for that test.
- Below these three cards, an **"Upcoming Test"** card is shown (if one exists) with a **Take It** button that launches the test-taking flow.

## 2. Review View (Past Test)

For each question in the selected test, display the question and the four answer options:

- Correct answer option → highlighted **green**
- If the user selected a different (wrong) option → that wrong option highlighted **red** (correct one still shown green)
- If the user omitted the question (no answer provided) → correct answer highlighted **orange**

## 3. Create Test Flow

Four modules, each with its own question set:

- **Module 1**: 27 questions
- **Module 2**: 27 questions
- **Module 3**: 22 questions
- **Module 4**: 22 questions

For each question, the creation form includes:

- Textarea: question text
- Image input: optional image upload for that question
- Textarea: specific requirement (e.g. "Which of the following is a suitable word")
- Textarea: answer option A
- Textarea: answer option B
- Textarea: answer option C
- Textarea: answer option D
- Field: correct answer (letter A–D)

After all four modules are filled in, four additional inputs let the user set the **duration in minutes** for each module (Module 1, 2, 3, 4 independently).

A **Next** button at the bottom submits everything — questions (with images), answer options, correct answers, and module durations — to the database as the new **upcoming** test.

**Validation before submit:** the app must confirm all 27/27/22/22 questions have question text, all 4 options, and a correct answer selected before allowing the test to be saved. Incomplete tests should not be submittable.

## 4. Taking a Test

- **Modules 1 & 2**: question text on the **left-hand side**; specific requirement + answer options on the **right-hand side**. User selects an answer per question.
- **Modules 3 & 4**: single-column layout (question, requirement, and options together) since questions are shorter — no LHS/RHS split.
- **Footer**: Next / Back buttons on the right. A "Question X of Y" indicator that, when clicked, opens a small drop-up grid (1, 2, 3 … up to the last question number in that module) letting the user jump directly to any question in the current module.
- **Header**: countdown timer for the current module's remaining time, and a **Pause** button.
  - Pausing fills the screen with a bold yellow overlay and shows a medium-large **Play** button.
  - Resuming removes the yellow overlay and continues the countdown from where it left off.

### Module progression

1. Module 1 countdown ends → Module 2 starts automatically, timer resets to Module 2's configured duration.
2. Module 2 countdown ends → **10-minute break** timer starts automatically.
3. Break ends → Module 3 starts, timer resets to Module 3's configured duration.
4. Module 3 countdown ends → Module 4 starts, timer resets to Module 4's configured duration.
5. Module 4 countdown ends →
   - All provided answers (per question, per module) are saved to the database.
   - The test transitions from "upcoming" to "latest" (see rotation logic below).
   - The previous "oldest" test's data is deleted.

### Timer reliability (revision)

Timers are **server-anchored**, not purely client-side:

- Each module's start is recorded as a timestamp (`module_started_at`) in the database or session state.
- Remaining time is computed as `duration_minutes - (now - module_started_at - accumulated_pause_seconds)`, not tracked solely via a client-side `setInterval` counter.
- Pausing records a `paused_at` timestamp; resuming adds the elapsed pause duration to `accumulated_pause_seconds`.
- This means a page refresh or browser crash mid-test does not lose or reset the timer — remaining time is recalculated from the stored timestamps on reload.

### Answer autosave (revision)

- Each time the user selects/changes an answer for a question, the answer is saved to the database immediately (or debounced by a couple seconds) via a small update request — not held only in frontend state until the end of Module 4.
- This means a crashed tab, closed browser, or refresh mid-test does not lose previously answered questions; the test can resume from where the user left off.

### Preload on "Take It" (new)

When the **Take It** button is clicked, the client fetches the entire upcoming test in one request — all questions, options, specific requirements, and image paths for all 4 modules — before the test-taking view is shown. Images referenced by `image_path` are preloaded into the browser cache at this point too (e.g. via `new Image().src = ...` for each path), so that no image has to fetch mid-test either.

- Only after this fetch (and image preload) completes does the UI transition into Module 1 with the timer starting.
- Show a brief loading state on the "Take It" button/card while this happens (test data is small — under a few MB even with images — so this should be near-instant on localhost).
- Once loaded, all module/question data for the test lives in frontend state for the rest of the session; navigating between questions or modules never triggers a network request for question content. (Answer **autosave**, described above, is the one exception — that's a small write request per answer, not a read.)
- This is why the app can safely support instant "jump to question N" navigation and modules 1↔4 switching without any loading flicker.

### Exam flow as a state machine (revision)

Because the flow has several sequential states (Module 1 → Module 2 → Break → Module 3 → Module 4 → Submit) each of which can independently be paused/resumed, the test-taking flow should be implemented as an explicit state machine rather than ad-hoc boolean flags, e.g. states like:

`RUNNING (module N)` → `PAUSED (module N)` → `RUNNING (module N)` → `BREAK` → `RUNNING (module N+1)` → … → `COMPLETE`

This can be done with `useReducer` and explicit state/action types, or a state machine library (e.g. XState), so that transitions (including pausing during the break) are handled predictably rather than as scattered conditionals.

## 5. Database Structure (Revised)

Rather than encoding test status into the primary key (the original O1–O98 / L1–L98 / U1–U98 scheme), status is stored as a **column**, and IDs are stable auto-incrementing keys. This avoids rewriting large batches of primary keys every time a test completes, and doesn't hard-cap the app at exactly 3 tests if that ever needs to change.

### `tests` table
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | stable identifier |
| `status` | enum/text | `'upcoming'`, `'latest'`, or `'oldest'` |
| `created_at` | timestamp | when the test was created |
| `completed_at` | timestamp, nullable | set when the test-taking finishes |

### `modules` table
| Column | Type | Notes |
|---|---|---|
| `id` | integer | 1, 2, 3, or 4 |
| `test_id` | FK → `tests.id` | which test this module belongs to |
| `name` | text | "Module 1", "Module 2", etc. |
| `duration_minutes` | integer | configured duration for this module |
| `module_started_at` | timestamp, nullable | set when this module's countdown begins (for server-anchored timing) |
| `paused_at` | timestamp, nullable | set while paused |
| `accumulated_pause_seconds` | integer, default 0 | total time spent paused, added back when resuming |

### `questions` table
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | stable identifier |
| `test_id` | FK → `tests.id` | which test this question belongs to |
| `module` | integer | 1, 2, 3, or 4 |
| `question_number` | integer | position within its module (1–27 or 1–22) |
| `description` | text | the question text (LHS content for modules 1–2) |
| `image_path` | text, nullable | path to the question's image, if any |
| `specific_requirement` | text | e.g. "Which of the following is a suitable word" |
| `option_a` | text | |
| `option_b` | text | |
| `option_c` | text | |
| `option_d` | text | |
| `correct_answer` | char(1) | letter A–D |
| `provided_answer` | char(1), nullable | letter A–D, or null if omitted |

*(Using four explicit columns for options instead of an array, since there are always exactly four in a fixed order — simpler to query and update than unpacking an array each time.)*

### Test rotation logic (on Module 4 completion)

Instead of rewriting ~98 primary keys, rotation is three cheap statements:

```sql
DELETE FROM tests WHERE status = 'oldest';
UPDATE tests SET status = 'oldest' WHERE status = 'latest';
UPDATE tests SET status = 'latest', completed_at = now() WHERE status = 'upcoming';
```

(Deleting the `tests` row cascades to its `modules` and `questions` rows via foreign key `ON DELETE CASCADE`.)

## 6. Image Handling

- Use `multer` middleware in Express to handle image uploads for questions.
- Store uploaded files on disk (e.g. `/uploads/{test_id}/{question_id}.jpg`) and save only the relative path in `questions.image_path`.
- Serve the `/uploads` directory as static content from Express.

## 7. Question Navigation Grid

The "Question X of Y" footer control opens a drop-up grid of question numbers (1 through the last question number in the current module). Each grid cell should reflect answered vs. unanswered state (e.g. via the `answeredSet` derived from which questions currently have a `provided_answer`), letting the user visually track progress and jump to any question in the module.
