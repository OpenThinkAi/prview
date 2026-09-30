# prview-review/1, for producers

prview reads one document format, described by
[`prview-review-1.schema.json`](./prview-review-1.schema.json). Any reviewer that writes it
can feed prview: `prview import review.json` (or `-` for stdin) merges its findings and chapters
into the review at that head, `prview show review.json` imports it and opens it. prview never asks which tool
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
      "severity": "blocking", "kind": "security", "title": "Token is logged on auth failure",
      "claim": "The token is logged on failure.",
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
- **`source`** is your tool's name, short. It is shown next to the finding (`▲ hal9k · security · blocking`)
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
- **`on_submit`**: `{ "run": ["argv", "..."] }` (or one string, `"cat {file} > /tmp/x"`), a command
  you want run once the human submits, e.g. to take a copy of the finished review. See below.
- **`human`**: the reader's comments, dismissals, coverage and verdict. prview writes this;
  a producer normally leaves it out. Whatever a producer puts here is never taken as the reader's
  own, since anything posted is the reader's words: each comment becomes a finding (kind `comment`,
  its text as the claim, anchored at its hunk and line, or at the diff's first hunk when it has
  none; source your findings' `source` when they all share one, else `imported`) that the reader
  adopts as their own editable comment or rejects; the verdict is shown to them as information and
  never picked; decisions, `visited` and `revealed` are dropped. `prview export <name>` prints a
  whole document, `human` included, and `prview import --mine <file>` restores it as it was, so a
  reader moves their own review between clones with `export` and `import --mine`.

## Submission and `on_submit`

Submitting is the same whoever produced the document: prview (1) writes the finished document to
`$PRVIEW_HOME/submitted/<review>.json` (and the write-up next to it as `.md`), (2) posts it through
the adapter for `target.platform` if it has one (`github`, with `gh`; no platform, or one without an
adapter, and the file is the review), then (3) runs your `on_submit` command, if the human allows it.
A failed post or command never loses the file. Each submit is recorded in the document's
`submissions`, with the command's exit code and output.

A document can come from anywhere, so `on_submit` is only ever a request, and consent is per submit:

- The submit preview shows the command exactly as it will run: the argv with `{file}` filled in,
  where stdout goes, the directory (the worktree at the head), and the timeout (60 s).
- It runs only if the human presses `x` in that preview to allow it, then Enter. Enter alone posts
  and skips it. Nothing is remembered: the next submit asks again.
- It is an argv run without a shell. A string is split on whitespace with `'...'` and `"..."`
  quoting; `$VAR`, `;`, `|`, backticks and globs are passed through as plain text. The only thing
  prview puts into it is the written document's path, for `{file}`. One trailing `>` and a path
  (or `>path`) sends stdout to that file, relative to the worktree; prview writes it, not a shell.
- Posting to the pull request carries only the human's verdict and comments, never anything a
  producer wrote.

## What prview does with it

Unknown fields are ignored and bad values dropped (an unknown severity becomes `warn`, a finding
without a claim is skipped, a `title` is cut to 12 words, and one left out is taken from the claim's
first sentence), so a slightly wrong document degrades rather than fails. Only a
different `schema`, or a `target` without full `base` and `head` commit ids, is refused.
