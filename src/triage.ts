// The reader's action on each finding: block, comment or ignore. Every finding has one: until the reader picks, it is the
// default for its severity (config `[defaults]`: high blocks, medium and low comment), and a finding the refute step
// dropped defaults to ignore. There is nothing "undecided" and no undo: pressing b, c or i again changes the action.
// Pure, like nav.ts, so the rules are tested without a screen.
//
// A block or comment the reader chose is carried out as an ordinary line comment of their own, at the finding's line,
// holding whatever text they saved. It posts like any comment they typed with Enter on a line, through the same path;
// the action only remembers which comment it wrote, so changing it to ignore takes that comment away again and nothing
// stale is posted.

import { titleOf, type Finding, type Severity } from "./guide.ts";
import type { Comment, Decision, DecisionKind, Decisions, Human, Suggested, Verdict } from "./document.ts";

/** The actions, in the order the keys and the settings list them. */
export const ACTION_KINDS: readonly DecisionKind[] = ["block", "comment", "ignore"];
/** How an action reads on the screen and in the write-up. */
export const LABEL: Record<DecisionKind, string> = { block: "block", comment: "comment", ignore: "ignore" };

/** The action a finding has until the reader picks one, by severity. `[defaults]` in the config changes it. */
export type Defaults = Record<Severity, DecisionKind>;
export const DEFAULTS: Readonly<Defaults> = { high: "block", medium: "comment", low: "comment" };

/** The action a finding starts with: ignore when the refute step dropped it, else the default for its severity. */
export const defaultAction = (f: Finding, defaults: Defaults = DEFAULTS): DecisionKind => f.status === "withdrawn" ? "ignore" : defaults[f.severity];

/** A finding's action now: the one the reader chose, or its default (`isDefault`), with the private note an ignore may carry. */
export type ActionNow = { kind: DecisionKind; isDefault: boolean; note?: string };
export function actionOf(h: Pick<Human, "decisions">, f: Finding, defaults: Defaults = DEFAULTS): ActionNow {
  const d = decisionOf(h, f.id);
  if (!d) return { kind: defaultAction(f, defaults), isDefault: true };
  return { kind: d.kind, isDefault: false, ...(d.reason ? { note: d.reason } : {}) };
}
/** The action as plain text: `block`, or `block (default)` while the reader has not picked one. */
export const actionText = (a: ActionNow): string => `${LABEL[a.kind]}${a.isDefault ? " (default)" : ""}`;

/** A document from before decisions only had dismissals: each becomes ignore, unless the finding already has an action. */
export function withLegacy(decisions: Decisions, dismissals: string[]): Decisions {
  const out = { ...decisions };
  for (const id of dismissals) out[id] ??= { kind: "ignore" };
  return out;
}

export const decisionOf = (h: Pick<Human, "decisions">, id: string): Decision | undefined => h.decisions?.[id];

/** The comment a block or comment action wrote, if it is still there. */
export function linkedComment(h: Pick<Human, "comments" | "decisions">, id: string): Comment | undefined {
  const ref = decisionOf(h, id)?.comment;
  return ref ? h.comments.find((c) => c.id === ref) : undefined;
}

/** How many findings there are of each severity: what the status area shows. */
export function bySeverity(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

/**
 * The verdict submit starts from: request changes once the reader has blocked on something; otherwise no default, the
 * reader picks. A block that is only a default does not count, since it has no comment of the reader's to post.
 */
export function defaultVerdict(findings: Finding[], h: Pick<Human, "decisions">): Verdict | undefined {
  return findings.some((f) => decisionOf(h, f.id)?.kind === "block") ? "request_changes" : undefined;
}

/**
 * The submit preview's list of every finding with its action, so what the review says about each is seen before
 * anything posts. `hidden`: blind chapters still hold findings back. Empty when there are no findings.
 */
export function actionsNote(findings: Finding[], h: Pick<Human, "decisions">, place: (hunk: string, line: number | null) => string, defaults: Defaults = DEFAULTS, hidden = false, note = ""): string {
  if (!findings.length && !hidden) return "";
  const out = [`── Findings (${findings.length})`, ""];
  if (note) out.splice(1, 0, note);
  for (const f of findings) out.push(`▲ ${place(f.hunk, f.file ? null : f.line)}${f.file ? " (whole file)" : ""} · ${f.severity} · ${actionText(actionOf(h, f, defaults))} · ${titleOf(f)}`);
  if (findings.length) out.push("", "What posts is the comments you saved with b or c; a finding on its default action posts nothing.");
  if (hidden) out.push("Chapters you have not read yet still hide their findings.");
  return out.join("\n") + "\n\n";
}

const freshId = (comments: Comment[]) => {
  const taken = new Set(comments.map((c) => c.id));
  let n = comments.length + 1;
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
};

/**
 * The reader's layer with `kind` as `f`'s action. Block and comment need the text the reader saved:
 * the comment the action wrote before is rewritten in place, or a new one is made at the finding's
 * line. Ignore removes that comment, since it would otherwise still post, and keeps the optional private note.
 */
export function decide(h: Human, f: Finding, kind: DecisionKind, input: { text?: string; reason?: string; at: string }): Human {
  const prior = linkedComment(h, f.id);
  let comments = h.comments, decision: Decision;
  if (kind === "block" || kind === "comment") {
    const text = input.text?.trim();
    if (!text) throw new Error("a block or comment action needs the comment's text");
    if (prior) {
      comments = comments.map((c) => c === prior ? { ...c, text } : c);
      decision = { kind, comment: prior.id! };
    } else {
      const id = freshId(comments);
      comments = [...comments, f.file ? { id, hunk: f.hunk, side: f.side, line: null, text, at: input.at, file: true } : { id, hunk: f.hunk, side: f.side, line: f.line, text, at: input.at }];
      decision = { kind, comment: id };
    }
  } else {
    comments = prior ? comments.filter((c) => c !== prior) : comments;
    const reason = input.reason?.trim();
    decision = { kind, ...(reason ? { reason } : {}) };
  }
  return { ...h, comments, decisions: { ...h.decisions, [f.id]: decision } };
}

/** Who the in-house guide/critic review signs its suggestion as. */
export const IN_HOUSE = "prview";

/**
 * The verdict the in-house review's findings point to, by rule and not by a model: anything high means request
 * changes, else anything medium means comment, else approve. Findings the refute step dropped never count.
 * Information only: nothing starts from it and nothing posts it.
 */
export function suggestVerdict(findings: Finding[]): Suggested {
  const live = findings.filter((f) => f.status !== "withdrawn");
  for (const [severity, verdict] of [["high", "request_changes"], ["medium", "comment"]] as const) {
    const hit = live.filter((f) => f.severity === severity);
    if (hit.length) return { by: IN_HOUSE, verdict, reason: `${hit.length} ${severity}: ${hit.slice(0, 2).map(titleOf).join("; ")}${hit.length > 2 ? "; …" : ""}` };
  }
  return { by: IN_HOUSE, verdict: "approve", reason: live.length ? `only ${live.length === 1 ? "a low finding" : `${live.length} low findings`}` : "no findings" };
}

/** The submit picker's hint line: every suggestion, marked as information. Empty when there are none. */
export function suggestionHint(suggested: Suggested[], label: (v: Verdict) => string): string {
  if (!suggested.length) return "";
  return `suggested, information only: ${suggested.map((s) => `${s.by === "imported" ? "imported" : s.by} ${label(s.verdict)}`).join(", ")}`;
}
