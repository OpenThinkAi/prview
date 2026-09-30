// The screen (layout.ts has the geometry). A status area on top: the title, then the review's fields. In the middle,
// the rail of chapters and one hunk at a time, with a finding shown on its line as a short box. At the bottom, the
// content area, which shows one thing at a time (the summary, a chapter's why, a finding's detail, docs search
// results, an answer, a prompt, the submit steps), and beside it the key panel for where you are.
//
// The app owns the terminal; an editor is something it launches. `v e` hands back an `edit` outcome
// with the file and line under the cursor, the CLI runs the editor in the head worktree, then renders
// the app again with the same state. Inside tmux the CLI passes `beside` instead, and the editor opens in
// a split pane while this screen stays up.
//
// Keys are key map v2 (keys.ts): arrows move, and the prefixes a/f/v/g hold the rest. A review opens in the table of
// contents, whose cursor walks chapters and blocks (nav.ts) while the content area shows the chapter's intent and why;
// → enters a block's code and ← comes back out. Every finding has an action (block, comment or ignore), its severity's
// default until the reader picks one: inside a finding b, c or i picks it, and pressing one again changes it; x only
// closes the finding. b and c open the comment line in the content area prefilled with the finding's text (or the
// comment already written for it), so what posts is what the reader saved.
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
import { chapterStart, fileEdge, gotoLine, nextBySeverity, nextFindingWrapping, tocIndex, tocMove, tocRows, type NavItem, type TocMove } from "./nav.ts";
import { highlightLines, langOf, lengthOf, sliceSpans, styleOf, type Span } from "./highlight.ts";
import { boxLines, clampScroll, layoutOf, STATUS_H, pageStep, rowsFor, windowOf, wrapText } from "./layout.ts";
import type { Beside } from "./editor.ts";
import { askText, confirmation, findingText, systemCopier, whyText, type Copier } from "./clipboard.ts";
import { describe, planOf } from "./submit.ts";
import { actionOf, actionsNote, bySeverity, decide, decisionOf, DEFAULTS, defaultVerdict, IN_HOUSE, LABEL, linkedComment, suggestionHint, type Defaults } from "./triage.ts";
import { type KeyState, keyOf, rowById } from "./keys.ts";
import { pendingText, step, tokenOf, type InkKey, type Pending } from "./chord.ts";
import { answersBody, answersFor, answerText, type Answer } from "./ask-docs.ts";
import { entriesOf, panelOf, panelTitle } from "./panel.ts";
import { fitFields, GAP, statusFields } from "./status.ts";
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

const SEV = { high: "red", medium: "yellow", low: "blue" } as const;
/**
 * What the content area shows. `lead` is bold above the body: a finding's title. `tag` is drawn dim after the title (a
 * finding's "(default)"). `copy` is the source text for `y`: what it means, not the wrapped lines drawn from `lead` and
 * `body`. `finding` is the id of the finding shown: while it is set the finding is open, drawn as a short box on its line
 * (its header, its title and at most two lines of `claim`) with its whole detail here, and the action keys act on it.
 */
type Content = { title: string; tag?: string; lead?: string; body: string; color?: string; copy?: string; finding?: string; claim?: string };
/**
 * `decide`: this comment carries out a block or comment action on that finding. `reason`: the optional private note of an ignore.
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
  /** The action a finding starts with, by severity (the config's [defaults]). */
  defaults?: Defaults;
};

/** What the content area opens on: the summary, the suggested verdicts and who prepared it. `a i` shows exactly this again; null when a review has neither. */
export function summaryContent(review: Review): Content | null {
  const d = review.doc;
  // An imported review's verdict is only ever information here: submit never starts from it.
  const verdicts = (review.suggested ?? []).map((v) => `${v.by === "imported" ? "An imported review" : `${v.by}'s review`} suggested ${VERDICT[v.verdict]}${v.reason ? `: ${v.reason.replace(/[.\s]+$/, "")}` : ""}.`);
  const suggested = verdicts.length ? [...verdicts, "That is information only: you pick your own verdict at submit."].join("\n") : "";
  if (!d.plan.summary && !suggested) return null;
  const hint = `Esc closes this; ${keyOf("ai.info")} brings it back. The key panel lists the keys for where you are.`;
  return { title: "Summary of this change · not a finding", color: "magenta", copy: d.plan.summary || suggested, body: [d.plan.summary, suggested, preparedBy(review.ai?.runs), hint].filter(Boolean).join("\n\n") };
}

export function App({ review, files, onDone, beside, size, blind = false, dryRun = false, copier = systemCopier, defaults = DEFAULTS }: AppProps) {
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
  const opening = () => summaryContent(review);
  const [content, setContentRaw] = useState<Content | null>(() => opening());
  const [scroll, setScroll] = useState(0);
  // Tab moves focus into the content area and back; `v c` makes it the whole screen, `v z` hides the rail.
  const [focus, setFocus] = useState<"code" | "content">("code");
  // Out of the content area the arrows act in the table of contents (where a review opens) or in the code. In the
  // table of contents the cursor is on a block or (`onChapter`) on its chapter's row; the mechanical chapter starts collapsed.
  const [tree, setTree] = useState<"toc" | "code">("toc");
  const [onChapter, setOnChapter] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set(items[pos.item]?.chapter === d.plan.chapters.length ? [] : [d.plan.chapters.length]));
  const [full, setFull] = useState(false);
  const [zen, setZen] = useState(false);
  // What `y` just did, or why a key did nothing, shown in the footer until the next key.
  const [note, setNote] = useState<string | null>(null);
  const setContent = (f: Content | null) => { setScroll(0); setContentRaw(f); if (!f || f.finding) setFocus("code"); if (!f) setFull(false); };
  const [mode, setMode] = useState<Mode>({ kind: "nav" });
  const [input, setInput] = useState("");
  // Keys can arrive several to a chunk (a fast "g12"), all handled by one closure: the pending prefix lives in a ref.
  const pendingRef = useRef<Pending | null>(null);
  const [, tick] = useState(0);
  const setPending = (p: Pending | null) => { if (p !== pendingRef.current) { pendingRef.current = p; tick((n) => n + 1); } };
  const [busy, setBusy] = useState<string | null>(null);
  // Long lines are cut with an ellipsis, or wrap onto more rows (v w).
  const [wrap, setWrap] = useState(false);

  const item = items[pos.item];
  const hunk = item?.hunk ?? null;
  const lines = hunk?.lines ?? [];
  const line = Math.min(pos.line, Math.max(0, lines.length - 1));
  // Tabs become spaces before colouring so a token's columns are the columns it is drawn in.
  const shape = useMemo(() => lines.map((l) => printable(l.text.replace(/\t/g, "    "))), [item?.id]);
  const spans = useMemo(() => highlightLines(shape, item ? langOf(item.path) : undefined), [shape, item?.path]);
  const chapter = item ? d.plan.chapters[item.chapter] : undefined;
  const chapterTitle = item ? chapter?.title ?? "Mechanical" : "";

  // In the table of contents, with nothing else shown, the content area shows the cursor's chapter: its intent and why.
  const chapterView = (): Content | null => {
    if (!item) return null;
    const why = chapter?.why || "The guide gave no reason for this chapter.";
    const body = item.mechanical ? `${MECHANICAL_INTENT}\n\nMechanical: ${item.mechanical}. Classified by rule, not by a model.` : `${chapter?.intent ? chapter.intent + "\n\n" : ""}${why}`;
    return { title: `${item.chapter + 1} · ${chapterTitle}`, body, copy: item.mechanical ? body : whyText(chapterTitle, chapter?.intent, why) };
  };
  const view: Content | null = content ?? (tree === "toc" && mode.kind === "nav" ? chapterView() : null);

  // Where a key is pressed: the submit steps, a prompt, the docs results, the content area (full-screen, or Tab), an
  // open finding, the table of contents or the code.
  const keyState: KeyState = mode.kind === "verdict" ? { state: "submit", step: "verdict" }
    : mode.kind === "preview" ? (() => { const p = planOf(r, files, { coverage: mode.coverage }); return { state: "submit" as const, step: "preview" as const, dryRun, hook: p.hook ? mode.hook : null, coverage: p.adapter ? mode.coverage : null }; })()
    : mode.kind === "results" ? { state: "content", results: true }
    : mode.kind !== "nav" ? { state: "prompt", kind: mode.kind, decide: mode.kind === "comment" && !!mode.decide }
    : full && view ? { state: "content" }
    : content?.finding ? { state: "finding" }
    : focus === "content" && view ? { state: "content" } : { state: tree };

  // Blind: what the critic found is not shown, counted or reachable until the chapter has been read. Everything below that
  // draws or steps through a finding goes through `unhidden`, so the gate cannot be bypassed by one key.
  const chapters = items.reduce<string[][]>((acc, x) => { (acc[x.chapter] ??= []).push(x.id); return acc; }, []).filter(Boolean);
  const hidden = hiddenHunks(blind, chapters, h);
  const unhidden = (f: Finding) => !hidden.has(f.hunk);
  // What the gutter marks, the counts count and the go-to keys step through: every finding the reader may see, those the
  // refute step dropped included (they are ignored by default).
  const visible = () => d.findings.filter(unhidden);
  const ignored = (f: Finding) => actionOf(h, f, defaults).kind === "ignore";
  // A ▲ mark or count on the rail, coloured like the gutter: the worst severity among the findings not ignored, dim when
  // every one is ignored (a refute-dropped finding, say).
  const mark = (fs: Finding[], text: string) => {
    const worst = fs.filter((f) => !ignored(f)).sort(worstFirst)[0];
    return fs.length ? <Text color={worst ? SEV[worst.severity] : undefined} dimColor={!worst}>{text}</Text> : null;
  };
  const findingsHere = item ? visible().filter((f) => f.hunk === item.id) : [];
  const findingsAt = (l: DiffLine) => findingsHere.filter((f) => f.side === "new" ? l.n !== null && f.line === l.n : l.o !== null && f.line === l.o);
  const notesAt = (l: DiffLine) => h.comments.filter((n) => n.hunk === item?.id && n.line !== null && (n.side === "new" ? n.line === l.n : n.line === l.o));

  // Seeing a hunk is reading it.
  useEffect(() => { if (item && !h.visited.includes(item.id)) { h.visited.push(item.id); redraw(); } }, [item?.id]);

  // A move to another block closes an open finding; a move within the block keeps it. Anything else in the content area stays.
  const goTo = (at: Pos) => { if (at.item !== pos.item && content?.finding) setContent(null); setPos(at); };
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
  // Back to the table of contents at block `at`, its chapter expanded so the cursor can be seen; the content area shows the chapter.
  const toToc = (at: Pos) => {
    const c = items[at.item]?.chapter;
    if (c !== undefined && collapsed.has(c)) setCollapsed(new Set([...collapsed].filter((x) => x !== c)));
    setTree("toc"); setOnChapter(false); setContent(null); setPos(at);
  };
  // One key in the table of contents (nav.ts). Every move shows the cursor's chapter in the content area; → on a block enters its code.
  const tocGo = (move: TocMove) => {
    const res = tocMove(items, collapsed, { item: pos.item, onChapter }, move);
    if (res.enter) { setTree("code"); return; }
    setCollapsed(res.collapsed); setOnChapter(res.at.onChapter); setContent(null);
    if (res.at.item !== pos.item) setPos({ item: res.at.item, line: 0 });
  };
  const anchor = (): { side: "new" | "old"; line: number | null } => {
    const l = lines[line];
    if (!l) return { side: "new", line: null };
    return l.n !== null ? { side: "new", line: l.n } : { side: "old", line: l.o };
  };
  // A finding's header says who raised it, what it is and its action now; "(default)" is drawn dim while the action is
  // still the one its severity (or the refute step) gave it. The content area holds the whole of it. A finding opens in
  // the code, whichever of the two the cursor was in.
  const showFinding = (f: Finding) => {
    setTree("code");
    const a = actionOf(h, f, defaults), mine = linkedComment(h, f.id);
    const why = !a.isDefault ? "" : f.status === "withdrawn" ? " The second look dropped this finding, so it starts ignored." : ` A ${f.severity} finding starts as ${LABEL[a.kind]}.`;
    const action = `Action: ${LABEL[a.kind]}${a.isDefault ? " (default)." : "."}${why}${mine ? ` Your comment: ${mine.text}` : ""}${a.note ? ` Private note: ${a.note}` : ""} ${keyOf("finding.block")}, ${keyOf("finding.comment")} or ${keyOf("finding.ignore")} changes it.`;
    setContent({
      title: `▲ ${f.source} · ${f.kind} · ${f.severity}${f.votes && r.ai?.samples ? ` · ${f.votes}/${r.ai.samples}` : ""} · ${LABEL[a.kind]}`, ...(a.isDefault ? { tag: " (default)" } : {}),
      color: a.kind === "ignore" ? "gray" : SEV[f.severity], lead: titleOf(f), finding: f.id, copy: findingText(f, place(f.hunk, f.line)),
      ...(claimAddsTo(f) ? { claim: f.claim } : {}),
      body: [claimAddsTo(f) ? f.claim : "", f.evidence, f.refute ? `Second look: ${f.refute}` : "", action].filter(Boolean).join("\n\n"),
    });
  };
  // What the decision keys act on: the open finding, and only while it is open. Only shown findings can be opened,
  // so a blind chapter's findings cannot be decided before they are revealed.
  const target = (): Finding | undefined => {
    const f = content?.finding ? d.findings.find((x) => x.id === content.finding) : undefined;
    return f && unhidden(f) ? f : undefined;
  };
  const hiddenNote = () => hidden.size ? " Chapters you have not read yet keep theirs hidden until you have been through them." : "";
  // After an action is picked the finding stays open, showing its new action; `g f` goes on to the next one.
  const decided = (f: Finding, next: Human) => { Object.assign(h, next); redraw(); showFinding(f); };
  const land = (hit: (Pos & { finding: Finding }) | undefined) => {
    if (!hit) { setContent({ title: "Findings", body: `There are no findings to go to.${hiddenNote()}` }); return; }
    setPos({ item: hit.item, line: hit.line });
    showFinding(hit.finding);
  };
  const place = (id: string, l: number | null) => `${printable(items.find((x) => x.id === id)?.path ?? id)}${l !== null ? `:${l}` : ""}`;
  // The preview ends with what Enter will do: where the file goes, where it posts, and the document's
  // command, if it has one, which runs only after its own keypress (x) in this preview.
  // Every finding and its action lead the preview, so what the review says about each is seen before anything posts.
  const preview = (hook: boolean, coverage: boolean) => {
    const p = planOf(r, files, { coverage });
    setMode({ kind: "preview", hook, coverage });
    setContent({ title: `${VERDICT[h.verdict!]} · Enter ${dryRun ? "prints the calls" : "submits"}${p.hook ? `, x ${hook ? "disallows" : "allows"} the command` : ""}${p.adapter ? `, v ${coverage ? "drops" : "adds"} the coverage line` : ""}, Esc goes back`, color: "green", body: `${actionsNote(visible(), h, place, defaults, hidden.size > 0)}${writeup(d, files, defaults)}\n${describe(p, hook, dryRun)}` });
  };
  // A block you chose makes request changes the verdict Enter picks; without one, Enter keeps the verdict already chosen, if any.
  const verdictDefault = (): Verdict | undefined => defaultVerdict(visible(), h) ?? h.verdict;

  // Fast typing or a paste can deliver several plain characters in one chunk ("g12"): take them one at a time. An escape
  // sequence Ink did not read as a key (it hands those over with the ESC stripped) stays whole, for tokenOf to read.
  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !/^[[O][0-9;]*[A-Za-z~]$/.test(input)) for (const c of input) handle(c, {});
    else handle(input, key);
  });
  const scrollBy = (by: number) => setScroll((s) => clampScroll(s + by, contentLines.length, L.contentRows));

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
  // Esc with nothing pending: out of full-screen, out of the docs results, out of the content area, or what it shows closes.
  const backOut = () => {
    if (full) { setFull(false); return; }
    if (mode.kind === "results") { setMode({ kind: "nav" }); setContent(null); return; }
    if (keyState.state === "content") { setFocus("code"); return; }
    setContent(null);
  };

  // The answers to a docs question, in the content area with focus in it; redrawn as the selection moves.
  const showResults = (query: string, answers: Answer[], sel: number) => {
    setMode({ kind: "results", query, answers, sel });
    const at = scroll;
    setContent({ title: `Search the docs · ${query}`, color: "cyan", body: answersBody(answers, sel) });
    setScroll(at);
  };
  // A key whose behaviour comes with a later change says so, and does nothing else.
  const coming = (id: string) => { const a = rowById(id); setNote(`${keyOf(id)} ${a?.label ?? id}: not built yet, coming with ${a?.coming ?? "a later change"}`); };
  const copy = () => {
    if (mode.kind === "results") { const a = mode.answers[mode.sel]; setNote(a ? confirmation(copier(answerText(a))) : "nothing to copy here"); return; }
    // The content area copies its own text; with nothing there, the cursor line's reference, which is what you paste into a note.
    const l = lines[line], at = l ? l.n ?? l.o : null;
    const text = view ? view.copy : item && at !== null ? `${item.path}:${at}` : undefined;
    setNote(text ? confirmation(copier(text)) : "nothing to copy here");
  };
  // Enter in a prompt: what the typed line does depends on the prompt.
  const send = () => {
    if (mode.kind === "nav" || mode.kind === "results" || mode.kind === "verdict" || mode.kind === "preview") return;
    const text = input.trim();
    if (mode.kind === "docs") {
      setInput("");
      if (!text) { setMode({ kind: "nav" }); return; }
      try { showResults(text, answersFor(text), 0); } catch (e) { setMode({ kind: "nav" }); setContent({ title: "search the docs failed", body: String((e as Error).message), color: "red" }); }
      return;
    }
    setMode({ kind: "nav" }); setInput("");
    const f = mode.kind === "reason" ? d.findings.find((x) => x.id === mode.id) : mode.kind === "comment" && mode.decide ? d.findings.find((x) => x.id === mode.decide!.id) : undefined;
    const at = new Date().toISOString();
    if (mode.kind === "reason") { if (f) decided(f, decide(h, f, "ignore", { reason: text, at })); return; }
    // An emptied comment changes nothing: the finding keeps the action it had.
    if (mode.kind === "comment" && mode.decide) { if (f) { if (text) decided(f, decide(h, f, mode.decide.kind, { text, at })); else showFinding(f); } return; }
    if (mode.kind === "comment" && text) {
      h.comments.push({ hunk: item?.id ?? null, ...anchor(), text, at });
      redraw();
    }
    if (mode.kind === "ask" && item) {
      setBusy("asking…"); setContent({ title: text || "Explain this block", body: "…" });
      ask(r, files, item.id, text).then((a) => setContent({ title: text || "This block", body: a, copy: askText(text || "Explain this block", a) }), (e) => setContent({ title: "ask failed", body: String((e as Error).message), color: "red" })).finally(() => setBusy(null));
    }
  };

  // What each action does. Every id in the key tables has a case here (a test holds the two together).
  const act = (id: string, n?: number) => {
    switch (id) {
      // ---- anywhere outside a finding
      case "review.quit": onDone({ kind: "quit" }); exit(); return;
      case "review.submit": setMode({ kind: "verdict" }); setContent(null); return;
      case "review.copy": case "finding.copy": case "content.copy": copy(); return;
      case "review.search_docs": setMode({ kind: "docs" }); setInput(""); return;

      // ---- the code
      case "code.down": lineBy(1); return;
      case "code.up": lineBy(-1); return;
      case "code.next_chapter": goChapter(1); return;
      case "code.prev_chapter": goChapter(-1); return;
      case "code.open_finding": {
        if (item && hidden.has(item.id)) { setContent({ title: "Findings", body: "Hidden until you have been through this chapter." }); return; }
        const l = lines[line], here = l ? [...findingsAt(l)].sort(worstFirst) : [];
        if (!here.length) { setNote(`no finding on this line; ${keyOf("go.next_finding")} goes to the next one`); return; }
        showFinding(here[0]!);
        return;
      }
      case "code.to_toc": if (item) toToc({ item: pos.item, line }); return;
      case "code.focus_content": case "toc.focus_content":
        if (view && !view.finding) setFocus("content"); else setNote("the content area is empty");
        return;

      // ---- the table of contents
      case "toc.down": tocGo("down"); return;
      case "toc.up": tocGo("up"); return;
      case "toc.next_chapter": tocGo("next_chapter"); return;
      case "toc.prev_chapter": tocGo("prev_chapter"); return;
      case "toc.expand": tocGo("expand"); return;
      case "toc.collapse": tocGo("collapse"); return;
      case "code.new_finding": setMode({ kind: "comment" }); return;

      // ---- the content area
      case "content.back": setFull(false); if (mode.kind === "results") { setMode({ kind: "nav" }); setContent(null); } else setFocus("code"); return;
      case "content.down": case "content.up": {
        const dir = id === "content.down" ? 1 : -1;
        if (mode.kind === "results") showResults(mode.query, mode.answers, Math.max(0, Math.min(mode.answers.length - 1, mode.sel + dir)));
        else scrollBy(dir);
        return;
      }
      case "content.page_down": case "finding.page_down": case "submit.page_down": scrollBy(pageStep(L.contentRows)); return;
      case "content.page_up": case "finding.page_up": case "submit.page_up": scrollBy(-pageStep(L.contentRows)); return;

      // ---- inside a finding
      case "finding.close": case "finding.back": setContent(null); return;
      case "finding.ignore": { const f = target(); if (f) { setMode({ kind: "reason", id: f.id }); setInput(decisionOf(h, f.id)?.reason ?? ""); } return; }
      case "finding.block": case "finding.comment": {
        const f = target();
        if (!f) return;
        // The comment starts as the finding's text (or the comment already written for it) and is saved only on Enter.
        setMode({ kind: "comment", decide: { id: f.id, kind: id === "finding.block" ? "block" : "comment" } });
        setInput(linkedComment(h, f.id)?.text ?? f.claim);
        return;
      }

      // ---- a: AI
      case "ai.info": setContent(opening() ?? { title: "Summary", body: "There is no summary for this review." }); return;
      case "ai.ask": setMode({ kind: "ask" }); setInput(""); return;

      // ---- v: view
      case "view.editor": {
        if (!item) return;
        const l = lines[line];
        const at = l?.n ?? lines.slice(line).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
        if (beside) { const err = beside(item.path, at); if (err) setContent({ title: "editor", body: err, color: "red" }); return; }
        onDone({ kind: "edit", path: item.path, line: at }); exit();
        return;
      }
      case "view.wrap": setWrap(!wrap); return;
      case "view.zen": setZen(!zen); return;
      case "view.fullscreen":
        if (full) setFull(false); else if (view) setFull(true); else setNote("the content area is empty");
        return;

      // ---- g: go to
      case "go.next_finding": case "go.prev_finding": land(nextFindingWrapping(items, visible(), { item: pos.item, line }, id === "go.next_finding" ? 1 : -1)); return;
      case "go.next_severity": case "go.prev_severity": land(nextBySeverity(items, visible(), target()?.id, id === "go.next_severity" ? 1 : -1)); return;
      // A line is in the code, so these land there; a chapter is in the table of contents.
      case "go.top": case "go.end": { const at = fileEdge(items, pos.item, id === "go.top" ? "top" : "end"); if (at) { setTree("code"); goTo(at); } return; }
      case "go.line": { const at = n !== undefined ? gotoLine(items, pos.item, n) : undefined; if (at) { setTree("code"); setContent(null); setPos(at); } return; }
      case "go.chapter": { const at = n !== undefined ? chapterStart(items, n) : undefined; if (at) toToc(at); else setNote(`there is no chapter ${n}`); return; }

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
      case "submit.back": setMode({ kind: "verdict" }); setContent(null); return;

      // ---- keys whose behaviour comes with a later change: each says so
      case "review.settings": case "ai.draft": case "ai.accept": case "ai.discard": case "filter.high": case "filter.medium": case "filter.all":
      case "settings.down": case "settings.up": case "settings.edit": case "settings.clear": case "settings.leave":
        coming(id); return;
    }
  };

  // ---- layout
  const L = layoutOf(cols, rows, { zen, full: (full && !!view) || mode.kind === "preview" });
  const { railW, mainW, gutterW, codeW, boxW, boxInner } = L;
  const codeCols = codeW - 1; // the +/- sign takes the first column
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && h.visited.includes(i.id)).length;
  const anyHidden = d.findings.some((f) => !unhidden(f));

  // The status area's second line: separate fields, each whole or dropped, in the order status.ts documents.
  const inHouse = r.suggested?.find((v) => v.by === IN_HOUSE);
  const fields = fitFields(statusFields({
    label: printable(d.target.label), base: d.target.base, head: d.target.head, read: { seen, total },
    findings: bySeverity(visible()), hidden: anyHidden,
    comments: h.comments.length, suggested: inHouse ? VERDICT[inHouse.verdict] : undefined,
  }), cols - 4);

  // The content area: one thing at a time, scrolled within its rows. A finding's title is bold above its detail.
  const leadLines = view?.lead ? wrapText(view.lead, L.contentInner) : [];
  const contentLines = view ? [...leadLines, ...wrapText(view.body, L.contentInner)] : [];
  const sc = clampScroll(scroll, contentLines.length, L.contentRows);
  const shownContent = contentLines.slice(sc, sc + L.contentRows);
  const focused = keyState.state === "content";
  // The key panel, beside it: the keys for where you are, or a pending prefix's second keys.
  const pending = pendingRef.current;
  const keyPanel = panelOf(panelTitle(keyState, pending), entriesOf(keyState, pending), L.panelW, L.bottomH);

  // An open finding is a short box on its line: its header in the top border, the bold title, and at most two lines of its
  // claim. The whole of it is in the content area.
  const boxBody = content?.finding && content.claim ? wrapText(content.claim, boxInner).filter(Boolean).slice(0, Math.min(2, boxLines(L.middleH))) : [];
  const boxH = content?.finding ? 3 + boxBody.length : 0;
  const bodyRows = L.middleH - 2; // the path line and the intent
  const heights = lines.map((l, i) => (wrap ? rowsFor(lengthOf(spans[i] ?? []), codeCols) : 1) + notesAt(l).length);
  const { start, end } = windowOf(heights, line, Math.max(1, bodyRows - boxH));
  // The table of contents: every chapter, the blocks of the expanded ones, windowed round the cursor's row like the code.
  const railRows = tocRows(items, collapsed);
  const railWin = windowOf(railRows.map(() => 1), Math.max(0, tocIndex(railRows, items, { item: pos.item, onChapter: tree === "toc" && onChapter })), Math.max(1, L.middleH - 1));
  const railShown = railRows.slice(railWin.start, railWin.end);
  const shown = lines.slice(start, end);
  const fit = (t: string) => t.length > codeW ? t.slice(0, codeW - 1) + "…" : t;

  /** The code of line `i` as rows of spans: one row cut with an ellipsis, or every row it wraps to. */
  const codeRows = (i: number): Span[][] => {
    const sp = spans[i] ?? [], len = lengthOf(sp);
    if (wrap) return Array.from({ length: rowsFor(len, codeCols) }, (_, k) => sliceSpans(sp, k * codeCols, (k + 1) * codeCols));
    const cut = len > codeCols;
    const vis = sliceSpans(sp, 0, codeCols - (cut ? 1 : 0));
    return [cut ? [...vis, { text: "…", kind: "comment" }] : vis];
  };

  // The top border: `╭ header (default) ───╮`, the header cut with … when it does not fit, the dim tag dropped first.
  const boxTop = (title: string, tag = "") => {
    const room = boxW - 5;
    const fits = [...title].length + [...tag].length <= room;
    const t = fits ? title : [...title].length > room ? [...title].slice(0, Math.max(1, room - 1)).join("") + "…" : title;
    const g = fits ? tag : "";
    return { head: `╭ ${t}`, tag: g, tail: ` ${"─".repeat(Math.max(0, boxW - [...t].length - [...g].length - 4))}╮` };
  };
  const findingBox = () => { if (!content?.finding) return null; const top = boxTop(content.title, content.tag); return (
    <Box flexDirection="column" marginLeft={gutterW + 2} width={boxW}>
      <Text color={content.color ?? "gray"} wrap="truncate">{top.head}{top.tag ? <Text dimColor>{top.tag}</Text> : null}{top.tail}</Text>
      <Box flexDirection="column" width={boxW} borderStyle="round" borderTop={false} borderColor={content.color ?? "gray"} paddingX={1}>
        <Text bold wrap="truncate">{content.lead ?? ""}</Text>
        {boxBody.map((t, j) => <Text key={j} wrap="truncate">{t}</Text>)}
      </Box>
    </Box>
  ); };

  // What the content area holds: a prompt or the verdict question while one is open, else what was last shown there.
  const contentView = () => {
    switch (mode.kind) {
      case "comment": case "reason": case "ask": case "docs": {
        const decideKind = mode.kind === "comment" ? mode.decide?.kind : undefined;
        const label = mode.kind === "docs" ? "search the docs" : mode.kind === "ask" ? "ask" : mode.kind === "reason" ? "ignore · private note" : decideKind === "block" ? "block on it" : decideKind ? "comment on the finding" : "new finding";
        const l = lines[line], at = l ? l.n ?? l.o : null;
        const title = mode.kind === "docs" ? "Search the docs" : mode.kind === "ask" ? "Ask the model about this block" : mode.kind === "reason" ? "Ignore the finding" : decideKind ? `${decideKind === "block" ? "Block on" : "Comment on"} the finding` : `Your own finding${item ? ` at ${place(item.id, at)}` : ""}`;
        return <>
          <Text bold color="cyan" wrap="truncate">{title}</Text>
          <Text><Text color="cyan" bold>{label} › </Text>{input}<Text inverse> </Text>{mode.kind === "reason" && !input ? <Text dimColor>private note — never posted</Text> : null}</Text>
        </>;
      }
      case "verdict": {
        const dv = verdictDefault(), hint = suggestionHint(r.suggested ?? [], (v) => VERDICT[v]);
        return <>
          <Text bold color="green" wrap="truncate">Verdict</Text>
          <Text><Text color="green" bold>verdict › </Text>{dv ? <Text dimColor>Enter takes {VERDICT[dv]}</Text> : null}</Text>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </>;
      }
    }
    if (!view) return <>
      <Text dimColor wrap="truncate">content</Text>
      <Text dimColor>Nothing here. {keyOf("ai.info")} shows the summary; {keyOf("review.search_docs")} searches the docs.</Text>
    </>;
    const more = contentLines.length > L.contentRows;
    const scrollHint = focused ? "" : view.finding ? ` ${keyOf("finding.page_up")}/${keyOf("finding.page_down")}` : ` ${keyOf("code.focus_content")} to scroll`;
    return <>
      <Text wrap="truncate"><Text bold color={view.color}>{view.title}</Text>{view.tag ? <Text dimColor>{view.tag}</Text> : null}{busy ? <Text dimColor> · {busy}</Text> : null}{more ? <Text dimColor> · {sc + 1}-{Math.min(contentLines.length, sc + L.contentRows)}/{contentLines.length}{scrollHint}</Text> : null}{focused ? <Text color="cyan"> · focused</Text> : null}</Text>
      {shownContent.map((t, j) => <Text key={j} bold={sc + j < leadLines.length} wrap="truncate">{t || " "}</Text>)}
    </>;
  };

  const footer = note
    ? <Text wrap="truncate" color="green"> {note}</Text>
    : <Text wrap="truncate" dimColor> {busy ? `${busy} keys wait until it answers` : full && view && mode.kind !== "preview" ? `${keyOf("view.fullscreen")} or Esc restores the layout` : ""}{pending ? <Text color="cyan">   {pendingText(pending)}</Text> : null}</Text>;

  if (tooSmall(term)) return <Text wrap="truncate">terminal too small, need {MIN_COLS}x{MIN_ROWS}</Text>;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width={cols} height={STATUS_H}>
        <Text bold wrap="truncate">{d.target.title || printable(d.target.label)}</Text>
        <Text wrap="truncate">{fields.map((f, i) => <Text key={f.key}>{i ? GAP : ""}<Text dimColor>{f.label} </Text><Text color={f.color}>{f.value}</Text></Text>)}</Text>
      </Box>
      {L.middleH > 0 ? (
        <Box height={L.middleH} overflow="hidden">
          {railW ? (
            <Box width={railW} flexDirection="column" borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} borderColor="gray" paddingRight={1}>
              <Text dimColor={tree !== "toc"} color={tree === "toc" ? "cyan" : undefined} wrap="truncate">{L.narrow ? " #" : " READ IN ORDER"}</Text>
              {railShown.map((row) => {
                const c = row.chapter, mine = items.filter((x) => x.chapter === c);
                const here = item?.chapter === c, expanded = !collapsed.has(c);
                if (row.kind === "block") {
                  // While the cursor is on the chapter's row, its first block (which the code shows) is not marked as well.
                  const x = items[row.item]!, cur = row.item === pos.item && !(tree === "toc" && onChapter), sel = cur && tree === "toc";
                  return <Text key={`b${row.item}`} color={cur ? "cyan" : undefined} inverse={sel} dimColor={!cur && h.visited.includes(x.id)} wrap="truncate">{L.narrow ? ` ${cur ? "›" : " "}${mine.indexOf(x) + 1}` : `   ${cur ? "›" : " "} ${printable(x.path.split("/").pop()!)}:${x.hunk.newStart}`}{mark(visible().filter((f) => f.hunk === x.id), " ▲")}</Text>;
                }
                const title = c < d.plan.chapters.length ? d.plan.chapters[c]!.title : `Mechanical (${d.plan.mechanical.length})`;
                const done = mine.every((x) => h.visited.includes(x.id));
                const fs = visible().filter((f) => mine.some((x) => x.id === f.hunk));
                const blindFs = chapterHidden(blind, chapters[c] ?? [], h) && d.findings.some((f) => mine.some((x) => x.id === f.hunk));
                // ▾ expanded, ▸ collapsed; ✓ every block read.
                return (
                  <Text key={`c${c}`} color={here ? "cyan" : done ? "green" : undefined} bold={here} inverse={here && tree === "toc" && onChapter} wrap="truncate">
                    {L.narrow ? "" : done ? "✓" : " "}{expanded ? "▾" : "▸"}{L.narrow ? "" : " "}{c + 1}{L.narrow ? "" : ` ${printable(title)}`}{fs.length ? mark(fs, `${L.narrow ? "" : " "}▲${fs.length}`) : blindFs ? <Text color="yellow">{L.narrow ? "" : " "}▲?</Text> : null}
                  </Text>
                );
              })}
            </Box>
          ) : null}
          <Box width={mainW} flexDirection="column" paddingLeft={1}>
            {item && hunk ? (
              <>
                <Text wrap="truncate">
                  <Text bold>{printable(item.path)}</Text>
                  <Text dimColor>{hunk.context.trim() ? ` · ${printable(hunk.context.trim())}` : ""} · {where(hunk)} · {pos.item + 1}/{items.length}{wrap ? " · wrapped" : ""}{zen ? " · zen" : ""}</Text>
                </Text>
                <Text wrap="truncate">
                  {item.mechanical
                    ? <Text color="magenta">  ▸ {MECHANICAL_INTENT} · {item.mechanical}</Text>
                    : chapter?.intent ? <Text color="cyan">  ▸ {chapter.intent}</Text> : <Text dimColor>  {chapterTitle}</Text>}
                </Text>
                {shown.map((l, k) => {
                  const i = start + k;
                  const cur = i === line, lit = cur && tree === "code"; // the cursor line is lit only while the arrows act in the code
                  const fs = findingsAt(l), ns = notesAt(l);
                  const worst = fs.filter((f) => !ignored(f)).sort(worstFirst)[0];
                  // ▲ in its severity's colour, △ dim when every finding on the line is ignored.
                  const mark = worst ? <Text color={SEV[worst.severity]}>▲</Text> : fs.length ? <Text dimColor>△</Text> : ns.length ? <Text color="cyan">»</Text> : <Text> </Text>;
                  const num = String(l.n ?? l.o ?? "").padStart(gutterW);
                  const color = l.t === "+" ? "green" : l.t === "-" ? "red" : undefined;
                  const changed = l.t !== " ";
                  const code = codeRows(i); // spans are indexed over the whole hunk
                  return (
                    <Box key={i} flexDirection="column">
                      {code.map((row, k) => {
                        const used = lengthOf(row);
                        return (
                          <Text key={k} wrap="truncate">
                            {k === 0
                              ? <><Text dimColor={!cur} color={cur ? "cyan" : undefined}>{num}</Text> {mark} <Text color={color} inverse={lit}>{l.t}</Text></>
                              : <Text dimColor>{" ".repeat(gutterW + 3)}↪</Text>}
                            {row.map((sp, j) => { const st = styleOf(sp.kind, changed); return <Text key={j} color={st.color ?? color} bold={st.bold} italic={st.italic} dimColor={st.dim} inverse={lit}>{sp.text}</Text>; })}
                            {lit ? <Text color={color} inverse>{" ".repeat(Math.max(0, codeCols - used))}</Text> : null}
                          </Text>
                        );
                      })}
                      {ns.map((n, j) => <Text key={j} color="cyan" wrap="truncate">{" ".repeat(gutterW + 3)}» {fit(n.text)}</Text>)}
                      {cur ? findingBox() : null}
                    </Box>
                  );
                })}
              </>
            ) : <Text dimColor>Nothing to read: the diff is empty.</Text>}
          </Box>
        </Box>
      ) : null}
      <Box height={L.bottomH}>
        <Box flexDirection="column" width={L.contentW} height={L.bottomH} overflow="hidden" borderStyle="single" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
          {contentView()}
        </Box>
        <Box flexDirection="column" width={L.panelW} height={L.bottomH} overflow="hidden" borderStyle="single" borderColor={pending ? "cyan" : "gray"} paddingX={1}>
          <Text bold wrap="truncate">{keyPanel.title}</Text>
          {keyPanel.lines.map((l, i) => <Text key={i} wrap="truncate">{l.map((sg, j) => <Text key={j} dimColor={sg.dim}>{sg.text}</Text>)}</Text>)}
        </Box>
      </Box>
      <Box height={1}>{footer}</Box>
    </Box>
  );
}

/** Run the app once; resolves with what the reader wants next. State lives on the review object and is saved as it changes. */
export function show(review: Review, files: FileDiff[], beside?: Beside, blind = false, dryRun = false, defaults: Defaults = DEFAULTS): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome = { kind: "quit" };
    process.stdout.write("\x1b[?1049h\x1b[H");
    const app = render(<App review={review} files={files} beside={beside} blind={blind} dryRun={dryRun} defaults={defaults} onDone={(o) => { outcome = o; }} />, { exitOnCtrlC: true });
    app.waitUntilExit().then(() => { app.clear(); process.stdout.write("\x1b[?1049l"); save(review); resolve(outcome); });
  });
}
