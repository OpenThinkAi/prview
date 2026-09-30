// Submitting a review, the same way whoever produced the document:
//   1. write the finished document (and its markdown) — always, first, so nothing after can lose it;
//   2. post it through the adapter for `target.platform`, if prview has one (none: the file is the review);
//   3. run the document's `on_submit` command, only if the human allowed it in this submit.
// A failed post or hook is reported and recorded in the document's `submissions`, never fatal.
//
// The hook is a stranger's command: a document can come from anywhere. So it is an argv, run without
// a shell; the only thing prview puts into it is the written file's path, for `{file}`; one trailing
// `> path` sends its stdout to that file (prview writes it, no shell does); it runs in the head
// worktree and is stopped after HOOK_TIMEOUT_MS. The preview shows exactly that before anything runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { FileDiff } from "./diff.ts";
import { hunksOf } from "./guide.ts";
import { exportDocument, Fail, home, save, VERDICT, writeup, type Review } from "./build.ts";
import type { Doc, Submission, Target } from "./document.ts";
import { adapterFor, postingOf, spawn, type Adapter, type Posting, type Runner } from "./platform.ts";

export const HOOK_TIMEOUT_MS = 60_000;

/** The hook as it will run: `{file}` filled in, a trailing `> path` taken off the argv and resolved against the worktree. */
export type Hook = { argv: string[]; cwd: string; stdout?: string; timeoutMs: number };

export function hookOf(run: string[], file: string, cwd: string, timeoutMs = HOOK_TIMEOUT_MS): Hook {
  let argv = run.map((a) => a.replaceAll("{file}", file));
  let stdout: string | undefined;
  const n = argv.length;
  if (n >= 3 && argv[n - 2] === ">" && argv[n - 1]) { stdout = argv[n - 1]; argv = argv.slice(0, -2); }
  else if (n >= 2 && argv[n - 1]!.startsWith(">") && argv[n - 1]!.length > 1) { stdout = argv[n - 1]!.slice(1); argv = argv.slice(0, -1); }
  return { argv, cwd, timeoutMs, ...(stdout ? { stdout: isAbsolute(stdout) ? stdout : resolve(cwd, stdout) } : {}) };
}

/** Everything submit will do, worked out before it does any of it, so the preview can show it. */
export type Plan = { file: string; md: string; target: Target; platform?: string; adapter?: Adapter; posting?: Posting; hook?: Hook };

export const submittedDir = () => join(home(), "submitted");

/** What the human opted into at submit: the ids of kept findings to post as their own comments, and a coverage line. Both default to nothing. */
export type Choices = { findings?: string[]; coverage?: boolean };

/** The coverage line, in the reader's own voice: how much of the change they read. */
export function coverageLine(d: Doc, files: FileDiff[]): string {
  const total = hunksOf(files).filter((x) => x.hunk).length;
  return `I read ${d.human.visited.length} of ${total} hunks.`;
}

export function planOf(r: Review, files: FileDiff[], choices: Choices = {}): Plan {
  const file = join(submittedDir(), `${r.slug}.json`), md = join(submittedDir(), `${r.slug}.md`);
  const d = r.doc, platform = d.target.platform, adapter = adapterFor(platform);
  const paths = new Map(hunksOf(files).map((h) => [h.id, h.file.path]));
  const chosen = d.findings.filter((f) => choices.findings?.includes(f.id) && f.status !== "withdrawn" && !d.human.dismissals.includes(f.id));
  const posting = d.human.verdict ? postingOf(d.human.verdict, d.human.comments, (id) => paths.get(id), { findings: chosen, coverage: choices.coverage ? coverageLine(d, files) : undefined }) : undefined;
  return { file, md, target: d.target, platform, adapter, posting, ...(d.on_submit ? { hook: hookOf(d.on_submit.run, file, r.worktree) } : {}) };
}

/** An argv the way a reader would type it back: plain words bare, anything else single-quoted. */
export const shown = (argv: string[]) => argv.map((a) => /^[\w@%+=:,./{}-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`).join(" ");

/** The preview's account of what Enter will do; `allowed` is whether the human has let the hook run. */
export function describe(p: Plan, allowed: boolean, dryRun = false): string {
  const post = !p.platform ? "No platform in the document's target: the written file is the review."
    : !p.adapter ? `No ${p.platform} adapter yet: the written file is the review.`
    : p.posting ? p.adapter.describe(p.target, p.posting) : "Pick a verdict first.";
  const out = ["── On submit", ...(dryRun ? ["", "DRY RUN: only the API calls are printed; nothing is written, posted or run."] : []), "", `1. Writes ${p.file}`, `   and ${p.md}`, `2. ${post[0]!.toUpperCase()}${post.slice(1)}`];
  if (p.hook) {
    out.push(
      "3. The document asks to run this command:", "",
      `     ${shown(p.hook.argv)}`,
      ...(p.hook.stdout ? [`     stdout to ${p.hook.stdout}`] : []),
      `   in ${p.hook.cwd}, no shell, stopped after ${Math.round(p.hook.timeoutMs / 1000)}s.`, "",
      allowed ? "   [x] Allowed for this submit (x takes it back)." : "   [ ] Not allowed: it will not run. Press x to allow it for this submit.",
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- doing it

export type HookRunner = (h: Hook) => { exit: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string };

export const runHook: HookRunner = (h) => {
  try {
    const p = Bun.spawnSync(h.argv, { cwd: h.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: h.timeoutMs });
    return { exit: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), timedOut: !!p.exitedDueToTimeout };
  } catch (e) { return { exit: null, stdout: "", stderr: "", timedOut: false, error: (e as Error).message }; }
};

const tail = (s: string, n = 4000) => s.length > n ? "…" + s.slice(-n) : s;
const firstLine = (s: string) => s.trim().split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";

export type Result = { submission: Submission; summary: string; ok: boolean };

/**
 * Submit the review. Throws only if the document itself cannot be written (step 1); anything after
 * that is caught, recorded in `submissions`, and summed up in one line.
 */
export function submit(r: Review, files: FileDiff[], opts: Choices & { allowHook: boolean; run?: Runner; hook?: HookRunner; now?: () => Date; dryRun?: boolean }): Result {
  const d = r.doc;
  if (!d.human.verdict) throw new Fail("pick a verdict before submitting");
  const p = planOf(r, files, opts);
  const at = (opts.now ?? (() => new Date()))().toISOString();

  // A dry run is a read-only account of the post: nothing is written, sent or run, and no submission is recorded.
  if (opts.dryRun) {
    const calls = p.adapter && p.posting ? p.adapter.dryRun(d.target, p.posting).join("\n\n") : `no ${p.platform ?? "platform"} adapter: there is nothing to post`;
    return { submission: { at, verdict: d.human.verdict, file: p.file }, summary: `Dry run (${VERDICT[d.human.verdict]}): nothing written or posted.\n\n${calls}`, ok: true };
  }

  // 1. The document, before anything that can fail for reasons outside this machine.
  try {
    mkdirSync(submittedDir(), { recursive: true });
    writeFileSync(p.md, writeup(d, files));
    writeFileSync(p.file, exportDocument(r));
  } catch (e) { throw new Fail(`could not write ${p.file}: ${(e as Error).message}`); }
  const sub: Submission = { at, verdict: d.human.verdict, file: p.file };
  const parts = [`Submitted (${VERDICT[d.human.verdict]}): wrote ${p.file}`];
  let ok = true;

  // 2. The platform.
  if (!p.platform) parts.push("no platform to post to, the file is the review");
  else if (!p.adapter) parts.push(`no ${p.platform} adapter yet, the file is the review`);
  else {
    try {
      const { url } = p.adapter.post(d.target, p.posting!, opts.run ?? spawn, r.worktree);
      sub.posted = { platform: p.adapter.platform, ok: true, ...(url ? { url } : {}) };
      parts.push(`posted to ${url ?? p.platform}`);
    } catch (e) {
      const error = (e as Error).message;
      sub.posted = { platform: p.adapter.platform, ok: false, error };
      parts.push(`NOT posted to ${p.platform}: ${error}`); ok = false;
    }
  }

  // 3. The hook, only with the human's say-so in this submit.
  if (p.hook) {
    const h = p.hook;
    const rec: NonNullable<Submission["hook"]> = { argv: [...h.argv, ...(h.stdout ? [">", h.stdout] : [])], cwd: h.cwd, ran: false };
    if (!opts.allowHook) parts.push("on_submit not run (not allowed)");
    else {
      const res = (opts.hook ?? runHook)(h);
      rec.ran = true; rec.exit = res.exit;
      let writeError = "";
      if (h.stdout && !res.error) { try { writeFileSync(h.stdout, res.stdout); } catch (e) { writeError = `could not write ${h.stdout}: ${(e as Error).message}`; } }
      rec.output = tail([h.stdout ? "" : res.stdout, res.stderr].filter(Boolean).join("\n"));
      if (res.timedOut) rec.timed_out = true;
      const error = res.error ?? (writeError || undefined);
      if (error) rec.error = error;
      if (res.exit === 0 && !res.timedOut && !error) parts.push(`on_submit ran (exit 0${h.stdout ? `, stdout in ${h.stdout}` : ""})`);
      else {
        ok = false;
        const why = res.timedOut ? `timed out after ${Math.round(h.timeoutMs / 1000)}s` : error ? error : `exit ${res.exit ?? "?"}`;
        const said = firstLine(res.stderr) || (h.stdout ? "" : firstLine(res.stdout));
        parts.push(`on_submit FAILED (${why})${said ? `: ${said}` : ""}`);
      }
    }
    sub.hook = rec;
  }

  // What happened goes into the document too; the file is written again so it carries the record.
  d.submissions = [...(d.submissions ?? []), sub];
  save(r);
  try { writeFileSync(p.file, exportDocument(r)); } catch {} // step 1 already wrote it; a stale record beats a lost file
  return { submission: sub, summary: parts.join(" · "), ok };
}
