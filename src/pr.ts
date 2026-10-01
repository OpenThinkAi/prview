// Where a pull request's code comes from: the contract every platform's source meets, and the few helpers
// they share. build.ts knows only this contract and the registry (registry.ts); each platform's own rules
// (its URL shapes, its remotes, how its PR head is fetched, what its CLI or API says) live in its module
// (github.ts). Posting a review back is the other half, in platform.ts.

import { basename } from "node:path";
import { Fail, type Target } from "./document.ts";

/**
 * One pull request, as a platform names it. `url` is the canonical web URL: what a review stores as its `ref`
 * and what the document's target carries, so reopening it never depends on a bare number meaning the right
 * thing in some clone. `repoKey` names the repository the way `PrSource.remoteKey` reads a remote (it
 * compares case-insensitively); `label` is how the platform writes a reference to it ("o/r#7").
 */
export type PrRef = { platform: string; url: string; repoKey: string; number: number; label: string };

/** What a review is built from: its name in the store and the document's target. */
export type Source = { slug: string; target: Target };

/** One platform's read side. */
export type PrSource = {
  /** The id documents carry in `target.platform` (and the adapter in platform.ts is registered under). */
  platform: string;
  /** This platform's PR URL as a ref, or undefined when the URL is not one of its. Pure. */
  parse(url: string): PrRef | undefined;
  /** The repoKey a remote URL points at, or undefined when it is not this platform's shape. Pure. */
  remoteKey(remoteUrl: string): string | undefined;
  /** The PR's head, base and words, its commits fetched into this clone. A bare number is a PR of the clone's own repo. */
  resolve(repo: string, ref: PrRef | number): Source;
  /**
   * Fetch the PR's head into refs/prview/pr-<n>. `known`: the ref came from a document, not from the platform in
   * this clone, so only a remote already configured here for its repo is used, never a URL the document chose.
   */
  fetch(repo: string, ref: PrRef, known: boolean): void;
};

/**
 * Runs one command in `cwd`; a failure is a Fail carrying what it said. `env` is passed explicitly (it is the default
 * anyway) so the command is looked up on the PATH as it is now: Bun otherwise keeps the PATH it first resolved with.
 */
export function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdin: "ignore", env: process.env });
  if (r.exitCode !== 0) throw new Fail(`${cmd.slice(0, 3).join(" ")} failed: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  return r.stdout.toString();
}
export const git = (args: string[], cwd: string) => run(["git", ...args], cwd).trim();

/** The store's name for a PR review: the clone's directory and the number, whatever the platform. */
export const prSlug = (repo: string, n: string | number) => `${basename(repo)}-pr-${n}`;

/** The clone's remotes, by name, with their URLs. */
export const remotesOf = (repo: string): { name: string; url: string }[] =>
  git(["remote"], repo).split("\n").filter(Boolean).map((name) => ({ name, url: git(["remote", "get-url", name], repo) }));

/** The remote in this clone that points at the ref's repository, by the platform's own reading of remote URLs. */
export function remoteFor(repo: string, source: PrSource, ref: PrRef): string | undefined {
  const want = ref.repoKey.toLowerCase();
  return remotesOf(repo).find((r) => source.remoteKey(r.url)?.toLowerCase() === want)?.name;
}
