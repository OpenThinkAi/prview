// Text to a vector, offline: model2vec's potion-base-8M, a static embedding table committed under
// models/potion-base-8M/ (built by scripts/build-embedder.ts). A sentence's vector is the mean of its
// tokens' rows, normalised, so there is no neural runtime and nothing to download; loading reads three
// files and embedding is a table lookup.
//
// The tokenizer is the model's own (BERT uncased WordPiece, as HuggingFace `tokenizers` runs it) and the
// pooling follows model2vec's StaticModel.encode: no [CLS]/[SEP], unknown tokens dropped, at most 512
// tokens after cutting the text to 512 × the median token length in characters. `tokenize` and
// `embedWith` are pure; only `loadModel` reads the disk.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DIR = join(import.meta.dir, "..", "models", "potion-base-8M");

export type ModelConfig = {
  dim: number; vocab_size: number; unk_id: number; max_input_chars_per_word: number; special_tokens: string[];
  median_token_length: number; max_length: number; normalize: boolean;
};
export type Model = {
  config: ModelConfig;
  vocab: Map<string, number>;
  /** Row-major, `dim` values per token id; a value is `rows[i] * scales[id]`. */
  rows: Int8Array;
  scales: Float32Array;
};

export function loadModel(dir = MODEL_DIR): Model {
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as ModelConfig;
  const vocab = new Map<string, number>();
  const tokens = readFileSync(join(dir, "vocab.txt"), "utf8").split("\n");
  for (let id = 0; id < config.vocab_size; id++) vocab.set(tokens[id]!, id);
  const r = readFileSync(join(dir, "embeddings.i8"));
  const s = readFileSync(join(dir, "scales.f32"));
  const rows = new Int8Array(r.buffer, r.byteOffset, r.byteLength);
  // Float32Array needs 4-byte alignment; a pooled Buffer may not start on one, so copy when it does not.
  const scales = s.byteOffset % 4 === 0 ? new Float32Array(s.buffer, s.byteOffset, s.byteLength / 4) : new Float32Array(new Uint8Array(s).buffer);
  if (rows.length !== config.vocab_size * config.dim || scales.length !== config.vocab_size || vocab.size !== config.vocab_size) {
    throw new Error(`${dir}: model files do not match config.json`);
  }
  return { config, vocab, rows, scales };
}

// ---------------------------------------------------------------- tokenizer

// tokenizers drops "other" characters, but its table has no unassigned (Cn) code points, so those survive.
const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;
const SPACE = /\p{White_Space}/u;
const MARK = /\p{Mn}/gu;
// Rust's is_ascii_punctuation (which counts $+<=>^`|~ though Unicode calls them symbols) or any Unicode P*.
const PUNCT = /[!-\/:-@\[-`{-~]|\p{P}/u;

function isCjk(cp: number) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df)
    || (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b920 && cp <= 0x2ceaf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

/** BertNormalizer: drop NUL, U+FFFD and control characters, whitespace to a space, space out CJK ideographs, strip accents, lowercase. */
export function normalize(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\t" || ch === "\n" || ch === "\r") { out += " "; continue; }
    if (cp === 0 || cp === 0xfffd || CONTROL.test(ch)) continue;
    if (SPACE.test(ch)) out += " ";
    else if (isCjk(cp)) out += ` ${ch} `;
    else out += ch;
  }
  out = out.normalize("NFD").replace(MARK, "");
  // Per character, as tokenizers does: String#toLowerCase on the whole string would apply the Greek final-sigma rule.
  let lower = "";
  for (const ch of out) lower += ch.toLowerCase();
  return lower;
}

/** BertPreTokenizer: split on whitespace, and every punctuation character is a word of its own. */
export function preTokenize(text: string): string[] {
  const words: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (SPACE.test(ch)) { if (cur) words.push(cur); cur = ""; }
    else if (PUNCT.test(ch)) { if (cur) words.push(cur); words.push(ch); cur = ""; }
    else cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/** Greedy longest-match WordPiece; a word with any piece missing from the vocabulary is one unknown token. */
function wordPiece(word: string, m: Model, out: number[]) {
  const chars = [...word];
  if (chars.length > m.config.max_input_chars_per_word) { out.push(m.config.unk_id); return; }
  const pieces: number[] = [];
  for (let start = 0; start < chars.length;) {
    let end = chars.length, id: number | undefined;
    for (; end > start; end--) {
      id = m.vocab.get((start > 0 ? "##" : "") + chars.slice(start, end).join(""));
      if (id !== undefined) break;
    }
    if (id === undefined) { out.push(m.config.unk_id); return; }
    pieces.push(id);
    start = end;
  }
  out.push(...pieces);
}

/** The token ids model2vec pools for `text`: no special tokens, unknowns dropped, at most `max_length`. */
export function tokenize(m: Model, text: string): number[] {
  const { max_length, median_token_length, unk_id } = m.config;
  const limit = max_length * median_token_length; // characters, counted as code points like Python's slicing
  if (text.length > limit) text = [...text].slice(0, limit).join("");
  const ids: number[] = [];
  // A special token written in the text ("[CLS]") is that token, matched before any normalising.
  let rest = text;
  while (rest) {
    let at = rest.length, hit = "";
    for (const t of m.config.special_tokens) {
      const i = rest.indexOf(t);
      if (i >= 0 && (i < at || (i === at && t.length > hit.length))) { at = i; hit = t; }
    }
    for (const word of preTokenize(normalize(rest.slice(0, at)))) wordPiece(word, m, ids);
    if (hit) ids.push(m.vocab.get(hit)!);
    rest = rest.slice(at + hit.length);
  }
  return ids.filter((id) => id !== unk_id).slice(0, max_length);
}

// ---------------------------------------------------------------- pooling

/** Mean of the token rows, normalised to unit length. Text with no known token embeds to all zeros. */
export function embedWith(m: Model, text: string): Float32Array {
  const { dim, normalize: norm } = m.config;
  const ids = tokenize(m, text);
  const acc = new Float64Array(dim);
  for (const id of ids) {
    const s = m.scales[id]!, base = id * dim;
    for (let j = 0; j < dim; j++) acc[j]! += m.rows[base + j]! * s;
  }
  const out = new Float32Array(dim);
  if (!ids.length) return out;
  let len = 0;
  for (let j = 0; j < dim; j++) { acc[j]! /= ids.length; len += acc[j]! * acc[j]!; }
  const k = norm ? 1 / (Math.sqrt(len) + 1e-32) : 1;
  for (let j = 0; j < dim; j++) out[j] = acc[j]! * k;
  return out;
}

let model: Model | undefined;
/** Embeds with the bundled model, loading it on first use. */
export const embed = (text: string): Float32Array => embedWith(model ??= loadModel(), text);

/** Cosine similarity; 0 when either side is all zeros. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
