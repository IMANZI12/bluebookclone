// client/src/lib/testMachine.js
// Phase 6 pass 2: explicit state machine + derived-time helper for the
// test-taking flow.
//
// Why a state machine:
//   The test is a sequence of phases (module N → pause → resume → module
//   N+1 → break → … → complete) and the wrong "thing" can happen at each
//   step (e.g. pausing during the break, which the app intentionally
//   forbids). Encoding the allowed transitions in a reducer makes those
//   rules explicit and removes the need for a maze of boolean flags in
//   the component.
//
// Why a SEPARATE `computeRemaining` helper instead of a derived value in
//   the reducer:
//   The reducer stores server-anchored timestamps (module_started_at etc.).
//   It does NOT compute "remaining seconds" because that would force a
//   time-dependent reducer — every tick would be a new state. Instead
//   the component reads `machine.startedAt` + `now()` on each setInterval
//   tick to recompute the display, and only dispatches transitions when
//   the timer actually hits zero. This keeps the reducer pure and the
//   timer refresh interval independent of React's render loop.

// ---------------------------------------------------------------------------
// Phases. Each value is a string in the state machine. Comments describe
// which events are valid in each phase.
//
//   'running'  — actively counting down a module's timer. PAUSE allowed.
//   'paused'   — module timer is frozen. RESUME allowed.
//   'break'    — counting down the 10-minute (or whatever) break. NOT
//                pausable in this app — PAUSE ignored.
//   'saving'   — module 4 has just ended; we're POSTing the rotation.
//   'complete' — terminal. Test finished, navigating to home.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Initial state factory. Called once on mount (via useReducer's lazy init).
// We start in 'running' on module 1 with no startedAt/pausedAt yet; the
// HYDRATE action supplies them after the server confirms.
// ---------------------------------------------------------------------------
export function initialMachineState() {
  return {
    phase: 'running',
    module: 1,             // 1..4 when in 'running' or 'paused'; null during 'break'
    startedAt: null,       // ISO string of modules.module_started_at
    pausedAt: null,        // ISO string of modules.paused_at, or null
    accumulatedPause: 0,   // modules.accumulated_pause_seconds
    durationSeconds: 0,    // duration for the current module (in seconds)
    breakDurationSeconds: 0, // duration for the break (in seconds); set at hydrate
    startedAtBreak: null,  // ISO string of breaks.started_at (only set when phase='break')
    saveError: null,       // string|null for the COMPLETE-save error retry
  };
}

// ---------------------------------------------------------------------------
// Reducer. Pure: (state, action) => newState.
//
// Note that this reducer is intentionally narrow: it does not handle the
// "start" or "pause" HTTP calls. The component does those, then dispatches
// HYDRATE / PAUSE / RESUME with the SERVER's returned timestamps. That way
// the reducer never has to "guess" what the server stored — it just stores
// what the server told it.
// ---------------------------------------------------------------------------
export function testMachineReducer(state, action) {
  switch (action.type) {
    // Set/overwrite the entire machine. Used to hydrate after fetching
    // the test + calling /start, and to transition into 'break'.
    case 'HYDRATE': {
      return { ...state, ...action.machine };
    }

    // PAUSE: only legal in 'running'. The component should have already
    // PATCHed /api/modules/.../pause; we just stamp pausedAt with the
    // server's returned timestamp.
    case 'PAUSE': {
      if (state.phase !== 'running') return state;
      return {
        ...state,
        phase: 'paused',
        pausedAt: action.pausedAt ?? new Date().toISOString(),
      };
    }

    // RESUME: only legal in 'paused'. Adds the pause duration to
    // accumulatedPause, clears pausedAt, returns to 'running'.
    case 'RESUME': {
      if (state.phase !== 'paused') return state;
      return {
        ...state,
        phase: 'running',
        pausedAt: null,
        accumulatedPause: action.accumulatedPause ?? state.accumulatedPause,
      };
    }

    // MODULE_DONE: a module's timer hit 0. Decision tree:
    //   - module 1 → running module 2
    //   - module 2 → break
    //   - module 3 → running module 4
    //   - module 4 → saving (the component will POST the rotation)
    // The component is responsible for the matching /start call before
    // dispatching this. We just update the in-memory machine.
    case 'MODULE_DONE': {
      if (state.phase !== 'running') return state;
      if (state.module === 1) {
        return {
          ...state,
          phase: 'running',
          module: 2,
          startedAt: action.nextStartedAt,
          pausedAt: null,
          accumulatedPause: 0,
          durationSeconds: action.nextDurationSeconds,
        };
      }
      if (state.module === 2) {
        return {
          ...state,
          phase: 'break',
          module: null,
          startedAt: null,
          pausedAt: null,
          accumulatedPause: 0,
          durationSeconds: 0,
          startedAtBreak: action.nextStartedAt,
        };
      }
      if (state.module === 3) {
        return {
          ...state,
          phase: 'running',
          module: 4,
          startedAt: action.nextStartedAt,
          pausedAt: null,
          accumulatedPause: 0,
          durationSeconds: action.nextDurationSeconds,
        };
      }
      // module 4 done → saving
      return {
        ...state,
        phase: 'saving',
        module: null,
        startedAt: null,
        pausedAt: null,
        accumulatedPause: 0,
        durationSeconds: 0,
      };
    }

    // BREAK_DONE: break timer hit 0 → running module 3.
    case 'BREAK_DONE': {
      if (state.phase !== 'break') return state;
      return {
        ...state,
        phase: 'running',
        module: 3,
        startedAt: action.nextStartedAt,
        pausedAt: null,
        accumulatedPause: 0,
        durationSeconds: action.nextDurationSeconds,
        startedAtBreak: null,
      };
    }

    // COMPLETE: rotation succeeded. Terminal state.
    case 'COMPLETE': {
      return { ...state, phase: 'complete' };
    }

    // SAVE_ERROR: rotation POST failed. Stay in 'saving' so the user
    // sees the error and a Retry button.
    case 'SAVE_ERROR': {
      return { ...state, saveError: action.error };
    }

    // CLEAR_SAVE_ERROR: clear the error string (e.g. when retry starts).
    case 'CLEAR_SAVE_ERROR': {
      return { ...state, saveError: null };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Compute remaining seconds for a given machine state, given a "now"
// timestamp. Pure function — used by both the tick handler and any
// server-data-hydration path so the displayed remaining time is always
// derived from server-anchored timestamps, never from a local counter.
//
// Returns 0 (not negative) when the timer has expired so the caller can
// just check `remaining <= 0` to detect completion.
// ---------------------------------------------------------------------------
export function computeRemaining(machine, nowMs) {
  if (machine.phase === 'paused') {
    // While paused, remaining is frozen at the value it had when we paused.
    // We reconstruct that value: at pause time, the elapsed live time
    // (excluding prior pauses) was (pausedAt - startedAt - priorAccPause)
    // and the total budget is durationSeconds. So remaining at pause
    // = durationSeconds - (pausedAtMs - startedAtMs - priorAccPause*1000).
    // Subtract that from durationSeconds — but easier: from the pausedAt
    // moment onward, the clock is frozen, so we use a synthetic "now"
    // that equals pausedAt.
    if (!machine.pausedAt || !machine.startedAt) return 0;
    const pausedAtMs = Date.parse(machine.pausedAt);
    const startedAtMs = Date.parse(machine.startedAt);
    if (Number.isNaN(pausedAtMs) || Number.isNaN(startedAtMs)) return 0;
    const elapsedLiveMs = pausedAtMs - startedAtMs - machine.accumulatedPause * 1000;
    return Math.max(0, machine.durationSeconds - Math.floor(elapsedLiveMs / 1000));
  }
  if (machine.phase === 'running') {
    if (!machine.startedAt) return 0;
    const startedAtMs = Date.parse(machine.startedAt);
    if (Number.isNaN(startedAtMs)) return 0;
    const elapsedLiveMs = nowMs - startedAtMs - machine.accumulatedPause * 1000;
    return Math.max(0, machine.durationSeconds - Math.floor(elapsedLiveMs / 1000));
  }
  if (machine.phase === 'break') {
    if (!machine.startedAtBreak) return 0;
    const breakStartMs = Date.parse(machine.startedAtBreak);
    if (Number.isNaN(breakStartMs)) return 0;
    // Break has no pause accumulator.
    return Math.max(0, machine.breakDurationSeconds - Math.floor((nowMs - breakStartMs) / 1000));
  }
  return 0;
}

// Format remaining seconds as "MM:SS" for the header. Values >= 1 hour
// would render as "H:MM:SS" but per the design spec all module durations
// are < 60 min so MM:SS is fine.
export function formatMmSs(secs) {
  const s = Math.max(0, Math.floor(secs));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
