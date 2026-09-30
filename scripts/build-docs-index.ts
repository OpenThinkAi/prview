#!/usr/bin/env bun
// Embeds every doc in the corpus with the bundled model and writes docs/index.json. Run it after any change to
// docs/recipes.toml, an action's label or description, or the model; test/docs-index.test.ts fails until you have.
//
//   bun run build:docs-index

import { buildIndex, INDEX_PATH, writeIndex } from "../src/docs-index.ts";

const idx = buildIndex();
writeIndex(idx);
console.log(`wrote ${INDEX_PATH}: ${idx.count} docs, dim ${idx.dim}, ${idx.model}, corpus ${idx.corpus.slice(0, 12)}`);
