// The status area's second line: separate fields, each a dim label and its value, so nothing runs together. Pure,
// so the narrow widths are tested without drawing anything.
//
// No field is cut to make room for another: when the line is too narrow, whole fields drop, in DROP_ORDER. The
// findings still to decide are never dropped (at a width too narrow even for them alone, the line is cut at the edge).

export type Field = { key: "pr" | "branch" | "read" | "findings" | "comments" | "suggested"; label: string; value: string; color?: string };

/** The order fields leave a narrow line in: the suggested verdict first, then the branches, the comments, the PR number, the reading progress. */
export const DROP_ORDER: readonly Field["key"][] = ["suggested", "branch", "comments", "pr", "read"];
export const GAP = "   ";

export type StatusInput = {
  /** The target's label: `owner/repo#12` for a pull request, `base..head` for a range. */
  label: string; base: string; head: string;
  read: { seen: number; total: number };
  /** Findings still to decide, by severity; `hidden`: blind, some are not shown yet; `withdrawn`: dropped by the refute step. */
  open: { blocking: number; warn: number; nit: number }; hidden: boolean; withdrawn: number;
  comments: number;
  /** The in-house review's suggested verdict, worded, when there is one. */
  suggested?: string;
};

/** Severity as the status area words it. */
const SEVERITY = [["blocking", "high"], ["warn", "medium"], ["nit", "low"]] as const;

export function statusFields(s: StatusInput): Field[] {
  const out: Field[] = [];
  const pr = s.label.match(/#(\d+)$/);
  if (pr) out.push({ key: "pr", label: "PR", value: `#${pr[1]}` });
  const range = s.label.match(/^(.+?)\.{2,3}(.+)$/);
  out.push({ key: "branch", label: range ? "branches" : "commits", value: range ? `${range[1]} ← ${range[2]}` : `${s.base.slice(0, 7)} ← ${s.head.slice(0, 7)}` });
  out.push({ key: "read", label: "read", value: `${s.read.seen}/${s.read.total}` });
  const counts = SEVERITY.filter(([k]) => s.open[k]).map(([k, word]) => `${s.open[k]} ${word}`);
  const open = counts.length ? `▲ ${counts.join(" · ")}` : "none";
  out.push({ key: "findings", label: "to decide", value: `${open}${s.hidden ? " · more hidden ▲?" : ""}${s.withdrawn ? ` · ${s.withdrawn} withdrawn` : ""}`, color: counts.length ? "yellow" : undefined });
  out.push({ key: "comments", label: "comments", value: String(s.comments) });
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
