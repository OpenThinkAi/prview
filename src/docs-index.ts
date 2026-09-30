// Docs search: the corpus (src/corpus.ts) embedded once, at build time, into docs/index.json, and a query ranked
// against those vectors. Nothing is embedded or downloaded at search time but the query itself, so a search is a
// table lookup and a few hundred dot products, offline.
//
// Ranking is hxq's: cosine plus a small bonus for each non-stopword query word that appears verbatim in the doc, so an
// exact term ("clipboard", "wrap") can tip a close call between two phrasings the embedding cannot tell apart.
// Results are action ids, never keys: the screen shows the user's live bindings next to whatever is found.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { buildCorpus, type Doc } from "./corpus.ts";
import { embed, MODEL_DIR } from "./embed.ts";

export const INDEX_PATH = join(import.meta.dir, "..", "docs", "index.json");
export const MODEL_NAME = basename(MODEL_DIR);
export const REBUILD_COMMAND = "bun run build:docs-index";

/** Added to a doc's cosine for each distinct query word it contains. */
export const WORD_BONUS = 0.02;
const STOP = new Set(["how", "do", "i", "the", "a", "an", "to", "in", "my", "of", "is", "it", "on", "and", "or", "can", "with", "for", "what", "this", "that", "me", "does", "so", "at", "be", "are", "am", "we", "you"]);

export type DocsIndex = { model: string; dim: number; corpus: string; count: number; vectors: string };
export type Hit = { action: string; score: number; doc: string };

/** Deterministic over what gets embedded: the model's name, then each doc's id and text in order. */
export function corpusHash(docs: Doc[], model = MODEL_NAME): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([model, docs.map((d) => [d.id, d.text])]));
  return h.digest("hex");
}

export function buildIndex(docs: Doc[] = buildCorpus()): DocsIndex {
  const vecs = docs.map((d) => embed(d.text));
  const dim = vecs[0]!.length;
  const flat = new Float32Array(vecs.length * dim);
  vecs.forEach((v, i) => flat.set(v, i * dim));
  return { model: MODEL_NAME, dim, corpus: corpusHash(docs), count: docs.length, vectors: Buffer.from(flat.buffer).toString("base64") };
}

export const writeIndex = (idx: DocsIndex, path = INDEX_PATH): void => writeFileSync(path, JSON.stringify(idx) + "\n");

/** `null` when the index matches `docs`, else what to do about it. */
export function staleness(idx: DocsIndex, docs: Doc[]): string | null {
  if (idx.model !== MODEL_NAME || idx.corpus !== corpusHash(docs)) return `docs/index.json is out of date with the docs corpus; run \`${REBUILD_COMMAND}\` and commit the result`;
  return null;
}

export type Loaded = { idx: DocsIndex; docs: Doc[]; vecs: Float32Array; words: Set<string>[] };

export const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Reads the index and checks it against the corpus; a stale index throws rather than answering from old vectors. */
export function loadIndex(path = INDEX_PATH, docs: Doc[] = buildCorpus()): Loaded {
  const idx = JSON.parse(readFileSync(path, "utf8")) as DocsIndex;
  const stale = staleness(idx, docs);
  if (stale) throw new Error(stale);
  const bytes = Buffer.from(idx.vectors, "base64");
  // Copied so the Float32Array starts on a 4-byte boundary whatever the Buffer's offset was.
  const vecs = new Float32Array(new Uint8Array(bytes).buffer);
  if (vecs.length !== idx.count * idx.dim || idx.count !== docs.length) throw new Error(`${path}: vectors do not match the corpus; run \`${REBUILD_COMMAND}\``);
  return { idx, docs, vecs, words: docs.map((d) => new Set(wordsOf(d.text))) };
}

let loaded: Loaded | undefined;
/** The committed index, read and checked once. */
export const defaultIndex = (): Loaded => (loaded ??= loadIndex());

/** What a doc is deduped by: a recipe's phrasings are one answer, an action's doc is its own. */
const groupOf = (d: Doc): string => d.kind === "recipe" ? d.id.split(".").slice(0, 2).join(".") : d.id;

/**
 * The `n` best actions for a question, best first. Each doc scores cosine plus WORD_BONUS per query word it
 * contains; docs of one recipe collapse to the best-scoring phrasing, and an action found twice keeps its best score.
 * `doc` is the id of the doc that put the action there.
 */
export function search(query: string, n = 5, index: Loaded = defaultIndex()): Hit[] {
  const { idx, docs, vecs, words } = index;
  const q = embed(query);
  const qwords = [...new Set(wordsOf(query).filter((w) => w.length > 1 && !STOP.has(w)))];
  const best = new Map<string, { score: number; doc: Doc }>();
  for (let i = 0; i < docs.length; i++) {
    let s = 0;
    const off = i * idx.dim;
    for (let k = 0; k < idx.dim; k++) s += vecs[off + k]! * q[k]!;
    for (const w of qwords) if (words[i]!.has(w)) s += WORD_BONUS;
    const g = groupOf(docs[i]!);
    if (s > (best.get(g)?.score ?? -Infinity)) best.set(g, { score: s, doc: docs[i]! });
  }
  const hits = new Map<string, Hit>();
  for (const { score, doc } of [...best.values()].sort((a, b) => b.score - a.score)) {
    for (const action of doc.actions) if (!hits.has(action)) hits.set(action, { action, score, doc: doc.id });
    if (hits.size >= n) break;
  }
  return [...hits.values()].slice(0, n);
}
