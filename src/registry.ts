// The platforms prview reads pull requests from, and how what the reader typed picks one. A URL belongs to
// the platform whose parser claims it; a bare number belongs to the clone it is typed in: the first platform
// whose remoteKey reads the clone's origin (else its only remote), and GitHub when none does, since GitHub's
// key reads any host (a mirror of o/r is still o/r) and so it goes last, as the fallback.

import { github } from "./github.ts";
import { remotesOf, type PrRef, type PrSource } from "./pr.ts";

export const SOURCES: readonly PrSource[] = [github];
const FALLBACK: PrSource = github;

const BARE = /^#?\d+$/;

/** The source for a platform id, if prview reads PRs from it. */
export const sourceOf = (platform: string | undefined): PrSource | undefined =>
  platform ? SOURCES.find((s) => s.platform === platform.toLowerCase()) : undefined;

/** The PR a URL names, on whichever platform claims it; undefined for anything else (a range, a bare number). */
export function parseRef(url: string | undefined): PrRef | undefined {
  if (!url) return undefined;
  for (const s of SOURCES) { const r = s.parse(url); if (r) return r; }
  return undefined;
}

/** Whether what the reader typed names a pull request (a number, `#n`, or a PR URL) rather than a range. */
export const isPR = (target: string | undefined): boolean => !!target && (BARE.test(target) || !!parseRef(target));

/** The platform a bare PR number in this clone means. */
function cloneSource(repo: string): PrSource {
  const others = SOURCES.filter((s) => s !== FALLBACK);
  if (!others.length) return FALLBACK;
  const remotes = remotesOf(repo);
  const home = remotes.find((r) => r.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
  return (home && others.find((s) => s.remoteKey(home.url) !== undefined)) || FALLBACK;
}

/** The source and ref for a PR the reader typed in `repo` (isPR said it is one). */
export function prIn(repo: string, target: string): { source: PrSource; ref: PrRef | number } {
  const ref = parseRef(target);
  if (ref) return { source: sourceOf(ref.platform)!, ref };
  return { source: cloneSource(repo), ref: Number(target.replace(/^#/, "")) };
}
