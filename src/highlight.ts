// Syntax colour for the code inside a hunk. Pure: text in, spans out, so it is tested without a terminal.
//
// This is a tokenizer, not a parser. It knows comments, strings, numbers, keywords and capitalised names
// per language family, and it is wrong in the ways a line-at-a-time scanner is wrong (a string that spans
// lines, a regex literal). That is fine: it only colours, and the +/- colour stays the dominant cue.

export type Kind = "plain" | "keyword" | "string" | "comment" | "number" | "type";
export type Span = { text: string; kind: Kind };

type Lang = { block: boolean; hash: boolean; slash: boolean; keywords: Set<string>; lifetimes?: boolean; backtick?: boolean };
const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = "if else for while do switch case default break continue return function const let var new delete typeof instanceof void this super class extends implements interface enum import export from as try catch finally throw async await yield static public private protected readonly abstract null true false undefined in of type namespace";
const LANGS: Record<string, Lang> = {
  ts: { block: true, hash: false, slash: true, backtick: true, keywords: words(C_LIKE) },
  rust: { block: true, hash: false, slash: true, lifetimes: true, keywords: words("fn let mut const static struct enum impl trait pub use mod crate self Self super as if else match for while loop break continue return where move ref async await dyn unsafe type in true false") },
  go: { block: true, hash: false, slash: true, backtick: true, keywords: words("func var const type struct interface map chan package import if else for range switch case default break continue return go defer select fallthrough goto nil true false") },
  clike: { block: true, hash: false, slash: true, keywords: words(C_LIKE + " int long short char float double unsigned signed struct union typedef sizeof extern auto register volatile final override virtual namespace using template typename package fun val when object") },
  python: { block: false, hash: true, slash: false, keywords: words("def class if elif else for while in not and or is return import from as try except finally raise with lambda pass break continue yield global nonlocal async await None True False assert del") },
  hash: { block: false, hash: true, slash: false, keywords: words("if then else elif fi for while do done case esac function in return export local def end class module begin rescue require true false nil") },
  json: { block: false, hash: false, slash: false, keywords: words("true false null") },
};

const EXT: Record<string, string> = {
  ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", mts: "ts", cts: "ts",
  rs: "rust", go: "go",
  c: "clike", h: "clike", cc: "clike", cpp: "clike", hpp: "clike", cs: "clike", java: "clike", kt: "clike", swift: "clike", scala: "clike", php: "clike",
  py: "python", rb: "hash", sh: "hash", bash: "hash", zsh: "hash", yml: "hash", yaml: "hash", toml: "hash", pl: "hash",
  json: "json", jsonc: "json",
};

export function langOf(path: string): string | undefined {
  const ext = path.split("/").pop()!.split(".").pop()?.toLowerCase();
  return ext ? EXT[ext] : undefined;
}

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[A-Za-z0-9]*/;
const IDENT = /^[A-Za-z_$][\w$]*/;
const RUST_CHAR = /^'(?:\\.[^']*|[^\\'])'/;

/**
 * One span list per input line. A block comment left open at the end of a line carries into the next, which
 * is how a doc comment stays a comment; it is reset by the caller per hunk, so a mistake never outlives one.
 * Without a known language every line is one plain span.
 */
export function highlightLines(lines: string[], lang: string | undefined): Span[][] {
  const L = lang ? LANGS[lang] : undefined;
  if (!L) return lines.map((text) => [{ text, kind: "plain" }]);
  let inBlock = false;
  return lines.map((text) => {
    const out: Span[] = [];
    const push = (t: string, kind: Kind) => {
      if (!t) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += t; else out.push({ text: t, kind });
    };
    let i = 0;
    while (i < text.length) {
      if (inBlock) {
        const end = text.indexOf("*/", i);
        if (end < 0) { push(text.slice(i), "comment"); i = text.length; } else { push(text.slice(i, end + 2), "comment"); i = end + 2; inBlock = false; }
        continue;
      }
      const rest = text.slice(i), c = text[i]!;
      if (L.slash && rest.startsWith("//")) { push(rest, "comment"); break; }
      if (L.hash && c === "#") { push(rest, "comment"); break; }
      if (L.block && rest.startsWith("/*")) { inBlock = true; push("/*", "comment"); i += 2; continue; }
      if (c === '"' || c === "`" && L.backtick || c === "'" && !L.lifetimes) {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
        push(text.slice(i, j + 1), "string"); i = Math.min(text.length, j + 1);
        continue;
      }
      if (c === "'" && L.lifetimes) { // a char literal is a string; anything else after a quote is a lifetime
        const m = RUST_CHAR.exec(rest);
        if (m) { push(m[0], "string"); i += m[0].length; } else { push(c, "plain"); i++; }
        continue;
      }
      const prev = text[i - 1];
      if (/\d/.test(c) && !(prev && /[\w$]/.test(prev))) { const m = NUMBER.exec(rest)!; push(m[0], "number"); i += m[0].length; continue; }
      const id = IDENT.exec(rest);
      if (id) { push(id[0], L.keywords.has(id[0]) ? "keyword" : /^[A-Z]/.test(id[0]) && /[a-z]/.test(id[0]) ? "type" : "plain"); i += id[0].length; continue; }
      push(c, "plain"); i++;
    }
    return out;
  });
}

/** The columns [from, to) of a line's spans, for horizontal scroll and for wrapping one long line into rows. */
export function sliceSpans(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const s of spans) {
    const a = Math.max(from, at), b = Math.min(to, at + s.text.length);
    if (b > a) out.push({ kind: s.kind, text: s.text.slice(a - at, b - at) });
    at += s.text.length;
    if (at >= to) break;
  }
  return out;
}

export const lengthOf = (spans: Span[]) => spans.reduce((n, s) => n + s.text.length, 0);

/**
 * How a token is drawn. On an added or removed line the line's own colour (green, red) stays the colour of
 * everything, and a token is told apart by weight and slant alone, so the diff still reads at a glance.
 * On a context line there is no such colour to protect, so tokens get their own.
 */
export type Style = { color?: string; bold?: boolean; italic?: boolean; dim?: boolean };
export function styleOf(kind: Kind, changed: boolean): Style {
  if (kind === "plain") return {};
  if (changed) return kind === "keyword" ? { bold: true } : kind === "string" ? { italic: true } : kind === "comment" ? { dim: true } : {};
  switch (kind) {
    case "keyword": return { color: "magenta" };
    case "string": return { color: "yellow" };
    case "number": return { color: "blueBright" };
    case "type": return { color: "cyan" };
    case "comment": return { dim: true };
  }
}
