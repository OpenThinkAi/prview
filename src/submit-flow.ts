// The submit flow (`s`), as state and the rules that move it; tui.tsx draws it and keys.ts names its keys. Pure, like
// nav.ts and triage.ts, so every step is tested without a screen:
//
//   1. findings   every finding with its action; block and comment ticked, ignore not. Ticked ones post.
//   2. verdict    the platform's verdicts as a radio, starting on what the ticks imply; the suggestions beside it.
//   3. comment    the top-level comment, several lines (`v e` for the editor); it replaces the old summary comments.
//   4. send       exactly what posts, the on_submit command and the coverage line as checkboxes (both off), Enter.
//
// Nothing here posts or writes. What the flow hands on is a Selection, which `applySelection` turns into the reader's
// layer as it will be written and posted: a ticked finding left on its default block or comment gets the comment it
// posts (the finding's own text), a ticked ignore becomes a comment the same way, and an unticked block or comment
// becomes ignore, so the document says exactly what went out. Posting then reads only the reader's comments, through
// the same path as always (platform.ts), so each platform adapter's own check (githubProblem for GitHub, azureProblem for Azure DevOps) stays the
// one check on posted text.

import { titleOf, type Finding } from "./guide.ts";
import type { Human, Verdict } from "./document.ts";
import type { SubmitStep } from "./keys.ts";
import { actionOf, actionText, decide, DEFAULTS, linkedComment, type Defaults } from "./triage.ts";

export type FlowStep = SubmitStep;
export const FLOW_STEPS: readonly FlowStep[] = ["findings", "verdict", "comment", "send"];
export const STEP_NAMES: Record<FlowStep, string> = { findings: "Findings", verdict: "Verdict", comment: "Comment", send: "Send" };

/** The checkboxes of the send step, when the submit has them: the document's command, and the coverage line. */
export type Box = "hook" | "coverage";

/**
 * Where the flow is. `listed`: the findings the checklist shows (a blind chapter's stay out), `ticked` the ones to
 * include, `at` the checklist's cursor. `verdict` is the radio's selection, `picked` once the reader (or a draft) chose
 * it rather than the ticks implying it. `typing`: the comment box takes the keys. `box`: the send step's cursor.
 */
export type Flow = {
  step: FlowStep; listed: string[]; ticked: string[]; at: number;
  verdicts: Verdict[]; verdict?: Verdict; picked: boolean;
  comment: string; typing: boolean;
  hook: boolean; coverage: boolean; box: number;
  /** Pre-filled by `a s`: marked in the step header until the reader sends or leaves. */
  drafted?: boolean;
};

/** What `a s` drafts for the reader to review here: the findings to include, a verdict and a comment. Any part may be missing. */
export type Draft = { include?: string[]; verdict?: Verdict; comment?: string };

/** What the flow hands to submit. `listed` findings not in `include` are left out (made ignore); the rest are untouched. */
export type Selection = { listed: string[]; include: string[]; comment: string; verdict?: Verdict };

/** The comment the box starts from: the summary comments already in the document (the old `N`), one after another. */
export const generalText = (h: Pick<Human, "comments">): string => h.comments.filter((c) => !c.hunk).map((c) => c.text).join("\n\n");

/** Ticked by default: a finding whose action is block or comment. */
export const tickedByDefault = (h: Pick<Human, "decisions">, f: Finding, defaults: Defaults = DEFAULTS): boolean => actionOf(h, f, defaults).kind !== "ignore";

export function startFlow(listed: Finding[], h: Pick<Human, "comments" | "decisions">, verdicts: Verdict[], defaults: Defaults = DEFAULTS, draft?: Draft): Flow {
  const ids = listed.map((f) => f.id);
  const ticked = draft?.include ? ids.filter((id) => draft.include!.includes(id)) : listed.filter((f) => tickedByDefault(h, f, defaults)).map((f) => f.id);
  const verdict = draft?.verdict && verdicts.includes(draft.verdict) ? draft.verdict : undefined;
  return {
    step: "findings", listed: ids, ticked, at: 0, verdicts, ...(verdict ? { verdict } : {}), picked: !!verdict,
    comment: draft?.comment ?? generalText(h), typing: false, hook: false, coverage: false, box: 0,
    ...(draft ? { drafted: true } : {}),
  };
}

/** How a ticked finding goes out: block as block, anything else (comment, or an ignore ticked back in) as a comment. */
const goesAs = (h: Pick<Human, "decisions">, f: Finding, defaults: Defaults) => actionOf(h, f, defaults).kind === "block" ? "block" : "comment";

/** The verdict the ticks imply: request changes with any ticked block, else comment with anything ticked, else none. */
export function impliedVerdict(findings: Finding[], h: Pick<Human, "decisions">, ticked: string[], defaults: Defaults = DEFAULTS): Verdict | undefined {
  const on = findings.filter((f) => ticked.includes(f.id));
  if (on.some((f) => goesAs(h, f, defaults) === "block")) return "request_changes";
  return on.length ? "comment" : undefined;
}

/** Into the verdict step the radio starts on what the ticks imply, unless a verdict was already picked. */
const entering = (fl: Flow, step: FlowStep, findings: Finding[], h: Pick<Human, "decisions">, defaults: Defaults): Flow => {
  if (step !== "verdict" || fl.picked) return { ...fl, step, typing: step === "comment" };
  const v = impliedVerdict(findings, h, fl.ticked, defaults);
  const { verdict: _, ...rest } = fl;
  return { ...rest, step, typing: false, ...(v && fl.verdicts.includes(v) ? { verdict: v } : {}) };
};

/** Tab: the next step (the comment box starts typing); the send step is the last. */
export function nextStep(fl: Flow, findings: Finding[], h: Pick<Human, "decisions">, defaults: Defaults = DEFAULTS): Flow {
  const i = FLOW_STEPS.indexOf(fl.step);
  return i < FLOW_STEPS.length - 1 ? entering(fl, FLOW_STEPS[i + 1]!, findings, h, defaults) : fl;
}

/** Shift-Tab: the step before; the first has none. */
export function prevStep(fl: Flow, findings: Finding[], h: Pick<Human, "decisions">, defaults: Defaults = DEFAULTS): Flow {
  const i = FLOW_STEPS.indexOf(fl.step);
  return i > 0 ? entering(fl, FLOW_STEPS[i - 1]!, findings, h, defaults) : fl;
}

const clamp = (n: number, len: number) => Math.max(0, Math.min(len - 1, n));

/** ↓ / ↑: the checklist's cursor, the radio (from no selection ↓ takes the first, ↑ the last), or the send step's checkboxes. */
export function move(fl: Flow, dir: 1 | -1, boxes: readonly Box[] = []): Flow {
  if (fl.step === "findings") return fl.listed.length ? { ...fl, at: clamp(fl.at + dir, fl.listed.length) } : fl;
  if (fl.step === "verdict") {
    if (!fl.verdicts.length) return fl;
    const i = fl.verdict ? fl.verdicts.indexOf(fl.verdict) : -1;
    const j = i < 0 ? (dir > 0 ? 0 : fl.verdicts.length - 1) : clamp(i + dir, fl.verdicts.length);
    return { ...fl, verdict: fl.verdicts[j]!, picked: true };
  }
  if (fl.step === "send" && boxes.length) return { ...fl, box: clamp(fl.box + dir, boxes.length) };
  return fl;
}

/** Space: tick or untick the finding under the cursor, or the checkbox under it in the send step. */
export function toggle(fl: Flow, boxes: readonly Box[] = []): Flow {
  if (fl.step === "findings") {
    const id = fl.listed[fl.at];
    if (id === undefined) return fl;
    return { ...fl, ticked: fl.ticked.includes(id) ? fl.ticked.filter((x) => x !== id) : fl.listed.filter((x) => x === id || fl.ticked.includes(x)) };
  }
  if (fl.step === "send") {
    const b = boxes[clamp(fl.box, boxes.length)];
    if (b) return { ...fl, [b]: !fl[b] };
  }
  return fl;
}

/** `a`: tick every finding, or untick them all when every one is ticked already. */
export const toggleAll = (fl: Flow): Flow => ({ ...fl, ticked: fl.listed.length && fl.ticked.length === fl.listed.length ? [] : [...fl.listed] });

// ---------------------------------------------------------------- the comment box

export const typeText = (fl: Flow, s: string): Flow => ({ ...fl, comment: fl.comment + s });
export const newline = (fl: Flow): Flow => typeText(fl, "\n");
export const backspace = (fl: Flow): Flow => ({ ...fl, comment: [...fl.comment].slice(0, -1).join("") });
/** ctrl-u: clear the line being typed (the last one); the lines above stay. */
export const clearLine = (fl: Flow): Flow => ({ ...fl, comment: fl.comment.replace(/[^\n]*$/, "") });
/** ctrl-w: delete the last word on the line being typed. */
export const deleteWord = (fl: Flow): Flow => ({ ...fl, comment: fl.comment.replace(/[^\S\n]*\S+[^\S\n]*$/, "").replace(/[^\S\n]+$/, "") });

// ---------------------------------------------------------------- what it hands on

export const selectionOf = (fl: Flow): Selection => ({ listed: [...fl.listed], include: [...fl.ticked], comment: fl.comment, ...(fl.verdict ? { verdict: fl.verdict } : {}) });

/**
 * The reader's layer with a selection applied: what the document records and what posts. The verdict is the one picked;
 * the top-level comment replaces the summary comments (none when it is blank). A ticked finding with a comment of the
 * reader's keeps it; one on its default block or comment, or ticked though ignored, gets the finding's own text as its
 * comment (the claim: never its source or any tool's name). A listed finding left unticked becomes ignore, which takes
 * away any comment it had, so nothing unticked posts. Findings not listed (hidden by a blind pass) are not touched.
 */
export function applySelection(h: Human, findings: Finding[], sel: Selection, defaults: Defaults = DEFAULTS, at = new Date().toISOString()): Human {
  const text = sel.comment.trim();
  let out: Human = { ...h, comments: [...(text ? [{ hunk: null, side: "new" as const, line: null, text, at }] : []), ...h.comments.filter((c) => c.hunk)] };
  if (sel.verdict) out.verdict = sel.verdict; else delete out.verdict;
  for (const f of findings) {
    if (!sel.listed.includes(f.id)) continue;
    const a = actionOf(out, f, defaults);
    if (!sel.include.includes(f.id)) { if (a.kind !== "ignore") out = decide(out, f, "ignore", { at }); continue; }
    if (a.kind !== "ignore" && !a.isDefault && linkedComment(out, f.id)) continue; // the reader's own comment posts as it is
    out = decide(out, f, goesAs(out, f, defaults), { text: linkedComment(out, f.id)?.text ?? f.claim, at });
  }
  return out;
}

// ---------------------------------------------------------------- what the steps show

/** One line of a step. `cursor`: where the step's cursor is; `on`: a selected radio or ticked box; `dim`: a hint. */
export type Line = { text: string; cursor?: boolean; on?: boolean; dim?: boolean; head?: boolean; wrap?: boolean };

export type Show = {
  /** Every finding of the review, for the ids the flow lists. */
  findings: Finding[]; h: Pick<Human, "decisions">; defaults?: Defaults;
  /** Where a finding is, `src/a.rs:11`. */
  place: (f: Finding) => string;
  label: (v: Verdict) => string;
  /** Keys named in the hints, as the keymap has them. */
  keys: { tick: string; all: string; editor: string; next: string; back: string };
  /** The checklist leaves out findings a blind pass still hides. */
  hidden?: boolean;
  /** A line above the checklist: that a severity filter is on, and is only for reading (filter.ts checklistNote). */
  note?: string;
  /** The suggestions, information only (triage.suggestionHint). */
  suggested?: string;
  /** Send step: the checkboxes with their wording, and the preview of what posts and what submit does. */
  boxes?: { box: Box; text: string }[];
  preview?: string;
};

/** The lines of the flow's current step. */
export function stepLines(fl: Flow, s: Show): Line[] {
  const defaults = s.defaults ?? DEFAULTS;
  const byId = new Map(s.findings.map((f) => [f.id, f]));
  switch (fl.step) {
    case "findings": {
      const out: Line[] = fl.drafted ? [{ text: "A draft: the ticks, the verdict and the comment are suggestions to review and change. Nothing is sent until Enter on Send.", wrap: true }] : [];
      out.push({ text: `Ticked findings post their comment on their line; the rest are left out. ${s.keys.tick} ticks one, ${s.keys.all} ticks all.`, dim: true, wrap: true });
      if (s.note) out.push({ text: s.note, wrap: true });
      if (!fl.listed.length) out.push({ text: `No findings to include. ${s.keys.next} goes on to the verdict.` });
      fl.listed.forEach((id, i) => {
        const f = byId.get(id);
        if (!f) return;
        const on = fl.ticked.includes(id);
        out.push({ text: `${on ? "[x]" : "[ ]"} ${f.severity} · ${actionText(actionOf(s.h, f, defaults))} · ${s.place(f)} · ${titleOf(f)}`, on, cursor: i === fl.at });
      });
      if (s.hidden) out.push({ text: "Chapters you have not read yet still hide their findings; they are not in this list and post nothing.", dim: true, wrap: true });
      return out;
    }
    case "verdict": {
      const implied = impliedVerdict(fl.listed.flatMap((id) => byId.get(id) ?? []), s.h, fl.ticked, defaults);
      const out: Line[] = fl.verdicts.map((v) => ({ text: `${fl.verdict === v ? "(•)" : "( )"} ${s.label(v)}`, on: fl.verdict === v, cursor: fl.verdict === v }));
      out.push({ text: "" });
      out.push({ text: implied ? `What you ticked implies ${s.label(implied)}.` : "Nothing ticked implies a verdict: pick one.", dim: true });
      if (s.suggested) out.push({ text: s.suggested, dim: true, wrap: true });
      return out;
    }
    case "comment": {
      const out: Line[] = [{ text: `The review's top-level comment, in your words. Enter adds a line${fl.typing ? "; Esc stops typing" : ""}; ${s.keys.editor} opens it in your editor.`, dim: true, wrap: true }];
      const lines = fl.comment.split("\n");
      lines.forEach((l, i) => out.push({ text: `│ ${l}`, cursor: fl.typing && i === lines.length - 1, wrap: true }));
      if (!fl.comment && !fl.typing) out.push({ text: "(no comment)", dim: true });
      return out;
    }
    case "send": {
      const out: Line[] = (s.boxes ?? []).map((b, i) => ({ text: `${fl[b.box] ? "[x]" : "[ ]"} ${b.text}`, on: fl[b.box], cursor: i === fl.box, wrap: true }));
      if (!fl.verdict) out.push({ text: `Pick a verdict first: ${s.keys.back} goes back to it.` });
      if (out.length) out.push({ text: "" });
      for (const l of (s.preview ?? "").split("\n")) out.push({ text: l, head: l.startsWith("── "), wrap: true });
      return out;
    }
  }
}
