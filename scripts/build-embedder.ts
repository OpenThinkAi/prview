#!/usr/bin/env bun
// Builds the offline embedder that the docs search (`/`) reads: model2vec's potion-base-8M, a static
// token-embedding table, shrunk to int8 and committed under models/potion-base-8M/ so nothing is ever
// downloaded at run time. src/embed.ts is the runtime; this script is the only thing that touches the network.
//
//   bun scripts/build-embedder.ts                 download the pinned revision, convert, write the reference
//   bun scripts/build-embedder.ts --from DIR      use an existing download (config.json, tokenizer.json, model.safetensors)
//   bun scripts/build-embedder.ts --no-reference  skip the reference fixtures (they need `uv`, see below)
//
// What it writes, all committed:
//   vocab.txt        one WordPiece token per line; the line number is the token id
//   embeddings.i8    the embedding matrix, row-major int8, one row per token
//   scales.f32       one little-endian float32 per row: row value = int8 × scale (scale = max |x| / 127)
//   config.json      dimensions and the tokenizer settings src/embed.ts relies on, plus where it came from
//   reference.json   fixture sentences with model2vec's own token ids and vectors, for test/embed.test.ts
//
// The reference is produced by the real Python `model2vec` (pinned below) in a throwaway environment made by
// `uv run --with`, loaded from the same download, so the test compares against the reference
// implementation rather than against this repo's reading of it. Re-running the script with the same
// revision rewrites byte-identical files.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "minishlab/potion-base-8M";
const REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"; // pinned so a re-run converts the same weights
const MODEL2VEC = "model2vec==0.9.0";
const OUT = join(import.meta.dir, "..", "models", "potion-base-8M");
const FILES = ["config.json", "tokenizer.json", "model.safetensors"];

// Sentences the reference is taken on: the kind of question the docs search gets, plus the corners of
// the tokenizer (accents, punctuation, CJK, emoji and other unknowns, long words, control characters, nothing at all).
const SENTENCES = [
  "how do I hide a finding",
  "open the file in my editor at this line",
  "submit the review with an approve verdict",
  "jump to the next chapter",
  "What does the `?` key do?",
  "Leave a summary comment on the pull request.",
  "which key marks a finding as not an issue",
  "scroll the preview before posting",
  "configure a local model with Ollama for the critic role",
  "Where is the review document written when posting fails?",
  "keybindings",
  "prview import review.json --ai qwen",
  "Café naïve résumé coöperate — Ünïcödé accents",
  "HELLO, World!!! (parentheses) [brackets] {braces} <angles> $100 & 50% off ~tilde^caret|pipe",
  "你好世界 and 日本語のテキスト mixed with English",
  "emoji 🙂🚀 and symbols ∑ ∂ √ ∞ ≠",
  "supercalifragilisticexpialidocious antidisestablishmentarianism",
  "a".repeat(120) + " overlong word",
  "tabs\tand\nnewlines\r\nand\u0000control\u200bchars\u0381unassigned\u000bvtab",
  "no [CLS] or [SEP] here, [UNK]nown [mask] [MASK]ed [[PAD]]",
  "   leading and trailing spaces   ",
  "Ελληνικά ΚΑΙ Русский текст",
  "don't can't won't it's",
  "3.14159 1,000,000 v1.2.3 2026-09-30",
  "",
  "🙂",
  "?",
];

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf("--from");
const from = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
const withReference = !argv.includes("--no-reference");

async function download(dir: string): Promise<string> {
  for (const f of FILES) {
    const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${f}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(join(dir, f), new Uint8Array(await res.arrayBuffer()));
    console.log(`downloaded ${f}`);
  }
  return dir;
}

// A safetensors file is an 8-byte little-endian header length, a JSON header naming each tensor's dtype,
// shape and byte range, then the raw tensor bytes.
type Tensor = { dtype: string; shape: number[]; data_offsets: [number, number] };
function readSafetensors(path: string): { header: Record<string, Tensor>; body: Uint8Array } {
  const buf = readFileSync(path);
  const len = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + len).toString("utf8")) as Record<string, Tensor>;
  return { header, body: new Uint8Array(buf.buffer, buf.byteOffset + 8 + len, buf.length - 8 - len) };
}

// src/embed.ts implements exactly one tokenizer; refuse a model that needs anything else rather than
// convert it into something that silently embeds differently.
function checkTokenizer(tok: any): { vocab: string[]; unk: number; maxChars: number; special: string[] } {
  const n = tok.normalizer, m = tok.model;
  const want = (ok: boolean, what: string) => { if (!ok) throw new Error(`unsupported tokenizer: ${what}`); };
  want(n?.type === "BertNormalizer" && n.clean_text === true && n.handle_chinese_chars === true && n.lowercase === true && (n.strip_accents ?? n.lowercase) === true, `normalizer ${JSON.stringify(n)}`);
  want(tok.pre_tokenizer?.type === "BertPreTokenizer", `pre-tokenizer ${JSON.stringify(tok.pre_tokenizer)}`);
  want(m?.type === "WordPiece" && m.continuing_subword_prefix === "##", `model ${m?.type}`);
  const entries = Object.entries(m.vocab as Record<string, number>);
  const vocab: string[] = new Array(entries.length);
  for (const [t, id] of entries) vocab[id] = t;
  want(vocab.every((t) => typeof t === "string" && !/[\r\n]/.test(t)), "vocab ids are not 0..n-1 or a token holds a newline");
  const unk = m.vocab[m.unk_token];
  want(typeof unk === "number", "no unk token");
  // Added tokens ([CLS], [UNK], ...) are matched in the raw text before normalising, verbatim.
  const added = tok.added_tokens as { id: number; content: string; single_word: boolean; lstrip: boolean; rstrip: boolean; normalized: boolean }[];
  want(added.every((a) => vocab[a.id] === a.content && !a.single_word && !a.lstrip && !a.rstrip && !a.normalized), "added tokens that are not plain verbatim matches");
  return { vocab, unk, maxChars: m.max_input_chars_per_word, special: added.map((a) => a.content) };
}

// model2vec truncates a sentence to max_length × the median token length in characters before tokenizing;
// numpy's median of an even count averages the middle two, and int() truncates.
function medianTokenLength(vocab: string[]): number {
  const lens = vocab.map((t) => [...t].length).sort((a, b) => a - b);
  const mid = lens.length >> 1;
  return Math.trunc(lens.length % 2 ? lens[mid]! : (lens[mid - 1]! + lens[mid]!) / 2);
}

const REFERENCE_PY = String.raw`
import json, sys
import numpy as np
from model2vec import StaticModel
src, out = sys.argv[1], sys.argv[2]
sentences = json.load(sys.stdin)
m = StaticModel.from_pretrained(src)
ids = m.tokenize(sentences, max_length=512)
vecs = m.encode(sentences)
json.dump({"median_token_length": int(m.median_token_length), "cases": [
    {"text": s, "ids": [int(i) for i in t], "vector": [round(float(x), 6) for x in v]}
    for s, t, v in zip(sentences, ids, vecs)]}, open(out, "w"), ensure_ascii=False)
`;

async function main(downloadTo: string | undefined) {
  const src = downloadTo ? await download(downloadTo) : from!;
  const config = JSON.parse(readFileSync(join(src, "config.json"), "utf8"));
  const tok = JSON.parse(readFileSync(join(src, "tokenizer.json"), "utf8"));
  const { vocab, unk, maxChars, special } = checkTokenizer(tok);

  const { header, body } = readSafetensors(join(src, "model.safetensors"));
  const tensors = Object.keys(header).filter((k) => k !== "__metadata__");
  // potion-base-8M has neither per-token weights nor a vocabulary mapping; src/embed.ts implements neither.
  if (tensors.join() !== "embeddings") throw new Error(`unexpected tensors: ${tensors.join(", ")}`);
  const e = header.embeddings!;
  const [rows, dim] = e.shape as [number, number];
  if (e.dtype !== "F32" || rows !== vocab.length) throw new Error(`embeddings ${e.dtype} ${e.shape} for ${vocab.length} tokens`);
  const f32 = new Float32Array(body.slice(e.data_offsets[0], e.data_offsets[1]).buffer);

  const q = new Int8Array(rows * dim);
  const scales = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let j = 0; j < dim; j++) max = Math.max(max, Math.abs(f32[r * dim + j]!));
    const s = max / 127 || 1;
    scales[r] = s;
    for (let j = 0; j < dim; j++) q[r * dim + j] = Math.round(f32[r * dim + j]! / s);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "vocab.txt"), vocab.join("\n") + "\n");
  writeFileSync(join(OUT, "embeddings.i8"), new Uint8Array(q.buffer));
  writeFileSync(join(OUT, "scales.f32"), new Uint8Array(scales.buffer));
  const median = medianTokenLength(vocab);
  writeFileSync(join(OUT, "config.json"), JSON.stringify({
    source: `https://huggingface.co/${REPO}`, revision: REVISION, license: "MIT",
    dim, vocab_size: rows, unk_id: unk, max_input_chars_per_word: maxChars, special_tokens: special,
    median_token_length: median, max_length: 512, normalize: config.normalize === true,
  }, null, 2) + "\n");
  console.log(`wrote ${OUT}: ${rows} tokens × ${dim} dims, int8 with a scale per row`);

  if (!withReference) return;
  const out = join(OUT, "reference.json");
  const py = Bun.spawnSync(["uv", "run", "--quiet", "--no-project", "--with", MODEL2VEC, "python", "-c", REFERENCE_PY, src, out], {
    stdin: new TextEncoder().encode(JSON.stringify(SENTENCES)), stdout: "inherit", stderr: "inherit",
  });
  if (py.exitCode !== 0) throw new Error("the reference run failed (it needs `uv`; pass --no-reference to skip it)");
  const ref = JSON.parse(readFileSync(out, "utf8"));
  if (ref.median_token_length !== median) throw new Error(`median token length: model2vec says ${ref.median_token_length}, this script ${median}`);
  console.log(`wrote ${out}: ${ref.cases.length} sentences from ${MODEL2VEC}`);
}

const downloaded = from ? undefined : mkdtempSync(join(tmpdir(), "prview-potion-"));
try { await main(downloaded); } finally { if (downloaded) rmSync(downloaded, { recursive: true, force: true }); }
