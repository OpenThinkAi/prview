// The blind first pass: a chapter's findings stay hidden until the reader has been through it, so
// the human forms a view of the code before seeing what the critic thought of it. Pure, like
// nav.ts, so the rule is tested without a screen.
//
// A chapter is named here by the id of its first hunk: chapters carry no ids of their own, and a
// hunk belongs to exactly one chapter, so the key survives a plan being replaced by a richer one.

/** The part of the reader's layer the gate looks at. */
export type Seen = { visited: string[]; revealed?: string[] };

export const chapterKey = (ids: string[]): string | undefined => ids[0];

const read = (ids: string[], human: Seen) => ids.every((id) => human.visited.includes(id));

/** A chapter with nothing in it has nothing to hide. Reading every hunk reveals it; so does an early reveal recorded in an older review. */
export function chapterHidden(blind: boolean, ids: string[], human: Seen): boolean {
  const key = chapterKey(ids);
  if (!blind || key === undefined) return false;
  return !(human.revealed ?? []).includes(key) && !read(ids, human);
}

/** Every hunk whose findings are hidden right now. `chapters` is each chapter's hunk ids, in reading order. */
export function hiddenHunks(blind: boolean, chapters: string[][], human: Seen): Set<string> {
  return new Set(chapters.filter((ids) => chapterHidden(blind, ids, human)).flat());
}

/** The titles of the chapters whose findings the reader asked to see before reading them, for the write-up. */
export function earlyTitles(chapters: { title: string; ids: string[] }[], human: Seen): string[] {
  return chapters.filter((c) => { const k = chapterKey(c.ids); return k !== undefined && (human.revealed ?? []).includes(k); }).map((c) => c.title);
}
