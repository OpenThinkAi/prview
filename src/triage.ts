// Deciding on findings, one key each: block on it, comment, not an issue, undo. Pure, like
// nav.ts, so the rules are tested without a screen.
//
// A block or comment decision is carried out as an ordinary line comment of the reader's own, at the
// finding's line, holding whatever text they saved. It posts like any comment they typed with `n`,
// through the same path; the decision only remembers which comment it wrote, so undoing it or
// changing it to "not an issue" takes that comment away again and nothing stale is posted.

import { titleOf, type Finding } from "./guide.ts";
import type { Comment, Decision, DecisionKind, Decisions, Human, Verdict } from "./document.ts";
import { spotsOf, type At, type NavItem } from "./nav.ts";

/** How a decision reads on the screen and in the write-up. */
export const LABEL: Record<DecisionKind, string> = { block: "blocking", comment: "comment", dismissed: "not an issue" };

/** A document from before decisions only had dismissals: each becomes "not an issue", unless the finding is already decided. */
export function withLegacy(decisions: Decisions, dismissals: string[]): Decisions {
  const out = { ...decisions };
  for (const id of dismissals) out[id] ??= { kind: "dismissed" };
  return out;
}

export const decisionOf = (h: Pick<Human, "decisions">, id: string): Decision | undefined => h.decisions?.[id];

/** The comment a block or comment decision wrote, if it is still there. */
export function linkedComment(h: Pick<Human, "comments" | "decisions">, id: string): Comment | undefined {
  const ref = decisionOf(h, id)?.comment;
  return ref ? h.comments.find((c) => c.id === ref) : undefined;
}

/** `3/9 decided`: of the findings the reader can see, how many have a decision. */
export function progress(findings: Finding[], h: Pick<Human, "decisions">): { decided: number; total: number } {
  return { decided: findings.filter((f) => decisionOf(h, f.id)).length, total: findings.length };
}

/**
 * Where a decision sends the cursor: the first undecided finding at or after `from` in `]f` order,
 * else the first undecided one from the top, so a pass that started midway still finishes.
 * At-or-after, not after: a second finding on the line just decided is the next one.
 */
export function nextUndecided(items: NavItem[], findings: Finding[], h: Pick<Human, "decisions">, from: At): (At & { finding: Finding }) | undefined {
  const open = spotsOf(items, findings.filter((f) => !decisionOf(h, f.id)));
  return open.find((s) => s.item > from.item || (s.item === from.item && s.line >= from.line)) ?? open[0];
}

/** The verdict submit starts from: request changes once anything is blocking; otherwise no default, the reader picks. */
export function defaultVerdict(findings: Finding[], h: Pick<Human, "decisions">): Verdict | undefined {
  return findings.some((f) => decisionOf(h, f.id)?.kind === "block") ? "request_changes" : undefined;
}

/** The submit preview's reminder of what is still undecided; empty when nothing is. `hidden`: blind chapters still hold findings back. */
export function undecidedNote(findings: Finding[], h: Pick<Human, "decisions">, place: (hunk: string, line: number) => string, hidden = false): string {
  const open = findings.filter((f) => !decisionOf(h, f.id));
  if (!open.length && !hidden) return "";
  const out = [`── Not decided yet (${open.length})`, ""];
  for (const f of open) out.push(`▲ ${place(f.hunk, f.line)} · ${f.severity} · ${titleOf(f)}`);
  if (!open.length) out.push("Every finding you can see is decided.");
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
 * The reader's layer with `f` decided as `kind`. Block and comment need the text the reader saved:
 * the comment the decision wrote before is rewritten in place, or a new one is made at the finding's
 * line. Any other kind removes that comment, since it would otherwise still post.
 */
export function decide(h: Human, f: Finding, kind: DecisionKind, input: { text?: string; reason?: string; at: string }): Human {
  const prior = linkedComment(h, f.id);
  let comments = h.comments, decision: Decision;
  if (kind === "block" || kind === "comment") {
    const text = input.text?.trim();
    if (!text) throw new Error("a block or comment decision needs the comment's text");
    if (prior) {
      comments = comments.map((c) => c === prior ? { ...c, text } : c);
      decision = { kind, comment: prior.id! };
    } else {
      const id = freshId(comments);
      comments = [...comments, { id, hunk: f.hunk, side: f.side, line: f.line, text, at: input.at }];
      decision = { kind, comment: id };
    }
  } else {
    comments = prior ? comments.filter((c) => c !== prior) : comments;
    const reason = kind === "dismissed" ? input.reason?.trim() : undefined;
    decision = { kind, ...(reason ? { reason } : {}) };
  }
  return { ...h, comments, decisions: { ...h.decisions, [f.id]: decision } };
}

/** The reader's layer with the decision on finding `id` taken back, and the comment it wrote with it. */
export function undo(h: Human, id: string): Human {
  if (!decisionOf(h, id)) return h;
  const prior = linkedComment(h, id);
  const { [id]: _, ...rest } = h.decisions!;
  return { ...h, comments: prior ? h.comments.filter((c) => c !== prior) : h.comments, decisions: rest };
}
