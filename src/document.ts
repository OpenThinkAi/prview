// The review document, `prview-review/1`: the one thing every producer writes and every consumer
// reads. The in-house guide and critic write one; so can any other reviewer, and prview never asks
// which. The only trace of a producer is the `source` on each finding, kept for attribution.
//
// Everything here is pure. A document from outside is untrusted input: parsing drops what does not
// fit rather than failing, and `fit` holds it to the diff it claims to describe (mechanical hunks by
// rule, chapters and findings anchored to hunks that exist). The document is anchored on its head
// commit; it never merges with, or opens against, another head.

import type { FileDiff } from "./diff.ts";
import { anchorLine, checkPlan, classify, clip, filePlan, hunksOf, SEVERITIES, type Chapter, type Finding, type Mechanical, type Plan, type Severity } from "./guide.ts";

export const SCHEMA = "prview-review/1";

/** A mistake by the caller (or in a document they handed us): printed without a stack trace. */
export class Fail extends Error {}

export type Verdict = "approve" | "request_changes" | "comment";
export type Target = { repo: string; base: string; head: string; url?: string; platform?: string; title: string; body: string; label: string };
export type Comment = { hunk: string | null; side: "new" | "old"; line: number | null; text: string; at: string };
export type Human = { comments: Comment[]; dismissals: string[]; visited: string[]; verdict?: Verdict };
/**
 * Reserved: a producer's command to run after submit. A document can come from anyone, so a command
 * it names is never kept silently; it is dropped on read until submission can show it and ask first.
 */
export type OnSubmit = { run: string[] };
export type Doc = { schema: typeof SCHEMA; target: Target; plan: Plan; findings: Finding[]; human: Human; on_submit?: OnSubmit };

export const blank = (target: Target): Doc => ({
  schema: SCHEMA, target, plan: { summary: "", chapters: [], mechanical: [], by: "files" }, findings: [], human: { comments: [], dismissals: [], visited: [] },
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
    const claim = str(f.claim, 300), line = Number(f.line);
    if (typeof f.hunk !== "string" || !claim || !Number.isInteger(line)) continue;
    // Ids only have to be unique within the document; a repeat or a missing one gets a fresh id.
    let id = typeof f.id === "string" || typeof f.id === "number" ? clip(String(f.id), 80) : `f${findings.length}`;
    for (let k = 2; ids.has(id); k++) id = `${String(f.id ?? "f")}.${k}`;
    ids.add(id);
    findings.push({
      id, source: str(f.source, 40) || "unknown", hunk: f.hunk, side: side(f.side), line,
      severity: SEVERITIES.has(f.severity as Severity) ? f.severity as Severity : "warn", kind: str(f.kind, 30).toLowerCase() || "finding",
      claim, evidence: str(f.evidence, 500), status: STATUSES.has(f.status as Finding["status"]) ? f.status as Finding["status"] : "unrefuted",
      ...(str(f.refute, 300) ? { refute: str(f.refute, 300) } : {}),
      // Only a producer that ran a reviewer several times has votes; anything else is left unset.
      ...(Number.isInteger(f.votes) && (f.votes as number) >= 1 && (f.votes as number) <= 99 ? { votes: f.votes as number } : {}),
    });
  }

  const h = isObj(j.human) ? j.human : {};
  const human: Human = {
    comments: arr(h.comments).filter(isObj).flatMap((c): Comment[] => {
      const text = str(c.text, 5000);
      if (!text) return [];
      return [{ hunk: typeof c.hunk === "string" ? c.hunk : null, side: side(c.side), line: Number.isInteger(c.line) ? c.line as number : null, text, at: str(c.at, 40) }];
    }),
    dismissals: arr(h.dismissals).map(String).filter((d) => ids.has(d)),
    visited: arr(h.visited).filter((v): v is string => typeof v === "string"),
  };
  if (VERDICTS.has(h.verdict as Verdict)) human.verdict = h.verdict as Verdict;

  // `on_submit` is deliberately not read (see OnSubmit).
  return { schema: SCHEMA, target, plan, findings, human };
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
  const human = { ...doc.human, dismissals: doc.human.dismissals.filter((d) => ids.has(d)), visited: doc.human.visited.filter((v) => at.has(v)) };
  return { ...doc, plan, findings, human };
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
  const seen = new Set(into.human.comments.map(commentKey));
  const comments = [...into.human.comments];
  for (const c of incoming.human.comments) {
    if (seen.has(commentKey(c))) continue;
    seen.add(commentKey(c)); comments.push(c);
  }
  const human: Human = {
    comments,
    dismissals: [...new Set([...into.human.dismissals, ...incoming.human.dismissals.map((d) => renamed.get(d) ?? d)])],
    visited: [...new Set([...into.human.visited, ...incoming.human.visited])],
  };
  const verdict = into.human.verdict ?? incoming.human.verdict;
  if (verdict) human.verdict = verdict;
  const plan = into.plan.by === "files" && incoming.plan.by !== "files" && incoming.plan.chapters.length ? incoming.plan : into.plan;
  return { ...into, plan, findings, human };
}
