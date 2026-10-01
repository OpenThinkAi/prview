// Reading the PR's worktree for a model. The worktree is checked out at the PR author's head, so the author controls
// every entry in it, symlinks included: a "source file" that links to ~/.aws/credentials must never be read and sent.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** A file read from the worktree: its text, nothing (it is not there), or why it was not read. */
export type InTree = { text: string } | { skipped: string } | { missing: true };

/** `rel` names somewhere outside `root` by itself: absolute, or with a `..` step. */
const outward = (rel: string) => isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[/\\]/).includes("..");

/** `p` (a real path) is strictly inside `root` (a real path). */
const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r !== "" && !outward(r);
};

/**
 * `rel` under `root`, read only when it is a regular file that is really inside the worktree: never a symlink (the diff
 * shows a link's target, not the file it leads to), never through a symlinked directory that leads out, never a path
 * with `..` or an absolute one.
 */
export function readInTree(root: string, rel: string): InTree {
  if (outward(rel)) return { skipped: `${rel} is a path out of the worktree; not read` };
  const p = join(root, rel);
  let link: boolean;
  try { link = lstatSync(p).isSymbolicLink(); } catch { return { missing: true }; }
  if (link) return { skipped: `${rel} is a symlink; not read` };
  let real: string;
  try { real = realpathSync(p); } catch { return { missing: true }; }
  let top: string;
  try { top = realpathSync(root); } catch { return { missing: true }; }
  if (!inside(top, real)) return { skipped: `${rel} leads out of the worktree through a symlinked directory; not read` };
  try {
    if (!statSync(real).isFile()) return { missing: true };
    return { text: readFileSync(real, "utf8") };
  } catch { return { missing: true }; }
}

/**
 * The symlinks git checked out in the worktree (mode 120000), relative to it. The agent is denied each one: it can read
 * whatever a link leads to inside the worktree by its own name, and nothing a link leads to outside it.
 */
export function linksIn(root: string, spawn: (argv: string[], cwd: string) => string = (argv, cwd) => Bun.spawnSync(argv, { cwd }).stdout.toString()): string[] {
  let out: string;
  try { out = spawn(["git", "ls-files", "-s", "-z"], root); } catch { return []; } // no worktree there: nothing to deny
  return out.split("\0").flatMap((e) => {
    const m = e.match(/^120000 [0-9a-f]+ \d+\t(.+)$/s);
    return m ? [m[1]!] : [];
  });
}
