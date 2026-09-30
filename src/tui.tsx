// The screen. A rail of chapters on the left, one hunk at a time on the right, and a floating box
// for whatever wants explaining: the guide's intent, a finding, the answer to a question.
//
// The app owns the terminal; an editor is something it launches. `e` hands back an `edit` outcome
// with the file and line under the cursor, the CLI runs the editor in the head worktree, then renders
// the app again with the same state.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { where, type DiffLine, type FileDiff } from "./diff.ts";
import { hunksOf, type Finding, type HunkAt } from "./guide.ts";
import { ask, save, type Pos, type Review } from "./build.ts";

export type Outcome = { kind: "quit" } | { kind: "submit" } | { kind: "edit"; path: string; line: number };

/** Everything the rail steps through, in reading order: each chapter's hunks, then the mechanical ones. */
type Item = { chapter: number; id: string; at: HunkAt; mechanical?: string };
function itemsOf(r: Review, files: FileDiff[]): Item[] {
  const at = new Map(hunksOf(files).map((h) => [h.id, h]));
  const out: Item[] = [];
  r.plan.chapters.forEach((c, i) => { for (const id of c.hunks) { const h = at.get(id); if (h?.hunk) out.push({ chapter: i, id, at: h }); } });
  for (const m of r.plan.mechanical) { const h = at.get(m.id); if (h?.hunk) out.push({ chapter: r.plan.chapters.length, id: m.id, at: h, mechanical: m.why }); }
  return out;
}

const SEV = { blocking: "red", warn: "yellow", nit: "blue" } as const;
type Float = { title: string; body: string; color?: string };
type Mode = { kind: "nav" } | { kind: "note"; general: boolean } | { kind: "ask" };

function App({ review, files, onDone }: { review: Review; files: FileDiff[]; onDone: (o: Outcome) => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout.columns || 100, rows = (stdout.rows || 40) - 1;
  const r = useRef(review).current;
  const items = useMemo(() => itemsOf(r, files), [r, files]);
  const [, bump] = useState(0);
  const redraw = () => { save(r); bump((n) => n + 1); };
  const [pos, setPosRaw] = useState<Pos>(() => ({ item: Math.min(r.pos.item, Math.max(0, items.length - 1)), line: r.pos.line }));
  const setPos = (p: Pos) => { r.pos = p; setPosRaw(p); };
  const [float, setFloat] = useState<Float | null>(() => r.plan.summary ? { title: "What this change is", body: `${r.plan.summary}\n\n? intent of the chapter · f a finding · a ask · e open in the editor · n note · s write-up · q quit` } : null);
  const [mode, setMode] = useState<Mode>({ kind: "nav" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const item = items[pos.item];
  const hunk = item?.at.hunk ?? null;
  const lines = hunk?.lines ?? [];
  const line = Math.min(pos.line, Math.max(0, lines.length - 1));
  const chapter = item ? r.plan.chapters[item.chapter] : undefined;
  const chapterTitle = item ? chapter?.title ?? "Mechanical" : "";

  const live = (f: Finding) => f.status !== "withdrawn";
  const findingsHere = item ? r.findings.filter((f) => f.hunk === item.id && live(f)) : [];
  const findingsAt = (l: DiffLine) => findingsHere.filter((f) => f.side === "new" ? l.n !== null && f.line === l.n : l.o !== null && f.line === l.o);
  const notesAt = (l: DiffLine) => r.notes.filter((n) => n.hunk === item?.id && n.line !== null && (n.side === "new" ? n.line === l.n : n.line === l.o));

  // Seeing a hunk is reading it.
  useEffect(() => { if (item && !r.visited.includes(item.id)) { r.visited.push(item.id); redraw(); } }, [item?.id]);

  const goItem = (i: number) => { const n = Math.max(0, Math.min(items.length - 1, i)); if (n !== pos.item) { setPos({ item: n, line: 0 }); setFloat(null); } };
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

  useInput((ch, key) => {
    if (busy) return;
    if (mode.kind !== "nav") {
      if (key.escape) { setMode({ kind: "nav" }); setInput(""); return; }
      if (key.return) {
        const text = input.trim();
        setMode({ kind: "nav" }); setInput("");
        if (mode.kind === "note" && text) {
          r.notes.push({ hunk: mode.general ? null : item?.id ?? null, ...(mode.general ? { side: "new", line: null } : anchor()), text, at: new Date().toISOString() });
          redraw();
        }
        if (mode.kind === "ask" && item) {
          setBusy("asking…"); setFloat({ title: text || "Explain this hunk", body: "…" });
          ask(r, files, item.id, text).then((a) => setFloat({ title: text || "This hunk", body: a }), (e) => setFloat({ title: "ask failed", body: String((e as Error).message), color: "red" })).finally(() => setBusy(null));
        }
        return;
      }
      if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
      else if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
      return;
    }
    if (key.escape) { setFloat(null); return; }
    if (ch === "q") { onDone({ kind: "quit" }); exit(); return; }
    if (ch === "s") { onDone({ kind: "submit" }); exit(); return; }
    if (ch === "j" || key.downArrow) setPos({ ...pos, line: Math.min(lines.length - 1, line + 1) });
    else if (ch === "k" || key.upArrow) setPos({ ...pos, line: Math.max(0, line - 1) });
    else if (ch === "l" || key.rightArrow || ch === " ") goItem(pos.item + 1);
    else if (ch === "h" || key.leftArrow) goItem(pos.item - 1);
    else if (ch === "J") goChapter(1);
    else if (ch === "K") goChapter(-1);
    else if (ch === "g") setPos({ ...pos, line: 0 });
    else if (ch === "G") setPos({ ...pos, line: Math.max(0, lines.length - 1) });
    else if (ch === "?") {
      if (!item) return;
      const body = item.mechanical ? `Mechanical: ${item.mechanical}. Classified by rule, not by a model.` : chapter?.intent || "The guide gave no intent for this chapter.";
      setFloat({ title: `${item.chapter + 1} · ${chapterTitle}`, body: `${body}\n\na to ask about this hunk.` });
    }
    else if (ch === "f") { // the next finding in this hunk, from the cursor
      if (!findingsHere.length) { setFloat({ title: "Findings", body: "None in this hunk." }); return; }
      const idx = lines.findIndex((l, i) => i > line && findingsAt(l).length) ;
      const at = idx >= 0 ? idx : lines.findIndex((l) => findingsAt(l).length);
      const target = at >= 0 ? at : line;
      setPos({ ...pos, line: target });
      const f = (at >= 0 ? findingsAt(lines[target]!) : findingsHere)[0]!;
      const gone = r.dismissed.includes(f.id);
      setFloat({ title: `${f.severity} · ${f.kind}${gone ? " · dismissed" : ""}`, color: SEV[f.severity], body: `${f.claim}\n\n${f.evidence}${f.refute ? `\n\nSecond look: ${f.refute}` : ""}\n\nd to ${gone ? "restore" : "dismiss"}.` });
    }
    else if (ch === "d") {
      const f = findingsAt(lines[line]!)[0] ?? findingsHere[0];
      if (!f) return;
      r.dismissed = r.dismissed.includes(f.id) ? r.dismissed.filter((x) => x !== f.id) : [...r.dismissed, f.id];
      redraw(); setFloat(null);
    }
    else if (ch === "e") {
      if (!item) return;
      const l = lines[line];
      const n = l?.n ?? lines.slice(line).find((x) => x.n !== null)?.n ?? hunk?.newStart ?? 1;
      onDone({ kind: "edit", path: item.at.file.path, line: n }); exit();
    }
    else if (ch === "n") setMode({ kind: "note", general: false });
    else if (ch === "N") setMode({ kind: "note", general: true });
    else if (ch === "a") setMode({ kind: "ask" });
  });

  // ---- layout
  const railW = Math.min(34, Math.max(24, Math.floor(cols * 0.28)));
  const mainW = cols - railW - 1;
  const total = items.filter((i) => !i.mechanical).length, seen = items.filter((i) => !i.mechanical && r.visited.includes(i.id)).length;
  const liveFindings = r.findings.filter((f) => live(f) && !r.dismissed.includes(f.id)).length;
  const gutterW = 5;
  const codeW = mainW - gutterW - 5; // paddingLeft, number, space, mark, space, and one to spare

  // The float sits right under the cursor line, so the window keeps that many rows free below it.
  const floatW = mainW - gutterW - 4, floatInner = floatW - 4; // border and padding on each side
  const floatLines = float ? wrapText(float.body, floatInner) : [];
  const floatH = float ? Math.min(floatLines.length + 3, Math.max(5, Math.floor(rows / 2))) : 0; // border, title, border
  const bodyRows = rows - 4; // header, hunk header, footer, spare
  const visible = Math.max(3, bodyRows - floatH);
  const start = Math.max(0, Math.min(line - Math.floor(visible / 2), lines.length - visible));
  const shown = lines.slice(start, start + visible);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box justifyContent="space-between">
        <Box width={cols - 34}><Text wrap="truncate"><Text bold> {r.title}</Text><Text dimColor>  {r.url ?? r.label}</Text></Text></Box>
        <Box width={32} justifyContent="flex-end"><Text>{seen}/{total} read · <Text color="yellow">{liveFindings} ▲</Text> · {r.notes.length} note{r.notes.length === 1 ? "" : "s"} </Text></Box>
      </Box>
      <Box flexGrow={1}>
        <Box width={railW} flexDirection="column" borderStyle="single" borderRight borderTop={false} borderBottom={false} borderLeft={false} borderColor="gray" paddingRight={1}>
          <Text dimColor> READ IN ORDER</Text>
          {[...r.plan.chapters.map((c, i) => ({ i, title: c.title })), ...(r.plan.mechanical.length ? [{ i: r.plan.chapters.length, title: `Mechanical (${r.plan.mechanical.length})` }] : [])].map(({ i, title }) => {
            const mine = items.filter((x) => x.chapter === i);
            const done = mine.length > 0 && mine.every((x) => r.visited.includes(x.id));
            const here = item?.chapter === i;
            const fs = r.findings.filter((f) => live(f) && !r.dismissed.includes(f.id) && mine.some((x) => x.id === f.hunk)).length;
            return (
              <Box key={i} flexDirection="column">
                <Text color={here ? "cyan" : done ? "green" : undefined} bold={here} wrap="truncate">
                  {here ? "▸" : done ? "✓" : " "} {i + 1} {title}{fs ? <Text color="yellow"> ▲{fs}</Text> : null}
                </Text>
                {here && mine.map((x, k) => {
                  const cur = x === item;
                  return <Text key={x.id} color={cur ? "cyan" : undefined} dimColor={!cur && r.visited.includes(x.id)} wrap="truncate">   {cur ? "›" : " "} {x.at.file.path.split("/").pop()}:{x.at.hunk!.newStart}{r.findings.some((f) => f.hunk === x.id && live(f) && !r.dismissed.includes(f.id)) ? " ▲" : ""}</Text>;
                })}
              </Box>
            );
          })}
        </Box>
        <Box width={mainW} flexDirection="column" paddingLeft={1}>
          {item && hunk ? (
            <>
              <Text wrap="truncate">
                <Text bold>{item.at.file.path}</Text>
                <Text dimColor>{hunk.context.trim() ? ` · ${hunk.context.trim()}` : ""} · {where(hunk)} · {pos.item + 1}/{items.length}</Text>
                {item.mechanical ? <Text color="magenta"> · mechanical: {item.mechanical}</Text> : null}
              </Text>
              {shown.map((l, k) => {
                const i = start + k;
                const cur = i === line;
                const fs = findingsAt(l), ns = notesAt(l);
                const worst = fs.find((f) => !r.dismissed.includes(f.id)) ? fs.filter((f) => !r.dismissed.includes(f.id)).sort((a, b) => ["blocking", "warn", "nit"].indexOf(a.severity) - ["blocking", "warn", "nit"].indexOf(b.severity))[0] : undefined;
                const mark = worst ? <Text color={SEV[worst.severity]}>▲</Text> : fs.length ? <Text dimColor>△</Text> : ns.length ? <Text color="cyan">»</Text> : <Text> </Text>;
                const num = String(l.n ?? l.o ?? "").padStart(gutterW);
                const color = l.t === "+" ? "green" : l.t === "-" ? "red" : undefined;
                const text = `${l.t}${l.text}`.replace(/\t/g, "    ");
                const fit = (t: string) => t.length > codeW ? t.slice(0, codeW - 1) + "…" : t;
                return (
                  <Box key={i} flexDirection="column">
                    <Text wrap="truncate">
                      <Text dimColor={!cur} color={cur ? "cyan" : undefined}>{num}</Text> {mark} <Text color={color} inverse={cur}>{cur ? fit(text).padEnd(codeW) : fit(text)}</Text>
                    </Text>
                    {ns.map((n, j) => <Text key={j} color="cyan" wrap="truncate">{" ".repeat(gutterW + 3)}» {fit(n.text)}</Text>)}
                    {cur && float ? (
                      <Box flexDirection="column" marginLeft={gutterW + 2} width={floatW} height={floatH} overflow="hidden" borderStyle="round" borderColor={float.color ?? "gray"} paddingX={1}>
                        <Text bold color={float.color} wrap="truncate">{float.title}{busy ? <Text dimColor> · {busy}</Text> : null}</Text>
                        {floatLines.slice(0, floatH - 3).map((t, j) => <Text key={j} wrap="truncate">{t}</Text>)}
                      </Box>
                    ) : null}
                  </Box>
                );
              })}
            </>
          ) : <Text dimColor>Nothing to read: the diff is empty.</Text>}
        </Box>
      </Box>
      <Box>
        {mode.kind === "nav"
          ? <Text dimColor> j/k line  h/l hunk  J/K chapter  ? intent  f finding  d dismiss  a ask  e editor  n note  N general  s write-up  q quit</Text>
          : <Text><Text color="cyan" bold> {mode.kind === "ask" ? "ask" : mode.kind === "note" && mode.general ? "general note" : "note"} › </Text>{input}<Text inverse> </Text><Text dimColor>  (Enter to send, Esc to cancel)</Text></Text>}
      </Box>
    </Box>
  );
}

function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(cur);
  }
  return out;
}

/** Run the app once; resolves with what the reader wants next. State lives on the review object and is saved as it changes. */
export function show(review: Review, files: FileDiff[]): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome = { kind: "quit" };
    process.stdout.write("\x1b[?1049h\x1b[H");
    const app = render(<App review={review} files={files} onDone={(o) => { outcome = o; }} />, { exitOnCtrlC: true });
    app.waitUntilExit().then(() => { app.clear(); process.stdout.write("\x1b[?1049l"); save(review); resolve(outcome); });
  });
}
