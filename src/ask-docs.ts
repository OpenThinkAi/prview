// `?` search the docs: a question in a reviewer's words, answered from the committed docs index (docs-index.ts) with
// the actions that do it. Offline and modelless: nothing here touches the network or a configured model. The search
// finds action ids; the key and the label are read from the installed keymap at the moment the answer is drawn,
// so a remap shows correctly. Pure, so the ranking and the text are tested without a screen. (Not `ai.ask`, which
// asks a model about the hunk.)

import { stateOf } from "./corpus.ts";
import { defaultIndex, search, type Loaded } from "./docs-index.ts";
import { keyOf, rowById } from "./keys.ts";

/** Answers shown per question: the top three, which is what the docs eval holds to its bar, and all of them fit a short terminal. */
export const ANSWERS = 3;

export type Answer = { id: string; label: string; key: string; state: string; why: string };

/** The best answers to `query`, best first; empty for a question with no words in it. Throws when the docs index is stale or unreadable. */
export function answersFor(query: string, n = ANSWERS, index: Loaded = defaultIndex()): Answer[] {
  if (!query.trim()) return [];
  const docs = new Map(index.docs.map((d) => [d.id, d]));
  return search(query, n, index).flatMap((hit) => {
    const row = rowById(hit.action);
    if (!row) return [];
    const doc = docs.get(hit.doc);
    return [{ id: row.id, label: row.label, key: keyOf(row.id), state: stateOf(row.id), why: doc?.kind === "recipe" ? doc.why : row.description }];
  });
}

/** One answer as plain prose, for `y`: no box, no marker. */
export const answerText = (a: Answer): string => `${a.label}: ${a.key}, ${a.state}\n${a.why}`;

/** The results box's body: each answer a heading line (marker, number, label, key, where it works) and its why; `sel` is marked. */
export function answersBody(answers: Answer[], sel: number): string {
  if (!answers.length) return "Nothing matched. Try other words: what you want to do, like \"mark this finding as wrong\".";
  return answers.map((a, i) => `${i === sel ? "›" : " "} ${i + 1}. ${a.label}: ${a.key}, ${a.state}\n${a.why}`).join("\n\n");
}
