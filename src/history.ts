// Every submit is kept: $PRVIEW_HOME/submitted/<slug>/<UTC timestamp>.json (+ .md, + .hook.json when the hook ran),
// never overwritten. Before this, a submit wrote submitted/<slug>.json (+ .md) and the next one replaced it; those flat
// files are still read, as the oldest record of their review. What a re-review needs from a record is in the
// document's last `submissions` entry: the reviewed head, the platform, and each posted item with its ids.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Fail, home, remove } from "./build.ts";
import { parseDocument, type Doc, type Submission } from "./document.ts";
import { parseRef } from "./registry.ts";

export const submittedDir = () => join(home(), "submitted");
/** Where one review's submissions are kept. A slug is one plain path part: nothing here may reach outside submitted/. */
export const historyDir = (slug: string) => {
  if (!/^[\w][\w.-]*$/.test(slug)) throw new Fail(`${slug} is not a review name`);
  return join(submittedDir(), slug);
};

/** A submit time as a file name: the UTC timestamp without colons (some filesystems refuse them), so names sort by time. */
export const stampOf = (at: string) => at.replace(/:/g, "");

/** A file name for a submit at `at` in `dir` that no earlier submit used: `<stamp>.json`, else `<stamp>-2.json`, … */
export function freshStamp(dir: string, at: string): string {
  const base = stampOf(at);
  for (let n = 1; ; n++) { const s = n === 1 ? base : `${base}-${n}`; if (!existsSync(join(dir, `${s}.json`))) return s; }
}

/** One kept submission: the document as it was written, the record of that submit, and where it came from. */
export type Submitted = {
  file: string; slug: string; doc: Doc;
  /** That submit's entry in the document's `submissions` (undefined only for a file whose record is missing). */
  submission?: Submission;
  /** When it was submitted, and the head it reviewed (the record's, else the document's: older records have no head). */
  at: string; head: string;
  /** A flat submitted/<slug>.json from before every submit was kept. */
  legacy: boolean;
};

/** A PR URL as compared here: the platform's canonical form, case folded (hosts, owners and projects are not case sensitive). */
const canonical = (url: string | undefined) => ((url && parseRef(url)?.url) || url)?.toLowerCase();

function read(file: string, slug: string, legacy: boolean): Submitted[] {
  let doc: Doc;
  try { doc = parseDocument(readFileSync(file, "utf8")); } catch { return []; }
  const subs = doc.submissions ?? [];
  const submission = subs.findLast((s) => s.file === file) ?? subs.at(-1);
  let at = submission?.at;
  if (!at) { try { at = statSync(file).mtime.toISOString(); } catch { at = ""; } }
  return [{ file, slug, doc, ...(submission ? { submission } : {}), at, head: submission?.head ?? doc.target.head, legacy }];
}

/** One review's kept submissions, in no particular order: its directory, and the flat file from before. */
function ofSlug(slug: string): Submitted[] {
  const dir = historyDir(slug), out: Submitted[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch {}
  for (const n of names) if (n.endsWith(".json") && !n.endsWith(".hook.json")) out.push(...read(join(dir, n), slug, false));
  const flat = join(submittedDir(), `${slug}.json`);
  if (existsSync(flat)) out.push(...read(flat, slug, true));
  return out;
}

/** Every slug with something kept under submitted/. */
function slugs(): string[] {
  let names: string[] = [];
  try { names = readdirSync(submittedDir()); } catch { return []; }
  const out = new Set<string>();
  for (const n of names) {
    const p = join(submittedDir(), n);
    try { if (statSync(p).isDirectory()) { out.add(n); continue; } } catch { continue; }
    if (n.endsWith(".json") && !n.endsWith(".hook.json")) out.add(n.slice(0, -".json".length));
  }
  return [...out];
}

/**
 * The submissions kept for a pull request (its URL, on any platform prview reads: matched on the canonical URL each
 * document's target names) or for a review (its slug), newest first. Legacy flat files are included; a file that is
 * not a document prview can read is skipped.
 */
export function submissionsFor(prUrlOrSlug: string): Submitted[] {
  const url = /^https?:\/\//.test(prUrlOrSlug) ? canonical(prUrlOrSlug) : undefined;
  const found = url
    ? slugs().flatMap(ofSlug).filter((s) => canonical(s.doc.target.url) === url)
    : ofSlug(prUrlOrSlug);
  // Same instant: the later file of the two (`<stamp>-2` after `<stamp>`).
  const seq = (f: string) => Number(f.match(/Z-(\d+)\.json$/)?.[1] ?? 1);
  return found.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : seq(b.file) - seq(a.file));
}

/** Removes a review's kept submissions (its directory and the legacy flat files); how many documents went. */
export function purgeHistory(slug: string): number {
  const n = ofSlug(slug).length;
  rmSync(historyDir(slug), { recursive: true, force: true });
  for (const end of [".json", ".md", ".hook.json"]) rmSync(join(submittedDir(), `${slug}${end}`), { force: true });
  return n;
}

/** `prview done`: the review goes; its submission history stays (a re-review reads it) unless purged. */
export function done(slug: string, purge: boolean): string {
  const kept = submissionsFor(slug).length;
  // With --purge, history left behind by a review already removed can still go.
  const removed = purge && kept && !existsSync(join(home(), `${slug}.json`)) ? undefined : remove(slug);
  if (purge) { const n = purgeHistory(slug); return [removed, n ? `purged ${n} submission${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "); }
  return kept ? `${removed} · kept ${kept} submission${kept === 1 ? "" : "s"} (prview done --purge ${slug} removes ${kept === 1 ? "it" : "them"})` : removed!;
}
