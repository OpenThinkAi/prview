// The model half of prview, minus the calls themselves: everything here is pure so it can be tested.
//
// Three roles, each a prompt and a parser:
//   guide   orders the hunks into chapters a human should read in sequence, and names each one
//   critic  raises findings anchored to a line of a hunk
//   refute  looks at one finding again, with more of the file, and upholds or withdraws it
// Mechanical hunks (whitespace, lock files, pure moves) are classified here by rule, never by the
// model: a model saying "skip this" is exactly where a bug would hide.

import type { FileDiff, Hunk } from "./diff.ts";

export type Chapter = { title: string; intent: string; hunks: string[] };
export type Mechanical = { id: string; why: string };
export type Plan = { summary: string; chapters: Chapter[]; mechanical: Mechanical[]; by: "guide" | "files" };
export type Severity = "blocking" | "warn" | "nit";
export type Finding = {
  id: number; hunk: string; side: "new" | "old"; line: number; severity: Severity; kind: string;
  claim: string; evidence: string; status: "upheld" | "withdrawn" | "unrefuted"; refute?: string;
};

/** A hunk's id is stable for as long as the head is: the file plus where it starts on each side. */
export const hunkId = (f: FileDiff, h: Hunk) => `${f.path}@${h.oldStart}:${h.newStart}`;
/** A file with no hunks (a pure rename, a binary) is one entry too. */
export const fileId = (f: FileDiff) => `${f.path}@file`;

export type HunkAt = { id: string; file: FileDiff; hunk: Hunk | null };
export function hunksOf(files: FileDiff[]): HunkAt[] {
  return files.flatMap((f): HunkAt[] => f.hunks.length ? f.hunks.map((h) => ({ id: hunkId(f, h), file: f, hunk: h })) : [{ id: fileId(f), file: f, hunk: null }]);
}

// ---------------------------------------------------------------- mechanical, by rule

const LOCK = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock|flake\.lock)$/;
const GENERATED = /(^|\/)(dist|build|generated|__snapshots__|vendor)\/|\.(snap|min\.js|min\.css|pb\.go|pb\.rs|generated\.ts)$/;
const squash = (s: string) => s.replace(/\s+/g, "");
const changed = (h: Hunk, t: "+" | "-") => h.lines.filter((l) => l.t === t).map((l) => l.text);
const meaningful = (s: string) => squash(s).length >= 8; // a brace or a blank proves nothing about a move

export function classify(files: FileDiff[]): Mechanical[] {
  const all = hunksOf(files);
  const added = new Map<string, number>(), removed = new Map<string, number>();
  const count = (m: Map<string, number>, s: string) => m.set(s, (m.get(s) ?? 0) + 1);
  for (const { hunk } of all) if (hunk) { for (const l of changed(hunk, "+")) count(added, squash(l)); for (const l of changed(hunk, "-")) count(removed, squash(l)); }

  const out: Mechanical[] = [];
  for (const { id, file, hunk } of all) {
    if (!hunk) { out.push({ id, why: file.binary ? "binary" : file.status === "renamed" ? "renamed, contents unchanged" : "no text changes" }); continue; }
    if (LOCK.test(file.path)) { out.push({ id, why: "lock file" }); continue; }
    if (GENERATED.test(file.path)) { out.push({ id, why: "generated" }); continue; }
    const plus = changed(hunk, "+"), minus = changed(hunk, "-");
    const same = (a: string[], b: string[]) => a.length === b.length && a.map(squash).join("\n") === b.map(squash).join("\n");
    if (plus.length && minus.length && same(plus, minus)) { out.push({ id, why: "whitespace only" }); continue; }
    // A pure move: every line removed here was added somewhere in this diff (or the reverse), and
    // there is enough of it that a coincidence is unlikely.
    const elsewhere = (mine: string[], other: Map<string, number>) => mine.filter(meaningful).length >= 3 && mine.filter(meaningful).every((l) => (other.get(squash(l)) ?? 0) > 0);
    if (!plus.length && elsewhere(minus, added)) { out.push({ id, why: "moved away: these lines are added elsewhere in the diff" }); continue; }
    if (!minus.length && elsewhere(plus, removed)) { out.push({ id, why: "moved here: these lines are removed elsewhere in the diff" }); continue; }
  }
  return out;
}

// ---------------------------------------------------------------- the guide

const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

function hunkText(h: Hunk, max = 60): string {
  const lines = h.lines.map((l) => `${l.t}${l.text}`);
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}

export const GUIDE_SYSTEM = `You prepare a code change so a human can review it well. You do not review it yourself.
You are given a pull request and its hunks, each with an id. Arrange the hunks into chapters in the order a careful reader should take them: the heart of the change first (the new type, the changed rule, the fix), then what depends on it (callers, wiring, config), then the tests last, in a chapter called "Proof". A chapter may mix files. Aim for 2 to 6 chapters; a small change may be one.
Every hunk id you were given must appear in exactly one chapter. Never invent ids.
Reply with JSON only, no prose around it:
{"summary": "2-4 plain sentences: what this change does, and the one thing the reviewer should keep in mind while reading",
 "chapters": [{"title": "at most 5 words", "intent": "one sentence: what the reader should verify here", "hunks": ["id", ...]}]}`;

export function guidePrompt(src: { title: string; body: string }, hunks: HunkAt[], mechanical: Mechanical[]): string {
  const skip = new Set(mechanical.map((m) => m.id));
  const parts = hunks.filter((h) => !skip.has(h.id) && h.hunk).map(({ id, file, hunk }) =>
    `### ${id}\n${file.path}${hunk!.context ? ` · ${hunk!.context.trim()}` : ""} · +${changed(hunk!, "+").length} −${changed(hunk!, "-").length}\n${hunkText(hunk!)}`);
  return `# ${src.title}\n\n${clip(src.body.trim(), 1500) || "(no description)"}\n\n# Hunks\n\n${parts.join("\n\n")}`;
}

/** Salvage JSON from a model reply that may have wrapped it in a fence or a sentence. */
export function jsonIn(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch {}
  const a = Math.min(...[t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0)), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a === Infinity || b < a) throw new Error(`no JSON in the reply: ${clip(t, 120)}`);
  return JSON.parse(t.slice(a, b + 1));
}

/** The guide's answer checked against the hunks: unknown ids dropped, repeats kept once, strays collected. */
export function parseGuide(reply: string, hunks: HunkAt[], mechanical: Mechanical[]): Plan {
  const j = jsonIn(reply) as { summary?: unknown; chapters?: unknown };
  const skip = new Set(mechanical.map((m) => m.id));
  const want = new Set(hunks.filter((h) => !skip.has(h.id)).map((h) => h.id));
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  for (const c of Array.isArray(j.chapters) ? j.chapters as any[] : []) {
    const ids = (Array.isArray(c?.hunks) ? c.hunks as unknown[] : []).filter((x): x is string => typeof x === "string" && want.has(x) && !seen.has(x) && !!seen.add(x));
    if (ids.length) chapters.push({ title: clip(String(c.title ?? "Untitled").trim(), 60), intent: clip(String(c.intent ?? "").trim(), 300), hunks: ids });
  }
  const strays = [...want].filter((id) => !seen.has(id));
  if (strays.length) chapters.push({ title: chapters.length ? "Also changed" : "The change", intent: chapters.length ? "Hunks the guide did not place; read them too." : "", hunks: strays });
  if (!chapters.length) throw new Error("the guide placed no hunks");
  return { summary: clip(String(j.summary ?? "").trim(), 800), chapters, mechanical, by: "guide" };
}

/** With no guide (or a failed one): a chapter per file, in git's order. */
export function filePlan(files: FileDiff[], mechanical: Mechanical[]): Plan {
  const skip = new Set(mechanical.map((m) => m.id));
  const chapters = files.flatMap((f) => {
    const ids = f.hunks.map((h) => hunkId(f, h)).filter((id) => !skip.has(id));
    return ids.length ? [{ title: f.path, intent: "", hunks: ids }] : [];
  });
  return { summary: "", chapters, mechanical, by: "files" };
}

// ---------------------------------------------------------------- the critic

export const CRITIC_SYSTEM = `You are a senior engineer reviewing one chapter of a code change for a colleague who will make the final call. Raise only what you would stake your name on in a real review: bugs, wrong logic, unhandled cases, security holes, broken or missing tests, a design that will hurt. No style, no praise, no restating the diff.
Each hunk is shown with line numbers: "n123" is line 123 of the new file, "o120" is line 120 of the old file. Anchor every finding to one of those lines, in the hunk it belongs to.
Reply with JSON only: an array (empty if nothing is wrong) of at most 4 objects:
[{"hunk": "the hunk id", "side": "new" or "old", "line": 123, "severity": "blocking" or "warn" or "nit", "kind": "bug|security|correctness|design|test|perf", "claim": "one sentence, what is wrong", "evidence": "at most two sentences, why, concretely"}]
"blocking" means you would not merge until it is fixed. If you are not sure, leave it out.`;

export function numbered(h: Hunk): string {
  return h.lines.map((l) => `${l.t === "-" ? `o${l.o}` : `n${l.n}`}`.padEnd(6) + `${l.t}${l.text}`).join("\n");
}

export function criticPrompt(src: { title: string }, chapter: Chapter, hunks: HunkAt[]): string {
  const at = new Map(hunks.map((h) => [h.id, h]));
  const parts = chapter.hunks.flatMap((id) => {
    const h = at.get(id); if (!h?.hunk) return [];
    return [`### ${id}\n${h.file.path}${h.hunk.context ? ` · ${h.hunk.context.trim()}` : ""}\n${numbered(h.hunk)}`];
  });
  return `# ${src.title}\n\n## Chapter: ${chapter.title}\n${chapter.intent}\n\n${parts.join("\n\n")}`;
}

const SEV = new Set<Severity>(["blocking", "warn", "nit"]);
export function parseCritic(reply: string, chapter: Chapter, hunks: HunkAt[], firstId: number): Finding[] {
  const j = jsonIn(reply);
  const at = new Map(hunks.map((h) => [h.id, h]));
  const out: Finding[] = [];
  for (const f of Array.isArray(j) ? j as any[] : []) {
    const h = typeof f?.hunk === "string" ? at.get(f.hunk) : undefined;
    if (!h?.hunk || !chapter.hunks.includes(h.id)) continue;
    const side = f.side === "old" ? "old" : "new", line = Number(f.line);
    const has = h.hunk.lines.some((l) => (side === "new" ? l.n : l.o) === line);
    const claim = String(f.claim ?? "").trim();
    if (!claim) continue;
    out.push({
      id: firstId + out.length, hunk: h.id, side, line: has ? line : (side === "new" ? h.hunk.newStart : h.hunk.oldStart),
      severity: SEV.has(f.severity) ? f.severity : "warn", kind: String(f.kind ?? "correctness").trim().toLowerCase(),
      claim: clip(claim, 300), evidence: clip(String(f.evidence ?? "").trim(), 500), status: "unrefuted",
    });
  }
  return out;
}

// ---------------------------------------------------------------- refute

export const REFUTE_SYSTEM = `A reviewer raised a finding on a code change. You get the finding, the hunk it points at, and more of the file as it is after the change. Decide whether the finding holds. Try to knock it down: check whether the case it names is already handled nearby, whether the claim misreads the code, whether it is a matter of taste dressed up as a bug.
Reply with JSON only: {"verdict": "uphold" or "withdraw" or "downgrade", "reason": "one or two sentences"}
"downgrade" means real but overstated: keep it at a lower severity.`;

export function refutePrompt(f: Finding, hunk: Hunk, fileText: string | null): string {
  let around = "(file not available)";
  if (fileText !== null && f.side === "new") {
    const lines = fileText.split("\n"), a = Math.max(0, f.line - 40), b = Math.min(lines.length, f.line + 40);
    around = lines.slice(a, b).map((l, i) => `${String(a + i + 1).padStart(5)}  ${l}`).join("\n");
  }
  return `# Finding\n${f.severity} · ${f.kind} · ${f.side} line ${f.line}\n${f.claim}\n${f.evidence}\n\n# Hunk ${f.hunk}\n${numbered(hunk)}\n\n# The file after the change, around the line\n${around}`;
}

export function applyRefute(f: Finding, reply: string): Finding {
  let j: { verdict?: unknown; reason?: unknown };
  try { j = jsonIn(reply) as typeof j; } catch { j = { verdict: "uphold", reason: reply }; } // an unparseable second look changes nothing
  const reason = clip(String(j.reason ?? "").trim(), 300);
  if (j.verdict === "withdraw") return { ...f, status: "withdrawn", refute: reason };
  if (j.verdict === "downgrade") return { ...f, status: "upheld", refute: reason, severity: f.severity === "blocking" ? "warn" : "nit" };
  return { ...f, status: "upheld", refute: reason };
}
