// The screen. A rail of chapters on the left, one hunk at a time on the right, and a floating box
// for whatever wants explaining: why a chapter matters, a finding, the answer to a question, the
// review before you submit it.
//
// The app owns the terminal; an editor is something it launches. `v e` hands back an `edit` outcome
// with the file and line under the cursor, the CLI runs the editor in the head worktree, then renders
// the app again with the same state. Inside tmux the CLI passes `beside` instead, and the editor opens in
// a split pane while this screen stays up.
//
// Keys are key map v2 (keys.ts): arrows move, and the prefixes a/f/v/g hold the rest. Deciding on findings is the
// first pass: `g f` opens the next one, and one key decides it (b block on it, c comment, i ignore; x closes the box
// without deciding, and deciding again changes the decision). b and c open the ordinary comment line prefilled with the
// finding's title, so what posts is what the reader saved. Each decision moves straight to the next undecided finding.
// The rules live in triage.ts.
//
// Everything shown comes from the review document (`review.doc`), whoever produced it; the rest of
// the review is only where the cursor was and where the worktree is.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { where, type DiffLine, type FileDiff } from "./diff.ts";
import { claimAddsTo, hunksOf, MECHANICAL_INTENT, titleOf, worstFirst, type Finding, type HunkAt } from "./guide.ts";
import { ask, preparedBy, save, VERDICT, writeup, type Pos, type Review } from "./build.ts";
import type { Doc, Human, Verdict } from "./document.ts";
import { chapterHidden, hiddenHunks } from "./blind.ts";
import { chapterStart, fileEdge, gotoLine, nextBySeverity, nextFindingWrapping, type NavItem } from "./nav.ts";
import { highlightLines, langOf, lengthOf, sliceSpans, styleOf, type Span } from "./highlight.ts";
import { clampScroll, floatHeight, floatRows, layoutOf, pageStep, rowsFor, windowOf, wrapText } from "./layout.ts";
import type { Beside } from "./editor.ts";
import { askText, confirmation, findingText, systemCopier, whyText, type Copier } from "./clipboard.ts";
import { describe, planOf } from "./submit.ts";
import { decide, decisionOf, defaultVerdict, LABEL, linkedComment, nextUndecided, progress, suggestionHint, undecidedNote } from "./triage.ts";
import { type KeyState, keyOf, rowById } from "./keys.ts";
import { pendingText, step, tokenOf, type InkKey, type Pending } from "./chord.ts";
import { answersBody, answersFor, answerText, type Answer } from "./ask-docs.ts";
import { entriesOf, panelOf, panelTitle } from "./panel.ts";
import { visible as printable } from "./sanitize.ts";
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

const SEV = { blocking: "red", warn: "yellow", nit: "blue" } as const;
/**
 * `lead` is bold above the body: a finding's title. `copy` is the float's source text for `y`: what it means, not the wrapped
 * and boxed lines drawn from `lead` and `body`. `finding` is the id of the finding shown, which the decision keys act on. `summary` is the review's opening overview: it is
 * drawn at the top of the hunk, in its own border, never under a cursor line where a finding sits.
 */
type Float = { title: string; lead?: string; body: string; color?: string; tall?: boolean; copy?: string; finding?: string; summary?: boolean };
/**
 * `decide`: this comment carries out a block or comment decision on that finding. `reason`: the optional reason for "not an issue".
 * `docs`: the question typed for the offline docs search (`ask` is the one for the model); `results`: its answers, `sel` the selected one.
 */
type Mode = { kind: "nav" } | { kind: "comment"; decide?: { id: string; kind: "block" | "comment" } } | { kind: "reason"; id: string } | { kind: "ask" } | { kind: "docs" } | { kind: "results"; query: string; answers: Answer[]; sel: number } | { kind: "verdict" } | { kind: "preview"; hook: boolean; coverage: boolean };

export type AppProps = {
  review: Review; files: FileDiff[]; onDone: (o: Outcome) => void;
  /** Open the editor in a pane beside this screen instead of taking the terminal over. */
  beside?: Beside;
  /** Override the terminal size (tests, mostly: there is no real terminal to measure). */
  size?: { cols: number; rows: number };
  /** Blind first pass: a chapter's findings stay hidden until every hunk in it has been visited. */
  blind?: boolean;
  /** `--dry-run`: the preview says that submit will only print the API calls. */
  dryRun?: boolean;
  /** How `y` reaches the clipboard; tests pass one that records instead of touching it. */
  copier?: Copier;
};

/** The opening box: the summary, the suggested verdicts and who prepared it. `a i` reopens exactly this; null when a review has neither. */
export function summaryFloat(review: Review): Float | null {
  const d = review.doc;
  // An imported review's verdict is only ever information here: submit never starts from it.
  const verdicts = (review.suggested ?? []).map((v) => `${v.by === "imported" ? "An imported review" : `${v.by}'s review`} suggested ${VERDICT[v.verdict]}${v.reason ? `: ${v.reason.replace(/[.\s]+$/, "")}` : ""}.`);
  const suggested = verdicts.length ? [...verdicts, "That is information only: you pick your own verdict at submit."].join("\n") : "";
  if (!d.plan.summary && !suggested) return null;
  const hint = `Esc closes this; ${keyOf("ai.info")} brings it back. The key panel lists the keys for where you are.`;
  return { title: "Summary of this change · not a finding", summary: true, color: "magenta", copy: d.plan.summary || suggested, body: [d.plan.summary, suggested, preparedBy(review.ai?.runs), hint].filter(Boolean).join("\n\n") };
}

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
  const opening = () => summaryFloat(review);
  const [float, setFloatRaw] = useState<Float | null>(() => opening());
  const [scroll, setScroll] = useState(0);
  // Tab moves focus into the box (the content area, until the new layout gives it a place of its own) and back.
  const [focus, setFocus] = useState<"code" | "content">("code");
  // What `y` just did, or why a key did nothing, shown in the footer until the next key.
  const [note, setNote] = useState<string | null>(null);
  const setFloat = (f: Float | null) => { setScroll(0); setFloatRaw(f); if (!f || f.finding) setFocus("code"); };
  const [mode, setMode] = useState<Mode>({ kind: "nav" });
  const [input, setInput] = useState("");
  // Keys can arrive several to a chunk (a fast "g12"), all handled by one closure: the pending prefix lives in a ref.
  const pendingRef = useRef<Pending | null>(null);
  const [, tick] = useState(0);
  const setPending = (p: Pending | null) => { if (p !== pendingRef.current) { pendingRef.current = p; tick((n) => n + 1); } };
  const [busy, setBusy] = useState<string | null>(null);
  // Long lines are cut with an ellipsis, or wrap onto more rows (v w).
  const [wrap, setWrap] = useState(false);

  // Where a key is pressed: the submit steps, a prompt, the docs results, an open finding, the content area (Tab), or the code.
  const keyState: KeyState = mode.kind === "verdict" ? { state: "submit", step: "verdict" }
    : mode.kind === "preview" ? (() => { const p = planOf(r, files, { coverage: mode.coverage }); return { state: "submit" as const, step: "preview" as const, dryRun, hook: p.hook ? mode.hook : null, coverage: p.adapter ? mode.coverage : null }; })()
    : mode.kind === "results" ? { state: "content", results: true }
    : mode.kind !== "nav" ? { state: "prompt", kind: mode.kind, decide: mode.kind === "comment" && !!mode.decide }
    : float?.finding ? { state: "finding" }
    : focus === "content" && float ? { state: "content" } : { state: "code" };

  const item = items[pos.item];
  const hunk = item?.hunk ?? null;
  const lines = hunk?.lines ?? [];
  const line = Math.min(pos.line, Math.max(0, lines.length - 1));
  // Tabs become spaces before colouring so a token's columns are the columns it is drawn in.
  const shape = useMemo(() => lines.map((l) => printable(l.text.replace(/\t/g, "    "))), [item?.id]);
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
  // What the gutter marks and the go-to keys step through: the live findings the reader may see.
  const visible = () => d.findings.filter((f) => live(f) && unhidden(f));
  const withdrawnCount = d.findings.filter((f) => !live(f) && unhidden(f)).length;
  const findingsHere = item ? visible().filter((f) => f.hunk === item.id) : [];
  const findingsAt = (l: DiffLine) => findingsHere.filter((f) => f.side === "new" ? l.n !== null && f.line === l.n : l.o !== null && f.line === l.o);
  const notesAt = (l: DiffLine) => h.comments.filter((n) => n.hunk === item?.id && n.line !== null && (n.side === "new" ? n.line === l.n : n.line === l.o));

  // Seeing a hunk is reading it.
  useEffect(() => { if (item && !h.visited.includes(item.id)) { h.visited.push(item.id); redraw(); } }, [item?.id]);

  // A move to another block closes whatever box was open; a move within the block keeps it.
  const goTo = (at: Pos) => { if (at.item !== pos.item) setFloat(null); setPos(at); };
  const goChapter = (dir: 1 | -1) => {
    if (!item) return;
    const target = item.chapter + dir;
    const i = dir > 0 ? items.findIndex((x) => x.chapter >= target) : items.findIndex((x) => x.chapter === Math.max(0, target));
    if (i >= 0 && i !== pos.item) goTo({ item: i, line: 0 });
  };
  // ↓ and ↑ run on from the end of a block into the next one in reading order, and back.
  const lineBy = (dir: 1 | -1) => {
    const next = line + dir;
    if (next >= 0 && next < lines.length) { setPos({ ...pos, line: next }); return; }
    const i = pos.item + dir;
    if (i < 0 || i >= items.length) return;
    goTo({ item: i, line: dir > 0 ? 0 : Math.max(0, items[i]!.hunk.lines.length - 1) });
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
  const hiddenNote = () => hidden.size ? " Chapters you have not read yet keep theirs hidden until you have been through them." : "";
  // After a decision: straight on to the next undecided finding, so a whole pass is one key per finding.
  const decided = (next: Human) => {
    Object.assign(h, next); redraw();
    const hit = nextUndecided(items, visible(), h, { item: pos.item, line });
    if (hit) { setPos({ item: hit.item, line: hit.line }); showFinding(hit.finding); return; }
    const p = progress(visible(), h);
    setFloat({ title: `Findings · ${p.decided}/${p.total} decided`, color: "green", body: `Every finding${hidden.size ? " you can see" : ""} is decided.${hiddenNote()} Esc closes this, then ${keyOf("review.submit")} submits; ${keyOf("go.next_finding")} and ${keyOf("go.prev_finding")} step back through them, and deciding one again changes it.` });
  };
  const land = (hit: (Pos & { finding: Finding }) | undefined) => {
    if (!hit) { setFloat({ title: "Findings", body: `There are no findings to go to.${hiddenNote()}` }); return; }
    setPos({ item: hit.item, line: hit.line });
    showFinding(hit.finding);
  };
  const place = (id: string, l: number | null) => `${printable(items.find((x) => x.id === id)?.path ?? id)}${l !== null ? `:${l}` : ""}`;
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

  // Fast typing or a paste can deliver several plain characters in one chunk ("g12"): take them one at a time. An escape
  // sequence Ink did not read as a key (it hands those over with the ESC stripped) stays whole, for tokenOf to read.
  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !/^[[O][0-9;]*[A-Za-z~]$/.test(input)) for (const c of input) handle(c, {});
    else handle(input, key);
  });
  const scrollBy = (by: number) => setScroll((s) => clampScroll(s + by, floatLines.length, floatH));

  /**
   * Every key goes through the tables: tokenOf reads the key, `step` (chord.ts) resolves it in the current state, with any
   * pending prefix, to an action id, and `act` does it. The only key outside the tables is Esc, which backs out; in a
   * prompt, anything that is not one of its keys is text.
   */
  const handle = (ch: string, key: InkKey) => {
    if (busy) return;
    const tok = tokenOf(ch, key);
    if (!tok) return;
    setNote(null);
    const res = step(keyState, pendingRef.current, tok);
    setPending(res.pending);
    if (res.out.kind === "act") { act(res.out.id, res.out.n); return; }
    if (res.out.kind === "escape") { backOut(); return; }
    if (keyState.state === "prompt" && res.out.kind === "none") {
      if (tok === "backspace") setInput((s) => s.slice(0, -1));
      else if (tok === "space") setInput((s) => s + " ");
      else if ([...tok].length === 1) setInput((s) => s + tok);
    }
  };
  // Esc with nothing pending: out of the docs results, out of the content area, or the open box closes.
  const backOut = () => {
    if (mode.kind === "results") { setMode({ kind: "nav" }); setFloat(null); return; }
    if (keyState.state === "content") { setFocus("code"); return; }
    setFloat(null);
  };

  // The answers to a docs question, as a box over the diff with focus in it; the same box is redrawn as the selection moves.
  const showResults = (query: string, answers: Answer[], sel: number) => {
    setMode({ kind: "results", query, answers, sel });
    setFloat({ title: `Search the docs · ${query}`, color: "cyan", tall: true, body: answersBody(answers, sel) });
  };
  // A key whose behaviour comes with a later change says so, and does nothing else.
  const coming = (id: string) => { const a = rowById(id); setNote(`${keyOf(id)} ${a?.label ?? id}: not built yet, coming with ${a?.coming ?? "a later change"}`); };
  const copy = () => {
    if (mode.kind === "results") { const a = mode.answers[mode.sel]; setNote(a ? confirmation(copier(answerText(a))) : "nothing to copy here"); return; }
    // An open box copies its own text; with none open, the cursor line's reference, which is what you paste into a note.
    const l = lines[line], at = l ? l.n ?? l.o : null;
    const text = float ? float.copy : item && at !== null ? `${item.path}:${at}` : undefined;
    setNote(text ? confirmation(copier(text)) : "nothing to copy here");
  };
  // Enter in a prompt: what the typed line does depends on the prompt.
  const send = () => {
    if (mode.kind === "nav" || mode.kind === "results" || mode.kind === "verdict" || mode.kind === "preview") return;
    const text = input.trim();
    if (mode.kind === "docs") {
      setInput("");
      if (!text) { setMode({ kind: "nav" }); return; }
      try { showResults(text, answersFor(text), 0); } catch (e) { setMode({ kind: "nav" }); setFloat({ title: "search the docs failed", body: String((e as Error).message), color: "red" }); }
      return;
    }
    setMode({ kind: "nav" }); setInput("");
    const f = mode.kind === "reason" ? d.findings.find((x) => x.id === mode.id) : mode.kind === "comment" && mode.decide ? d.findings.find((x) => x.id === mode.decide!.id) : undefined;
    const at = new Date().toISOString();
    if (mode.kind === "reason") { if (f) decided(decide(h, f, "dismissed", { reason: text, at })); return; }
    // An emptied comment decides nothing: the finding stays as it was.
    if (mode.kind === "comment" && mode.decide) { if (f && text) decided(decide(h, f, mode.decide.kind, { text, at })); return; }
    if (mode.kind === "comment" && text) {
      h.comments.push({ hunk: item?.id ?? null, ...anchor(), text, at });
      redraw();
    }
    if (mode.kind === "ask" && item) {
      setBusy("asking…"); setFloat({ title: text || "Explain this block", body: "…" });
      ask(r, files, item.id, text).then((a) => setFloat({ title: text || "This block", body: a, copy: askText(text || "Explain this block", a) }), (e) => setFloat({ title: "ask failed", body: String((e as Error).message), color: "red" })).finally(() => setBusy(null));
    }
  };

  // What each action does. Every id in the key tables has a case here (a test holds the two together).
  const act = (id: string, n?: number) => {
    switch (id) {
      // ---- anywhere outside a finding
      case "review.quit": onDone({ kind: "quit" }); exit(); return;
      case "review.submit": setMode({ kind: "verdict" }); setFloat(null); return;
      case "review.copy": case "finding.copy": case "content.copy": copy(); return;
      case "review.search_docs": setMode({ kind: "docs" }); setInput(""); return;

      // ---- the code
      case "code.down": lineBy(1); return;
      case "code.up": lineBy(-1); return;
      case "code.next_chapter": goChapter(1); return;
      case "code.prev_chapter": goChapter(-1); return;
      case "code.open_finding": {
        if (item && hidden.has(item.id)) { setFloat({ title: "Findings", body: "Hidden until you have been through this chapter." }); return; }
        const l = lines[line], here = l ? [...findingsAt(l)].sort(worstFirst) : [];
        if (!here.length) { setNote(`no finding on this line; ${keyOf("go.next_finding")} goes to the next one`); return; }
        showFinding(here[0]!);
        return;
      }
      case "code.to_toc": {
        // The table of contents shows the chapter's intent and why; until it is drawn, they open here.
        if (!item) return;
        const body = item.mechanical ? `${MECHANICAL_INTENT}\n\nMechanical: ${item.mechanical}. Classified by rule, not by a model.` : `${chapter?.intent ? chapter.intent + "\n\n" : ""}${chapter?.why || "The guide gave no reason for this chapter."}`;
        setFloat({ title: `${item.chapter + 1} · ${chapterTitle}`, body, copy: item.mechanical ? body : whyText(chapterTitle, chapter?.intent, chapter?.why || "The guide gave no reason for this chapter.") });
        return;
      }
      case "code.focus_content": case "toc.focus_content":
        if (float && !float.finding) setFocus("content"); else setNote("the content area is empty");
        return;
      case "code.new_finding": setMode({ kind: "comment" }); return;

      // ---- the content area
      case "content.back": if (mode.kind === "results") backOut(); else setFocus("code"); return;
      case "content.down": case "content.up": {
        const dir = id === "content.down" ? 1 : -1;
        if (mode.kind === "results") showResults(mode.query, mode.answers, Math.max(0, Math.min(mode.answers.length - 1, mode.sel + dir)));
        else scrollBy(dir);
        return;
      }
      case "content.page_down": case "finding.page_down": case "submit.page_down": scrollBy(pageStep(floatH)); return;
      case "content.page_up": case "finding.page_up": case "submit.page_up": scrollBy(-pageStep(floatH)); return;

      // ---- inside a finding
      case "finding.close": case "finding.back": setFloat(null); return;
      case "finding.ignore": { const f = target(); if (f) { setMode({ kind: "reason", id: f.id }); setInput(decisionOf(h, f.id)?.reason ?? ""); } return; }
      case "finding.block": case "finding.comment": {
        const f = target();
        if (!f) return;
        // The comment starts as the finding's title (or the comment already written for it) and is saved only on Enter.
        setMode({ kind: "comment", decide: { id: f.id, kind: id === "finding.block" ? "block" : "comment" } });
        setInput(linkedComment(h, f.id)?.text ?? titleOf(f));
        return;
      }

      // ---- a: AI
      case "ai.info": setFloat(opening() ?? { title: "Summary", body: "There is no summary for this review." }); return;
      case "ai.ask": setMode({ kind: "ask" }); setInput(""); return;

      // ---- v: view
      case "view.editor": {
        if (!item) return;
        const l = lines[line];
        const at = l?.n ?? lines.slice(line).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
        if (beside) { const err = beside(item.path, at); if (err) setFloat({ title: "editor", body: err, color: "red" }); return; }
        onDone({ kind: "edit", path: item.path, line: at }); exit();
        return;
      }
      case "view.wrap": setWrap(!wrap); return;

      // ---- g: go to
      case "go.next_finding": case "go.prev_finding": land(nextFindingWrapping(items, visible(), { item: pos.item, line }, id === "go.next_finding" ? 1 : -1)); return;
      case "go.next_severity": case "go.prev_severity": land(nextBySeverity(items, visible(), target()?.id, id === "go.next_severity" ? 1 : -1)); return;
      case "go.top": case "go.end": { const at = fileEdge(items, pos.item, id === "go.top" ? "top" : "end"); if (at) goTo(at); return; }
      case "go.line": { const at = n !== undefined ? gotoLine(items, pos.item, n) : undefined; if (at) { setFloat(null); setPos(at); } return; }
      case "go.chapter": { const at = n !== undefined ? chapterStart(items, n) : undefined; if (at) goTo(at); else setNote(`there is no chapter ${n}`); return; }

      // ---- a line being typed
      case "prompt.send": send(); return;
      case "prompt.clear": setInput(""); return;
      case "prompt.word": setInput((s) => s.replace(/\S+\s*$/, "")); return;
      case "prompt.cancel": setMode({ kind: "nav" }); setInput(""); return;

      // ---- submit: the verdict, then the preview
      case "submit.approve": case "submit.request_changes": case "submit.comment": case "submit.default": {
        const v: Verdict | undefined = id === "submit.approve" ? "approve" : id === "submit.request_changes" ? "request_changes" : id === "submit.comment" ? "comment" : verdictDefault();
        if (v) { h.verdict = v; save(r); preview(false, false); }
        return;
      }
      case "submit.cancel": setMode({ kind: "nav" }); return;
      case "submit.send": if (mode.kind === "preview") { onDone({ kind: "submit", hook: mode.hook, coverage: mode.coverage }); exit(); } return;
      case "submit.hook": case "submit.coverage":
        if (mode.kind === "preview") { const at = scroll; preview(id === "submit.hook" ? !mode.hook : mode.hook, id === "submit.coverage" ? !mode.coverage : mode.coverage); setScroll(at); }
        return;
      case "submit.down": scrollBy(1); return;
      case "submit.up": scrollBy(-1); return;
      case "submit.back": setMode({ kind: "verdict" }); setFloat(null); return;

      // ---- keys whose behaviour comes with a later change: each says so
      case "toc.down": case "toc.up": case "toc.next_chapter": case "toc.prev_chapter": case "toc.expand": case "toc.collapse":
      case "review.settings": case "ai.draft": case "ai.accept": case "ai.discard": case "filter.high": case "filter.medium": case "filter.all":
      case "view.zen": case "view.fullscreen":
      case "settings.down": case "settings.up": case "settings.edit": case "settings.clear": case "settings.leave":
        coming(id); return;
    }
  };

  // ---- layout
  const L = layoutOf(cols);
  const { railW, mainW, gutterW, codeW, floatW, floatInner } = L;
  const codeCols = codeW - 1; // the +/- sign takes the first column
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && h.visited.includes(i.id)).length;
  const liveFindings = d.findings.filter(open).length;
  const anyHidden = d.findings.some((f) => live(f) && !unhidden(f));
  // The counts on the right of the header: read, open ▲, withdrawn (when any were), comments. The title gets the rest.
  const countsW = Math.max(32, `${seen}/${total} read · ${liveFindings} ▲${anyHidden ? "?" : ""}${withdrawnCount ? ` · ${withdrawnCount} withdrawn` : ""} · ${h.comments.length} comment${h.comments.length === 1 ? "" : "s"} `.length);

  // A finding's float sits right under the cursor line (the summary at the top of the hunk), so the window keeps that many rows free.
  const leadLines = float?.lead ? wrapText(float.lead, floatInner) : [];
  const floatLines = float ? [...leadLines, ...(leadLines.length ? [""] : []), ...wrapText(float.body, floatInner)] : [];
  // The panel takes its rows out of the screen before the box and the code divide what is left, so it covers neither.
  // It is always there: the keys for where you are, or a pending prefix's second keys.
  const pending = pendingRef.current;
  const keyPanel = panelOf(panelTitle(keyState, pending), entriesOf(keyState, pending), cols, rows);
  const avail = rows - keyPanel.height;
  const floatH = float ? floatHeight(floatLines.length, avail, !!float.tall) : 0;
  const sc = float ? clampScroll(scroll, floatLines.length, floatH) : 0;
  const shownFloat = floatLines.slice(sc, sc + floatRows(floatH));
  const bodyRows = avail - 5; // header, hunk header, intent, footer, spare
  const heights = lines.map((l, i) => (wrap ? rowsFor(lengthOf(spans[i] ?? []), codeCols) : 1) + notesAt(l).length);
  const { start, end } = windowOf(heights, line, Math.max(3, bodyRows - floatH));
  const shown = lines.slice(start, end);
  const fit = (t: string) => t.length > codeW ? t.slice(0, codeW - 1) + "…" : t;

  /** The code of line `i` as rows of spans: one row cut with an ellipsis, or every row it wraps to. */
  const rowsOf = (i: number): Span[][] => {
    const sp = spans[i] ?? [], len = lengthOf(sp);
    if (wrap) return Array.from({ length: rowsFor(len, codeCols) }, (_, k) => sliceSpans(sp, k * codeCols, (k + 1) * codeCols));
    const cut = len > codeCols;
    const vis = sliceSpans(sp, 0, codeCols - (cut ? 1 : 0));
    return [cut ? [...vis, { text: "…", kind: "comment" }] : vis];
  };

  // A finding's box is rounded and coloured by severity; the opening summary is double-ruled in magenta, so they cannot be mistaken for each other.
  const floatBox = (left: number) => float ? (
    <Box flexDirection="column" marginLeft={left} width={floatW} height={floatH} overflow="hidden" borderStyle={float.summary ? "double" : "round"} borderColor={float.color ?? "gray"} paddingX={1}>
      <Text bold color={float.color} wrap="truncate">{float.title}{busy ? <Text dimColor> · {busy}</Text> : null}{floatLines.length > floatRows(floatH) ? <Text dimColor> · {sc + 1}-{Math.min(floatLines.length, sc + floatRows(floatH))}/{floatLines.length} {float.finding ? "PgUp/PgDn" : `${keyOf("code.focus_content")} to scroll`}</Text> : null}{keyState.state === "content" ? <Text color="cyan"> · focused</Text> : null}</Text>
      {shownFloat.map((t, j) => <Text key={j} bold={sc + j < leadLines.length} wrap="truncate">{t}</Text>)}
    </Box>
  ) : null;

  const footer = () => {
    switch (mode.kind) {
      case "verdict": {
        const dv = verdictDefault(), hint = suggestionHint(review.suggested ?? [], (v) => VERDICT[v]);
        return <Text><Text color="green" bold> verdict › </Text>{dv ? <Text dimColor>Enter takes {VERDICT[dv]}</Text> : null}{hint ? <Text dimColor wrap="truncate">{dv ? " · " : ""}{hint}</Text> : null}</Text>;
      }
      case "reason": return <Text><Text color="cyan" bold> ignore · private note › </Text>{input}<Text inverse> </Text><Text dimColor>  (optional, never posted)</Text></Text>;
      case "preview": return <Text dimColor> </Text>;
      case "results": return note ? <Text wrap="truncate" color="green"> {note}</Text> : <Text dimColor> </Text>;
      case "nav": if (note) return <Text wrap="truncate" color="green"> {note}</Text>;
        return <Text wrap="truncate" dimColor> {busy ? `${busy} keys wait until it answers` : ""}{pending ? <Text color="cyan">   {pendingText(pending)}</Text> : null}</Text>;
      default: {
        const decideKind = mode.kind === "comment" ? mode.decide?.kind : undefined;
        const label = mode.kind === "docs" ? "search the docs" : mode.kind === "ask" ? "ask" : decideKind === "block" ? "block on it" : decideKind ? "comment on the finding" : "new finding";
        return <Text><Text color="cyan" bold> {label} › </Text>{input}<Text inverse> </Text></Text>;
      }
    }
  };

  if (tooSmall(term)) return <Text wrap="truncate">terminal too small, need {MIN_COLS}x{MIN_ROWS}</Text>;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box justifyContent="space-between">
        <Box width={cols - countsW - 2}><Text wrap="truncate"><Text bold> {d.target.title}</Text><Text dimColor>  {d.target.url ?? d.target.label}</Text></Text></Box>
        <Box width={countsW} justifyContent="flex-end"><Text>{seen}/{total} read · <Text color="yellow">{liveFindings} ▲{anyHidden ? "?" : ""}</Text>{withdrawnCount ? <Text dimColor> · {withdrawnCount} withdrawn</Text> : null} · {h.comments.length} comment{h.comments.length === 1 ? "" : "s"} </Text></Box>
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
                  return <Text key={x.id} color={cur ? "cyan" : undefined} dimColor={!cur && h.visited.includes(x.id)} wrap="truncate">   {cur ? "›" : " "} {printable(x.path.split("/").pop()!)}:{x.hunk.newStart}{d.findings.some((f) => f.hunk === x.id && open(f)) ? " ▲" : ""}</Text>;
                })}
              </Box>
            );
          })}
        </Box>
        <Box width={mainW} flexDirection="column" paddingLeft={1}>
          {item && hunk ? (
            <>
              <Text wrap="truncate">
                <Text bold>{printable(item.path)}</Text>
                <Text dimColor>{hunk.context.trim() ? ` · ${printable(hunk.context.trim())}` : ""} · {where(hunk)} · {pos.item + 1}/{items.length}{wrap ? " · wrapped" : ""}</Text>
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
                // ▲ open, △ decided, ▽ withdrawn (only while W shows them).
                const mark = worst ? <Text color={SEV[worst.severity]}>▲</Text> : fs.some(live) ? <Text dimColor>△</Text> : fs.length ? <Text dimColor>▽</Text> : ns.length ? <Text color="cyan">»</Text> : <Text> </Text>;
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
      {keyPanel.boxed
        ? <Box flexDirection="column" borderStyle="single" borderColor={pending ? "cyan" : "gray"} paddingX={1} width={keyPanel.width} height={keyPanel.height}><Text bold>{keyPanel.title}</Text>{keyPanel.lines.map((t, i) => <Text key={i} wrap="truncate">{t}</Text>)}</Box>
        : <Text wrap="truncate" dimColor> {keyPanel.lines[0]}</Text>}
      <Box><Box flexShrink={1}>{footer()}</Box></Box>
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
