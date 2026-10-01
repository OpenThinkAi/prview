// Submitting a review, the same way whoever produced the document. What the submit flow chose (submit-flow.ts: the
// ticked findings, the verdict, the top-level comment) is applied to the reader's layer first, so the document
// records exactly what goes out, and the preview is drawn from the same plan that posts. Then:
//   1. write the finished document (and its markdown) — always, first, so nothing after can lose it;
//   2. post it through the adapter for `target.platform`, if prview has one (none: the file is the review);
//   3. run the document's `on_submit` command, only if the human allowed it in this submit.
// A failed post or hook is reported and recorded in the document's `submissions`, never fatal.
//
// The hook is a stranger's command: a document can come from anywhere. So it is an argv, run without
// a shell; the only thing prview puts into it is the written file's path, for `{file}`; one trailing
// `> path` sends its stdout to that file (prview writes it, no shell does) and must land inside the head
// worktree, symlinks followed, or the hook is refused before it runs; it runs in the head worktree and is
// stopped after HOOK_TIMEOUT_MS. `{file}` is a copy of the document without the reader's private ignore
// notes. The preview shows exactly that before anything runs.

import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { FileDiff } from "./diff.ts";
import { hunksOf } from "./guide.ts";
import { exportDocument, Fail, save, VERDICT, writeup, type Review } from "./build.ts";
import { PostError, type Doc, type Human, type Submission, type Target } from "./document.ts";
import { freshStamp, historyDir, submittedDir } from "./history.ts";
import { adapterFor, postingOf, spawn, type Adapter, type Posting, type Runner } from "./platform.ts";
import { applySelection, type Selection } from "./submit-flow.ts";
import { afterSubmit, earlierPosts } from "./earlier.ts";
import type { Defaults } from "./triage.ts";

export const HOOK_TIMEOUT_MS = 60_000;

/** The hook as it will run: `{file}` filled in, a trailing `> path` taken off the argv and resolved against the worktree. `refused` is why it will not run. */
export type Hook = { argv: string[]; cwd: string; stdout?: string; timeoutMs: number; refused?: string };

/**
 * Why a `> path` may not be written, or undefined if it may: it has to resolve inside the worktree. The check is on
 * the real location (every symlink followed, the deepest existing ancestor if the file is new), so neither `..`
 * nor a link pointing out gets past it. The worktree's own `.git` is off limits too.
 */
export function redirectRefusal(cwd: string, target: string): string | undefined {
  const abs = resolve(cwd, target);
  const out = `the redirect to ${target} would write outside the worktree (${cwd})`;
  let root: string;
  try { root = realpathSync(cwd); } catch { root = resolve(cwd); }
  const within = (p: string) => p === root || p.startsWith(root + sep);
  const lexical = relative(resolve(cwd), abs);
  if (lexical === ".." || lexical.startsWith(".." + sep) || resolve(lexical) === lexical) return out;
  // The real place: follow the path itself if it exists (a dangling link is refused), else its deepest existing parent.
  let real: string;
  try {
    let at = abs, tailParts: string[] = [];
    for (;;) {
      try { lstatSync(at); break; } catch { tailParts = [basename(at), ...tailParts]; const up = dirname(at); if (up === at) return out; at = up; }
    }
    real = join(realpathSync(at), ...tailParts);
  } catch { return `the redirect to ${target} could not be resolved (a link that points nowhere?)`; }
  if (!within(real)) return out;
  if (real === root) return `the redirect to ${target} is the worktree itself`;
  if (relative(root, real).split(sep)[0] === ".git") return `the redirect to ${target} is inside the worktree's .git`;
  return undefined;
}

export function hookOf(run: string[], file: string, cwd: string, timeoutMs = HOOK_TIMEOUT_MS): Hook {
  let argv = run.map((a) => a.replaceAll("{file}", file));
  let stdout: string | undefined;
  const n = argv.length;
  if (n >= 3 && argv[n - 2] === ">" && argv[n - 1]) { stdout = argv[n - 1]; argv = argv.slice(0, -2); }
  else if (n >= 2 && argv[n - 1]!.startsWith(">") && argv[n - 1]!.length > 1) { stdout = argv[n - 1]!.slice(1); argv = argv.slice(0, -1); }
  const refused = stdout ? redirectRefusal(cwd, stdout) : undefined;
  return { argv, cwd, timeoutMs, ...(stdout ? { stdout: resolve(cwd, stdout) } : {}), ...(refused ? { refused } : {}) };
}

/** Everything submit will do, worked out before it does any of it, so the preview can show it. `human`: the reader's layer as it will be written. */
export type Plan = { file: string; md: string; hookFile: string; target: Target; platform?: string; adapter?: Adapter; posting?: Posting; hook?: Hook; human: Human };

export { submittedDir };

/**
 * What the human chose at submit: the flow's selection (ticked findings, verdict, top-level comment) and a coverage
 * line, off by default. Without a selection the reader's layer is taken as it stands.
 */
export type Choices = { coverage?: boolean; selection?: Selection; defaults?: Defaults; at?: string };

/** The coverage line, in the reader's own voice: how much of the change they read. */
export function coverageLine(d: Doc, files: FileDiff[]): string {
  const total = hunksOf(files).filter((x) => x.hunk).length;
  const seen = new Set(d.human.visited).size;
  return `I read ${seen} of ${total} hunk${total === 1 ? "" : "s"}.`;
}

export function planOf(r: Review, files: FileDiff[], choices: Choices = {}): Plan {
  // Every submit is kept, under its own time: submitted/<slug>/<UTC timestamp>.json, .md and .hook.json (history.ts).
  const dir = historyDir(r.slug), stamp = freshStamp(dir, choices.at ?? new Date().toISOString());
  const file = join(dir, `${stamp}.json`), md = join(dir, `${stamp}.md`), hookFile = join(dir, `${stamp}.hook.json`);
  const d = r.doc, platform = d.target.platform, adapter = adapterFor(platform);
  const human = choices.selection ? applySelection(d.human, d.findings, choices.selection, choices.defaults, choices.at) : d.human;
  const paths = new Map(hunksOf(files).map((h) => [h.id, h.file.path]));
  // A re-review's replies and resolves on earlier threads (earlier.ts), the ticked ones: they go out first.
  const earlier = earlierPosts(r.earlier, choices.selection);
  const posting = human.verdict ? postingOf(human.verdict, human.comments, (id) => paths.get(id), { coverage: choices.coverage ? coverageLine(d, files) : undefined }) : undefined;
  if (posting && earlier.length) posting.earlier = earlier;
  return { file, md, hookFile, target: d.target, platform, adapter, posting, human, ...(d.on_submit ? { hook: hookOf(d.on_submit.run, hookFile, r.worktree) } : {}) };
}

/**
 * The send step's account of what posts, drawn from the posting itself so it is exactly what goes out: the verdict,
 * the top-level comment (and the coverage line when chosen), each line comment on its file and line, and each comment
 * on a whole file.
 */
/**
 * `marks`: what is known of the reader's own comments (carryover.ts): `tag` labels a comment that posts ("carried over
 * from …", "posted … (round 1)" when ticked again), `left` counts the ones posted before and left out.
 */
export type Marks = { tag: (path: string, side: "new" | "old" | "file", line: number | null, text: string) => string | undefined; left: number };

export function postPreview(p: Plan, label: (v: Posting["verdict"]) => string, marks?: Marks): string {
  const where = !p.platform ? "nothing is posted (the document has no platform): this is what the review records"
    : !p.adapter ? `nothing is posted (no ${p.platform} adapter yet): this is what the review records`
    : `what posts to ${p.target.url ?? p.platform}`;
  const out = [`── ${where[0]!.toUpperCase()}${where.slice(1)}`, ""];
  const q = p.posting;
  if (!q) return [...out, "No verdict yet."].join("\n");
  // Sent first, so listed first: what answers the threads of your last submit.
  if (q.earlier?.length) {
    out.push(`Earlier threads (${q.earlier.length}, sent first, before the review):`);
    for (const e of q.earlier) {
      if (e.kind === "resolve") { out.push(`  resolve ${e.place}`); continue; }
      out.push(`  reply to ${e.place}`, ...e.text.split("\n").map((l) => `    ${l}`));
    }
    out.push("");
  }
  out.push(`Verdict: ${label(q.verdict)}`, "", "Comment:");
  const body = [q.body, q.coverage].filter(Boolean).join("\n\n");
  out.push(...(body ? body.split("\n").map((l) => `  ${l}`) : ["  (none)"]));
  out.push("", `Line comments (${q.comments.length}):`);
  if (!q.comments.length) out.push("  (none)");
  const tag = (path: string, side: "new" | "old" | "file", line: number | null, text: string) => { const t = marks?.tag(path, side, line, text); return t ? ` · ${t}` : ""; };
  for (const c of q.comments) { out.push(`  ${c.path}:${c.line}${c.side === "old" ? " (old side)" : ""}${tag(c.path, c.side, c.line, c.text)}`); out.push(...c.text.split("\n").map((l) => `    ${l}`)); }
  if (q.files?.length) {
    out.push("", `Whole-file comments (${q.files.length}):`);
    for (const x of q.files) { out.push(`  ${x.path}${tag(x.path, "file", null, x.text)}`); out.push(...x.text.split("\n").map((l) => `    ${l}`)); }
  }
  if (marks?.left) out.push("", `Left out: ${marks.left} of your comment${marks.left === 1 ? "" : "s"} an earlier submit already posted (unticked in step 1).`);
  return out.join("\n");
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
      `   in ${p.hook.cwd}, no shell, stopped after ${Math.round(p.hook.timeoutMs / 1000)}s.`,
      `   {file} is ${p.hookFile}: your review without your private ignore notes.`, "",
      ...(p.hook.refused ? [`   REFUSED: ${p.hook.refused}. It will not run.`] : []),
      ...(p.hook.refused ? [] : [allowed ? "   Allowed for this submit: it runs after the post." : "   Not allowed: it will not run. Tick it above to allow it for this submit."]),
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
export async function submit(r: Review, files: FileDiff[], opts: Choices & { allowHook: boolean; run?: Runner; hook?: HookRunner; now?: () => Date; dryRun?: boolean }): Promise<Result> {
  const d = r.doc;
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const p = planOf(r, files, { ...opts, at });
  const verdict = p.human.verdict;
  if (!verdict) throw new Fail("pick a verdict before submitting");

  // A dry run is a read-only account of the post: nothing is written, sent or run, and no submission is recorded.
  if (opts.dryRun) {
    const calls = p.adapter && p.posting ? p.adapter.dryRun(d.target, p.posting).join("\n\n") : `no ${p.platform ?? "platform"} adapter: there is nothing to post`;
    return { submission: { at, verdict, file: p.file }, summary: `Dry run (${VERDICT[verdict]}): nothing written or posted.\n\n${calls}`, ok: true };
  }

  // What the flow chose becomes the reader's layer, so the document written next is the record of what posts.
  d.human = p.human;

  // 1. The document, before anything that can fail for reasons outside this machine.
  try {
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.md, writeup(d, files, opts.defaults));
    writeFileSync(p.file, exportDocument(r));
  } catch (e) { throw new Fail(`could not write ${p.file}: ${(e as Error).message}`); }
  const sub: Submission = { at, verdict, file: p.file, head: d.target.head, ...(p.platform ? { platform: p.platform } : {}) };
  const parts = [`Submitted (${VERDICT[verdict]}): wrote ${p.file}`];
  let ok = true;

  // 2. The platform.
  if (!p.platform) parts.push("no platform to post to, the file is the review");
  else if (!p.adapter) parts.push(`no ${p.platform} adapter yet, the file is the review`);
  else {
    try {
      const { url, review_id, items } = await p.adapter.post(d.target, p.posting!, opts.run ?? spawn, r.worktree);
      sub.posted = { platform: p.adapter.platform, ok: true, ...(url ? { url } : {}), ...(review_id ? { review_id } : {}), ...(items?.length ? { items } : {}) };
      parts.push(`posted to ${url ?? p.platform}`);
      // What went out on earlier threads leaves the queue; an unticked one stays for the next submit.
      if (p.posting?.earlier) { const q = afterSubmit(r.earlier, p.posting.earlier, items ?? []); if (q) r.earlier = q; else delete r.earlier; }
    } catch (e) {
      const error = (e as Error).message;
      // A partial failure still records what reached the PR, with its ids: a re-review finds those comments too.
      const items = e instanceof PostError ? e.items : [];
      sub.posted = { platform: p.adapter.platform, ok: false, error, ...(items.length ? { items } : {}) };
      if (p.posting?.earlier) { const q = afterSubmit(r.earlier, p.posting.earlier, items); if (q) r.earlier = q; else delete r.earlier; }
      parts.push(`NOT posted to ${p.platform}: ${error}`); ok = false;
    }
  }

  // 3. The hook, only with the human's say-so in this submit.
  if (p.hook) {
    const h = p.hook;
    const rec: NonNullable<Submission["hook"]> = { argv: [...h.argv, ...(h.stdout ? [">", h.stdout] : [])], cwd: h.cwd, ran: false };
    if (!opts.allowHook) parts.push("on_submit not run (not allowed)");
    else if (h.refused) { rec.error = h.refused; parts.push(`on_submit REFUSED, not run: ${h.refused}`); ok = false; }
    else {
      // The hook gets its own copy, minus the private ignore notes: those are the reader's, not the producer's.
      let copyError = "";
      try { writeFileSync(p.hookFile, exportDocument(r, { redact: true })); } catch (e) { copyError = `could not write ${p.hookFile}: ${(e as Error).message}`; }
      const res = copyError ? { exit: null, stdout: "", stderr: "", timedOut: false, error: copyError } : (opts.hook ?? runHook)(h);
      rec.ran = !copyError; rec.exit = res.exit;
      let writeError = "";
      // Checked again now: the hook ran in the worktree and could have put a link where the path was clean a moment ago.
      const late = h.stdout ? redirectRefusal(h.cwd, h.stdout) : undefined;
      if (late) writeError = late;
      else if (h.stdout && !res.error) { try { writeFileSync(h.stdout, res.stdout); } catch (e) { writeError = `could not write ${h.stdout}: ${(e as Error).message}`; } }
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
