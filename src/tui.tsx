// The screen. A rail of chapters on the left, one hunk at a time on the right, and a floating box
// for whatever wants explaining: why a chapter matters, a finding, the answer to a question, the
// review before you submit it.
//
// The app owns the terminal; an editor is something it launches. `e` hands back an `edit` outcome
// with the file and line under the cursor, the CLI runs the editor in the head worktree, then renders
// the app again with the same state. Inside tmux the CLI passes `beside` instead, and the editor opens in
// a split pane while this screen stays up.
//
// Deciding on findings is the first pass: `]f` opens the next one, and one key decides it (n not an issue,
// b block on it, c comment; u undoes, h hides the box without deciding). b and c open the ordinary comment line prefilled
// with the finding's title, so what posts is what the reader saved. Each decision moves straight to
// the next undecided finding. The rules live in triage.ts.
//
// Everything shown comes from the review document (`review.doc`), whoever produced it; the rest of
// the review is only where the cursor was and where the worktree is.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { where, type DiffLine, type FileDiff } from "./diff.ts";
import { claimAddsTo, hunksOf, MECHANICAL_INTENT, titleOf, worstFirst, type Finding, type HunkAt } from "./guide.ts";
import { ask, preparedBy, save, VERDICT, writeup, type Pos, type Review } from "./build.ts";
import type { Doc, Human, Verdict } from "./document.ts";
import { chapterHidden, hiddenHunks, revealBody, revealEarly } from "./blind.ts";
import { gotoLine, nextFinding, type NavItem } from "./nav.ts";
import { highlightLines, langOf, lengthOf, sliceSpans, styleOf, type Span } from "./highlight.ts";
import { clampScroll, clampX, floatHeight, floatRows, layoutOf, pageStep, rowsFor, windowOf, wrapText } from "./layout.ts";
import type { Beside } from "./editor.ts";
import { askText, confirmation, findingText, systemCopier, whyText, type Copier } from "./clipboard.ts";
import { describe, planOf } from "./submit.ts";
import { decide, decisionOf, defaultVerdict, LABEL, linkedComment, nextUndecided, progress, undecidedNote, undo } from "./triage.ts";
import { actionOf, bindingsBody, findingFooter, infoFooter, type KeyState, keyOf, navFooter, startsChord } from "./keys.ts";
import { MIN_COLS, MIN_ROWS, tooSmall, useTerminalSize } from "./resize.ts";

/** `hook`: the human allowed the document's on_submit command for this submit (x in the preview). */
export type Outcome = { kind: "quit" } | { kind: "submit"; hook: boolean; coverage: boolean } | { kind: "edit"; path: string; line: number };

/** Everything the rail steps through, in reading order: each chapter's hunks, then the mechanical ones. */
type Item = NavItem & { at: HunkAt; mechanical?: string };
function itemsOf(d: Doc, files: FileDiff[]): Item[] {
  const at = new Map(hunksOf(files).map((h) => [h.id, h]));
  const out: Item[] = [];
  const add = (id: string, chapter: number, mechanical?: string) => { const h = at.get(id); if (h?.hunk) out.push({ id, path: h.file.path, hunk: h.hunk, chapter, at: h, mechanical }); };
  d.plan.chapters.forEach((c, i) => c.hunks.forEach((id) => add(id, i)));
  d.plan.mechanical.forEach((m) => add(m.id, d.plan.chapters.length, m.why));
  return out;
}

/** Columns a press of H or L moves the code sideways. */
const PAN = 8;
const SEV = { blocking: "red", warn: "yellow", nit: "blue" } as const;
/**
 * `lead` is bold above the body: a finding's title. `copy` is the float's source text for `y`: what it means, not the wrapped
 * and boxed lines drawn from `lead` and `body`. `finding` is the id of the finding shown, which the decision keys act on. `summary` is the review's opening overview: it is
 * drawn at the top of the hunk, in its own border, never under a cursor line where a finding sits.
 */
type Float = { title: string; lead?: string; body: string; color?: string; tall?: boolean; copy?: string; finding?: string; summary?: boolean };
/** `decide`: this comment carries out a block or comment decision on that finding. `reason`: the optional reason for "not an issue". */
type Mode = { kind: "nav" } | { kind: "comment"; general: boolean; decide?: { id: string; kind: "block" | "comment" } } | { kind: "reason"; id: string } | { kind: "ask" } | { kind: "verdict" } | { kind: "preview"; hook: boolean; coverage: boolean };

export type AppProps = {
  review: Review; files: FileDiff[]; onDone: (o: Outcome) => void;
  /** Open the editor in a pane beside this screen instead of taking the terminal over. */
  beside?: Beside;
  /** Override the terminal size (tests, mostly: there is no real terminal to measure). */
  size?: { cols: number; rows: number };
  /** Blind first pass: a chapter's findings stay hidden until every hunk in it has been visited (or `F`). */
  blind?: boolean;
  /** `--dry-run`: the preview says that submit will only print the API calls. */
  dryRun?: boolean;
  /** How `y` reaches the clipboard; tests pass one that records instead of touching it. */
  copier?: Copier;
};

export function App({ review, files, onDone, beside, size, blind = false, dryRun = false, copier = systemCopier }: AppProps) {
  const { exit } = useApp();
  const term = useTerminalSize(size);
  const cols = term.cols, rows = term.rows - 1;
  const r = useRef(review).current;
  const d = r.doc, h = d.human;
  const items = useMemo(() => itemsOf(d, files), [d, files]);
  const [, bump] = useState(0);
  const redraw = () => { save(r); bump((n) => n + 1); };
  const [pos, setPosRaw] = useState<Pos>(() => ({ item: Math.min(r.pos.item, Math.max(0, items.length - 1)), line: r.pos.line }));
  const setPos = (p: Pos) => { r.pos = p; setPosRaw(p); };
  const [float, setFloatRaw] = useState<Float | null>(() => d.plan.summary ? { title: "Summary of this change · not a finding", summary: true, color: "magenta", copy: d.plan.summary, body: [d.plan.summary, preparedBy(review.ai?.runs)].filter(Boolean).join("\n\n") } : null);
  const [scroll, setScroll] = useState(0);
  // What `y` just did, shown in the footer until the next key.
  const [note, setNote] = useState<string | null>(null);
  const setFloat = (f: Float | null) => { setScroll(0); setFloatRaw(f); };
  const [mode, setMode] = useState<Mode>({ kind: "nav" });
  const [input, setInput] = useState("");
  // Keys can arrive several to a chunk (a fast "781G"), all handled by one closure: the prefix state lives in refs.
  const countRef = useRef(""), pendingRef = useRef<string | null>(null);
  const [, tick] = useState(0);
  const setCount = (c: string) => { countRef.current = c; tick((n) => n + 1); };
  const setPending = (p: string | null) => { pendingRef.current = p; tick((n) => n + 1); };
  const [busy, setBusy] = useState<string | null>(null);
  // Long lines either scroll sideways (H/L) or wrap onto more rows (w).
  const [wrap, setWrap] = useState(false);
  const [panX, setPanX] = useState(0);

  const item = items[pos.item];
  const hunk = item?.hunk ?? null;
  const lines = hunk?.lines ?? [];
  const line = Math.min(pos.line, Math.max(0, lines.length - 1));
  // Tabs become spaces before colouring so a token's columns are the columns it is drawn in.
  const shape = useMemo(() => lines.map((l) => l.text.replace(/\t/g, "    ")), [item?.id]);
  const spans = useMemo(() => highlightLines(shape, item ? langOf(item.path) : undefined), [shape, item?.path]);
  const chapter = item ? d.plan.chapters[item.chapter] : undefined;
  const chapterTitle = item ? chapter?.title ?? "Mechanical" : "";

  const live = (f: Finding) => f.status !== "withdrawn";
  // Blind: what the critic found is not shown, counted or reachable until the chapter has been read. Everything below that
  // draws or steps through a finding goes through `unhidden`, so the gate cannot be bypassed by one key.
  const chapters = items.reduce<string[][]>((acc, x) => { (acc[x.chapter] ??= []).push(x.id); return acc; }, []).filter(Boolean);
  const hidden = hiddenHunks(blind, chapters, h);
  const unhidden = (f: Finding) => !hidden.has(f.hunk);
  // Open: shown and not decided yet. The ▲ counts on the rail and header are what is left to decide.
  const open = (f: Finding) => live(f) && unhidden(f) && !decisionOf(h, f.id);
  const visible = () => d.findings.filter((f) => live(f) && unhidden(f));
  const findingsHere = item ? d.findings.filter((f) => f.hunk === item.id && live(f) && unhidden(f)) : [];
  const findingsAt = (l: DiffLine) => findingsHere.filter((f) => f.side === "new" ? l.n !== null && f.line === l.n : l.o !== null && f.line === l.o);
  const notesAt = (l: DiffLine) => h.comments.filter((n) => n.hunk === item?.id && n.line !== null && (n.side === "new" ? n.line === l.n : n.line === l.o));

  // Seeing a hunk is reading it.
  useEffect(() => { if (item && !h.visited.includes(item.id)) { h.visited.push(item.id); redraw(); } }, [item?.id]);

  const goItem = (i: number) => { const n = Math.max(0, Math.min(items.length - 1, i)); if (n !== pos.item) { setPos({ item: n, line: 0 }); setFloat(null); setPanX(0); } };
  const goChapter = (dir: 1 | -1) => {
    if (!item) return;
    const target = item.chapter + dir;
    const i = dir > 0 ? items.findIndex((x) => x.chapter >= target) : items.findIndex((x) => x.chapter === Math.max(0, target));
    if (i >= 0) goItem(i);
  };
  const anchor = (): { side: "new" | "old"; line: number | null } => {
    const l = lines[line];
    if (!l) return { side: "new", line: null };
    return l.n !== null ? { side: "new", line: l.n } : { side: "old", line: l.o };
  };
  const showFinding = (f: Finding) => {
    const dec = decisionOf(h, f.id), p = progress(visible(), h), mine = linkedComment(h, f.id);
    const state = dec
      ? `Decided: ${LABEL[dec.kind]}${dec.reason ? ` (${dec.reason})` : ""}${mine ? `. Your comment: ${mine.text}` : ""}`
      : "";
    setFloat({ title: `▲ ${f.source} · ${f.kind} · ${f.severity}${f.votes && r.ai?.samples ? ` · ${f.votes}/${r.ai.samples}` : ""} · ${p.decided}/${p.total} decided`, color: dec ? "gray" : SEV[f.severity], lead: titleOf(f), finding: f.id, copy: findingText(f, place(f.hunk, f.line)), body: [claimAddsTo(f) ? f.claim : "", f.evidence, f.refute ? `Second look: ${f.refute}` : "", state].filter(Boolean).join("\n\n") });
  };
  // What the decision keys act on: the finding in the open box, and only while it is open. Only shown findings can be in a box,
  // so a blind chapter's findings cannot be decided before they are revealed.
  const target = (): Finding | undefined => {
    const f = float?.finding ? d.findings.find((x) => x.id === float.finding) : undefined;
    return f && live(f) && unhidden(f) ? f : undefined;
  };
  // After a decision: straight on to the next undecided finding, so a whole pass is ]f and then one key per finding.
  const decided = (next: Human) => {
    Object.assign(h, next); redraw();
    const hit = nextUndecided(items, visible(), h, { item: pos.item, line });
    if (hit) { setPos({ item: hit.item, line: hit.line }); if (hit.item !== pos.item) setPanX(0); showFinding(hit.finding); return; }
    const p = progress(visible(), h);
    setFloat({ title: `Findings · ${p.decided}/${p.total} decided`, color: "green", body: `Every finding${hidden.size ? " you can see" : ""} is decided.${hidden.size ? ` Chapters you have not read yet keep theirs hidden; ${keyOf("nav.reveal")} reveals one.` : ""} ${keyOf("finding.hide")} closes this, then ${keyOf("nav.submit")} submits; ${keyOf("finding.next")} and ${keyOf("finding.prev")} step back through them, ${keyOf("finding.undo")} undoes one.` });
  };
  const jumpFinding = (dir: 1 | -1) => {
    const hit = nextFinding(items, d.findings.filter((f) => live(f) && unhidden(f)), { item: pos.item, line }, dir);
    if (!hit) { setFloat({ title: "Findings", body: (dir > 0 ? "No more findings after this point." : "No findings before this point.") + (hidden.size ? ` Chapters you have not read yet keep theirs hidden; close this with ${keyOf("info.hide")}, then ${keyOf("nav.reveal")} reveals one.` : "") }); return; }
    setPos({ item: hit.item, line: hit.line });
    showFinding(hit.finding);
  };
  const place = (id: string, l: number | null) => `${items.find((x) => x.id === id)?.path ?? id}${l !== null ? `:${l}` : ""}`;
  const reveal = () => {
    if (!item) return;
    const ids = chapters[item.chapter] ?? [];
    const early = revealEarly(blind, ids, h);
    if (early) { h.revealed = early; redraw(); } // recorded: a finding seen before the reading is part of how the review went
    const mine = new Set(ids);
    const body = revealBody(d.findings.filter((f) => live(f) && mine.has(f.hunk)), h.comments.filter((c) => c.hunk !== null && mine.has(c.hunk)), place);
    setFloat({ title: `${item.chapter + 1} · ${chapterTitle} · what the model found`, tall: true, color: "yellow", body, copy: body });
  };
  // The preview ends with what Enter will do: where the file goes, where it posts, and the document's
  // command, if it has one, which runs only after its own keypress (x) in this preview.
  // Undecided findings lead the preview, so a pass left unfinished is seen before anything posts.
  const preview = (hook: boolean, coverage: boolean) => {
    const p = planOf(r, files, { coverage });
    setMode({ kind: "preview", hook, coverage });
    setFloat({ title: `${VERDICT[h.verdict!]} · Enter ${dryRun ? "prints the calls" : "submits"}${p.hook ? `, x ${hook ? "disallows" : "allows"} the command` : ""}${p.adapter ? `, v ${coverage ? "drops" : "adds"} the coverage line` : ""}, Esc goes back`, color: "green", tall: true, body: `${undecidedNote(visible(), h, place, hidden.size > 0)}${writeup(d, files)}\n${describe(p, hook, dryRun)}` });
  };
  // Anything blocking makes request changes the verdict Enter picks; without one, Enter keeps the verdict already chosen, if any.
  const verdictDefault = (): Verdict | undefined => defaultVerdict(visible(), h) ?? h.verdict;

  // Fast typing or a paste can deliver several plain characters in one chunk ("781G"): take them one at a time.
  useInput((input, key) => { if (input.length > 1 && !key.ctrl && !key.meta) for (const c of input) handle(c, key); else handle(input, key); });
  const scrollFloat = (ch: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): boolean => {
    const by = key.pageDown || key.ctrl && ch === "d" ? pageStep(floatH) : key.pageUp || key.ctrl && ch === "u" ? -pageStep(floatH)
      : mode.kind === "preview" && (ch === "j" || key.downArrow) ? 1 : mode.kind === "preview" && (ch === "k" || key.upArrow) ? -1 : 0;
    if (!by) return false;
    setScroll((s) => clampScroll(s + by, floatLines.length, floatH));
    return true;
  };
  const stateOf = (): KeyState => float ? (float.finding ? { box: "finding" } : { box: "info", copyable: !!float.copy }) : { box: null, blind };
  const handle = (ch: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (busy) return;
    if (mode.kind === "verdict") {
      const v: Verdict | undefined = ch === "a" ? "approve" : ch === "r" ? "request_changes" : ch === "c" ? "comment" : key.return ? verdictDefault() : undefined;
      if (key.escape) { setMode({ kind: "nav" }); return; }
      if (v) { h.verdict = v; save(r); preview(false, false); }
      return;
    }
    if (mode.kind === "preview") {
      if (key.escape) { setMode({ kind: "verdict" }); setFloat(null); return; }
      if (key.return) { onDone({ kind: "submit", hook: mode.hook, coverage: mode.coverage }); exit(); return; }
      if (ch === "x" && d.on_submit) { const at = scroll; preview(!mode.hook, mode.coverage); setScroll(at); return; }
      if (ch === "v" && planOf(r, files).adapter) { const at = scroll; preview(mode.hook, !mode.coverage); setScroll(at); return; }
      scrollFloat(ch, key);
      return;
    }
    if (mode.kind !== "nav") {
      if (key.escape) { setMode({ kind: "nav" }); setInput(""); return; }
      if (key.return) {
        const text = input.trim();
        setMode({ kind: "nav" }); setInput("");
        const f = mode.kind === "reason" ? d.findings.find((x) => x.id === mode.id) : mode.kind === "comment" && mode.decide ? d.findings.find((x) => x.id === mode.decide!.id) : undefined;
        const at = new Date().toISOString();
        if (mode.kind === "reason") { if (f) decided(decide(h, f, "dismissed", { reason: text, at })); return; }
        // An emptied comment decides nothing: the finding stays as it was.
        if (mode.kind === "comment" && mode.decide) { if (f && text) decided(decide(h, f, mode.decide.kind, { text, at })); return; }
        if (mode.kind === "comment" && text) {
          h.comments.push({ hunk: mode.general ? null : item?.id ?? null, ...(mode.general ? { side: "new", line: null } : anchor()), text, at: new Date().toISOString() });
          redraw();
        }
        if (mode.kind === "ask" && item) {
          setBusy("asking…"); setFloat({ title: text || "Explain this hunk", body: "…" });
          ask(r, files, item.id, text).then((a) => setFloat({ title: text || "This hunk", body: a, copy: askText(text || "Explain this hunk", a) }), (e) => setFloat({ title: "ask failed", body: String((e as Error).message), color: "red" })).finally(() => setBusy(null));
        }
        return;
      }
      if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
      // A prefilled title is often rewritten whole: ctrl-u clears the line, ctrl-w the last word, as in a shell.
      else if (key.ctrl && ch === "u") setInput("");
      else if (key.ctrl && ch === "w") setInput((s) => s.replace(/\S+\s*$/, ""));
      else if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
      return;
    }

    // ---- nav, and the boxes over it: a key resolves to an action id through keys.ts (state + key → action) and the
    // handler dispatches on the id, so the footer and the handler read one table. The documented exceptions stay raw
    // here: Esc, paging, a count, gg/G and the arrow keys.
    const count = countRef.current, pending = pendingRef.current;
    setNote(null);
    const state = stateOf();
    if (key.escape) { setFloat(null); setCount(""); setPending(null); return; }
    if (pending) {
      const p = pending; setPending(null);
      if (p === "g") { if (ch === "g") setPos({ ...pos, line: 0 }); return; }
      const id = actionOf(state, p + ch);
      if (id) act(id);
      return;
    }
    if (key.ctrl || key.pageDown || key.pageUp) { scrollFloat(ch, key); return; } // before the letters: ctrl-d is a page, not a letter key
    // A box open: only the keys its footer lists act, so the footer is the truth. Hide closes any box and records nothing.
    if (float && !actionOf(state, ch) && !startsChord(state, ch)) return;
    if (/^[0-9]$/.test(ch) && (count || ch !== "0")) { setCount(count + ch); return; }
    const n = count ? parseInt(count, 10) : undefined;
    setCount("");
    const toLine = () => { const at = gotoLine(items, pos.item, n!); if (at) { setPos(at); setFloat(null); } };
    if (ch === "g") { if (n !== undefined) toLine(); else setPending("g"); return; }
    if (ch === "G") { if (n !== undefined) toLine(); else setPos({ ...pos, line: Math.max(0, lines.length - 1) }); return; }
    if (startsChord(state, ch)) { setPending(ch); return; }
    const id = actionOf(state, ch) ?? (key.downArrow ? "nav.line_down" : key.upArrow ? "nav.line_up" : key.rightArrow ? "nav.next_hunk" : key.leftArrow ? "nav.prev_hunk" : undefined);
    if (id) act(id, n); else scrollFloat(ch, key);
  };

  // What each action does. Every id in the key tables has a case here (a test holds the two together).
  const act = (id: string, n?: number) => {
    switch (id) {
      case "nav.quit": onDone({ kind: "quit" }); exit(); return;
      case "nav.bindings": setFloat({ title: "Key bindings · reading", body: bindingsBody(stateOf()), copy: bindingsBody(stateOf()) }); return;
      case "nav.submit": setMode({ kind: "verdict" }); setFloat(null); return;
      case "nav.line_down": setPos({ ...pos, line: Math.min(lines.length - 1, line + (n ?? 1)) }); return;
      case "nav.line_up": setPos({ ...pos, line: Math.max(0, line - (n ?? 1)) }); return;
      case "nav.next_hunk": goItem(pos.item + (n ?? 1)); return;
      case "nav.prev_hunk": goItem(pos.item - (n ?? 1)); return;
      case "nav.next_chapter": goChapter(1); return;
      case "nav.prev_chapter": goChapter(-1); return;
      case "nav.next_finding": case "finding.next": case "info.next_finding": jumpFinding(1); return;
      case "nav.prev_finding": case "finding.prev": case "info.prev_finding": jumpFinding(-1); return;
      case "finding.hide": case "info.hide": setFloat(null); return;
      case "nav.why": {
        if (!item) return;
        const body = item.mechanical ? `${MECHANICAL_INTENT}\n\nMechanical: ${item.mechanical}. Classified by rule, not by a model.` : `${chapter?.intent ? chapter.intent + "\n\n" : ""}${chapter?.why || "The guide gave no reason for this chapter."}`;
        setFloat({ title: `${item.chapter + 1} · ${chapterTitle}`, body, copy: item.mechanical ? body : whyText(chapterTitle, chapter?.intent, chapter?.why || "The guide gave no reason for this chapter.") });
        return;
      }
      case "nav.copy": case "finding.copy": case "info.copy": {
        // An open box copies its own text; with none open, the cursor line's reference, which is what you paste into a note.
        const l = lines[line], at = l ? l.n ?? l.o : null;
        const text = float ? float.copy : item && at !== null ? `${item.path}:${at}` : undefined;
        setNote(text ? confirmation(copier(text)) : "nothing to copy here");
        return;
      }
      case "nav.reveal": reveal(); return; // listed only with --blind
      case "nav.finding_here": { // the next finding in this hunk, from the cursor, wrapping
        if (item && hidden.has(item.id)) { setFloat({ title: "Findings", body: `Hidden until you have been through this chapter. Close this with ${keyOf("info.hide")}, then ${keyOf("nav.reveal")} reveals them now (and the review notes you did).` }); return; }
        if (!findingsHere.length) { setFloat({ title: "Findings", body: `None in this hunk. ${keyOf("nav.next_finding")} jumps to the next one anywhere.` }); return; }
        let at = lines.findIndex((l, i) => i > line && findingsAt(l).length);
        if (at < 0) at = lines.findIndex((l) => findingsAt(l).length);
        if (at >= 0) setPos({ ...pos, line: at });
        showFinding((at >= 0 ? findingsAt(lines[at]!) : findingsHere)[0]!);
        return;
      }
      case "finding.not_an_issue": { const f = target(); if (f) { setMode({ kind: "reason", id: f.id }); setInput(decisionOf(h, f.id)?.reason ?? ""); } return; }
      case "finding.undo": {
        const f = target();
        if (!f) return;
        if (!decisionOf(h, f.id)) { setNote("nothing decided on this finding"); return; }
        Object.assign(h, undo(h, f.id)); redraw(); showFinding(f); return;
      }
      case "finding.block": case "finding.comment": {
        const f = target();
        if (!f) return;
        // The comment starts as the finding's title (or the comment already written for it) and is saved only on Enter.
        setMode({ kind: "comment", general: false, decide: { id: f.id, kind: id === "finding.block" ? "block" : "comment" } });
        setInput(linkedComment(h, f.id)?.text ?? titleOf(f));
        return;
      }
      case "nav.edit": {
        if (!item) return;
        const l = lines[line];
        const at = l?.n ?? lines.slice(line).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
        if (beside) { const err = beside(item.path, at); if (err) setFloat({ title: "editor", body: err, color: "red" }); return; }
        onDone({ kind: "edit", path: item.path, line: at }); exit();
        return;
      }
      case "nav.note": setMode({ kind: "comment", general: false }); return;
      case "nav.general_note": setMode({ kind: "comment", general: true }); return;
      case "nav.ask": setMode({ kind: "ask" }); return;
      case "nav.wrap": setWrap(!wrap); setPanX(0); return;
      case "nav.pan_left": case "nav.pan_right": if (!wrap) setPanX(clampX(panX + (id === "nav.pan_right" ? PAN : -PAN), longest, codeCols)); return;
    }
  };

  // ---- layout
  const L = layoutOf(cols);
  const { railW, mainW, gutterW, codeW, floatW, floatInner } = L;
  const codeCols = codeW - 1; // the +/- sign takes the first column
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && h.visited.includes(i.id)).length;
  const liveFindings = d.findings.filter(open).length;
  const anyHidden = d.findings.some((f) => live(f) && !unhidden(f));

  // A finding's float sits right under the cursor line (the summary at the top of the hunk), so the window keeps that many rows free.
  const leadLines = float?.lead ? wrapText(float.lead, floatInner) : [];
  const floatLines = float ? [...leadLines, ...(leadLines.length ? [""] : []), ...wrapText(float.body, floatInner)] : [];
  const floatH = float ? floatHeight(floatLines.length, rows, !!float.tall) : 0;
  const sc = float ? clampScroll(scroll, floatLines.length, floatH) : 0;
  const shownFloat = floatLines.slice(sc, sc + floatRows(floatH));
  const bodyRows = rows - 5; // header, hunk header, intent, footer, spare
  const longest = Math.max(0, ...spans.map(lengthOf));
  const x = wrap ? 0 : clampX(panX, longest, codeCols);
  const heights = lines.map((l, i) => (wrap ? rowsFor(lengthOf(spans[i] ?? []), codeCols) : 1) + notesAt(l).length);
  const { start, end } = windowOf(heights, line, Math.max(3, bodyRows - floatH));
  const shown = lines.slice(start, end);
  const fit = (t: string) => t.length > codeW ? t.slice(0, codeW - 1) + "…" : t;

  /** The code of line `i` as rows of spans: one row scrolled by `x`, or every row it wraps to. */
  const rowsOf = (i: number): Span[][] => {
    const sp = spans[i] ?? [], len = lengthOf(sp);
    if (wrap) return Array.from({ length: rowsFor(len, codeCols) }, (_, k) => sliceSpans(sp, k * codeCols, (k + 1) * codeCols));
    const cut = len > x + codeCols;
    const vis = sliceSpans(sp, x, x + codeCols - (cut ? 1 : 0));
    return [cut ? [...vis, { text: "…", kind: "comment" }] : vis];
  };

  // A finding's box is rounded and coloured by severity; the opening summary is double-ruled in magenta, so they cannot be mistaken for each other.
  const floatBox = (left: number) => float ? (
    <Box flexDirection="column" marginLeft={left} width={floatW} height={floatH} overflow="hidden" borderStyle={float.summary ? "double" : "round"} borderColor={float.color ?? "gray"} paddingX={1}>
      <Text bold color={float.color} wrap="truncate">{float.title}{busy ? <Text dimColor> · {busy}</Text> : null}{floatLines.length > floatRows(floatH) ? <Text dimColor> · {sc + 1}-{Math.min(floatLines.length, sc + floatRows(floatH))}/{floatLines.length} PgUp/PgDn</Text> : null}</Text>
      {shownFloat.map((t, j) => <Text key={j} bold={sc + j < leadLines.length} wrap="truncate">{t}</Text>)}
    </Box>
  ) : null;

  const footer = () => {
    switch (mode.kind) {
      case "verdict": {
        const dv = verdictDefault(), opt = (k: string, v: Verdict, label: string) => dv === v ? <Text bold>{k} {label} (Enter)</Text> : <Text>{k} {label}</Text>;
        return <Text><Text color="green" bold> verdict › </Text>{opt("a", "approve", "approve")}   {opt("r", "request_changes", "request changes")}   {opt("c", "comment", "comment")}   <Text dimColor>Esc cancel</Text></Text>;
      }
      case "reason": return <Text><Text color="cyan" bold> not an issue, why? › </Text>{input}<Text inverse> </Text><Text dimColor>  (optional, never posted; Enter to decide, Esc to cancel)</Text></Text>;
      case "preview": return <Text wrap="truncate" dimColor> Enter {dryRun ? "prints the calls" : "submits"}{planOf(r, files).adapter ? ` · v ${mode.coverage ? "drop" : "add"} coverage line` : ""}{d.on_submit ? ` · x ${mode.hook ? "disallow" : "allow"} the document's command` : ""} · Esc back to the verdict · j/k PgUp/PgDn scroll</Text>;
      case "nav": if (note) return <Text wrap="truncate" color="green"> {note}</Text>;
        return <Text wrap="truncate" dimColor> {busy ? `${busy} keys wait until it answers` : float ? (float.finding ? findingFooter() : infoFooter(!!float.copy, floatLines.length > floatRows(floatH))) : navFooter(cols, blind)}{countRef.current || pendingRef.current ? <Text color="cyan">   {countRef.current}{pendingRef.current}</Text> : null}</Text>;
      default: {
        const decideKind = mode.kind === "comment" ? mode.decide?.kind : undefined;
        const label = mode.kind === "ask" ? "ask" : decideKind === "block" ? "block on it" : decideKind ? "comment on the finding" : mode.general ? "summary comment" : "comment";
        return <Text><Text color="cyan" bold> {label} › </Text>{input}<Text inverse> </Text><Text dimColor>  ({decideKind ? "Enter saves, ctrl-u clears, Esc cancels the decision" : "Enter to send, Esc to cancel"})</Text></Text>;
      }
    }
  };

  if (tooSmall(term)) return <Text wrap="truncate">terminal too small, need {MIN_COLS}x{MIN_ROWS}</Text>;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box justifyContent="space-between">
        <Box width={cols - 34}><Text wrap="truncate"><Text bold> {d.target.title}</Text><Text dimColor>  {d.target.url ?? d.target.label}</Text></Text></Box>
        <Box width={32} justifyContent="flex-end"><Text>{seen}/{total} read · <Text color="yellow">{liveFindings} ▲{anyHidden ? "?" : ""}</Text> · {h.comments.length} comment{h.comments.length === 1 ? "" : "s"} </Text></Box>
      </Box>
      <Box flexGrow={1}>
        <Box width={railW} flexDirection="column" borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} borderColor="gray" paddingRight={1}>
          <Text dimColor>{L.narrow ? " #" : " READ IN ORDER"}</Text>
          {[...d.plan.chapters.map((c, i) => ({ i, title: c.title })), ...(d.plan.mechanical.length ? [{ i: d.plan.chapters.length, title: `Mechanical (${d.plan.mechanical.length})` }] : [])].map(({ i, title }) => {
            const mine = items.filter((x) => x.chapter === i);
            const done = mine.length > 0 && mine.every((x) => h.visited.includes(x.id));
            const here = item?.chapter === i;
            const fs = d.findings.filter((f) => open(f) && mine.some((x) => x.id === f.hunk)).length;
            const blindFs = chapterHidden(blind, chapters[i] ?? [], h) && d.findings.some((f) => live(f) && mine.some((x) => x.id === f.hunk));
            return (
              <Box key={i} flexDirection="column">
                <Text color={here ? "cyan" : done ? "green" : undefined} bold={here} wrap="truncate">
                  {here ? "▸" : done ? "✓" : " "}{L.narrow ? "" : " "}{i + 1}{L.narrow ? "" : ` ${title}`}{fs ? <Text color="yellow">{L.narrow ? "" : " "}▲{fs}</Text> : blindFs ? <Text color="yellow">{L.narrow ? "" : " "}▲?</Text> : null}
                </Text>
                {here && !L.narrow && mine.map((x) => {
                  const cur = x === item;
                  return <Text key={x.id} color={cur ? "cyan" : undefined} dimColor={!cur && h.visited.includes(x.id)} wrap="truncate">   {cur ? "›" : " "} {x.path.split("/").pop()}:{x.hunk.newStart}{d.findings.some((f) => f.hunk === x.id && open(f)) ? " ▲" : ""}</Text>;
                })}
              </Box>
            );
          })}
        </Box>
        <Box width={mainW} flexDirection="column" paddingLeft={1}>
          {item && hunk ? (
            <>
              <Text wrap="truncate">
                <Text bold>{item.path}</Text>
                <Text dimColor>{hunk.context.trim() ? ` · ${hunk.context.trim()}` : ""} · {where(hunk)} · {pos.item + 1}/{items.length}{wrap ? " · wrapped" : x ? ` · →${x}` : ""}</Text>
              </Text>
              <Text wrap="truncate">
                {item.mechanical
                  ? <Text color="magenta">  ▸ {MECHANICAL_INTENT} · {item.mechanical}</Text>
                  : chapter?.intent ? <Text color="cyan">  ▸ {chapter.intent}</Text> : <Text dimColor>  {chapterTitle}</Text>}
              </Text>
              {float?.summary ? floatBox(0) : null}
              {shown.map((l, k) => {
                const i = start + k;
                const cur = i === line;
                const fs = findingsAt(l), ns = notesAt(l);
                const worst = fs.filter(open).sort(worstFirst)[0];
                const mark = worst ? <Text color={SEV[worst.severity]}>▲</Text> : fs.length ? <Text dimColor>△</Text> : ns.length ? <Text color="cyan">»</Text> : <Text> </Text>;
                const num = String(l.n ?? l.o ?? "").padStart(gutterW);
                const color = l.t === "+" ? "green" : l.t === "-" ? "red" : undefined;
                const changed = l.t !== " ";
                const code = rowsOf(start + k); // `shown` starts at `start`; spans are indexed over the whole hunk
                return (
                  <Box key={i} flexDirection="column">
                    {code.map((row, k) => {
                      const used = lengthOf(row);
                      return (
                        <Text key={k} wrap="truncate">
                          {k === 0
                            ? <><Text dimColor={!cur} color={cur ? "cyan" : undefined}>{num}</Text> {mark} <Text color={color} inverse={cur}>{l.t}</Text></>
                            : <Text dimColor>{" ".repeat(gutterW + 3)}↪</Text>}
                          {row.map((sp, j) => { const st = styleOf(sp.kind, changed); return <Text key={j} color={st.color ?? color} bold={st.bold} italic={st.italic} dimColor={st.dim} inverse={cur}>{sp.text}</Text>; })}
                          {cur ? <Text color={color} inverse>{" ".repeat(Math.max(0, codeCols - used))}</Text> : null}
                        </Text>
                      );
                    })}
                    {ns.map((n, j) => <Text key={j} color="cyan" wrap="truncate">{" ".repeat(gutterW + 3)}» {fit(n.text)}</Text>)}
                    {cur && float && !float.summary ? floatBox(gutterW + 2) : null}
                  </Box>
                );
              })}
            </>
          ) : <Text dimColor>Nothing to read: the diff is empty.</Text>}
        </Box>
      </Box>
      <Box>{footer()}</Box>
    </Box>
  );
}

/** Run the app once; resolves with what the reader wants next. State lives on the review object and is saved as it changes. */
export function show(review: Review, files: FileDiff[], beside?: Beside, blind = false, dryRun = false): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome = { kind: "quit" };
    process.stdout.write("\x1b[?1049h\x1b[H");
    const app = render(<App review={review} files={files} beside={beside} blind={blind} dryRun={dryRun} onDone={(o) => { outcome = o; }} />, { exitOnCtrlC: true });
    app.waitUntilExit().then(() => { app.clear(); process.stdout.write("\x1b[?1049l"); save(review); resolve(outcome); });
  });
}
