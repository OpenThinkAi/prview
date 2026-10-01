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
import { claimAddsTo, hunksOf, MECHANICAL_INTENT, titleOf, worstFirst, type Finding, type HunkAt, type Severity } from "./guide.ts";
import { preparedBy, save, VERDICT, writeup, type Pos, type Review } from "./build.ts";
import { acceptAnswer, askAbout, conversationText, discardAnswer, pendingTurn, revisedNote, subjectKey, subjectLabel, type AskDeps, type Subject } from "./deep.ts";
import type { Doc, Human, Verdict } from "./document.ts";
import { checklistNote, filtered, filterLabel, filterOf, type Filter } from "./filter.ts";
import { chapterHidden, hiddenHunks } from "./blind.ts";
import { chapterStart, fileEdge, gotoLine, nextBySeverity, nextFindingWrapping, tocIndex, tocMove, tocRows, type NavItem, type TocMove } from "./nav.ts";
import { highlightLines, langOf, lengthOf, sliceSpans, styleOf, type Span } from "./highlight.ts";
import { boxLines, clampScroll, layoutOf, STATUS_H, pageStep, rowsFor, windowOf, wrapText } from "./layout.ts";
import type { Beside } from "./editor.ts";
import { askText, confirmation, findingText, systemCopier, whyText, type Copier } from "./clipboard.ts";
import { coverageLine, describe, planOf, postPreview, shown as shownArgv, type Plan } from "./submit.ts";
import { clampLine, edgesOf, inputLines, ownFinding, rowKind, SEVERITIES, stepLine, type Spot } from "./rows.ts";
import { actionOf, bySeverity, decide, decisionOf, DEFAULTS, IN_HOUSE, LABEL, linkedComment, suggestionHint, type Defaults } from "./triage.ts";
import * as flows from "./submit-flow.ts";
import { FLOW_STEPS, STEP_NAMES, type Box as CheckBox, type Draft, type Flow, type Selection } from "./submit-flow.ts";
import { verdictsFor } from "./platform.ts";
import { installKeymap, type KeyState, keyOf, rowById } from "./keys.ts";
import { pendingText, step, tokenOf, type InkKey, type Pending } from "./chord.ts";
import { answersBody, answersFor, answerText, type Answer } from "./ask-docs.ts";
import { entriesOf, panelOf, panelTitle } from "./panel.ts";
import { fitFields, GAP, statusFields } from "./status.ts";
import { visible as printable } from "./sanitize.ts";
import { MIN_COLS, MIN_ROWS, tooSmall, useTerminalSize } from "./resize.ts";
import { configPath, parseConfig, type Config } from "./config.ts";
import { openSettings, saveSettings, settingsAct, settingsKey, type Out as SettingsOut, type Settings } from "./settings.ts";
import { SettingsScreen } from "./settings-view.tsx";

/**
 * `submit`: send what the submit flow chose; `hook`: the human ticked the document's on_submit command for this submit;
 * `defaults`: the default actions the flow's preview used, so what posts is worked out exactly as it was shown.
 * `edit_comment`: `v e` in the flow's comment step; the CLI opens the comment in the editor and reopens the flow there.
 */
export type Outcome = { kind: "quit" } | { kind: "submit"; hook: boolean; coverage: boolean; selection: Selection; defaults: Defaults } | { kind: "edit"; path: string; line: number } | { kind: "edit_comment"; flow: Flow };

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
type Mode = { kind: "nav" } | { kind: "comment"; decide?: { id: string; kind: "block" | "comment" } } | { kind: "severity"; sel: number; spot: Spot } | { kind: "finding"; severity: Severity; spot: Spot } | { kind: "reason"; id: string } | { kind: "ask"; subject: Subject } | { kind: "docs" } | { kind: "results"; query: string; answers: Answer[]; sel: number } | { kind: "submit"; flow: Flow };

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
  /** The config as loaded: what the settings view (`\`) opens on. None: the built-in one. */
  config?: Config;
  /** A save in the settings view: the config as it now reads, for whatever outlives this screen (the editor command). */
  onConfig?: (cfg: Config) => void;
  /** Reopen in the submit flow where it was (after `v e` wrote the comment in the editor). */
  resume?: Flow;
  /** A drafted submission (`a s`): the submit flow starts from it instead of the defaults. */
  draft?: Draft;
  /** How `a ?` reaches a model: the config, the agent runner, the one-call path. Tests pass stubs; unset, the real ones. */
  askDeps?: AskDeps;
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

export function App({ review, files, onDone, beside, size, blind: blindAtStart = false, dryRun = false, copier = systemCopier, defaults: defaultsAtStart = DEFAULTS, config, onConfig, resume, draft, askDeps }: AppProps) {
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
  const [mode, setMode] = useState<Mode>(resume ? { kind: "submit", flow: resume } : { kind: "nav" });
  // The submit flow changes through the mode's own state, so several keys in one chunk (typing) build on each other.
  const setFlow = (fn: (f: Flow) => Flow) => setMode((m) => m.kind === "submit" ? { kind: "submit", flow: fn(m.flow) } : m);
  const [input, setInput] = useState("");
  // Keys can arrive several to a chunk (a fast "g12"), all handled by one closure: the pending prefix lives in a ref.
  const pendingRef = useRef<Pending | null>(null);
  const [, tick] = useState(0);
  const setPending = (p: Pending | null) => { if (p !== pendingRef.current) { pendingRef.current = p; tick((n) => n + 1); } };
  const [busy, setBusy] = useState<string | null>(null);
  // An `a ?` run in progress: Esc cancels it (the only key that does anything while it runs).
  const abortRef = useRef<AbortController | null>(null);
  // Long lines are cut with an ellipsis, or wrap onto more rows (v w).
  const [wrap, setWrap] = useState(config?.wrap ?? false);
  // The severity filter (f h, f m, f a): kept with the stored review, so it is still set when the review is opened again.
  const [level, setLevelRaw] = useState<Filter>(() => filterOf(r.filter));
  // The settings view (settings.ts), full-screen while open. A save applies at once: the keymap, the defaults, and the
  // display settings it changed; `live` is the config the next opening starts from.
  // Like the pending prefix, it lives in a ref too: a paste into the editor line delivers many keys to one closure.
  const settingsRef = useRef<Settings | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const setSettings = (s: Settings | null) => { settingsRef.current = s; setSettingsState(s); };
  const live = useRef<Config>(config ?? parseConfig("")).current;
  const [defaults, setDefaults] = useState<Defaults>(defaultsAtStart);
  const [blind, setBlind] = useState(blindAtStart);

  const item = items[pos.item];
  const hunk = item?.hunk ?? null;
  const lines = hunk?.lines ?? [];
  // The cursor's row: a diff line, or a file's "whole file" row before its first block's lines (-1) or after its last block's (lines.length).
  const edges = edgesOf(items, pos.item), off = edges.top ? 1 : 0;
  const nRows = lines.length + off + (edges.end ? 1 : 0);
  const line = clampLine(items, pos);
  const row = rowKind(items, { item: pos.item, line });
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

  // ---- the submit flow (submit-flow.ts has the rules). The send step's plan is the one submit posts from, so its
  // preview is exactly what goes out; its checkboxes are the ones this submit has.
  const sendPlan = (fl: Flow): Plan => planOf(r, files, { coverage: fl.coverage, selection: flows.selectionOf(fl), defaults });
  const boxesOf = (p: Plan): CheckBox[] => [...(p.hook && !p.hook.refused ? ["hook" as const] : []), ...(p.adapter ? ["coverage" as const] : [])];
  function submitState(fl: Flow): KeyState {
    if (fl.step === "comment") return { state: "submit", step: "comment", typing: fl.typing };
    if (fl.step === "send") return { state: "submit", step: "send", dryRun, boxes: boxesOf(sendPlan(fl)).length > 0 };
    return { state: "submit", step: fl.step };
  }
  const flowBoxes = (): CheckBox[] => mode.kind === "submit" && mode.flow.step === "send" ? boxesOf(sendPlan(mode.flow)) : [];
  // The flow's current step as display lines, wrapped to the content area's width.
  const flowView = (fl: Flow, inner: number): flows.Line[] => {
    const p = fl.step === "send" ? sendPlan(fl) : undefined, boxes = p ? boxesOf(p) : [];
    const boxText = (b: CheckBox) => b === "hook"
      ? `Run the document's on_submit command: ${shownArgv(p!.hook!.argv)}${p!.hook!.stdout ? ` > ${p!.hook!.stdout}` : ""}`
      : `Add "${coverageLine(d, files)}" to the posted comment`;
    const ls = flows.stepLines(fl, {
      findings: d.findings, h, defaults, place: (f) => `${place(f.hunk, f.file ? null : f.line)}${f.file ? " (whole file)" : ""}`, label: (v) => VERDICT[v],
      keys: { tick: keyOf("submit.tick"), all: keyOf("submit.tick_all"), editor: keyOf("view.comment_editor"), next: keyOf("submit.next"), back: keyOf("submit.back") },
      hidden: d.findings.some((f) => !unhidden(f)), note: checklistNote(level), suggested: suggestionHint(r.suggested ?? [], (v) => VERDICT[v]),
      ...(p ? { boxes: boxes.map((box) => ({ box, text: boxText(box) })), preview: `${postPreview(p, (v) => VERDICT[v])}\n\n${describe(p, fl.hook, dryRun)}` } : {}),
    });
    // A wrapped line keeps its indent on every row, so the preview's comments stay under their file and line.
    return ls.flatMap((l) => {
      if (!l.wrap) return [l];
      const pad = /^ */.exec(l.text)![0].slice(0, Math.max(0, inner - 10));
      return wrapText(l.text.slice(pad.length), inner - pad.length).map((text, i) => ({ ...l, text: pad + text, cursor: l.cursor && i === 0 }));
    });
  };

  // Where a key is pressed: the submit steps, a prompt, the docs results, the content area (full-screen, or Tab), an
  // open finding, the table of contents or the code.
  const keyState: KeyState = settings ? { state: "settings" } : mode.kind === "submit" ? submitState(mode.flow)
    : mode.kind === "results" ? { state: "content", results: true }
    : mode.kind !== "nav" ? { state: "prompt", kind: mode.kind, decide: mode.kind === "comment" && !!mode.decide }
    : full && view ? { state: "content" }
    : content?.finding ? { state: "finding", answer: !!pendingTurn(r.asks, content.finding) }
    : focus === "content" && view ? { state: "content" } : { state: tree };

  // Blind: what the critic found is not shown, counted or reachable until the chapter has been read. Everything below that
  // draws or steps through a finding goes through `unhidden`, so the gate cannot be bypassed by one key.
  const chapters = items.reduce<string[][]>((acc, x) => { (acc[x.chapter] ??= []).push(x.id); return acc; }, []).filter(Boolean);
  const hidden = hiddenHunks(blind, chapters, h);
  const unhidden = (f: Finding) => !hidden.has(f.hunk);
  // What the gutter marks, the counts count and the go-to keys step through: every finding the reader may see, those the
  // refute step dropped included (they are ignored by default).
  const visible = () => filtered(d.findings.filter(unhidden), level);
  // The submit checklist and the default verdict ignore the filter: it is for reading, not for what gets posted.
  const unfiltered = () => d.findings.filter(unhidden);
  const ignored = (f: Finding) => actionOf(h, f, defaults).kind === "ignore";
  // A ▲ mark or count on the rail, coloured like the gutter: the worst severity among the findings not ignored, dim when
  // every one is ignored (a refute-dropped finding, say).
  const mark = (fs: Finding[], text: string) => {
    const worst = fs.filter((f) => !ignored(f)).sort(worstFirst)[0];
    return fs.length ? <Text color={worst ? SEV[worst.severity] : undefined} dimColor={!worst}>{text}</Text> : null;
  };
  const findingsHere = item ? visible().filter((f) => f.hunk === item.id) : [];
  const findingsAt = (l: DiffLine) => findingsHere.filter((f) => !f.file && (f.side === "new" ? l.n !== null && f.line === l.n : l.o !== null && f.line === l.o));
  // A finding on a whole file is shown on the row where it was written, the one that starts the file's diff or the one that ends it.
  const findingsOnFile = (r: "start" | "end") => findingsHere.filter((f) => f.file && f.line === (r === "end" ? 1 : 0));
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
    const to = stepLine(items, { item: pos.item, line }, dir);
    if (to) goTo(to);
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
  // Where a new finding goes: the cursor's line, or the file when the cursor is on a "whole file" row.
  const spotHere = (): Spot | undefined => {
    if (!item) return undefined;
    if (row !== "line") return { hunk: item.id, file: row };
    const l = lines[line];
    return l ? { hunk: item.id, ...(l.n !== null ? { side: "new" as const, line: l.n } : { side: "old" as const, line: l.o! }) } : undefined;
  };
  // A finding's header says who raised it, what it is and its action now; "(default)" is drawn dim while the action is
  // still the one its severity (or the refute step) gave it. The content area holds the whole of it. A finding opens in
  // the code, whichever of the two the cursor was in.
  // Questions asked about it follow its detail, with the keys that accept or discard the latest answer while it waits.
  const findingContent = (f: Finding): Content => {
    const a = actionOf(h, f, defaults), mine = linkedComment(h, f.id);
    const why = !a.isDefault ? "" : f.status === "withdrawn" ? " The second look dropped this finding, so it starts ignored." : ` A ${f.severity} finding starts as ${LABEL[a.kind]}.`;
    const action = `Action: ${LABEL[a.kind]}${a.isDefault ? " (default)." : "."}${why}${mine ? ` Your comment: ${mine.text}` : ""}${a.note ? ` Private note: ${a.note}` : ""} ${keyOf("finding.block")}, ${keyOf("finding.comment")} or ${keyOf("finding.ignore")} changes it.`;
    const turns = r.asks?.[subjectKey({ kind: "finding", id: f.id })] ?? [], waiting = pendingTurn(r.asks, f.id);
    const asked = turns.length ? `Asked about this finding:\n\n${conversationText(turns, f)}${waiting ? `\n\n${keyOf("ai.accept")} accepts ${waiting.revision ? "the proposed change" : "the answer (it proposes no change)"}; ${keyOf("ai.discard")} discards it.` : ""}` : "";
    return {
      title: `▲ ${f.source} · ${f.kind} · ${f.severity}${f.votes && r.ai?.samples ? ` · ${f.votes}/${r.ai.samples}` : ""} · ${LABEL[a.kind]}`, ...(a.isDefault ? { tag: " (default)" } : {}),
      color: a.kind === "ignore" ? "gray" : SEV[f.severity], lead: titleOf(f), finding: f.id, copy: findingText(f, `${place(f.hunk, f.file ? null : f.line)}${f.file ? " (whole file)" : ""}`),
      ...(claimAddsTo(f) ? { claim: f.claim } : {}),
      body: [claimAddsTo(f) ? f.claim : "", f.evidence, f.refute ? `Second look: ${f.refute}` : "", action, revisedNote(r.asks, f.id), asked].filter(Boolean).join("\n\n"),
    };
  };
  const showFinding = (f: Finding) => { setTree("code"); setContent(findingContent(f)); };
  // What the decision keys act on: the open finding, and only while it is open. Only shown findings can be opened,
  // so a blind chapter's findings cannot be decided before they are revealed.
  const target = (): Finding | undefined => {
    const f = content?.finding ? d.findings.find((x) => x.id === content.finding) : undefined;
    return f && unhidden(f) ? f : undefined;
  };
  const hiddenNote = () => (level !== "all" ? ` The filter (${filterLabel(level)}) is hiding the rest; ${keyOf("filter.all")} shows all.` : "") + (hidden.size ? " Chapters you have not read yet keep theirs hidden until you have been through them." : "");
  // `f h`, `f m`, `f a`: findings the level hides leave the screen, and an open one that goes is closed.
  const setFilter = (next: Filter) => {
    if (next === level) { setNote(`already showing ${filterLabel(next)}`); return; }
    if (next === "all") delete r.filter; else r.filter = next;
    setLevelRaw(next); save(r);
    const open = content?.finding ? d.findings.find((x) => x.id === content.finding) : undefined;
    if (open && !filtered([open], next).length) setContent(null);
    const gone = d.findings.filter((f) => unhidden(f) && !filtered([f], next).length).length;
    setNote(`filter: ${filterLabel(next)}${gone ? ` (${gone} hidden by the filter)` : ""}`);
  };
  // After an action is picked the finding stays open, showing its new action; `g f` goes on to the next one.
  const decided = (f: Finding, next: Human) => { Object.assign(h, next); redraw(); showFinding(f); };
  const land = (hit: (Pos & { finding: Finding }) | undefined) => {
    if (!hit) { setContent({ title: "Findings", body: `There are no findings to go to.${hiddenNote()}` }); return; }
    setPos({ item: hit.item, line: hit.line });
    showFinding(hit.finding);
  };
  const place = (id: string, l: number | null) => `${printable(items.find((x) => x.id === id)?.path ?? id)}${l !== null ? `:${l}` : ""}`;

  // Fast typing or a paste can deliver several plain characters in one chunk ("g12"): take them one at a time. An escape
  // sequence Ink did not read as a key (it hands those over with the ESC stripped) stays whole, for tokenOf to read.
  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !/^[[O][0-9;]*[A-Za-z~]$/.test(input)) for (const c of input) handle(c, {});
    else handle(input, key);
  });
  // From where the content is drawn: an answer opens scrolled to its end (a scroll past it), and a page up starts from there.
  const scrollBy = (by: number) => setScroll((s) => { const n = mode.kind === "submit" ? flowLines(L.contentInner).length : contentLines.length; return clampScroll(clampScroll(s, n, L.contentRows) + by, n, L.contentRows); });

  /**
   * Every key goes through the tables: tokenOf reads the key, `step` (chord.ts) resolves it in the current state, with any
   * pending prefix, to an action id, and `act` does it. The only key outside the tables is Esc, which backs out; in a
   * prompt, anything that is not one of its keys is text.
   */
  const handle = (ch: string, key: InkKey) => {
    const tok = tokenOf(ch, key);
    if (busy) { if (tok === "esc") abortRef.current?.abort(); return; }
    if (!tok) return;
    setNote(null);
    // Capturing a binding, typing the editor, or the question on leaving: the key itself, not what it is bound to.
    const open = settingsRef.current;
    if (open?.sub) { settingsDone(settingsKey(open, tok)); return; }
    const res = step(open ? { state: "settings" } : keyState, pendingRef.current, tok);
    setPending(res.pending);
    if (res.out.kind === "act") { act(res.out.id, res.out.n); return; }
    if (res.out.kind === "escape") { backOut(); return; }
    if (keyState.state === "prompt" && res.out.kind === "none" && mode.kind !== "severity") {
      if (tok === "backspace") setInput((s) => s.slice(0, -1));
      else if (tok === "space") setInput((s) => s + " ");
      else if ([...tok].length === 1) setInput((s) => s + tok);
    }
    // The submit flow's comment box, while it is typing, takes text the same way.
    if (keyState.state === "submit" && keyState.step === "comment" && keyState.typing && res.out.kind === "none") {
      if (tok === "backspace") setFlow(flows.backspace);
      else if (tok === "space") setFlow((f) => flows.typeText(f, " "));
      else if ([...tok].length === 1) setFlow((f) => flows.typeText(f, tok));
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
  // After a settings key: save (applying the config at once) and leave, leave, or stay with the new state.
  const settingsDone = ({ s, out }: SettingsOut) => {
    if (out === "leave") { setSettings(null); return; }
    if (out !== "save") { setSettings(s); return; }
    let cfg: Config;
    try { cfg = saveSettings(s); } catch (e) { setSettings({ ...s, message: { text: `not saved: ${(e as Error).message}`, error: true } }); return; }
    installKeymap(cfg.keymap); setDefaults(cfg.defaults);
    if (cfg.wrap !== s.initial.wrap) setWrap(cfg.wrap);
    if (cfg.blind !== s.initial.blind) setBlind(cfg.blind);
    Object.assign(live, cfg); onConfig?.(cfg);
    setSettings(null); setNote(`settings saved to ${cfg.path}`);
  };
  // A key whose behaviour comes with a later change says so, and does nothing else.
  const coming = (id: string) => { const a = rowById(id); setNote(`${keyOf(id)} ${a?.label ?? id}: not built yet, coming with ${a?.coming ?? "a later change"}`); };
  const copy = () => {
    if (mode.kind === "results") { const a = mode.answers[mode.sel]; setNote(a ? confirmation(copier(answerText(a))) : "nothing to copy here"); return; }
    // The content area copies its own text; with nothing there, the cursor line's reference, which is what you paste into a note.
    const l = lines[line], at = l ? l.n ?? l.o : null;
    const text = view ? view.copy : item && at !== null ? `${item.path}:${at}` : item && row !== "line" ? item.path : undefined;
    setNote(text ? confirmation(copier(text)) : "nothing to copy here");
  };
  // Enter in a prompt: what the typed line does depends on the prompt.
  const send = () => {
    if (mode.kind === "nav" || mode.kind === "results" || mode.kind === "submit") return;
    // Your own finding: Enter on the severity goes on to the comment; Enter on the comment saves the finding.
    if (mode.kind === "severity") { setMode({ kind: "finding", severity: SEVERITIES[mode.sel]!, spot: mode.spot }); setInput(""); return; }
    const text = input.trim();
    if (mode.kind === "docs") {
      setInput("");
      if (!text) { setMode({ kind: "nav" }); return; }
      try { showResults(text, answersFor(text), 0); } catch (e) { setMode({ kind: "nav" }); setContent({ title: "search the docs failed", body: String((e as Error).message), color: "red" }); }
      return;
    }
    if (mode.kind === "finding") {
      // An emptied comment makes no finding; the prompt stays open.
      if (!text) { setNote("a finding needs its comment; Esc cancels"); return; }
      const made = ownFinding(d.findings, h, mode.spot, mode.severity, text, new Date().toISOString(), defaults);
      setMode({ kind: "nav" }); setInput("");
      d.findings.push(made.finding); Object.assign(h, made.human); redraw(); showFinding(made.finding);
      // A filter that hides its severity hides it on its line too; it is still made, and still in the submit checklist.
      if (!filtered([made.finding], level).length) setNote(`saved; the filter (${filterLabel(level)}) hides it on the screen, ${keyOf("filter.all")} shows all`);
      return;
    }
    setMode({ kind: "nav" }); setInput("");
    const f = mode.kind === "reason" ? d.findings.find((x) => x.id === mode.id) : mode.kind === "comment" && mode.decide ? d.findings.find((x) => x.id === mode.decide!.id) : undefined;
    const at = new Date().toISOString();
    if (mode.kind === "reason") { if (f) decided(f, decide(h, f, "ignore", { reason: text, at })); return; }
    // An emptied comment changes nothing: the finding keeps the action it had.
    if (mode.kind === "comment" && mode.decide) { if (f) { if (text) decided(f, decide(h, f, mode.decide.kind, { text, at })); else showFinding(f); } return; }
    if (mode.kind === "ask") ask(mode.subject, text);
  };

  // `a ?`: the agent's steps stream into the content area as it reads, then the subject's whole conversation replaces
  // them. About a finding, the finding stays open throughout and the conversation follows its detail.
  const ask = (s: Subject, q: string) => {
    const f = s.kind === "finding" ? d.findings.find((x) => x.id === s.id) : undefined;
    const base: Content = f ? findingContent(f) : { title: `Ask · ${subjectLabel(d, files, s)}`, color: "cyan", body: "" };
    const steps: string[] = [];
    const draw = () => setContentRaw({ ...base, body: `› ${q || "(explain this)"}\n\n${steps.length ? steps.map((x) => `  ${x}`).join("\n") : "  starting…"}` });
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy("asking…"); setScroll(0); draw();
    askAbout(r, files, s, q, { ...askDeps, signal: ctl.signal, onStep: (x) => { steps.push(x); draw(); } })
      .then(() => {
        save(r);
        const turns = r.asks?.[subjectKey(s)] ?? [], last = turns[turns.length - 1];
        if (f) { setContent(findingContent(d.findings.find((x) => x.id === f.id) ?? f)); setScroll(Number.MAX_SAFE_INTEGER); return; }
        setContent({ title: `Ask · ${subjectLabel(d, files, s)}`, color: "cyan", body: `${conversationText(turns)}\n\n${keyOf("ai.ask")} asks a follow-up.`, copy: last ? askText(last.q || "Explain this", last.a) : undefined });
        setScroll(Number.MAX_SAFE_INTEGER);
      }, (e) => {
        const why = ctl.signal.aborted ? "Cancelled; nothing was kept." : `Asking failed: ${String((e as Error).message)}`;
        setContent(f ? { ...findingContent(f), body: why } : { title: `Ask · ${subjectLabel(d, files, s)}`, body: why, color: ctl.signal.aborted ? undefined : "red" });
      })
      .finally(() => { abortRef.current = null; setBusy(null); });
  };

  // What each action does. Every id in the key tables has a case here (a test holds the two together).
  const act = (id: string, n?: number) => {
    switch (id) {
      // ---- anywhere outside a finding
      case "review.quit": onDone({ kind: "quit" }); exit(); return;
      // Every finding is in the checklist, whatever the filter (it is for reading); a blind chapter's stay hidden and post nothing.
      case "review.submit": setContent(null); setMode({ kind: "submit", flow: flows.startFlow(unfiltered(), h, verdictsFor(d.target.platform), defaults, draft) }); return;
      case "review.copy": case "finding.copy": case "content.copy": copy(); return;
      case "review.search_docs": setMode({ kind: "docs" }); setInput(""); return;
      case "review.settings": setSettings(openSettings(live, configPath())); return;

      // ---- the settings view
      case "settings.down": case "settings.up": case "settings.right": case "settings.left": case "settings.edit": case "settings.clear": case "settings.leave":
        if (settingsRef.current) settingsDone(settingsAct(settingsRef.current, id));
        return;

      // ---- the code
      case "code.down": lineBy(1); return;
      case "code.up": lineBy(-1); return;
      case "code.next_chapter": goChapter(1); return;
      case "code.prev_chapter": goChapter(-1); return;
      case "code.open_finding": {
        if (item && hidden.has(item.id)) { setContent({ title: "Findings", body: "Hidden until you have been through this chapter." }); return; }
        const l = lines[line], here = (row !== "line" ? findingsOnFile(row) : l ? findingsAt(l) : []).sort(worstFirst);
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
      // Enter always makes a new finding, on the cursor's line or the file's row: the severity first, then the comment.
      case "code.new_finding": {
        const spot = spotHere();
        if (!spot) { setNote("there is nothing here to write a finding on"); return; }
        if (item && hidden.has(item.id)) { setContent({ title: "Findings", body: "Hidden until you have been through this chapter." }); return; }
        setMode({ kind: "severity", sel: 1, spot }); return;
      }
      case "prompt.up": case "prompt.down":
        if (mode.kind === "severity") setMode({ ...mode, sel: Math.max(0, Math.min(SEVERITIES.length - 1, mode.sel + (id === "prompt.down" ? 1 : -1))) });
        return;
      case "prompt.newline": setInput((s) => s + "\n"); return;

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
      // The subject: the open finding, else the chapter in the table of contents, else the block in the code.
      case "ai.ask": {
        const f = target();
        const s: Subject | undefined = f ? { kind: "finding", id: f.id } : !item ? undefined : tree === "toc" ? { kind: "chapter", chapter: item.chapter } : { kind: "block", hunk: item.id };
        if (s) { setMode({ kind: "ask", subject: s }); setInput(""); } else setNote("nothing to ask about: the diff is empty");
        return;
      }
      case "ai.accept": {
        const f = target(), res = f && r.asks ? acceptAnswer(d, r.asks, f.id, new Date().toISOString()) : undefined;
        if (!f || !res) return;
        redraw(); showFinding(d.findings.find((x) => x.id === f.id) ?? f);
        setNote(res.changed ? `finding revised: ${res.changed}` : "answer accepted; it proposed no change to the finding");
        return;
      }
      case "ai.discard": {
        const f = target();
        if (!f || !r.asks || !discardAnswer(r.asks, f.id)) return;
        redraw(); showFinding(f); setNote("answer discarded; the finding is as it was");
        return;
      }

      // ---- v: view
      case "view.editor": {
        if (!item) return;
        const l = lines[line];
        const at = l?.n ?? lines.slice(Math.max(0, line)).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
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

      // ---- submit: findings, verdict, comment, send (submit-flow.ts)
      case "submit.down": case "submit.up": { const b = flowBoxes(); setFlow((f) => flows.move(f, id === "submit.down" ? 1 : -1, b)); return; }
      case "submit.tick": { const b = flowBoxes(); setFlow((f) => flows.toggle(f, b)); return; }
      case "submit.tick_all": setFlow(flows.toggleAll); return;
      case "submit.next": setScroll(0); setFlow((f) => flows.nextStep(f, d.findings, h, defaults)); return;
      case "submit.back": setScroll(0); setFlow((f) => flows.prevStep(f, d.findings, h, defaults)); return;
      case "submit.newline": setFlow(flows.newline); return;
      case "submit.clear_line": setFlow(flows.clearLine); return;
      case "submit.word": setFlow(flows.deleteWord); return;
      case "submit.stop_typing": setFlow((f) => ({ ...f, typing: false })); return;
      case "submit.edit": setFlow((f) => ({ ...f, typing: true })); return;
      case "view.comment_editor": if (mode.kind === "submit") { onDone({ kind: "edit_comment", flow: mode.flow }); exit(); } return;
      case "submit.leave": setMode({ kind: "nav" }); setContent(null); return;
      case "submit.send": {
        if (mode.kind !== "submit") return;
        const fl = mode.flow;
        if (!fl.verdict) { setNote(`pick a verdict first: ${keyOf("submit.back")} goes back to it`); return; }
        const b = flowBoxes();
        onDone({ kind: "submit", hook: fl.hook && b.includes("hook"), coverage: fl.coverage && b.includes("coverage"), selection: flows.selectionOf(fl), defaults });
        exit();
        return;
      }

      // ---- f: filter
      case "filter.high": setFilter("high"); return;
      case "filter.medium": setFilter("medium"); return;
      case "filter.all": setFilter("all"); return;

      // ---- keys whose behaviour comes with a later change: each says so
      case "ai.draft":
        coming(id); return;
    }
  };

  // ---- layout
  // The submit flow takes the whole screen when its step needs the room; the send step always does.
  const L0 = layoutOf(cols, rows, { zen, full: full && !!view });
  const flowLines = (inner: number) => mode.kind === "submit" ? flowView(mode.flow, inner) : [];
  const flowFull = mode.kind === "submit" && (mode.flow.step === "send" || flowLines(L0.contentInner).length > L0.contentRows);
  const L = flowFull ? layoutOf(cols, rows, { zen, full: true }) : L0;
  const { railW, mainW, gutterW, codeW, boxW, boxInner } = L;
  const codeCols = codeW - 1; // the +/- sign takes the first column
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && h.visited.includes(i.id)).length;
  const anyHidden = d.findings.some((f) => !unhidden(f));

  // The status area's second line: separate fields, each whole or dropped, in the order status.ts documents.
  const inHouse = r.suggested?.find((v) => v.by === IN_HOUSE);
  const fields = fitFields(statusFields({
    label: printable(d.target.label), base: d.target.base, head: d.target.head, read: { seen, total },
    findings: bySeverity(visible()), hidden: anyHidden,
    comments: h.comments.length, filter: level, suggested: inHouse ? VERDICT[inHouse.verdict] : undefined,
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
  // Rows: the file's "whole file" row first when this block starts it, then the diff lines, then the row that ends the file.
  const rowLine = (i: number): number => i - off; // the index into `lines`, or -1 / lines.length on a whole-file row
  const heights = Array.from({ length: nRows }, (_, i) => { const l = lines[rowLine(i)]; return l ? (wrap ? rowsFor(lengthOf(spans[rowLine(i)] ?? []), codeCols) : 1) + notesAt(l).length : 1; });
  const { start, end } = windowOf(heights, line + off, Math.max(1, bodyRows - boxH));
  // The table of contents: every chapter, the blocks of the expanded ones, windowed round the cursor's row like the code.
  const railRows = tocRows(items, collapsed);
  const railWin = windowOf(railRows.map(() => 1), Math.max(0, tocIndex(railRows, items, { item: pos.item, onChapter: tree === "toc" && onChapter })), Math.max(1, L.middleH - 1));
  const railShown = railRows.slice(railWin.start, railWin.end);
  const shown = Array.from({ length: Math.max(0, end - start) }, (_, k) => start + k);
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

  // A comment being typed, which can have several lines: the last ones that fit, the cursor at the end.
  const typed = (title: string, label: string, hint: string) => {
    const room = Math.max(1, L.contentRows - 2), all = inputLines(input, L.contentInner - label.length - 3), tail = all.slice(-room);
    return <>
      <Text bold color="cyan" wrap="truncate">{title}</Text>
      {tail.map((t, i) => <Text key={i} wrap="truncate">{i === 0 && all.length <= room ? <Text color="cyan" bold>{label} › </Text> : <Text>{" ".repeat(label.length + 3)}</Text>}{t}{i === tail.length - 1 ? <Text inverse> </Text> : null}</Text>)}
      <Text dimColor wrap="truncate">{hint}</Text>
    </>;
  };
  // What the content area holds: a prompt or the verdict question while one is open, else what was last shown there.
  const contentView = () => {
    switch (mode.kind) {
      // Your own finding: the severity (arrows, then Enter), then the comment, which can run to several lines.
      case "severity": case "finding": {
        const where = "file" in mode.spot ? `${printable(items.find((x) => x.id === mode.spot.hunk)?.path ?? "")} (whole file)` : place(mode.spot.hunk, mode.spot.line);
        if (mode.kind === "severity") return <>
          <Text bold color="cyan" wrap="truncate">New finding at {where} · pick its severity</Text>
          {SEVERITIES.map((s, i) => <Text key={s} wrap="truncate" color={i === mode.sel ? SEV[s] : undefined} bold={i === mode.sel}>{i === mode.sel ? "▸" : " "} {s}<Text dimColor>{` · starts as ${LABEL[defaults[s]]}`}</Text></Text>)}
          <Text dimColor wrap="truncate">Enter chooses, Esc cancels.</Text>
        </>;
        return typed(`New ${mode.severity} finding at ${where}`, "comment", `Posted if its action is ${LABEL.block} or ${LABEL.comment}. Enter saves · ${keyOf("prompt.newline")} new line.`);
      }
      // A comment on a finding can run to several lines too (one saved with a new line in it comes back prefilled).
      case "comment": return typed(`${mode.decide?.kind === "block" ? "Block on" : "Comment on"} the finding`, mode.decide?.kind === "block" ? "block on it" : "comment on the finding", `Enter saves · ${keyOf("prompt.newline")} new line.`);
      case "reason": case "ask": case "docs": {
        const label = mode.kind === "docs" ? "search the docs" : mode.kind === "ask" ? "ask" : "ignore · private note";
        const earlier = mode.kind === "ask" ? (r.asks?.[subjectKey(mode.subject)] ?? []).filter((t) => t.outcome !== "discarded").length : 0;
        const title = mode.kind === "docs" ? "Search the docs" : mode.kind === "ask" ? `Ask about the ${subjectLabel(d, files, mode.subject)}${earlier ? ` · a follow-up to ${earlier} earlier question${earlier === 1 ? "" : "s"}` : ""}` : "Ignore the finding";
        return <>
          <Text bold color="cyan" wrap="truncate">{title}</Text>
          <Text><Text color="cyan" bold>{label} › </Text>{input}<Text inverse> </Text>{mode.kind === "reason" && !input ? <Text dimColor>private note — never posted</Text> : null}</Text>
        </>;
      }
      case "submit": {
        const fl = mode.flow, ls = flowLines(L.contentInner);
        // The findings, the radio and the comment keep their cursor in view; the send step scrolls with the page keys.
        const focus = Math.max(0, ls.findIndex((l) => l.cursor));
        const top = fl.step === "send" ? clampScroll(scroll, ls.length, L.contentRows) : Math.max(0, Math.min(Math.max(0, ls.length - L.contentRows), focus - Math.floor(L.contentRows / 2)));
        const more = ls.length > L.contentRows;
        return <>
          <Text wrap="truncate"><Text bold color="green">Submit</Text>{FLOW_STEPS.map((st, i) => <Text key={st} dimColor={st !== fl.step} bold={st === fl.step} color={st === fl.step ? "green" : undefined}>{i ? " › " : " · "}{i + 1} {STEP_NAMES[st]}</Text>)}{dryRun ? <Text color="yellow"> · dry run</Text> : null}{more ? <Text dimColor> · {top + 1}-{Math.min(ls.length, top + L.contentRows)}/{ls.length}</Text> : null}</Text>
          {ls.slice(top, top + L.contentRows).map((l, j) => <Text key={j} wrap="truncate" inverse={l.cursor && fl.step !== "comment"} bold={l.head} dimColor={l.dim} color={l.on ? "green" : undefined}>{l.text || " "}{l.cursor && fl.step === "comment" ? <Text inverse> </Text> : null}</Text>)}
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
    : <Text wrap="truncate" dimColor> {busy ? `${busy} keys wait until it answers${abortRef.current ? "; Esc cancels" : ""}` : full && view && mode.kind !== "submit" ? `${keyOf("view.fullscreen")} or Esc restores the layout` : ""}{pending ? <Text color="cyan">   {pendingText(pending)}</Text> : null}</Text>;

  if (tooSmall(term)) return <Text wrap="truncate">terminal too small, need {MIN_COLS}x{MIN_ROWS}</Text>;
  if (settings) return <SettingsScreen s={settings} cols={cols} rows={rows} />;

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
                {shown.map((ri) => {
                  const i = rowLine(ri), l = lines[i];
                  const cur = i === line, lit = cur && tree === "code"; // the cursor line is lit only while the arrows act in the code
                  if (!l) {
                    // A file's whole-file row: where Enter writes a finding about the file. Its findings are marked like a line's.
                    const kind = i < 0 ? "start" : "end", wf = findingsOnFile(kind), worst = wf.filter((f) => !ignored(f)).sort(worstFirst)[0];
                    const wmark = worst ? <Text color={SEV[worst.severity]}>▲</Text> : wf.length ? <Text dimColor>△</Text> : <Text> </Text>;
                    return (
                      <Box key={`w${kind}`} flexDirection="column">
                        <Text wrap="truncate"><Text dimColor={!cur} color={cur ? "cyan" : undefined}>{" ".repeat(gutterW)}</Text> {wmark} <Text dimColor={!lit} inverse={lit}>{fit(`${kind === "start" ? "┌" : "└"} whole file · ${printable(item.path)}`).padEnd(lit ? codeW : 0)}</Text></Text>
                        {cur ? findingBox() : null}
                      </Box>
                    );
                  }
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
export function show(review: Review, files: FileDiff[], beside?: Beside, blind = false, dryRun = false, defaults: Defaults = DEFAULTS, config?: Config, onConfig?: (cfg: Config) => void, resume?: Flow, askDeps?: AskDeps): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome = { kind: "quit" };
    process.stdout.write("\x1b[?1049h\x1b[H");
    const app = render(<App review={review} files={files} beside={beside} blind={blind} dryRun={dryRun} defaults={defaults} config={config} onConfig={onConfig} resume={resume} askDeps={askDeps} onDone={(o) => { outcome = o; }} />, { exitOnCtrlC: true });
    app.waitUntilExit().then(() => { app.clear(); process.stdout.write("\x1b[?1049l"); save(review); resolve(outcome); });
  });
}
