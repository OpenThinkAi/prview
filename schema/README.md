# prview-review/1, for producers

prview reads one document format, described by
[`prview-review-1.schema.json`](./prview-review-1.schema.json). Any reviewer that writes it
can feed prview: `prview import review.json` (or `-` for stdin) merges it into the review at
that head, `prview show review.json` imports it and opens it. prview never asks which tool
wrote a document; the only trace of a producer is the `source` on each finding.

## The least a producer writes

```json
{
  "schema": "prview-review/1",
  "target": { "repo": "owner/name", "base": "<merge-base sha>", "head": "<head sha>",
              "url": "https://github.com/owner/name/pull/42", "platform": "github",
              "title": "The PR title" },
  "findings": [
    { "id": "1", "source": "hal9k", "hunk": "src/auth.ts@40:42", "side": "new", "line": 57,
      "severity": "blocking", "kind": "security", "claim": "The token is logged on failure.",
      "evidence": "Line 57 passes the whole request, headers included, to the logger." }
  ]
}
```

- **`target.base` and `target.head` are full commit ids.** `base` is the merge base, not the
  branch tip. The document is anchored on `head`: prview refuses to merge it into, or open it
  against, a review at any other head. When the PR moves, produce a new document.
- **Hunk ids** are `path@oldStart:newStart`, the two start numbers from the `@@ -o,n +o,n @@`
  header of `git diff -M <base> <head>` with the default 3 lines of context, and `path` the
  new path. A file with no hunks (a pure rename, a binary) is `path@file`.
- **`line`** is a line number in the new file (`side: "new"`) or the old one (`side: "old"`).
  One the hunk does not show is moved to the hunk's first line; a finding on a hunk that is not
  in the diff is dropped.
- **`source`** is your tool's name, short. It is shown next to the finding (`▲ hal9k · security`)
  and used to recognise a finding you already sent: importing the same finding twice (same
  source, hunk, side, line and claim) keeps one.
- **`id`** only has to be unique within your document; prview renames one that clashes with a
  finding already in the review.

## Optional

- **`plan.chapters`**: a reading order, `{title, intent, why, hunks}`. `intent` is one
  imperative line of at most 12 words; longer is cut. Hunks you leave out are gathered into a
  last chapter. A review that already has a producer's chapters keeps them; yours replace only
  the file-by-file fallback. `plan.mechanical` is ignored: prview classifies mechanical hunks
  (lock files, whitespace, pure moves) itself, by rule.
- **`on_submit`**: `{ "run": ["argv", "..."] }`, a command you want run once the human submits.
- **`human`**: the reader's comments, dismissals, coverage and verdict. prview writes this;
  a producer normally leaves it out. `prview export <name>` prints a whole document, `human`
  included, so a review moves between clones with `export` and `import`.

## What prview does with it

Unknown fields are ignored and bad values dropped (an unknown severity becomes `warn`, a finding
without a claim is skipped), so a slightly wrong document degrades rather than fails. Only a
different `schema`, or a `target` without full `base` and `head` commit ids, is refused.
