// Launching an editor at a line: what to run, and how to run it beside prview when we are inside tmux.

import { resolve } from "node:path";

/** $PRVIEW_EDITOR, else the config's `editor` (the settings view sets it), else $EDITOR, else hx. */
export function editor(env: Record<string, string | undefined> = process.env, configured?: string): string[] {
  const e = env.PRVIEW_EDITOR ?? configured ?? env.EDITOR ?? "hx";
  return e.split(/\s+/).filter(Boolean);
}

/**
 * `hx +12 -- /wt/file`, `vim +12 -- /wt/file`, `code -g /wt/file:12`, `zed /wt/file:12`: the common ways to say
 * "open here". The path comes from the PR, so it is made absolute against `root` (the worktree) first: it then starts
 * with `/` and no editor can read it as an option or a command (vim runs `+cmd` and `-c cmd`; a file named
 * `+:!touch x` would otherwise be one). The `+N` is ours. Editors known to take `--` get it too, before the path;
 * anything else gets the absolute path alone, since an editor that does not know `--` would open a file of that name.
 */
export function editorArgs(cmd: string[], path: string, line: number, root: string): string[] {
  const bin = cmd[0]!.split("/").pop()!;
  const p = resolve(root, path);
  if (/^(code|cursor|codium)$/.test(bin)) return [...cmd, "-g", `${p}:${line}`, "--wait"];
  if (/^(zed|subl)$/.test(bin)) return [...cmd, `${p}:${line}`];
  return [...cmd, `+${line}`, ...(DASHDASH.test(bin) ? ["--"] : []), p];
}

/** Editors that end their options at `--` (and still take `+N` before it). */
const DASHDASH = /^(hx|helix|vi|vim|nvim|gvim|mvim|view|vimdiff|ex)$/;

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The tmux command that opens the editor in a pane to the right, in the worktree. The pane runs through
 * `sh -c` so it does not depend on the user's login shell, and on a failed exit waits for Enter so a typo in
 * $EDITOR shows its error instead of a pane that flashes and vanishes.
 */
export function tmuxSplit(argv: string[], cwd: string): string[] {
  const inner = `${argv.map(shellQuote).join(" ")} || { printf 'prview: the editor exited with an error; press Enter'; read _; }`;
  return ["tmux", "split-window", "-h", "-l", "60%", "-c", cwd, `sh -c ${shellQuote(inner)}`];
}

/** Opens the editor beside prview; returns a message when it could not. Only offered inside tmux. */
export type Beside = (path: string, line: number) => string | undefined;

/** `configured` is read at each open, so an editor saved in the settings is used at once. */
export function besideIn(worktree: string, env: Record<string, string | undefined> = process.env, configured: () => string | undefined = () => undefined): Beside | undefined {
  if (!env.TMUX) return undefined;
  return (path, line) => {
    const p = Bun.spawnSync(tmuxSplit(editorArgs(editor(env, configured()), path, line, worktree), worktree), { stdin: "ignore" });
    return p.exitCode === 0 ? undefined : `tmux could not open a pane: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`;
  };
}
