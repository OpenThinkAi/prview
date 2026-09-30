// The review document, `prview-review/1`: the one thing every producer writes and every consumer
// reads. The in-house guide and critic write one; so can any other reviewer, and prview never asks
// which. The only trace of a producer is the `source` on each finding, kept for attribution.
//
// Everything here is pure. A document from outside is untrusted input: parsing drops what does not
// fit rather than failing, and `fit` holds it to the diff it claims to describe (mechanical hunks by
// rule, chapters and findings anchored to hunks that exist). The document is anchored on its head
// commit; it never merges with, or opens against, another head.

import type { FileDiff } from "./diff.ts";
import { anchorLine, checkPlan, classify, clip, filePlan, fitLine, hunksOf, SEVERITIES, type Chapter, type Finding, type Mechanical, type Plan, type Severity } from "./guide.ts";
import { withLegacy } from "./triage.ts";

export const SCHEMA = "prview-review/1";

/** A mistake by the caller (or in a document they handed us): printed without a stack trace. */
export class Fail extends Error {}

export type Verdict = "approve" | "request_changes" | "comment";
export type Target = { repo: string; base: string; head: string; url?: string; platform?: string; title: string; body: string; label: string };
/** `id` is only set on a comment something points at: the one a finding decision (block or comment) wrote. */
export type Comment = { id?: string; hunk: string | null; side: "new" | "old"; line: number | null; text: string; at: string };
/**
 * What the reader decided about one finding. `block` and `comment` made a line comment of the
 * reader's own (`comment` is its id); `dismissed` is "not an issue", with an optional reason that
 * stays in the document and is never posted. A stored `ignored` (an older document) reads as `dismissed`.
 */
export type DecisionKind = "block" | "comment" | "dismissed";
export type Decision = { kind: DecisionKind; reason?: string; comment?: string };
/** Finding id to decision. */
export type Decisions = Record<string, Decision>;
/**
 * `revealed` and `decisions` are optional so older documents load unchanged: chapters (by first hunk) whose findings were
 * shown before being read, and the reader's decision per finding. A document's legacy `dismissals` are read as decisions.
 */
export type Human = { comments: Comment[]; visited: string[]; decisions?: Decisions; revealed?: string[]; verdict?: Verdict };
/**
 * A producer's command to run after submit, as an argv (a string form is split here, without a
 * shell). A document can come from anyone, so this is only ever a request: submit shows the exact
 * command and runs it only when the human allows it, that time (see src/submit.ts).
 */
export type OnSubmit = { run: string[] };
/** What one submit did: the file written, where it was posted, and what the hook did if it ran. */
export type Submission = {
  at: string; verdict?: Verdict; file: string;
  posted?: { platform: string; ok: boolean; url?: string; error?: string };
  hook?: { argv: string[]; cwd: string; ran: boolean; exit?: number | null; output?: string; error?: string; timed_out?: boolean };
};
export type Doc = { schema: typeof SCHEMA; target: Target; plan: Plan; findings: Finding[]; human: Human; on_submit?: OnSubmit; submissions?: Submission[] };

export const blank = (target: Target): Doc => ({
  schema: SCHEMA, target, plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [], visited: [] },
});

// ---------------------------------------------------------------- reading one

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown, n: number) => typeof v === "string" ? clip(v.trim(), n) : "";
const sha = (v: unknown) => typeof v === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v) ? v : "";
const side = (v: unknown): "new" | "old" => v === "old" ? "old" : "new";
const VERDICTS = new Set<Verdict>(["approve", "request_changes", "comment"]);
const STATUSES = new Set<Finding["status"]>(["upheld", "withdrawn", "unrefuted"]);
const KINDS = new Set<string>(["block", "comment", "dismissed", "ignored"]);

/** A document from a file, stdin or the store. Refuses only what cannot be a review at all: another schema, or no commits to anchor on. */
export function parseDocument(input: unknown): Doc {
  let j = input;
  if (typeof input === "string") {
    try { j = JSON.parse(input); } catch { throw new Fail("not JSON: a review document is one JSON object"); }
  }
  if (!isObj(j) || j.schema !== SCHEMA) throw new Fail(`not a ${SCHEMA} document${isObj(j) && typeof j.schema === "string" ? ` (it says ${clip(j.schema, 40)})` : ""}`);
  const t = isObj(j.target) ? j.target : {};
  const base = sha(t.base), head = sha(t.head);
  if (!base || !head) throw new Fail("the document's target needs full base and head commit ids");
  const target: Target = { repo: str(t.repo, 200), base, head, title: str(t.title, 300), body: str(t.body, 20000), label: str(t.label, 200) || `${base.slice(0, 8)}..${head.slice(0, 8)}` };
  if (str(t.url, 500)) target.url = str(t.url, 500);
  if (str(t.platform, 40)) target.platform = str(t.platform, 40);

  const p = isObj(j.plan) ? j.plan : {};
  const chapters: Chapter[] = arr(p.chapters).filter(isObj).map((c) => ({
    title: str(c.title, 60) || "Untitled", intent: str(c.intent, 200), why: str(c.why, 400), hunks: arr(c.hunks).filter((h): h is string => typeof h === "string"),
  }));
  const mechanical: Mechanical[] = arr(p.mechanical).filter(isObj).flatMap((m) => typeof m.id === "string" ? [{ id: m.id, why: str(m.why, 200) }] : []);
  // A producer that ordered chapters but did not name itself still ordered them: only "files" means the fallback.
  const plan: Plan = { summary: str(p.summary, 400), chapters, mechanical, by: str(p.by, 40) || (chapters.length ? "producer" : "files") };

  const ids = new Set<string>();
  const findings: Finding[] = [];
  for (const f of arr(j.findings).filter(isObj)) {
    const claim = str(f.claim, 300), line = Number(f.line), title = fitLine(str(f.title, 300)).text;
    if (typeof f.hunk !== "string" || !claim || !Number.isInteger(line)) continue;
    // Ids only have to be unique within the document; a repeat or a missing one gets a fresh id.
    let id = typeof f.id === "string" || typeof f.id === "number" ? clip(String(f.id), 80) : `f${findings.length}`;
    for (let k = 2; ids.has(id); k++) id = `${String(f.id ?? "f")}.${k}`;
    ids.add(id);
    findings.push({
      id, source: str(f.source, 40) || "unknown", hunk: f.hunk, side: side(f.side), line,
      severity: SEVERITIES.has(f.severity as Severity) ? f.severity as Severity : "warn", kind: str(f.kind, 30).toLowerCase() || "finding",
      // A producer's title is held to 12 words like the critic's; one it did not give is derived on display.
      ...(title ? { title } : {}),
      claim, evidence: str(f.evidence, 500), status: STATUSES.has(f.status as Finding["status"]) ? f.status as Finding["status"] : "unrefuted",
      ...(str(f.refute, 300) ? { refute: str(f.refute, 300) } : {}),
      // Only a producer that ran a reviewer several times has votes; anything else is left unset.
      ...(Number.isInteger(f.votes) && (f.votes as number) >= 1 && (f.votes as number) <= 99 ? { votes: f.votes as number } : {}),
    });
  }

  const h = isObj(j.human) ? j.human : {};
  const cids = new Set<string>();
  const human: Human = {
    comments: arr(h.comments).filter(isObj).flatMap((c): Comment[] => {
      const text = str(c.text, 5000);
      if (!text) return [];
      // A repeated id would make a decision point at two comments: the second one loses it.
      const id = typeof c.id === "string" && c.id && c.id.length <= 40 && !cids.has(c.id) ? c.id : undefined;
      if (id) cids.add(id);
      return [{ ...(id ? { id } : {}), hunk: typeof c.hunk === "string" ? c.hunk : null, side: side(c.side), line: Number.isInteger(c.line) ? c.line as number : null, text, at: str(c.at, 40) }];
    }),
    visited: arr(h.visited).filter((v): v is string => typeof v === "string"),
  };
  const decisions: Decisions = {};
  for (const [id, v] of Object.entries(isObj(h.decisions) ? h.decisions : {})) {
    if (!ids.has(id) || !isObj(v) || !KINDS.has(v.kind as string)) continue;
    const kind: DecisionKind = v.kind === "ignored" ? "dismissed" : v.kind as DecisionKind, reason = v.kind === "dismissed" ? str(v.reason, 200) : "";
    decisions[id] = { kind, ...(reason && kind === "dismissed" ? { reason } : {}), ...(typeof v.comment === "string" && cids.has(v.comment) && (kind === "block" || kind === "comment") ? { comment: v.comment } : {}) };
  }
  const all = withLegacy(decisions, arr(h.dismissals).map(String).filter((d) => ids.has(d)));
  if (Object.keys(all).length) human.decisions = all;
  const revealed = arr(h.revealed).filter((v): v is string => typeof v === "string");
  if (revealed.length) human.revealed = [...new Set(revealed)];
  if (VERDICTS.has(h.verdict as Verdict)) human.verdict = h.verdict as Verdict;

  const doc: Doc = { schema: SCHEMA, target, plan, findings, human };
  const onSubmit = isObj(j.on_submit) ? argvOf(j.on_submit.run) : null;
  if (onSubmit) doc.on_submit = { run: onSubmit };
  const submissions = arr(j.submissions).filter(isObj).flatMap(submissionOf).slice(-50);
  if (submissions.length) doc.submissions = submissions;
  return doc;
}

// ---------------------------------------------------------------- on_submit and submissions

/**
 * A command as an argv, never a shell line: a list of strings is taken as it is, a string is split
 * on whitespace with '...' and "..." quoting (and \ escaping the next character). Anything that
 * cannot be split cleanly, or is too big to show a human in one look, is no command at all.
 */
export function argvOf(v: unknown): string[] | null {
  let argv: string[];
  if (Array.isArray(v)) {
    if (!v.every((a) => typeof a === "string")) return null;
    argv = v as string[];
  } else if (typeof v === "string") {
    const split = splitArgs(v);
    if (!split) return null;
    argv = split;
  } else return null;
  if (!argv.length || !argv[0] || argv.length > 64 || argv.some((a) => a.length > 500 || a.includes("\0"))) return null;
  return argv;
}

/** Whitespace-separated words with quotes and backslashes the way a reader expects; null for an unclosed quote. */
export function splitArgs(s: string): string[] | null {
  if (s.length > 2000) return null;
  const out: string[] = [];
  let cur = "", word = false, quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (c === "\\" && i + 1 < s.length) { cur += s[++i]; word = true; continue; }
    if (quote === '"') { if (c === '"') quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; word = true; continue; }
    if (/\s/.test(c)) { if (word) out.push(cur); cur = ""; word = false; continue; }
    cur += c; word = true;
  }
  if (quote) return null;
  if (word) out.push(cur);
  return out;
}

function submissionOf(s: Obj): Submission[] {
  const file = str(s.file, 1000), at = str(s.at, 40);
  if (!file || !at) return [];
  const out: Submission = { at, file };
  if (VERDICTS.has(s.verdict as Verdict)) out.verdict = s.verdict as Verdict;
  if (isObj(s.posted) && str(s.posted.platform, 40)) {
    const p = s.posted;
    out.posted = { platform: str(p.platform, 40), ok: p.ok === true, ...(str(p.url, 500) ? { url: str(p.url, 500) } : {}), ...(str(p.error, 1000) ? { error: str(p.error, 1000) } : {}) };
  }
  if (isObj(s.hook)) {
    const k = s.hook, argv = argvOf(k.argv);
    if (argv) out.hook = {
      argv, cwd: str(k.cwd, 1000), ran: k.ran === true,
      ...(Number.isInteger(k.exit) || k.exit === null ? { exit: k.exit as number | null } : {}),
      ...(typeof k.output === "string" ? { output: clip(k.output, 4000) } : {}),
      ...(str(k.error, 1000) ? { error: str(k.error, 1000) } : {}),
      ...(k.timed_out === true ? { timed_out: true } : {}),
    };
  }
  return [out];
}

// ---------------------------------------------------------------- holding it to the diff

/**
 * A document checked against the diff of its own head: mechanical hunks classified here by rule
 * whatever the producer said, chapters held to the guide's rules, findings on hunks that do not
 * exist dropped and lines that do not exist moved to the hunk's start. Running it twice changes nothing.
 */
export function fit(doc: Doc, files: FileDiff[]): Doc {
  const hunks = hunksOf(files), mechanical = classify(files);
  let plan: Plan;
  try { plan = doc.plan.by === "files" || !doc.plan.chapters.length ? filePlan(files, mechanical) : checkPlan(doc.plan, hunks, mechanical, doc.plan.by); }
  catch { plan = filePlan(files, mechanical); } // a plan that places no hunk of this diff is no plan
  plan = { ...plan, summary: doc.plan.summary };
  const at = new Map(hunks.map((h) => [h.id, h]));
  const findings = doc.findings.flatMap((f) => {
    const h = at.get(f.hunk)?.hunk;
    return h ? [{ ...f, line: anchorLine(h, f.side, f.line) }] : [];
  });
  const ids = new Set(findings.map((f) => f.id));
  const human: Human = { ...doc.human, visited: doc.human.visited.filter((v) => at.has(v)) };
  if (doc.human.decisions) {
    const kept = Object.fromEntries(Object.entries(doc.human.decisions).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length) human.decisions = kept; else delete human.decisions;
  }
  if (doc.human.revealed) human.revealed = doc.human.revealed.filter((v) => at.has(v));
  return { ...doc, plan, findings, human };
}

// ---------------------------------------------------------------- someone else's human layer

/** What an imported review's verdict was: shown to the reader as information, never picked for them. */
export type Suggested = { by: string; verdict: Verdict };

/**
 * A document's `human` layer belongs to whoever wrote it, and anything posted from this review is the
 * reader's own words. So a document from anywhere but the reader's own export loses its human layer
 * here: each comment becomes a finding of kind `comment` the reader triages like any other (`c`/`b`
 * adopt it as their own editable comment, `n` rejects it), and the verdict comes back separately, as
 * information. Decisions, coverage and reveals are theirs too, and are dropped. A comment on the whole
 * change is anchored at the diff's first hunk; one on a hunk this diff does not have is dropped by `fit`.
 * The findings take the producer's name as their source when every finding in the document shares one,
 * else `imported`.
 */
export function suggestions(doc: Doc, files: FileDiff[]): { doc: Doc; suggested?: Suggested } {
  const sources = new Set(doc.findings.map((f) => f.source));
  const by = sources.size === 1 ? [...sources][0]! : "imported";
  const first = hunksOf(files).find((h) => h.hunk)?.id;
  const ids = new Set(doc.findings.map((f) => f.id));
  const findings = [...doc.findings];
  let n = 0;
  for (const c of doc.human.comments) {
    const hunk = c.hunk ?? first;
    if (!hunk) continue;
    let id = `comment-${++n}`;
    while (ids.has(id)) id = `comment-${++n}`;
    ids.add(id);
    findings.push({
      id, source: by, hunk, side: c.side, line: c.line ?? 0, severity: "warn", kind: "comment",
      claim: clip(c.text, 300), evidence: c.hunk ? "A comment from an imported review." : "A comment on the whole change, from an imported review.", status: "unrefuted",
    });
  }
  const out: Doc = { ...doc, findings, human: { comments: [], visited: [] } };
  return { doc: out, ...(doc.human.verdict ? { suggested: { by, verdict: doc.human.verdict } } : {}) };
}

// ---------------------------------------------------------------- merging two

const findingKey = (f: Finding) => [f.source, f.hunk, f.side, f.line, f.claim].join("\0");
const commentKey = (c: Comment) => [c.hunk, c.side, c.line, c.text].join("\0");

/**
 * `incoming` folded into `into`, both at the same head. A finding already there (same source,
 * anchor and claim) is kept once; a new one whose id is taken gets a fresh id. The existing plan
 * stands unless it is only the by-file fallback. The reader's layer is a union; their verdict wins.
 */
export function merge(into: Doc, incoming: Doc): Doc {
  if (into.target.head !== incoming.target.head) {
    throw new Fail(`the document is for ${incoming.target.head.slice(0, 8)} but the review is at ${into.target.head.slice(0, 8)}: a document only opens against its own head`);
  }
  const byKey = new Map(into.findings.map((f) => [findingKey(f), f.id]));
  const ids = new Set(into.findings.map((f) => f.id));
  const renamed = new Map<string, string>();
  const findings = [...into.findings];
  for (const f of incoming.findings) {
    const known = byKey.get(findingKey(f));
    if (known !== undefined) { renamed.set(f.id, known); continue; }
    let id = f.id;
    for (let k = 2; ids.has(id); k++) id = `${f.id}.${k}`;
    ids.add(id); byKey.set(findingKey(f), id); renamed.set(f.id, id);
    findings.push({ ...f, id });
  }
  // Comments are copied so an existing one can take an id an incoming decision points at.
  const comments = into.human.comments.map((c) => ({ ...c }));
  const byComment = new Map(comments.map((c) => [commentKey(c), c]));
  const taken = new Set(comments.flatMap((c) => c.id ? [c.id] : []));
  const fresh = (id: string) => { let n = id; for (let k = 2; taken.has(n); k++) n = `${id}.${k}`; taken.add(n); return n; };
  const cid = new Map<string, string>(); // an incoming comment id to the id it has here
  for (const c of incoming.human.comments) {
    const known = byComment.get(commentKey(c));
    if (known) {
      if (c.id) { known.id ??= fresh(c.id); cid.set(c.id, known.id); }
      continue;
    }
    const mine = { ...c, ...(c.id ? { id: fresh(c.id) } : {}) };
    if (c.id) cid.set(c.id, mine.id!);
    byComment.set(commentKey(c), mine); comments.push(mine);
  }
  // The reader's decision here stands; an incoming one fills in only a finding not decided yet.
  const decisions: Decisions = {};
  for (const [id, v] of Object.entries(incoming.human.decisions ?? {})) {
    const comment = v.comment ? cid.get(v.comment) : undefined;
    decisions[renamed.get(id) ?? id] = { kind: v.kind, ...(v.reason ? { reason: v.reason } : {}), ...(comment ? { comment } : {}) };
  }
  Object.assign(decisions, into.human.decisions ?? {});
  const human: Human = {
    comments,
    visited: [...new Set([...into.human.visited, ...incoming.human.visited])],
  };
  if (Object.keys(decisions).length) human.decisions = decisions;
  const revealed = [...new Set([...(into.human.revealed ?? []), ...(incoming.human.revealed ?? [])])];
  if (revealed.length) human.revealed = revealed;
  const verdict = into.human.verdict ?? incoming.human.verdict;
  if (verdict) human.verdict = verdict;
  const plan = into.plan.by === "files" && incoming.plan.by !== "files" && incoming.plan.chapters.length ? incoming.plan : into.plan;
  // The newest producer's hook replaces an older one; either way submit shows it and asks before running it.
  const onSubmit = incoming.on_submit ?? into.on_submit;
  return { ...into, plan, findings, human, ...(onSubmit ? { on_submit: onSubmit } : {}) };
}
