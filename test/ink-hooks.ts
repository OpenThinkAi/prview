// Timing and teardown for every test file that mounts ink. A render costs real time and a slow shared runner (CI:
// ubuntu, Bun 1.3.13, colour forced on) takes several times what a laptop does, so a test that drives many keys
// needs more than Bun's 5s default; none is near it on a laptop. And every ink instance a test mounts is unmounted
// after the test whether it passed, failed or timed out: a timed-out test otherwise leaves its app (stdin listener,
// timers) alive and its key loop running, which stalled the whole run until the job limit.
//
// A function each file calls, not a preload: Bun applies setDefaultTimeout (and hooks) from a preload to the first
// test file only.
import { afterEach, setDefaultTimeout } from "bun:test";
import { cleanup } from "ink-testing-library";

export function inkTestHooks(): void {
  setDefaultTimeout(60_000);
  afterEach(() => { cleanup(); });
}
