// Create Test — README §3.
// Six-step wizard:
//   1-4: Module 1 / 2 / 3 / 4 question forms
//   5:   Per-module duration inputs
//   6:   Review / submit
//
// Each module step shows every question slot (27 for modules 1-2, 22 for
// 3-4) with: question text, image picker (file kept in local state until
// submit), specific requirement, options A-D, and a single correct-answer
// input that validates to A/B/C/D on blur.
//
// On submit, the client first POSTs /api/tests with the full 98-question
// payload (image_path null for everyone), then walks the question ID list
// returned and POSTs each picked file to /api/questions/:id/image. After
// that it navigates to / where the new Upcoming card appears.
//
// All validation lives in this file; we surface exactly which questions
// are incomplete on the Review step so you can fix them without hunting.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createTest, uploadQuestionImage } from '../api.js';

// Expected question counts per module — mirrors the server's EXPECTED_COUNTS
// and the seed script. Kept in one place so the wizard can build the right
// number of slots and the validation can sanity-check totals.
const COUNTS = { 1: 27, 2: 27, 3: 22, 4: 22 };
const MODULES = [1, 2, 3, 4];
const TOTAL_STEPS = 6;
// Phase 8: mirror of the server's MAX_FILE_BYTES (questions.js). Anything
// larger gets rejected at the file-picker so the user finds out immediately
// instead of after waiting for the upload to round-trip.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const STEP_LABELS = [
  'Module 1',
  'Module 2',
  'Module 3',
  'Module 4',
  'Durations',
  'Review',
];

// Friendly labels for the per-field error messages on the Review step.
// The keys match the field names in the question shape so the same map can
// drive both validation and rendering of the missing-fields list.
const FIELD_LABELS = {
  description: 'question text',
  specific_requirement: 'specific requirement',
  option_a: 'option A',
  option_b: 'option B',
  option_c: 'option C',
  option_d: 'option D',
  correct_answer: 'correct answer',
};

// Make one empty question slot. `file` is a File object (from the picker)
// or null. Everything else is just an empty string. correct_answer starts
// as '' so the empty-string check catches it as missing.
function emptyQuestion() {
  return {
    description: '',
    file: null,           // File | null
    specific_requirement: '',
    option_a: '',
    option_b: '',
    option_c: '',
    option_d: '',
    correct_answer: '',
  };
}

// Build the full nested { module: { question_number: {…} } } shape for the
// wizard's local state. Called once on mount via useState's lazy initializer.
function initQuestions() {
  const out = {};
  for (const m of MODULES) {
    out[m] = {};
    for (let n = 1; n <= COUNTS[m]; n++) {
      out[m][n] = emptyQuestion();
    }
  }
  return out;
}

// Phase 8: friendly byte-size formatter for the file-picker hint. Rounds
// to one decimal place and uses KB/MB/GB. Bytes < 1 KB render as "<1 KB"
// to avoid silly values like "523 B".
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Returns an array of human-readable missing-field strings for one question.
// Empty array means the question is complete. Used by both the per-module
// progress text and the Review step's missing-fields list.
function validateQuestion(q) {
  const missing = [];
  if (!q.description.trim()) missing.push(FIELD_LABELS.description);
  if (!q.specific_requirement.trim()) missing.push(FIELD_LABELS.specific_requirement);
  if (!q.option_a.trim()) missing.push(FIELD_LABELS.option_a);
  if (!q.option_b.trim()) missing.push(FIELD_LABELS.option_b);
  if (!q.option_c.trim()) missing.push(FIELD_LABELS.option_c);
  if (!q.option_d.trim()) missing.push(FIELD_LABELS.option_d);
  if (!/^[ABCD]$/.test(q.correct_answer.trim())) missing.push(FIELD_LABELS.correct_answer);
  return missing;
}

// True iff a single character is one of A-D (case-insensitive). Used for
// the inline red-border validation on the correct-answer input.
function isValidAnswerLetter(s) {
  return /^[ABCD]$/.test(s);
}

export default function CreateTest() {
  const navigate = useNavigate();

  // Wizard step. 1 = Module 1, …, 4 = Module 4, 5 = Durations, 6 = Review.
  const [step, setStep] = useState(1);

  // Per-module durations. Defaults are typical SAT-ish values so the form
  // is usable out of the box; user can edit on step 5. Phase 6 pass 2:
  // these accept fractional minutes (e.g. 0.1 = 6s) so the test flow can
  // be verified end-to-end without sitting through full module durations.
  const [durations, setDurations] = useState([32, 32, 35, 35]);

  // Break duration in minutes. Phase 6 pass 2: a fifth input on the
  // Durations step. Default 10 (the SAT break length).
  const [breakMinutes, setBreakMinutes] = useState(10);

  // All 98 question slots. Built once via lazy initializer.
  const [questions, setQuestions] = useState(initQuestions);

  // Submit lifecycle. progressText is shown on the Submit button when
  // uploading images (e.g. "Uploading images… 3 / 7"). `partialUpload`
  // is non-null when the test row was created but at least one image
  // upload failed; in that case we expose a Retry button that resumes
  // uploads instead of forcing the user to re-fill the wizard.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });
  // Track an in-flight partial upload: the created test id + a list of
  // image upload jobs that have not yet been POSTed successfully. The
  // retry path re-runs the loop on this same list.
  const [partialUpload, setPartialUpload] = useState(null);

  // Updater for a single field on a single question. Defined as a function
  // inside the component so it always sees the latest `questions` closure.
  function updateField(module, qNum, field, value) {
    setQuestions((prev) => ({
      ...prev,
      [module]: {
        ...prev[module],
        [qNum]: { ...prev[module][qNum], [field]: value },
      },
    }));
  }

  // Snapshot of the form for review. Memoized because both the per-step
  // progress display and the Review step use it; recomputing it on every
  // keystroke would still be cheap but no need to.
  const validation = useMemo(() => {
    const perModule = {}; // { module: { qNum: [missingFieldLabels] } }
    let totalComplete = 0;
    for (const m of MODULES) {
      perModule[m] = {};
      for (let n = 1; n <= COUNTS[m]; n++) {
        const missing = validateQuestion(questions[m][n]);
        perModule[m][n] = missing;
        if (missing.length === 0) totalComplete += 1;
      }
    }
    return { perModule, totalComplete };
  }, [questions]);

  // True iff all 98 questions are complete AND every duration (modules +
  // break) is a positive number AND no picked image exceeds the server's
  // size cap. Review step's submit button is disabled when this is false.
  // Fractional durations are allowed (e.g. 0.1 for short test runs), so
  // we only check Number.isFinite and > 0.
  const allComplete = useMemo(() => {
    if (validation.totalComplete !== 98) return false;
    if (!Number.isFinite(breakMinutes) || breakMinutes <= 0) return false;
    if (!durations.every((d) => Number.isFinite(d) && d > 0)) return false;
    // Phase 8: any oversized picked image blocks submit. The user sees
    // the inline warning at the file-picker; this just enforces it.
    for (const m of MODULES) {
      for (let n = 1; n <= COUNTS[m]; n++) {
        const f = questions[m][n].file;
        if (f && f.size > MAX_IMAGE_BYTES) return false;
      }
    }
    return true;
  }, [validation, durations, breakMinutes, questions]);

  // Flatten the missing-fields-per-question into the human-readable lines
  // for the Review step, e.g. "Module 2, Question 14: missing option C,
  // correct answer". Returns an array of strings; empty if all complete.
  const missingLines = useMemo(() => {
    const lines = [];
    for (const m of MODULES) {
      for (let n = 1; n <= COUNTS[m]; n++) {
        const missing = validation.perModule[m][n];
        if (missing.length) {
          lines.push(`Module ${m}, Question ${n}: missing ${missing.join(', ')}`);
        }
      }
    }
    return lines;
  }, [validation]);

  // Step 5 validation: every duration (modules + break) must be a positive
  // number. Fractional minutes are allowed so this can be e.g. 0.1 (6s)
  // for end-to-end testing.
  const durationErrors = useMemo(() => {
    const moduleErrors = durations.map((d, i) =>
      Number.isFinite(d) && d > 0 ? null : `Module ${i + 1} duration must be a positive number.`
    );
    const breakError =
      Number.isFinite(breakMinutes) && breakMinutes > 0
        ? null
        : 'Break duration must be a positive number.';
    return { modules: moduleErrors, break: breakError };
  }, [durations, breakMinutes]);

  async function handleSubmit() {
    if (!allComplete || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setPartialUpload(null);

    // Build the JSON payload the server expects. Note image_path is null
    // for every question; the actual files go up in a second pass.
    // break_minutes is included so the test's per-test break length is
    // stored on the new breaks row at creation time.
    const payload = {
      modules: durations.map((d) => ({ duration_minutes: d })),
      break_minutes: breakMinutes,
      questions: [],
    };
    const fileJobs = [];
    for (const m of MODULES) {
      for (let n = 1; n <= COUNTS[m]; n++) {
        const q = questions[m][n];
        payload.questions.push({
          module: m,
          question_number: n,
          description: q.description.trim(),
          image_path: null,
          specific_requirement: q.specific_requirement.trim(),
          option_a: q.option_a.trim(),
          option_b: q.option_b.trim(),
          option_c: q.option_c.trim(),
          option_d: q.option_d.trim(),
          correct_answer: q.correct_answer.trim(),
        });
        if (q.file) fileJobs.push({ module: m, qNum: n, file: q.file });
      }
    }

    try {
      const created = await createTest(payload);
      await runUploads(created, fileJobs);
    } catch (err) {
      setSubmitError(err.message || String(err));
      setSubmitting(false);
    }
  }

  // Re-runs the image upload loop for an already-created test. Used by
  // the initial submit AND the retry button when an upload fails partway.
  // The server's POST /api/tests replaces any pre-existing upcoming test,
  // so retrying is safe and the user is never left with an orphan row.
  async function runUploads(created, fileJobs) {
    // Build a (module, question_number) -> id map from the response.
    const idMap = new Map();
    for (const ins of created.questions ?? []) {
      idMap.set(`${ins.module}-${ins.question_number}`, ins.id);
    }
    setUploadProgress({ done: 0, total: fileJobs.length });

    for (let i = 0; i < fileJobs.length; i++) {
      const { module, qNum, file } = fileJobs[i];
      const qid = idMap.get(`${module}-${qNum}`);
      if (!qid) {
        // Shouldn't happen — the server gave us one row per question we
        // sent. If it does, skip the file and keep going so one missing
        // ID doesn't strand the others.
        console.warn(`No question id for module ${module} q${qNum}; skipping image.`);
        setUploadProgress({ done: i + 1, total: fileJobs.length });
        continue;
      }
      try {
        await uploadQuestionImage(qid, file);
        setUploadProgress({ done: i + 1, total: fileJobs.length });
      } catch (uploadErr) {
        // Partial-submit: the test row is created in the DB and some
        // images may have uploaded, but this one failed. Stash the
        // remaining jobs so the retry button can re-attempt them.
        const remaining = fileJobs.slice(i);
        setPartialUpload({
          testId: created.id,
          remaining,
          alreadyDone: i,
        });
        throw uploadErr;
      }
    }

    // All done. Head back to home; its useEffect re-fetches and the
    // new Upcoming card will appear.
    navigate('/');
  }

  // Retry button handler. Re-runs the upload loop on the remaining
  // (not-yet-uploaded) files. The server's POST /api/tests created a
  // fresh 'upcoming' row, so re-uploading to the same question IDs is
  // safe — the file is just overwritten with a new timestamped name.
  async function handleRetryUploads() {
    if (!partialUpload || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Re-fetch the test so we have a fresh questions list (in case the
      // page was reloaded after the partial submit). The idMap built here
      // maps (module, question_number) to question.id, which is what the
      // upload endpoint needs.
      const res = await fetch(`/api/tests/${partialUpload.testId}`);
      if (!res.ok) {
        throw new Error(`Could not re-fetch test ${partialUpload.testId}`);
      }
      const fresh = await res.json();
      const idMap = new Map();
      for (const q of fresh.questions ?? []) {
        idMap.set(`${q.module}-${q.question_number}`, q.id);
      }
      const { remaining, alreadyDone } = partialUpload;
      const total = alreadyDone + remaining.length;
      setUploadProgress({ done: alreadyDone, total });

      for (let i = 0; i < remaining.length; i++) {
        const { module, qNum, file } = remaining[i];
        const qid = idMap.get(`${module}-${qNum}`);
        if (!qid) {
          console.warn(`Retry: no question id for module ${module} q${qNum}; skipping.`);
          setUploadProgress({ done: alreadyDone + i + 1, total });
          continue;
        }
        await uploadQuestionImage(qid, file);
        setUploadProgress({ done: alreadyDone + i + 1, total });
      }
      setPartialUpload(null);
      navigate('/');
    } catch (err) {
      setSubmitError(err.message || String(err));
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="page create-test">
      <header className="ct-header">
        <h1>Create New Test</h1>
        <p className="subtitle">Step {step} of {TOTAL_STEPS} · {STEP_LABELS[step - 1]}</p>
      </header>

      <Stepper
        step={step}
        onJump={(s) => {
          // Allow jumping to any step we have already visited. Submit is
          // step 6 and only reachable once everything's filled in, but you
          // can always jump back to an earlier step to fix something.
          if (s <= step || s === 6) setStep(s);
        }}
      />

      {step >= 1 && step <= 4 && (
        <ModuleStep
          moduleNum={step}
          questions={questions[step]}
          validation={validation.perModule[step]}
          onChange={(qNum, field, value) => updateField(step, qNum, field, value)}
        />
      )}

      {step === 5 && (
        <DurationsStep
          durations={durations}
          breakMinutes={breakMinutes}
          errors={durationErrors}
          onChangeModule={(i, v) => {
            const next = [...durations];
            next[i] = v;
            setDurations(next);
          }}
          onChangeBreak={setBreakMinutes}
        />
      )}

      {step === 6 && (
        <ReviewStep
          durations={durations}
          breakMinutes={breakMinutes}
          validation={validation}
          allComplete={allComplete}
          missingLines={missingLines}
          onJumpToModule={(m) => setStep(m)}
        />
      )}

      <footer className="ct-footer">
        <button
          className="secondary"
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          disabled={step === 1 || submitting}
        >
          ← Back
        </button>

        {step < TOTAL_STEPS ? (
          <button
            className="primary"
            onClick={() => setStep((s) => Math.min(TOTAL_STEPS, s + 1))}
            disabled={submitting}
          >
            Next →
          </button>
        ) : (
          <button
            className="primary"
            onClick={handleSubmit}
            disabled={!allComplete || submitting}
          >
            {submitting
              ? uploadProgress.total > 0
                ? `Uploading images… ${uploadProgress.done} / ${uploadProgress.total}`
                : 'Creating test…'
              : 'Create Test'}
          </button>
        )}
      </footer>

      {submitError && (
        <div className="ct-error-block">
          <p className="bad ct-error">
            Submit failed: {submitError}
            {partialUpload
              ? ` The test row was created (id ${partialUpload.testId}); ${partialUpload.remaining.length} image upload(s) still pending. You can retry the uploads below — your answers and previously-uploaded images are saved.`
              : ''}
          </p>
          {partialUpload && (
            <button
              type="button"
              className="primary"
              onClick={handleRetryUploads}
              disabled={submitting}
            >
              {submitting
                ? `Retrying uploads… ${uploadProgress.done} / ${uploadProgress.total}`
                : `Retry ${partialUpload.remaining.length} image upload(s)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper header. Clickable earlier steps so you can jump back; future step
// is shown as disabled. Submit/Review step is reachable only when everything
// is complete (enforced by the disabled state on the Next button + the
// onJump guard in the parent).
// ---------------------------------------------------------------------------
function Stepper({ step, onJump }) {
  return (
    <ol className="stepper">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const isActive = n === step;
        const isPast = n < step;
        return (
          <li
            key={label}
            className={
              'stepper-item' +
              (isActive ? ' stepper-active' : '') +
              (isPast ? ' stepper-past' : '')
            }
          >
            {isPast ? (
              <button className="stepper-button" onClick={() => onJump(n)}>
                {n}. {label}
              </button>
            ) : (
              <span className={'stepper-button' + (isActive ? '' : ' stepper-disabled')}>
                {n}. {label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// One module's question form. Renders every slot in question_number order.
// ---------------------------------------------------------------------------
function ModuleStep({ moduleNum, questions, validation, onChange }) {
  const total = COUNTS[moduleNum];
  const completeCount = Object.values(validation).filter(
    (missing) => missing.length === 0
  ).length;
  return (
    <section className="ct-module">
      <div className="ct-module-header">
        <h2>Module {moduleNum}</h2>
        <span className="ct-progress">
          {completeCount} / {total} questions complete
        </span>
      </div>
      {Array.from({ length: total }, (_, i) => i + 1).map((qNum) => (
        <QuestionForm
          key={qNum}
          moduleNum={moduleNum}
          qNum={qNum}
          value={questions[qNum]}
          missing={validation[qNum]}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Single question slot. Mirrors the field set in README §3 plus a file
// picker for the image (kept in local state until submit).
// ---------------------------------------------------------------------------
function QuestionForm({ moduleNum, qNum, value, missing, onChange }) {
  // correct-answer inline validation state. We only mark the field red on
  // blur, and only if the value is non-empty and not A-D, so a freshly
  // empty field doesn't flash red while the user is still typing.
  const [answerBlurred, setAnswerBlurred] = useState(false);
  const answerInvalid =
    answerBlurred && value.correct_answer !== '' && !isValidAnswerLetter(value.correct_answer);

  // Stable list of missing-field labels for the inline summary at the top
  // of the slot. Only shown when there are some, to keep clean slots tidy.
  const missingSet = new Set(missing);
  const summaryMissing = Array.from(missingSet);

  return (
    <div className="question-form">
      <div className="question-form-header">
        <span className="q-label">Question {qNum}</span>
        {summaryMissing.length > 0 && (
          <span className="q-missing">
            missing: {summaryMissing.join(', ')}
          </span>
        )}
      </div>

      <label className="field">
        <span className="field-label">Question text</span>
        <textarea
          rows={3}
          value={value.description}
          onChange={(e) => onChange(qNum, 'description', e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">Image (optional)</span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
            // Phase 8: pre-check file size against the server's cap so the
            // user finds out immediately rather than after a failed upload.
            // We still keep the file in state (not rejected outright) so
            // the user can see the size in the hint and pick a different
            // file via the remove button — but the upload step will also
            // re-check, and the submit button stays disabled.
            onChange(qNum, 'file', file);
          }}
        />
        {value.file && (
          <span className="file-hint">
            {value.file.name}
            {' '}
            <span className="file-size">({formatBytes(value.file.size)})</span>
            {' '}
            <button
              type="button"
              className="link-button"
              onClick={() => onChange(qNum, 'file', null)}
            >
              remove
            </button>
            {value.file.size > MAX_IMAGE_BYTES && (
              <span className="field-error" style={{ marginLeft: 8 }}>
                Image is too large (max {formatBytes(MAX_IMAGE_BYTES)}). Pick a smaller file.
              </span>
            )}
          </span>
        )}
      </label>

      <label className="field">
        <span className="field-label">Specific requirement</span>
        <textarea
          rows={2}
          value={value.specific_requirement}
          onChange={(e) => onChange(qNum, 'specific_requirement', e.target.value)}
        />
      </label>

      <div className="field-grid">
        {['a', 'b', 'c', 'd'].map((letter) => (
          <label key={letter} className="field">
            <span className="field-label">Option {letter.toUpperCase()}</span>
            <textarea
              style={{ WebkitTextSecurity: "disc" }}
              rows={2}
              value={value[`option_${letter}`]}
              onChange={(e) => onChange(qNum, `option_${letter}`, e.target.value)}
            />
          </label>
        ))}
      </div>

      <label className="field field-inline">
        <span className="field-label">Correct answer</span>
        <input
          style={{ WebkitTextSecurity: "disc" }}
          className={'answer-input' + (answerInvalid ? ' invalid' : '')}
          type="text"
          maxLength={1}
          value={value.correct_answer}
          onChange={(e) => onChange(qNum, 'correct_answer', e.target.value.toUpperCase())}
          onBlur={() => setAnswerBlurred(true)}
          placeholder="A-D"
          aria-invalid={answerInvalid}
        />
        {answerInvalid && (
          <span className="field-error">Must be A, B, C, or D.</span>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: per-module durations plus the break duration. Number inputs;
// we accept decimals (e.g. 0.1 = 6 seconds) so the test flow can be
// verified end-to-end in ~30s. The min/step matches the input precision.
// ---------------------------------------------------------------------------
function DurationsStep({ durations, breakMinutes, errors, onChangeModule, onChangeBreak }) {
  return (
    <section className="ct-durations">
      <h2>Module Durations</h2>
      <p className="subtitle">
        How long, in minutes, should each module's timer be set to? Decimals
        are allowed (e.g. <code>0.1</code> = 6 seconds) for fast testing.
      </p>
      <div className="duration-grid">
        {durations.map((d, i) => (
          <label key={i} className="field">
            <span className="field-label">Module {i + 1} (minutes)</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={Number.isFinite(d) ? d : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') return onChangeModule(i, 0);
                const n = parseFloat(raw);
                onChangeModule(i, Number.isFinite(n) ? n : 0);
              }}
            />
            {errors.modules[i] && <span className="field-error">{errors.modules[i]}</span>}
          </label>
        ))}
        <label className="field">
          <span className="field-label">Break (minutes)</span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={Number.isFinite(breakMinutes) ? breakMinutes : ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onChangeBreak(0);
              const n = parseFloat(raw);
              onChangeBreak(Number.isFinite(n) ? n : 0);
            }}
          />
          {errors.break && <span className="field-error">{errors.break}</span>}
        </label>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Review. Shows total completion, per-module breakdown, and the
// full missing-fields list. Each module summary has a "Jump to module N"
// button to take the user back to fix the listed problems.
// ---------------------------------------------------------------------------
function ReviewStep({ durations, breakMinutes, validation, allComplete, missingLines, onJumpToModule }) {
  return (
    <section className="ct-review">
      <h2>Review</h2>
      <p className="ct-review-total">
        <strong>{validation.totalComplete}</strong> / 98 questions complete
      </p>

      <div className="ct-review-grid">
        {MODULES.map((m) => {
          const total = COUNTS[m];
          const done = Object.values(validation.perModule[m]).filter(
            (arr) => arr.length === 0
          ).length;
          return (
            <div key={m} className={'ct-review-module' + (done === total ? ' is-complete' : '')}>
              <div className="ct-review-module-title">Module {m}</div>
              <div className="ct-review-module-stat">{done} / {total}</div>
              <button
                type="button"
                className="link-button"
                onClick={() => onJumpToModule(m)}
              >
                {done === total ? 'view' : 'fix'}
              </button>
            </div>
          );
        })}
      </div>

      <h3>Module &amp; Break Durations</h3>
      <ul className="ct-review-durations">
        {durations.map((d, i) => (
          <li key={i}>Module {i + 1}: {d} minutes</li>
        ))}
        <li>Break: {breakMinutes} minutes</li>
      </ul>

      {missingLines.length > 0 ? (
        <>
          <h3 className="bad">Incomplete questions ({missingLines.length})</h3>
          <ul className="ct-missing-list">
            {missingLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="ok">All 98 questions and durations look good.</p>
      )}

      <p className="ct-review-hint">
        {allComplete
          ? 'Click "Create Test" to save and upload any selected images.'
          : 'Fix the items above, then return to this step to submit.'}
      </p>
    </section>
  );
}
