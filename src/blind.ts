// The blind first pass: a chapter's findings stay hidden until the reader has been through it, so
// the human forms a view of the code before seeing what the critic thought of it. Pure, like
// nav.ts, so the rule is tested without a screen.
//
// A chapter is named here by the id of its first hunk: chapters carry no ids of their own, and a
// hunk belongs to exactly one chapter, so the key survives a plan being replaced by a richer one.

import type { Finding } from "./guide.ts";
import type { Comment } from "./document.ts";

/** The part of the reader's layer the gate looks at. */
export type Seen = { visited: string[]; revealed?: string[] };

export const chapterKey = (ids: string[]): string | undefined => ids[0];

const read = (ids: string[], human: Seen) => ids.every((id) => human.visited.includes(id));

/** A chapter with nothing in it has nothing to hide. Reading every hunk reveals it; so does an early reveal. */
export function chapterHidden(blind: boolean, ids: string[], human: Seen): boolean {
  const key = chapterKey(ids);
  if (!blind || key === undefined) return false;
  return !(human.revealed ?? []).includes(key) && !read(ids, human);
}

/** Every hunk whose findings are hidden right now. `chapters` is each chapter's hunk ids, in reading order. */
export function hiddenHunks(blind: boolean, chapters: string[][], human: Seen): Set<string> {
  return new Set(chapters.filter((ids) => chapterHidden(blind, ids, human)).flat());
}

/**
 * The revealed list after pressing F on a chapter, or null when there is nothing to record: the
 * chapter is not hidden (blind is off, it was already read or already revealed). Only a reveal that
 * actually skipped the reading is an early one.
 */
export function revealEarly(blind: boolean, ids: string[], human: Seen): string[] | null {
  const key = chapterKey(ids);
  if (key === undefined || !chapterHidden(blind, ids, human)) return null;
  return [...(human.revealed ?? []), key];
}

/** The titles of the chapters whose findings the reader asked to see before reading them, for the write-up. */
export function earlyTitles(chapters: { title: string; ids: string[] }[], human: Seen): string[] {
  return chapters.filter((c) => { const k = chapterKey(c.ids); return k !== undefined && (human.revealed ?? []).includes(k); }).map((c) => c.title);
}

/** What the reveal float says: the model's findings for the chapter beside what the reader already noted there. */
export function revealBody(findings: Finding[], comments: Comment[], place: (hunk: string, line: number | null) => string): string {
  const out: string[] = [];
  out.push(findings.length ? `The model found ${findings.length}:` : "The model found nothing in this chapter.");
  for (const f of findings) out.push(`▲ ${place(f.hunk, f.line)} · ${f.severity} · ${f.claim}`);
  out.push("", comments.length ? `You noted ${comments.length}:` : "You left no comments here.");
  for (const c of comments) out.push(`» ${place(c.hunk ?? "", c.line)} · ${c.text}`);
  return out.join("\n");
}
