// The settings view, drawn full-screen over the review: a header with the config file's path, the fields by section
// (the cursor's field lit, a changed one marked *), and at the bottom the field's description, what the last key did and
// the key panel. The state and every rule are in settings.ts; this only draws them.

import React from "react";
import { Box, Text } from "ink";
import { changed, describeField, sectionOf, type Settings } from "./settings.ts";
import { entriesOf, panelOf, type Entry } from "./panel.ts";
import { layoutOf, STATUS_H, windowOf, wrapText } from "./layout.ts";

const entry = (prim: string, label: string): Entry => ({ keys: prim, prim, sec: "", label });

/** The key panel: the settings keys from the table, or what a capture, the editor line or the way-out question takes. */
export function settingsEntries(s: Settings): Entry[] {
  switch (s.sub?.kind) {
    case "capture": return [entry("any key", "bind it"), ...(s.slot === "secondary" ? [entry("Backspace", "clear")] : []), entry("Esc", "cancel")];
    case "typing": return [entry("Enter", "set"), entry("ctrl-u", "clear line"), entry("Esc", "cancel")];
    case "confirm": return [entry("y", "save"), entry("n", "discard"), entry("Esc", "keep editing")];
    default: return entriesOf({ state: "settings" });
  }
}

type Row = { kind: "section"; title: string } | { kind: "field"; at: number };

export function SettingsScreen({ s, cols, rows }: { s: Settings; cols: number; rows: number }) {
  const L = layoutOf(cols, rows);
  const listH = Math.max(1, rows - STATUS_H - L.bottomH - 1);
  const list: Row[] = [];
  s.fields.forEach((f, at) => {
    const title = sectionOf(f);
    if (at === 0 || sectionOf(s.fields[at - 1]!) !== title) list.push({ kind: "section", title });
    list.push({ kind: "field", at });
  });
  const cur = list.findIndex((r) => r.kind === "field" && r.at === s.cursor);
  // Keep the cursor's section title in view when the cursor is on the section's first field.
  const win = windowOf(list.map(() => 1), Math.max(0, list[cur - 1]?.kind === "section" ? cur - 1 : cur), listH);
  const idW = Math.max(...s.fields.map((f) => describeField(s, f).label.length));
  const n = changed(s.initial, s.values).length;

  const fieldRow = (at: number) => {
    const f = s.fields[at]!, d = describeField(s, f), here = at === s.cursor;
    const mark = <Text color="yellow">{d.changed ? "*" : " "}</Text>;
    const name = <Text color={here ? "cyan" : undefined} bold={here} dimColor={d.fixed && !here}>{d.label.padEnd(idW)}</Text>;
    if (f.kind === "key") {
      const cell = (text: string, slot: "primary" | "secondary") => <Text inverse={here && s.slot === slot && !d.fixed} dimColor={d.fixed}>{` ${text} `.padEnd(12)}</Text>;
      return <Text key={`f${at}`} wrap="truncate">{mark}{name} <Text dimColor>{(d.states ?? "").padEnd(18)}</Text>{cell(d.primary!, "primary")} {cell(d.secondary!, "secondary")} <Text dimColor>{d.fixed ? "(fixed) " : ""}{d.description}</Text></Text>;
    }
    return <Text key={`f${at}`} wrap="truncate">{mark}{name} <Text inverse={here}>{` ${d.value} `}</Text></Text>;
  };

  const f = s.fields[s.cursor]!, d = describeField(s, f);
  const detail: React.ReactNode[] = [];
  const inner = L.contentInner;
  if (s.sub?.kind === "capture") detail.push(<Text key="c" color="cyan" wrap="truncate">Press the new {s.slot} key for {d.label}. Esc cancels; Esc and Tab cannot be bound.</Text>);
  else if (s.sub?.kind === "typing") detail.push(<Text key="t"><Text color="cyan" bold>editor › </Text>{s.sub.text}<Text inverse> </Text></Text>);
  else if (s.sub?.kind === "confirm") detail.push(<Text key="q" color="yellow" bold wrap="truncate">Save changes? y / n / Esc to keep editing</Text>, <Text key="w" dimColor wrap="truncate">y writes {n} setting{n === 1 ? "" : "s"} to {s.path}; only their lines change.</Text>);
  if (s.message) detail.push(<Text key="m" color={s.message.error ? "red" : "green"} wrap="truncate">{s.message.text}</Text>);
  const room = Math.max(0, L.bottomH - 3 - detail.length);
  const desc = wrapText(d.description, inner).slice(0, room);
  const panel = panelOf("settings", settingsEntries(s), L.panelW, L.bottomH);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width={cols} height={STATUS_H}>
        <Text bold wrap="truncate">Settings</Text>
        <Text wrap="truncate"><Text dimColor>saved to </Text>{s.path}{n ? <Text color="yellow"> · {n} unsaved change{n === 1 ? "" : "s"}</Text> : null}</Text>
      </Box>
      <Box height={listH} flexDirection="column" paddingX={1} overflow="hidden">
        {list.slice(win.start, win.end).map((r, i) => r.kind === "section" ? <Text key={`s${win.start + i}`} bold color="magenta" wrap="truncate">{r.title}</Text> : fieldRow(r.at))}
      </Box>
      <Box height={L.bottomH}>
        <Box flexDirection="column" width={L.contentW} height={L.bottomH} overflow="hidden" borderStyle="single" borderColor={s.sub ? "cyan" : "gray"} paddingX={1}>
          <Text bold wrap="truncate">{sectionOf(f)} · {d.label}</Text>
          {desc.map((t, i) => <Text key={`d${i}`} dimColor wrap="truncate">{t || " "}</Text>)}
          {detail}
        </Box>
        <Box flexDirection="column" width={L.panelW} height={L.bottomH} overflow="hidden" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold wrap="truncate">{panel.title}</Text>
          {panel.lines.map((l, i) => <Text key={i} wrap="truncate">{l.map((sg, j) => <Text key={j} dimColor={sg.dim}>{sg.text}</Text>)}</Text>)}
        </Box>
      </Box>
      <Box height={1} />
    </Box>
  );
}
