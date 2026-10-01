// "Since your review": on a re-review (a PR you already submitted on, opened again at a newer head), which lines of the
// new head are new or changed relative to the head you reviewed. The review document stays the whole PR (base..new
// head); this is a layer on top, kept with the stored review (`Review.since`, build.ts) and never in the document or
// anything posted. Pure: the git calls that feed it are in rereview.ts, so every case here is tested without a repo.
//
// The layer is per file of the PR, from `git diff --unified=0 <reviewed head> <new head>`: each hunk of that diff is
// a stretch of the new head that differs from what you read. A file added since (new at the new head) is changed
// whole, one removed since has no lines left to mark, and a renamed one is followed to its new name. A block of the
// PR is "changed since" when its lines overlap any of that. `mapLine` is the same diff read the other way, old line
// to new line, for the previous-comments chapter (where an earlier comment's line is now).

import type { FileDiff, Hunk } from "./diff.ts";

/** One stretch of the old→new diff: `oldCount` lines at `oldStart` of the reviewed head became `newCount` at `newStart`. */
export type SinceHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };
/** One file of the PR as it moved since your review. `path` is its name at the new head (a removed file: its old name). */
export type SinceFile = { path: string; oldPath?: string; status: "added" | "removed" | "renamed" | "modified"; hunks: SinceHunk[] };
/**
 * A re-review: the head you last submitted at (`head`) and when (`at`). `rebased`: that head is not an ancestor of the
 * new one (a rebase or force-push), so upstream changes in these files may show as new. `gone`: that head could not be
 * found or fetched, so there is no layer and the whole PR is shown. Otherwise `files` holds every PR file that moved.
 */
export type Since = { head: string; at: string; rebased?: true; gone?: true; files?: SinceFile[] };

export const REBASED_NOTE = "rebased since your review: upstream changes in these files may show as new";
export const GONE_NOTE = "your earlier head is gone; showing the whole PR";
/** A note as a sentence of its own: `rebased since…` → `Rebased since….` */
export const sentence = (note: string): string => `${note.charAt(0).toUpperCase()}${note.slice(1)}.`;

/** `abc1234 2026-09-30`: the reviewed head and the day you submitted it. */
export const sinceLabel = (s: Pick<Since, "head" | "at">): string => `${s.head.slice(0, 7)}${s.at ? ` ${s.at.slice(0, 10)}` : ""}`;

/** A stored value read back: anything malformed is dropped (the layer is rebuilt on the next open anyway). */
export function sinceOf(v: unknown): Since | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const j = v as Record<string, unknown>;
  if (typeof j.head !== "string" || !/^[0-9a-f]{7,64}$/.test(j.head) || typeof j.at !== "string") return undefined;
  const num = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : undefined;
  const files = Array.isArray(j.files) ? j.files.flatMap((f: any): SinceFile[] => {
    if (typeof f?.path !== "string" || !["added", "removed", "renamed", "modified"].includes(f.status) || !Array.isArray(f.hunks)) return [];
    const hunks = f.hunks.flatMap((h: any): SinceHunk[] => {
      const [os, oc, ns, nc] = [num(h?.oldStart), num(h?.oldCount), num(h?.newStart), num(h?.newCount)];
      return os === undefined || oc === undefined || ns === undefined || nc === undefined ? [] : [{ oldStart: os, oldCount: oc, newStart: ns, newCount: nc }];
    });
    return [{ path: f.path, ...(typeof f.oldPath === "string" ? { oldPath: f.oldPath } : {}), status: f.status, hunks }];
  }) : undefined;
  return { head: j.head, at: j.at, ...(j.rebased === true ? { rebased: true as const } : {}), ...(j.gone === true ? { gone: true as const } : {}), ...(files && !j.gone ? { files } : {}) };
}

// ---------------------------------------------------------------- which files, from git's name-status

/** One line of `git diff --name-status -z -M`: the status letter, the old name and the new one (the same unless renamed or copied). */
export type NameStatus = { status: string; old: string; path: string };

/** `git diff --name-status -z -M` output read into entries (a rename or copy carries both names). */
export function parseNameStatus(z: string): NameStatus[] {
  const parts = z.split("\0"), out: NameStatus[] = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    const letter = st[0]!;
    if (letter === "R" || letter === "C") { const old = parts[i++] ?? "", path = parts[i++] ?? ""; out.push({ status: letter, old, path }); }
    else { const p = parts[i++] ?? ""; out.push({ status: letter, old: p, path: p }); }
  }
  return out;
}

/**
 * The paths to diff old head → new head: every entry that touches a file of the PR (by its new or old name) or one of
 * `extra` (the paths your earlier comments were on), both names of a rename, so git can pair them. Upstream changes to
 * files the PR does not touch (after a rebase) are left out.
 */
export function pathsToDiff(entries: NameStatus[], pr: FileDiff[], extra: string[] = []): string[] {
  const want = new Set([...pr.flatMap((f) => [f.path, f.oldPath ?? f.path]), ...extra]);
  const out = new Set<string>();
  for (const e of entries) if (want.has(e.path) || want.has(e.old)) { out.add(e.old); out.add(e.path); }
  return [...out].sort();
}

/** The old→new diff (parsed with diff.ts from `git diff -M --unified=0`) as the layer's files. */
export function sinceFiles(diff: FileDiff[]): SinceFile[] {
  return diff.map((f) => ({
    path: f.path,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    status: f.status === "deleted" ? "removed" as const : f.status,
    hunks: f.hunks.map(({ oldStart, oldCount, newStart, newCount }) => ({ oldStart, oldCount, newStart, newCount })),
  }));
}

// ---------------------------------------------------------------- the new head's lines

/** The layer's entry for a PR file, by its name at the new head (a file the PR deletes is found by that name too). */
export const sinceFile = (s: Since | undefined, path: string): SinceFile | undefined => s?.files?.find((f) => f.path === path);

/**
 * The new head's line ranges (inclusive) that differ from the reviewed head. A stretch that only removed lines is the
 * pair of lines either side of where they were.
 */
export function changedRanges(f: SinceFile): [number, number][] {
  return f.hunks.map((h) => h.newCount ? [h.newStart, h.newStart + h.newCount - 1] as [number, number] : [h.newStart, h.newStart + 1] as [number, number]);
}

/** Whether line `n` of the new head is new or changed since the review (a gutter mark). Removals mark no line. */
export function lineChanged(f: SinceFile | undefined, n: number | null): boolean {
  if (!f || n === null) return false;
  if (f.status === "added") return true;
  return f.hunks.some((h) => h.newCount > 0 && n >= h.newStart && n < h.newStart + h.newCount);
}

/**
 * Whether a block of the PR (one hunk of base..new head) overlaps what changed since the review: its lines on the new
 * side, context included, or the place a block that only removes lines sits. A file added or removed since is all changed.
 */
export function blockChanged(f: SinceFile | undefined, hunk: Pick<Hunk, "newStart" | "newCount">): boolean {
  if (!f) return false;
  if (f.status === "added" || f.status === "removed") return true;
  const [a, b] = hunk.newCount ? [hunk.newStart, hunk.newStart + hunk.newCount - 1] : [hunk.newStart, hunk.newStart + 1];
  return changedRanges(f).some(([x, y]) => x <= b && a <= y);
}

/** The ids of the blocks (`{ id, path, hunk }`, the TUI's rail items) changed since the review; empty without a layer. */
export function changedBlocks(items: { id: string; path: string; hunk: Pick<Hunk, "newStart" | "newCount"> }[], s: Since | undefined): Set<string> {
  if (!s?.files) return new Set();
  return new Set(items.filter((x) => blockChanged(sinceFile(s, x.path), x.hunk)).map((x) => x.id));
}

// ---------------------------------------------------------------- old line → new line (the previous-comments chapter)

/**
 * Where line `line` of `path` at the reviewed head is at the new head. `same`: the line is unchanged, at `line` of
 * `path` (its new name after a rename). `changed`: it was edited or removed in a stretch that now starts at `near`.
 * `removed`: the whole file is gone. A file the layer does not list did not move: same line, same path.
 */
export type Mapped = { kind: "same"; path: string; line: number } | { kind: "changed"; path: string; near: number } | { kind: "removed"; path: string };

export function mapLine(s: Since | undefined, path: string, line: number): Mapped {
  const f = s?.files?.find((x) => (x.oldPath ?? x.path) === path && x.status !== "added");
  if (!f) return { kind: "same", path, line };
  if (f.status === "removed") return { kind: "removed", path };
  let shift = 0;
  for (const h of [...f.hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    // A stretch that only adds lines adds them after line oldStart; one that replaces covers oldStart..oldStart+oldCount-1.
    if (h.oldCount > 0 && line >= h.oldStart && line < h.oldStart + h.oldCount) return { kind: "changed", path: f.path, near: Math.max(1, h.newStart) };
    const before = h.oldCount > 0 ? h.oldStart + h.oldCount - 1 < line : h.oldStart < line;
    if (before) shift += h.newCount - h.oldCount;
  }
  return { kind: "same", path: f.path, line: line + shift };
}

/** For the previous-comments chapter (R3): every old path of the layer, to where its lines went; any other path did not move. */
export function lineMaps(s: Since | undefined): (path: string, line: number) => Mapped {
  return (path, line) => mapLine(s, path, line);
}
