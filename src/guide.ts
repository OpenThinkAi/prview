// The model half of prview, minus the calls themselves: everything here is pure so it can be tested.
//
// Three roles, each a prompt and a parser:
//   guide   orders the hunks into chapters a human should read in sequence, and names each one
//   critic  raises findings anchored to a line of a hunk
//   refute  looks at one finding again, with more of the file, and upholds or withdraws it
// Mechanical hunks (whitespace, lock files, pure moves) are classified here by rule, never by the
// model: a model saying "skip this" is exactly where a bug would hide.

import type { FileDiff, Hunk } from "./diff.ts";

/** `intent` is the one line shown with every hunk of the chapter; `why` is the paragraph behind `?`. */
export type Chapter = { title: string; intent: string; why: string; hunks: string[] };
export type Mechanical = { id: string; why: string };
/** `by` names who ordered the chapters: "files" is the rule-based fallback (a chapter per file). */
export type Plan = { summary: string; chapters: Chapter[]; mechanical: Mechanical[]; by: string };
export type Severity = "blocking" | "warn" | "nit";
/** `source` is the producer that raised it, set by that producer; it is shown, never branched on. */
export type Finding = {
  id: string; source: string; hunk: string; side: "new" | "old"; line: number; severity: Severity; kind: string;
  claim: string; evidence: string; status: "upheld" | "withdrawn" | "unrefuted"; refute?: string;
  /** How many of the critic's runs raised this finding. Absent on reviews saved before sampling. */
  votes?: number;
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

export const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

function hunkText(h: Hunk, max = 60): string {
  const lines = h.lines.map((l) => `${l.t}${l.text}`);
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n") : lines.join("\n");
}

export const GUIDE_SYSTEM = `You prepare a code change so a human can review it well. You do not review it yourself.
You are given a pull request and its hunks, each with an id. Arrange the hunks into chapters in the order a careful reader should take them: the heart of the change first (the new type, the changed rule, the fix), then what depends on it (callers, wiring, config), then the tests last, in a chapter called "Proof". A chapter may mix files. Aim for 2 to 6 chapters; a small change may be one.
Every hunk id you were given must appear in exactly one chapter. Never invent ids.
Reply with JSON only, no prose around it:
{"summary": "at most two short sentences: what this change does, and the one thing to keep in mind while reading",
 "chapters": [{"title": "at most 5 words",
               "check": "at most 12 words: the one concrete thing to check in these hunks",
               "why": "one or two sentences: what goes wrong if that check fails, or what makes it subtle",
               "hunks": ["id", ...]}]}
The "check" is the line the reader sees above every hunk of the chapter, so it must earn its place:
- Name the thing to look at: a function, field, flag, file, rule or case from these hunks.
- Say what must hold for it, in one clause. Count the words; 12 is the hard limit.
- Do not reword the chapter title or the pull request title; say what to look for, not what changed.
Good: "Seeding runs once per millisecond, only for dated intents" · "Every caller of open_store passes the new floor" · "Expired tokens return 404, never 401" · "The test fails on the old parse_range".
Bad: "Verify that the changes are correct" (says nothing) · "Adds hub login" (restates the title) · "Check the token is stored and the URL is validated and errors are handled" (a list, too long).`;

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

/**
 * Something the parser had to shorten, kept with what the guide actually said so it can be asked
 * once to say it shorter itself: a cut made by the model reads better than one made by a word count.
 */
export type Cut = { at: "summary" } | { at: "chapter"; index: number; title: string; said: string; why: string };

/** The guide's answer checked against the hunks: unknown ids dropped, repeats kept once, strays collected. */
export function parseGuide(reply: string, hunks: HunkAt[], mechanical: Mechanical[]): Plan {
  return readGuide(reply, hunks, mechanical).plan;
}

/** parseGuide, plus the list of lines it had to cut to fit (see Cut). */
export function readGuide(reply: string, hunks: HunkAt[], mechanical: Mechanical[]): { plan: Plan; cuts: Cut[]; summarySaid: string } {
  return readPlan(jsonIn(reply) as object, hunks, mechanical, "guide");
}

/** Any producer's chapters, held to the same rules as the guide's: a document's plan goes through here too. */
export function checkPlan(j: { summary?: unknown; chapters?: unknown }, hunks: HunkAt[], mechanical: Mechanical[], by: string): Plan {
  return readPlan(j, hunks, mechanical, by).plan;
}

function readPlan(j: { summary?: unknown; chapters?: unknown }, hunks: HunkAt[], mechanical: Mechanical[], by: string): { plan: Plan; cuts: Cut[]; summarySaid: string } {
  const skip = new Set(mechanical.map((m) => m.id));
  const want = new Set(hunks.filter((h) => !skip.has(h.id)).map((h) => h.id));
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  const cuts: Cut[] = [];
  for (const c of Array.isArray(j.chapters) ? j.chapters as any[] : []) {
    const ids = (Array.isArray(c?.hunks) ? c.hunks as unknown[] : []).filter((x): x is string => typeof x === "string" && want.has(x) && !seen.has(x) && !!seen.add(x));
    if (!ids.length) continue;
    const said = String(c.check ?? c.intent ?? ""), line = fitLine(said);
    const chapter = { title: clip(String(c.title ?? "Untitled").trim(), 60), intent: line.text, why: clip(String(c.why ?? "").trim(), 400), hunks: ids };
    if (line.cut) cuts.push({ at: "chapter", index: chapters.length, title: chapter.title, said: said.trim(), why: chapter.why });
    chapters.push(chapter);
  }
  const strays = [...want].filter((id) => !seen.has(id));
  if (strays.length) chapters.push({ title: chapters.length ? "Also changed" : "The change", intent: chapters.length ? "Hunks the guide did not place" : "", why: chapters.length ? "The guide left these out of every chapter; read them too." : "", hunks: strays });
  if (!chapters.length) throw new Error("the guide placed no hunks");
  const summarySaid = String(j.summary ?? "").trim(), summary = twoSentences(summarySaid);
  if (summary.cut) cuts.unshift({ at: "summary" });
  return { plan: { summary: summary.text, chapters, mechanical, by }, cuts, summarySaid };
}

/** The guide's one-liner, held to one line: no "verify that", no trailing period, at most 12 words. */
export function oneLine(s: string): string {
  return fitLine(s).text;
}

/** oneLine, saying whether it had to drop words (a leading "verify that" is not a cut; it is noise). */
export function fitLine(s: string): { text: string; cut: boolean } {
  const t = s.trim().replace(/^(please )?(verify|check|confirm|ensure|make sure)( that)?\s+/i, "").replace(/[.\s]+$/, "");
  const words = t.split(/\s+/).filter(Boolean);
  const cut = words.length > 12;
  const out = cut ? words.slice(0, 12).join(" ") + "…" : words.join(" ");
  // Capitalise a plain word only: "buildClient" or "apply_doc" is a name, and a capital breaks it.
  return { text: /^[a-z]+(\s|…|$)/.test(out) ? out[0]!.toUpperCase() + out.slice(1) : out, cut };
}

/**
 * The summary, held to two sentences and 50 words. It sits above the whole review, so a third
 * sentence is where the guide starts reviewing instead of orienting.
 */
export function twoSentences(s: string): { text: string; cut: boolean } {
  const t = s.trim().replace(/\s+/g, " ");
  // A sentence ends at . ! or ? followed by a space and a capital; "e.g. foo" or "v1.2" do not split.
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/).filter(Boolean);
  let text = sentences.slice(0, 2).join(" "), cut = sentences.length > 2;
  const words = text.split(" ").filter(Boolean);
  if (words.length > 50) { text = words.slice(0, 50).join(" ") + "…"; cut = true; }
  return { text, cut };
}

export const REASK_SYSTEM = `You wrote a reading guide for a code change, but some lines were too long and had to be cut. Rewrite only those lines, keeping their meaning.
A "check" is at most 12 words, one clause, and names the concrete thing to look at (a function, field, flag, rule or case). A summary is at most two short sentences.
Reply with JSON only: {"summary": "only if asked", "chapters": [{"n": 1, "check": "..."}]}`;

/** The one follow-up after a cut: just the lines that were too long, with enough around them to rewrite them. */
export function reaskPrompt(title: string, cuts: Cut[], summarySaid: string): string {
  const parts = cuts.map((c) => c.at === "summary"
    ? `## summary (too long)\n${summarySaid}`
    : `## chapter n=${c.index + 1}: ${c.title}\ncheck (too long): ${c.said}\nwhy: ${c.why}`);
  return `# ${title}\n\n${parts.join("\n\n")}`;
}

/** Apply the rewritten lines where they now fit; anything still too long, or missing, keeps the cut version. */
export function applyReask(plan: Plan, cuts: Cut[], reply: string): Plan {
  let j: { summary?: unknown; chapters?: unknown };
  try { j = jsonIn(reply) as typeof j; } catch { return plan; } // a failed retry leaves the first answer standing
  const asked = new Set(cuts.flatMap((c) => c.at === "chapter" ? [c.index] : []));
  const chapters = plan.chapters.map((c) => ({ ...c }));
  for (const r of Array.isArray(j.chapters) ? j.chapters as any[] : []) {
    const i = Number(r?.n) - 1;
    if (!asked.has(i) || !chapters[i]) continue;
    const line = fitLine(String(r.check ?? ""));
    if (line.text && !line.cut) chapters[i]!.intent = line.text;
  }
  let summary = plan.summary;
  if (cuts.some((c) => c.at === "summary") && typeof j.summary === "string") {
    const s = twoSentences(j.summary);
    if (s.text && !s.cut) summary = s.text;
  }
  return { ...plan, summary, chapters };
}

/**
 * The intent shown for mechanical hunks. They were classified by rule, so the guide never names them;
 * the one thing worth checking is that the rule was right.
 */
export const MECHANICAL_INTENT = "Skim for a behaviour change the rule may have missed";

// ---------------------------------------------------------------- the intent rubric

// Words that say nothing about what to look at: an intent made only of these is vague.
const VAGUE = new Set(("a an the this that these those it its is are be been being was were to of in on for with as by and or " +
  "all any every each everything nothing new old changes change changed code logic correct correctly works work working " +
  "properly proper handled handles handle behaves behaviour behavior functionality implementation implemented updated update " +
  "updates fine expected good right still now here there used using also no not tests test pass passes passing").split(" "));
const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, " ").split(/\s+/).filter(Boolean);
const content = (s: string) => tokens(s).filter((w) => !VAGUE.has(w));

/**
 * Why an intent fails the rubric (empty when it passes). The rubric is the ticket's: at most 12
 * words, names a concrete thing to check, no "verify that", not a restatement of the title. The
 * checks are heuristics meant for an eval, not a gate on the review: a failing intent is still shown.
 */
export function rubric(intent: string, title: string): string[] {
  const fails: string[] = [];
  const t = intent.trim();
  if (!t) return ["empty"];
  if (t.split(/\s+/).length > 12 || t.endsWith("…")) fails.push("over 12 words");
  if (/\b(verify|make sure|ensure)( that)?\b|^(check|confirm)( that)?\s/i.test(t)) fails.push("says verify that");
  // Concrete: code-shaped (an identifier, a path, a flag, a number) or at least two words that carry meaning.
  const code = /`|\w[_.:/]\w|\w\(|--?\w|[a-z][A-Z]|\d/.test(t);
  const mine = content(t);
  if (!code && mine.length < 2) fails.push("names nothing concrete");
  // A restatement: nearly every meaningful word of the intent is already in the title.
  const theirs = new Set(content(title));
  if (mine.length && theirs.size && mine.filter((w) => theirs.has(w)).length / mine.length >= 0.75) fails.push("restates the title");
  return fails;
}

/** With no guide (or a failed one): a chapter per file, in git's order. */
export function filePlan(files: FileDiff[], mechanical: Mechanical[]): Plan {
  const skip = new Set(mechanical.map((m) => m.id));
  const chapters = files.flatMap((f) => {
    const ids = f.hunks.map((h) => hunkId(f, h)).filter((id) => !skip.has(id));
    return ids.length ? [{ title: f.path, intent: "", why: "", hunks: ids }] : [];
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
  return `# ${src.title}\n\n## Chapter: ${chapter.title}\n${chapter.intent}. ${chapter.why}\n\n${parts.join("\n\n")}`;
}

export const SEVERITIES = new Set<Severity>(["blocking", "warn", "nit"]);

/** A finding's line if the hunk shows it on that side; otherwise the hunk's first line on that side. */
export function anchorLine(h: Hunk, side: "new" | "old", line: number): number {
  return h.lines.some((l) => (side === "new" ? l.n : l.o) === line) ? line : side === "new" ? h.newStart : h.oldStart;
}

export function parseCritic(reply: string, chapter: Chapter, hunks: HunkAt[], firstId: number): Finding[] {
  const j = jsonIn(reply);
  const at = new Map(hunks.map((h) => [h.id, h]));
  const out: Finding[] = [];
  for (const f of Array.isArray(j) ? j as any[] : []) {
    const h = typeof f?.hunk === "string" ? at.get(f.hunk) : undefined;
    if (!h?.hunk || !chapter.hunks.includes(h.id)) continue;
    const side = f.side === "old" ? "old" : "new";
    const claim = String(f.claim ?? "").trim();
    if (!claim) continue;
    out.push({
      id: String(firstId + out.length), source: "critic", hunk: h.id, side, line: anchorLine(h.hunk, side, Number(f.line)),
      severity: SEVERITIES.has(f.severity) ? f.severity : "warn", kind: String(f.kind ?? "correctness").trim().toLowerCase(),
      claim: clip(claim, 300), evidence: clip(String(f.evidence ?? "").trim(), 500), status: "unrefuted",
    });
  }
  return out;
}

// ---------------------------------------------------------------- sampling

const RANK: Record<Severity, number> = { blocking: 0, warn: 1, nit: 2 };
/** Worst first, then the most-agreed-on: the order the gutter and the counts should read in. */
export const worstFirst = (a: Finding, b: Finding) => RANK[a.severity] - RANK[b.severity] || (b.votes ?? 1) - (a.votes ?? 1);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter(Boolean));
/** The same claim in different words: identical once normalised, or at least half the words shared. */
export function sameClaim(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.5;
}

/**
 * The critic's runs on one chapter folded into one list. Two findings are the same when they sit on the
 * same hunk and side, within two lines of each other, and say the same thing: a model rarely lands on
 * the exact line twice, so an exact anchor match would count one bug as several. A run counts once per
 * finding however many of its own findings match. Severity is the one most runs gave (ties go to the
 * worse), so one run's overreach cannot promote a finding by itself.
 */
export function mergeFindings(runs: Finding[][], firstId: number): Finding[] {
  type Group = { first: Finding; from: Set<number>; sev: Severity[] };
  const groups: Group[] = [];
  runs.forEach((run, r) => {
    for (const f of run) {
      const g = groups.find((g) => g.first.hunk === f.hunk && g.first.side === f.side && Math.abs(g.first.line - f.line) <= 2 && sameClaim(g.first.claim, f.claim));
      if (g) { g.from.add(r); g.sev.push(f.severity); } else groups.push({ first: f, from: new Set([r]), sev: [f.severity] });
    }
  });
  return groups.map((g) => {
    const count = (s: Severity) => g.sev.filter((x) => x === s).length;
    const severity = (["blocking", "warn", "nit"] as Severity[]).reduce((best, s) => count(s) > count(best) ? s : best);
    return { ...g.first, severity, votes: g.from.size };
  }).sort(worstFirst).map((f, i) => ({ ...f, id: String(firstId + i) }));
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
