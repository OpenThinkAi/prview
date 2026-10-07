// The status area's second line: separate fields, each a dim label and its value, so nothing runs together. Pure,
// so the narrow widths are tested without drawing anything.
//
// No field is cut to make room for another: when the line is too narrow, whole fields drop, in DROP_ORDER. The
// findings by severity are never dropped (at a width too narrow even for them alone, the line is cut at the edge).

import { filterLabel, type Filter } from "./filter.ts";
import type { Severity } from "./guide.ts";

export type Field = { key: "pr" | "branch" | "read" | "findings" | "filter" | "comments" | "suggested" | "rereview" | "view"; label: string; value: string; color?: string };

/**
 * The order fields leave a narrow line in: the suggested verdict first, then the branches, the comments, the PR number,
 * the reading progress. The severity filter goes after those, then a re-review's view (`v s`), then the re-review itself.
 * The findings stay.
 */
export const DROP_ORDER: readonly Field["key"][] = ["suggested", "branch", "comments", "pr", "read", "filter", "view", "rereview"];
export const GAP = "   ";

export type StatusInput = {
  /** The target's label: `owner/repo#12` for a GitHub pull request, `repo!12` for an Azure DevOps one, `base..head` for a range. */
  label: string; base: string; head: string;
  read: { seen: number; total: number };
  /** The findings shown, by severity, whatever their action; `hidden`: blind, some are not shown yet. */
  findings: Record<Severity, number>; hidden: boolean;
  comments: number;
  /** The severity filter (`f h`/`f m`/`f a`): the findings above are the ones it lets through. */
  filter?: Filter;
  /** The in-house review's suggested verdict, worded, when there is one. */
  suggested?: string;
  /**
   * A re-review: `label` is the head last submitted at and the day (`abc1234 2026-09-30`); `view` is what `v s` shows
   * (only the blocks changed since, or the whole PR), absent when there is no layer (the reviewed head is gone).
   */
  rereview?: { label: string; view?: "since" | "whole" };
};

const SEVERITY: readonly Severity[] = ["high", "medium", "low"];

/** The number a PR label ends in, as the platform writes it (`#12` on GitHub, `!12` on Azure DevOps); undefined for a range. */
export function prNumber(label: string): string | undefined {
  return label.match(/[#!]\d+$/)?.[0];
}

/**
 * The status area's bold first line. A pull request's line leads with its label (`owner/repo#12  Title`), so the repo it
 * is from is on screen whatever the width: the title is what gets cut. A range keeps its title, or its label when it has none.
 */
export function headerText(t: { label: string; title: string }): string {
  if (!prNumber(t.label)) return t.title || t.label;
  return t.title ? `${t.label}  ${t.title}` : t.label;
}

export function statusFields(s: StatusInput): Field[] {
  const out: Field[] = [];
  const pr = prNumber(s.label);
  if (pr) out.push({ key: "pr", label: "PR", value: pr });
  const range = s.label.match(/^(.+?)\.{2,3}(.+)$/);
  out.push({ key: "branch", label: range ? "branches" : "commits", value: range ? `${range[1]} ← ${range[2]}` : `${s.base.slice(0, 7)} ← ${s.head.slice(0, 7)}` });
  out.push({ key: "read", label: "read", value: `${s.read.seen}/${s.read.total}` });
  const counts = SEVERITY.filter((k) => s.findings[k]).map((k) => `${s.findings[k]} ${k}`);
  const shown = counts.length ? `▲ ${counts.join(" · ")}` : "none";
  out.push({ key: "findings", label: "findings", value: `${shown}${s.hidden ? " · more hidden ▲?" : ""}`, color: counts.length ? "yellow" : undefined });
  if (s.filter) out.push({ key: "filter", label: "filter", value: filterLabel(s.filter), color: s.filter === "all" ? undefined : "cyan" });
  out.push({ key: "comments", label: "comments", value: String(s.comments) });
  if (s.rereview) {
    out.push({ key: "rereview", label: "re-review ·", value: `since ${s.rereview.label}`, color: "magenta" });
    if (s.rereview.view) out.push({ key: "view", label: "view", value: s.rereview.view === "since" ? "since review" : "whole PR", color: s.rereview.view === "since" ? "magenta" : undefined });
  }
  if (s.suggested) out.push({ key: "suggested", label: "suggested", value: s.suggested });
  return out;
}

/** Columns a field takes: its label, a space, its value. */
export const fieldWidth = (f: Field): number => [...f.label].length + 1 + [...f.value].length;
const lineWidth = (fs: Field[]) => fs.reduce((n, f) => n + fieldWidth(f), 0) + GAP.length * Math.max(0, fs.length - 1);

/** The fields that fit `width`, whole, dropping in DROP_ORDER until they do. */
export function fitFields(fields: Field[], width: number): Field[] {
  let kept = fields;
  for (const k of DROP_ORDER) {
    if (lineWidth(kept) <= width) break;
    kept = kept.filter((f) => f.key !== k);
  }
  return kept;
}
