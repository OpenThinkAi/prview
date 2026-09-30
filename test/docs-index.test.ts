import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpus, loadRecipes, type Doc } from "../src/corpus.ts";
import { embed } from "../src/embed.ts";
import { buildIndex, corpusHash, INDEX_PATH, loadIndex, MODEL_NAME, REBUILD_COMMAND, search, staleness, WORD_BONUS, wordsOf, type DocsIndex, type Loaded } from "../src/docs-index.ts";
import { ALL_ACTIONS } from "../src/keys.ts";
import { evaluate, PASS_RATE, QUESTIONS } from "../scripts/eval-docs.ts";

const docs = buildCorpus();
const committed = JSON.parse(await Bun.file(INDEX_PATH).text()) as DocsIndex;

test("the committed index matches the corpus; if not, rebuild it", () => {
  // Fails when docs/recipes.toml, an action's label or description, or the model changed without a rebuild.
  expect({ stale: staleness(committed, docs) }).toEqual({ stale: null });
  expect(committed.corpus, `the corpus changed but docs/index.json did not: run \`${REBUILD_COMMAND}\``).toBe(corpusHash(docs));
});

test("the staleness message names the command to run", () => {
  expect(staleness({ ...committed, corpus: "0".repeat(64) }, docs)).toContain(REBUILD_COMMAND);
  expect(staleness({ ...committed, model: "other" }, docs)).toContain("bun run build:docs-index");
  expect(REBUILD_COMMAND).toBe("bun run build:docs-index");
});

test("a stale index is refused with the rebuild command, not answered from", () => {
  const dir = mkdtempSync(join(tmpdir(), "prview-idx-"));
  const path = join(dir, "index.json");
  writeFileSync(path, JSON.stringify({ ...committed, corpus: "stale" }));
  expect(() => loadIndex(path)).toThrow(/bun run build:docs-index/);
  writeFileSync(path, JSON.stringify(committed));
  expect(loadIndex(path).docs.length).toBe(docs.length);
});

test("the corpus hash is deterministic and sensitive to ids, texts and the model", () => {
  expect(corpusHash(docs)).toBe(corpusHash(buildCorpus(loadRecipes())));
  expect(corpusHash(docs)).toMatch(/^[0-9a-f]{64}$/);
  expect(corpusHash(docs, "another-model")).not.toBe(corpusHash(docs));
  const edited = docs.map((d, i) => i === 0 ? { ...d, text: d.text + " more" } : d);
  expect(corpusHash(edited)).not.toBe(corpusHash(docs));
  const renamed = docs.map((d, i) => i === 0 ? { ...d, id: "x" } : d);
  expect(corpusHash(renamed)).not.toBe(corpusHash(docs));
});

test("the index holds the model name, dim, hash and one Float32 vector per doc", () => {
  expect(committed.model).toBe(MODEL_NAME);
  expect(committed.dim).toBe(256);
  expect(committed.count).toBe(docs.length);
  expect(Buffer.from(committed.vectors, "base64").length).toBe(docs.length * committed.dim * 4);
});

test("rebuilding reproduces the committed vectors", () => {
  expect(buildIndex(docs)).toEqual(committed);
});

test("search returns action ids with descending scores, deduped by recipe and by action", () => {
  const hits = search("how do I submit a review", 8);
  expect(hits.length).toBe(8);
  expect(hits[0]!.action).toBe("nav.submit");
  const known = new Set(ALL_ACTIONS.map((a) => a.id));
  expect(hits.every((h) => known.has(h.action) && typeof h.score === "number")).toBe(true);
  expect(new Set(hits.map((h) => h.action)).size).toBe(hits.length);
  for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
  // Phrasings of one recipe never each take a slot: hits from one recipe all come through the same phrasing.
  const via = new Map<string, Set<string>>();
  for (const h of hits.filter((h) => h.doc.startsWith("recipe."))) via.set(h.doc.split(".")[1]!, (via.get(h.doc.split(".")[1]!) ?? new Set()).add(h.doc));
  expect([...via.values()].filter((d) => d.size > 1)).toEqual([]);
  expect(search("anything", 3).length).toBe(3);
});

test("a recipe that names several actions returns them all, in its order", () => {
  const hits = search("how do I open the file in my editor", 3).map((h) => h.action);
  expect(hits.slice(0, 2)).toEqual(["nav.line_down", "nav.edit"]);
});

test("a verbatim word breaks a tie in cosine, and a stopword does not", () => {
  const mk = (id: string, text: string): Doc => ({ kind: "action", id, state: "", label: id, text, actions: [id] });
  const tie = [mk("a", "alpha beta"), mk("b", "gamma delta")];
  const v = embed("anything at all");
  const vecs = new Float32Array(2 * v.length);
  vecs.set(v, 0); vecs.set(v, v.length);
  const index: Loaded = { idx: { model: MODEL_NAME, dim: v.length, corpus: "", count: 2, vectors: "" }, docs: tie, vecs, words: tie.map((d) => new Set(wordsOf(d.text))) };
  expect(search("delta", 2, index).map((h) => h.action)).toEqual(["b", "a"]);
  expect(search("alpha", 2, index).map((h) => h.action)).toEqual(["a", "b"]);
  const [top, next] = search("delta", 2, index);
  expect(top!.score - next!.score).toBeCloseTo(WORD_BONUS, 6);
  // "the" is a stopword even when a doc contains it.
  const stop = [mk("a", "the alpha"), mk("b", "beta")];
  const idx2: Loaded = { ...index, docs: stop, words: stop.map((d) => new Set(wordsOf(d.text))) };
  expect(search("the", 2, idx2)[0]!.score).toBe(search("the", 2, idx2)[1]!.score);
});

test("an unintelligible query still returns without throwing", () => {
  expect(search("", 3).length).toBe(3);
  expect(search("zzzzqqqq xxyyzz", 3).length).toBe(3);
});

test("a query returns in under 50 ms once the model is loaded", () => {
  search("warm up", 3);
  const runs = 20;
  const t = performance.now();
  for (let i = 0; i < runs; i++) search("how do I leave a comment on a line", 5);
  expect((performance.now() - t) / runs).toBeLessThan(50);
});

test("the eval: at least 20 questions, the right action in the top 3 for 85%", () => {
  expect(QUESTIONS.length).toBeGreaterThanOrEqual(20);
  const results = evaluate();
  const misses = results.filter((r) => r.rank < 1 || r.rank > 3);
  expect(misses.map((r) => r.q)).toEqual(expect.any(Array));
  expect(1 - misses.length / results.length).toBeGreaterThanOrEqual(PASS_RATE);
  // No eval question is a recipe phrasing verbatim: the eval is written independently of them.
  const phrasings = new Set(loadRecipes().flatMap((r) => r.q.map((q) => q.toLowerCase())));
  expect(QUESTIONS.filter(([q]) => phrasings.has(q.toLowerCase()))).toEqual([]);
  expect(new Set(QUESTIONS.map(([, a]) => a)).size).toBeGreaterThan(15);
});
