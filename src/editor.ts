// Launching an editor at a line: what to run, and how to run it beside prview when we are inside tmux.

export function editor(env: Record<string, string | undefined> = process.env): string[] {
  const e = env.PRVIEW_EDITOR ?? env.EDITOR ?? "hx";
  return e.split(/\s+/).filter(Boolean);
}

/** `hx +12 file`, `vim +12 file`, `code -g file:12`, `zed file:12`: the common ways to say "open here". */
export function editorArgs(cmd: string[], path: string, line: number): string[] {
  const bin = cmd[0]!.split("/").pop()!;
  if (/^(code|cursor|codium)$/.test(bin)) return [...cmd, "-g", `${path}:${line}`, "--wait"];
  if (/^(zed|subl)$/.test(bin)) return [...cmd, `${path}:${line}`];
  return [...cmd, `+${line}`, path];
}

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

export function besideIn(worktree: string, env: Record<string, string | undefined> = process.env): Beside | undefined {
  if (!env.TMUX) return undefined;
  return (path, line) => {
    const p = Bun.spawnSync(tmuxSplit(editorArgs(editor(env), path, line), worktree), { stdin: "ignore" });
    return p.exitCode === 0 ? undefined : `tmux could not open a pane: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`;
  };
}
