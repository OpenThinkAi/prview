// git's unified diff, parsed into files, hunks and lines numbered on both sides.

export type DiffLine = { t: " " | "+" | "-"; text: string; o: number | null; n: number | null };
export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; context: string; lines: DiffLine[] };
export type FileDiff = { path: string; oldPath?: string; status: "added" | "deleted" | "renamed" | "modified"; binary: boolean; hunks: Hunk[] };

const unquote = (p: string) => p.startsWith('"') ? JSON.parse(p) as string : p;

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | undefined, h: Hunk | undefined, o = 0, n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/);
      f = { path: m?.[2] ?? line, oldPath: undefined, status: "modified", binary: false, hunks: [] };
      files.push(f); h = undefined;
      continue;
    }
    if (!f) continue;
    if (h && /^[ +\-\\]/.test(line)) { // inside a hunk every line starts with one of these
      if (line[0] === "\\") continue; // "\ No newline at end of file"
      const t = line[0] as DiffLine["t"];
      h.lines.push({ t, text: line.slice(1), o: t === "+" ? null : o++, n: t === "-" ? null : n++ });
      continue;
    }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hm) {
      h = { oldStart: +hm[1]!, oldCount: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3]!, newCount: hm[4] === undefined ? 1 : +hm[4], context: hm[5]!, lines: [] };
      f.hunks.push(h); o = h.oldStart; n = h.newStart;
    }
    else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = unquote(line.slice(12)); }
    else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files ")) f.binary = true;
  }
  return files;
}

export const span = (start: number, count: number) => count === 0 ? "none" : count === 1 ? `${start}` : `${start}–${start + count - 1}`;
export const where = (h: Hunk) => h.newCount ? `lines ${span(h.newStart, h.newCount)}` : `removed from ${span(h.oldStart, h.oldCount)}`;
export const counts = (f: FileDiff): [number, number] => {
  const lines = f.hunks.flatMap((h) => h.lines);
  return [lines.filter((l) => l.t === "+").length, lines.filter((l) => l.t === "-").length];
};
