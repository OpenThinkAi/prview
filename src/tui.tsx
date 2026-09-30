// The screen. A rail of chapters on the left, one hunk at a time on the right, and a floating box
// for whatever wants explaining: why a chapter matters, a finding, the answer to a question, the
// review before you submit it.
//
// The app owns the terminal; an editor is something it launches. `e` hands back an `edit` outcome
// with the file and line under the cursor, the CLI runs the editor in the head worktree, then renders
// the app again with the same state. Inside tmux the CLI passes `beside` instead, and the editor opens in
// a split pane while this screen stays up.
//
// Everything shown comes from the review document (`review.doc`), whoever produced it; the rest of
// the review is only where the cursor was and where the worktree is.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { where, type DiffLine, type FileDiff } from "./diff.ts";
import { hunksOf, MECHANICAL_INTENT, worstFirst, type Finding, type HunkAt } from "./guide.ts";
import { ask, save, VERDICT, writeup, type Pos, type Review } from "./build.ts";
import type { Doc, Verdict } from "./document.ts";
import { chapterHidden, hiddenHunks, revealBody, revealEarly } from "./blind.ts";
import { gotoLine, nextFinding, type NavItem } from "./nav.ts";
import { highlightLines, langOf, lengthOf, sliceSpans, styleOf, type Span } from "./highlight.ts";
import { clampScroll, clampX, floatHeight, floatRows, layoutOf, pageStep, rowsFor, windowOf, wrapText } from "./layout.ts";
import type { Beside } from "./editor.ts";
import { askText, confirmation, findingText, systemCopier, whyText, type Copier } from "./clipboard.ts";
import { describe, planOf } from "./submit.ts";

/** `hook`: the human allowed the document's on_submit command for this submit (x in the preview). */
export type Outcome = { kind: "quit" } | { kind: "submit"; hook: boolean; findings: string[]; coverage: boolean } | { kind: "edit"; path: string; line: number };

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
/** `copy` is the float's source text for `y`: what it means, not the wrapped and boxed lines drawn from `body`. */
type Float = { title: string; body: string; color?: string; tall?: boolean; copy?: string };
type Mode = { kind: "nav" } | { kind: "comment"; general: boolean } | { kind: "ask" } | { kind: "verdict" } | { kind: "include" } | { kind: "preview"; hook: boolean; findings: string[]; coverage: boolean };

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
  const { stdout } = useStdout();
  const cols = size?.cols ?? (stdout.columns || 100), rows = (size?.rows ?? (stdout.rows || 40)) - 1;
  const r = useRef(review).current;
  const d = r.doc, h = d.human;
  const items = useMemo(() => itemsOf(d, files), [d, files]);
  const [, bump] = useState(0);
  const redraw = () => { save(r); bump((n) => n + 1); };
  const [pos, setPosRaw] = useState<Pos>(() => ({ item: Math.min(r.pos.item, Math.max(0, items.length - 1)), line: r.pos.line }));
  const setPos = (p: Pos) => { r.pos = p; setPosRaw(p); };
  const [float, setFloatRaw] = useState<Float | null>(() => d.plan.summary ? { title: "What this change is", copy: d.plan.summary, body: `${d.plan.summary}\n\n? why this chapter · f finding · ]f next finding · w wrap · a ask · e editor · n comment · N summary · s submit · q quit` } : null);
  const [scroll, setScroll] = useState(0);
  // What `y` just did, shown in the footer until the next key.
  const [note, setNote] = useState<string | null>(null);
  const setFloat = (f: Float | null) => { setScroll(0); setFloatRaw(f); };
  const [mode, setMode] = useState<Mode>({ kind: "nav" });
  const [input, setInput] = useState("");
  // Keys can arrive several to a chunk (a fast "781G"), all handled by one closure: the prefix state lives in refs.
  const countRef = useRef(""), pendingRef = useRef<"g" | "]" | "[" | null>(null);
  const [, tick] = useState(0);
  const setCount = (c: string) => { countRef.current = c; tick((n) => n + 1); };
  const setPending = (p: "g" | "]" | "[" | null) => { pendingRef.current = p; tick((n) => n + 1); };
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
  const kept = (f: Finding) => live(f) && unhidden(f) && !h.dismissals.includes(f.id);
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
    const gone = h.dismissals.includes(f.id);
    setFloat({ title: `▲ ${f.source} · ${f.kind} · ${f.severity}${f.votes && r.ai?.samples ? ` · ${f.votes}/${r.ai.samples}` : ""}${gone ? " · dismissed" : ""}`, color: SEV[f.severity], copy: findingText(f, place(f.hunk, f.line)), body: `${f.claim}\n\n${f.evidence}${f.refute ? `\n\nSecond look: ${f.refute}` : ""}\n\nd to ${gone ? "restore" : "dismiss"}.` });
  };
  const jumpFinding = (dir: 1 | -1) => {
    const hit = nextFinding(items, d.findings.filter((f) => live(f) && unhidden(f)), { item: pos.item, line }, dir);
    if (!hit) { setFloat({ title: "Findings", body: (dir > 0 ? "No more findings after this point." : "No findings before this point.") + (hidden.size ? " Chapters you have not read yet keep theirs hidden; F reveals one." : "") }); return; }
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
  const preview = (hook: boolean, findings: string[], coverage: boolean) => {
    const p = planOf(r, files, { findings, coverage });
    setMode({ kind: "preview", hook, findings, coverage });
    setFloat({ title: `${VERDICT[h.verdict!]} · Enter ${dryRun ? "prints the calls" : "submits"}${p.hook ? `, x ${hook ? "disallows" : "allows"} the command` : ""}${p.adapter ? `, v ${coverage ? "drops" : "adds"} the coverage line` : ""}, Esc goes back`, color: "green", tall: true, body: `${writeup(d, files)}\n${describe(p, hook, dryRun)}` });
  };

  // Fast typing or a paste can deliver several plain characters in one chunk ("781G"): take them one at a time.
  useInput((input, key) => { if (input.length > 1 && !key.ctrl && !key.meta) for (const c of input) handle(c, key); else handle(input, key); });
  const scrollFloat = (ch: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): boolean => {
    const by = key.pageDown || key.ctrl && ch === "d" ? pageStep(floatH) : key.pageUp || key.ctrl && ch === "u" ? -pageStep(floatH)
      : mode.kind === "preview" && (ch === "j" || key.downArrow) ? 1 : mode.kind === "preview" && (ch === "k" || key.upArrow) ? -1 : 0;
    if (!by) return false;
    setScroll((s) => clampScroll(s + by, floatLines.length, floatH));
    return true;
  };
  const handle = (ch: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (busy) return;
    if (mode.kind === "verdict") {
      const v: Verdict | undefined = ch === "a" ? "approve" : ch === "r" ? "request_changes" : ch === "c" ? "comment" : undefined;
      if (key.escape) { setMode({ kind: "nav" }); return; }
      if (v) {
        h.verdict = v; save(r);
        // Kept findings are the critic's, not yours: posting them is a choice, and the answer starts as no.
        if (d.findings.some(kept)) { setMode({ kind: "include" }); setFloat(null); } else preview(false, [], false);
      }
      return;
    }
    if (mode.kind === "include") {
      if (key.escape) { setMode({ kind: "verdict" }); return; }
      if (ch === "y" || ch === "n" || key.return) preview(false, ch === "y" ? d.findings.filter(kept).map((f) => f.id) : [], false);
      return;
    }
    if (mode.kind === "preview") {
      if (key.escape) { setMode({ kind: "verdict" }); setFloat(null); return; }
      if (key.return) { onDone({ kind: "submit", hook: mode.hook, findings: mode.findings, coverage: mode.coverage }); exit(); return; }
      if (ch === "x" && d.on_submit) { const at = scroll; preview(!mode.hook, mode.findings, mode.coverage); setScroll(at); return; }
      if (ch === "v" && planOf(r, files).adapter) { const at = scroll; preview(mode.hook, mode.findings, !mode.coverage); setScroll(at); return; }
      scrollFloat(ch, key);
      return;
    }
    if (mode.kind !== "nav") {
      if (key.escape) { setMode({ kind: "nav" }); setInput(""); return; }
      if (key.return) {
        const text = input.trim();
        setMode({ kind: "nav" }); setInput("");
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
      else if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
      return;
    }

    // ---- nav
    const count = countRef.current, pending = pendingRef.current;
    setNote(null);
    if (key.escape) { setFloat(null); setCount(""); setPending(null); return; }
    if (pending) {
      const p = pending; setPending(null);
      if (p === "g" && ch === "g") setPos({ ...pos, line: 0 });
      else if ((p === "]" || p === "[") && ch === "f") jumpFinding(p === "]" ? 1 : -1);
      else if ((p === "]" || p === "[") && ch === "c") goChapter(p === "]" ? 1 : -1);
      return;
    }
    if (key.ctrl || key.pageDown || key.pageUp) { scrollFloat(ch, key); return; } // before the letters: ctrl-d is a page, not "dismiss"
    if (/^[0-9]$/.test(ch) && (count || ch !== "0")) { setCount(count + ch); return; }
    const n = count ? parseInt(count, 10) : undefined;
    setCount("");
    const toLine = () => { const at = gotoLine(items, pos.item, n!); if (at) { setPos(at); setFloat(null); } };
    if (ch === "g") { if (n !== undefined) toLine(); else setPending("g"); return; }
    if (ch === "]" || ch === "[") { setPending(ch); return; }
    if (ch === "q") { onDone({ kind: "quit" }); exit(); return; }
    if (ch === "s") { setMode({ kind: "verdict" }); setFloat(null); return; }
    if (ch === "G") { if (n !== undefined) toLine(); else setPos({ ...pos, line: Math.max(0, lines.length - 1) }); }
    else if (ch === "j" || key.downArrow) setPos({ ...pos, line: Math.min(lines.length - 1, line + (n ?? 1)) });
    else if (ch === "k" || key.upArrow) setPos({ ...pos, line: Math.max(0, line - (n ?? 1)) });
    else if (ch === "l" || key.rightArrow || ch === " ") goItem(pos.item + (n ?? 1));
    else if (ch === "h" || key.leftArrow) goItem(pos.item - (n ?? 1));
    else if (ch === "J") goChapter(1);
    else if (ch === "K") goChapter(-1);
    else if (ch === "?") {
      if (!item) return;
      const body = item.mechanical ? `${MECHANICAL_INTENT}\n\nMechanical: ${item.mechanical}. Classified by rule, not by a model.` : `${chapter?.intent ? chapter.intent + "\n\n" : ""}${chapter?.why || "The guide gave no reason for this chapter."}`;
      setFloat({ title: `${item.chapter + 1} · ${chapterTitle}`, body, copy: item.mechanical ? body : whyText(chapterTitle, chapter?.intent, chapter?.why || "The guide gave no reason for this chapter.") });
    }
    else if (ch === "y") {
      // An open box copies its own text; with none open, the cursor line's reference, which is what you paste into a note.
      const l = lines[line], at = l ? l.n ?? l.o : null;
      const text = float ? float.copy : item && at !== null ? `${item.path}:${at}` : undefined;
      setNote(text ? confirmation(copier(text)) : "nothing to copy here");
    }
    else if (ch === "F") reveal();
    else if (ch === "f") { // the next finding in this hunk, from the cursor, wrapping
      if (item && hidden.has(item.id)) { setFloat({ title: "Findings", body: "Hidden until you have been through this chapter. F reveals them now (and the review notes you did)." }); return; }
      if (!findingsHere.length) { setFloat({ title: "Findings", body: "None in this hunk. ]f jumps to the next one anywhere." }); return; }
      let at = lines.findIndex((l, i) => i > line && findingsAt(l).length);
      if (at < 0) at = lines.findIndex((l) => findingsAt(l).length);
      if (at >= 0) setPos({ ...pos, line: at });
      showFinding((at >= 0 ? findingsAt(lines[at]!) : findingsHere)[0]!);
    }
    else if (ch === "d") {
      const f = findingsAt(lines[line]!)[0] ?? findingsHere[0];
      if (!f) return;
      h.dismissals = h.dismissals.includes(f.id) ? h.dismissals.filter((x) => x !== f.id) : [...h.dismissals, f.id];
      redraw(); setFloat(null);
    }
    else if (ch === "e") {
      if (!item) return;
      const l = lines[line];
      const at = l?.n ?? lines.slice(line).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
      if (beside) { const err = beside(item.path, at); if (err) setFloat({ title: "editor", body: err, color: "red" }); return; }
      onDone({ kind: "edit", path: item.path, line: at }); exit();
    }
    else if (ch === "n") setMode({ kind: "comment", general: false });
    else if (ch === "N") setMode({ kind: "comment", general: true });
    else if (ch === "a") setMode({ kind: "ask" });
    else if (ch === "w") { setWrap(!wrap); setPanX(0); }
    else if (ch === "H" || ch === "L") { if (!wrap) setPanX(clampX(panX + (ch === "L" ? PAN : -PAN), longest, codeCols)); }
    else scrollFloat(ch, key);
  };

  // ---- layout
  const L = layoutOf(cols);
  const { railW, mainW, gutterW, codeW, floatW, floatInner } = L;
  const codeCols = codeW - 1; // the +/- sign takes the first column
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && h.visited.includes(i.id)).length;
  const liveFindings = d.findings.filter(kept).length;
  const anyHidden = d.findings.some((f) => live(f) && !unhidden(f));

  // The float sits right under the cursor line, so the window keeps that many rows free below it.
  const floatLines = float ? wrapText(float.body, floatInner) : [];
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

  const footer = () => {
    switch (mode.kind) {
      case "verdict": return <Text><Text color="green" bold> verdict › </Text>a approve   r request changes   c comment   <Text dimColor>Esc cancel</Text></Text>;
      case "include": return <Text><Text color="green" bold> post your {d.findings.filter(kept).length} kept finding{d.findings.filter(kept).length === 1 ? "" : "s"} as comments? › </Text>y yes   <Text bold>n no</Text> (Enter)   <Text dimColor>Esc back</Text></Text>;
      case "preview": return <Text wrap="truncate" dimColor> Enter {dryRun ? "prints the calls" : "submits"}{planOf(r, files).adapter ? ` · v ${mode.coverage ? "drop" : "add"} coverage line` : ""}{d.on_submit ? ` · x ${mode.hook ? "disallow" : "allow"} the document's command` : ""} · Esc back to the verdict · j/k PgUp/PgDn scroll</Text>;
      case "nav": if (note) return <Text wrap="truncate" color="green"> {note}</Text>;
        return <Text wrap="truncate" dimColor> {L.narrow
        ? "j/k h/l hunk  ]f find  ? why  y copy  a ask  e edit  n note  w wrap  s send  q quit"
        : `j/k line  h/l hunk  J/K chapter  ]f finding  ${blind ? "F reveal  " : ""}? why  y copy  f/d finding  a ask  e edit  n/N note  w wrap  H/L pan  s submit  q quit`}{countRef.current || pendingRef.current ? <Text color="cyan">   {countRef.current}{pendingRef.current}</Text> : null}</Text>;
      default: return <Text><Text color="cyan" bold> {mode.kind === "ask" ? "ask" : mode.general ? "summary comment" : "comment"} › </Text>{input}<Text inverse> </Text><Text dimColor>  (Enter to send, Esc to cancel)</Text></Text>;
    }
  };

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
            const fs = d.findings.filter((f) => kept(f) && mine.some((x) => x.id === f.hunk)).length;
            const blindFs = chapterHidden(blind, chapters[i] ?? [], h) && d.findings.some((f) => live(f) && mine.some((x) => x.id === f.hunk));
            return (
              <Box key={i} flexDirection="column">
                <Text color={here ? "cyan" : done ? "green" : undefined} bold={here} wrap="truncate">
                  {here ? "▸" : done ? "✓" : " "}{L.narrow ? "" : " "}{i + 1}{L.narrow ? "" : ` ${title}`}{fs ? <Text color="yellow">{L.narrow ? "" : " "}▲{fs}</Text> : blindFs ? <Text color="yellow">{L.narrow ? "" : " "}▲?</Text> : null}
                </Text>
                {here && !L.narrow && mine.map((x) => {
                  const cur = x === item;
                  return <Text key={x.id} color={cur ? "cyan" : undefined} dimColor={!cur && h.visited.includes(x.id)} wrap="truncate">   {cur ? "›" : " "} {x.path.split("/").pop()}:{x.hunk.newStart}{d.findings.some((f) => f.hunk === x.id && kept(f)) ? " ▲" : ""}</Text>;
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
              {shown.map((l, k) => {
                const i = start + k;
                const cur = i === line;
                const fs = findingsAt(l), ns = notesAt(l);
                const worst = fs.filter(kept).sort(worstFirst)[0];
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
                    {cur && float ? (
                      <Box flexDirection="column" marginLeft={gutterW + 2} width={floatW} height={floatH} overflow="hidden" borderStyle="round" borderColor={float.color ?? "gray"} paddingX={1}>
                        <Text bold color={float.color} wrap="truncate">{float.title}{busy ? <Text dimColor> · {busy}</Text> : null}{floatLines.length > floatRows(floatH) ? <Text dimColor> · {sc + 1}-{Math.min(floatLines.length, sc + floatRows(floatH))}/{floatLines.length} PgUp/PgDn</Text> : null}</Text>
                        {shownFloat.map((t, j) => <Text key={j} wrap="truncate">{t}</Text>)}
                      </Box>
                    ) : null}
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
