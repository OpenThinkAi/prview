// Copying what the screen shows, as the text that was meant rather than the text that was drawn.
//
// Selecting with the mouse picks up the box border, the padding and the hard wraps prview put in to
// fit the float. So `y` copies the source strings instead. Everything here is pure or takes its
// effects as arguments (a runner for local tools, a writer for OSC 52), so it is tested without a clipboard.

import { claimAddsTo, titleOf, type Finding } from "./guide.ts";

/** A finding as prose: where it is and its title, then the detail (the same order the float reads in). */
export function findingText(f: Finding, where: string): string {
  const lead = titleOf(f);
  const detail = [claimAddsTo(f) ? f.claim : "", f.evidence, f.refute ? `Second look: ${f.refute}` : ""].filter(Boolean).join("\n\n");
  return `${where} — ${lead}${detail ? `\n\n${detail}` : ""}`;
}

/** The chapter's box (← in the code): the chapter title, its one-line intent, then the longer why. */
export function whyText(title: string, intent: string | undefined, why: string): string {
  return [title, intent, why].filter(Boolean).join("\n\n");
}

/** An `a ?` answer with the question it answered. */
export function askText(question: string, answer: string): string {
  return `${question}\n\n${answer}`;
}

// ---------------------------------------------------------------- where it goes

export type Route = { kind: "cmd"; argv: string[] } | { kind: "osc52" };

/**
 * The clipboard routes to try, in order. A local tool only makes sense when the screen and the clipboard are on
 * the same machine, so over ssh (or when forced with PRVIEW_CLIPBOARD=osc52) the terminal escape is the only route:
 * pbcopy would fill the remote host's clipboard. OSC 52 is always last, since it needs no tool at all.
 */
export function routes(platform: string, env: Record<string, string | undefined>): Route[] {
  const osc: Route = { kind: "osc52" };
  if (env.PRVIEW_CLIPBOARD === "osc52" || env.SSH_CONNECTION || env.SSH_TTY) return [osc];
  const out: Route[] = [];
  if (platform === "darwin") out.push({ kind: "cmd", argv: ["pbcopy"] });
  else if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) out.push({ kind: "cmd", argv: ["wl-copy"] });
    if (env.DISPLAY) out.push({ kind: "cmd", argv: ["xclip", "-selection", "clipboard"] });
  }
  return [...out, osc];
}

/**
 * The OSC 52 sequence that sets the clipboard. Inside tmux it is wrapped in a passthrough (every ESC doubled)
 * so tmux hands it to the outer terminal; that needs `allow-passthrough on` in tmux, which is why local tools go first.
 */
export function osc52(text: string, env: Record<string, string | undefined>): string {
  const seq = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  return env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq;
}

/** Runs a tool with `text` on stdin; true when it exited cleanly. A missing tool is false, not a throw. */
export type Runner = (argv: string[], input: string) => boolean;

export type Copied = { ok: true; chars: number; via: string } | { ok: false; message: string };
export type Copier = (text: string) => Copied;

export type Deps = { platform: string; env: Record<string, string | undefined>; run: Runner; write: (s: string) => void };

export function copyText(text: string, d: Deps): Copied {
  if (!text) return { ok: false, message: "nothing to copy" };
  const chars = [...text].length;
  const tried: string[] = [];
  for (const route of routes(d.platform, d.env)) {
    if (route.kind === "cmd") {
      let ok = false;
      try { ok = d.run(route.argv, text); } catch { ok = false; }
      if (ok) return { ok: true, chars, via: route.argv[0]! };
      tried.push(route.argv[0]!);
    } else {
      try { d.write(osc52(text, d.env)); return { ok: true, chars, via: "osc52" }; } catch { tried.push("osc52"); }
    }
  }
  return { ok: false, message: `no clipboard route worked (tried ${tried.join(", ")})` };
}

const spawnRunner: Runner = (argv, input) => {
  try { return Bun.spawnSync(argv, { stdin: new TextEncoder().encode(input), stdout: "ignore", stderr: "ignore" }).exitCode === 0; }
  catch { return false; }
};

/** The real thing: this machine's tools, this process's environment, the terminal on stdout. */
export const systemCopier: Copier = (text) => copyText(text, { platform: process.platform, env: process.env, run: spawnRunner, write: (s) => { process.stdout.write(s); } });

/** What the footer says afterwards. OSC 52 cannot be confirmed, so it says what was done. */
export const confirmation = (r: Copied) => r.ok ? (r.via === "osc52" ? `sent ${r.chars} chars to the terminal clipboard (OSC 52)` : `copied ${r.chars} chars`) : r.message;
