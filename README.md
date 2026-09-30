# prview

Review a pull request in the terminal. A model prepares the reading; you do the reviewing.

```sh
prview 42                      # a PR in this repo
prview main..my-branch         # any range
prview prepare 42              # build now, open later (the model pass takes a few minutes)
prview open pm-pr-42
```

What you get is a full-screen review, not a diff dump:

- **A reading order.** A guide (a model) sorts the hunks into chapters: the core change first,
  what depends on it next, tests last, with one line per chapter (at most 12 words) naming
  the concrete thing to check there.
  Mechanical hunks (whitespace, lock files, pure moves, unchanged renames) are classified by
  rule, never by the model, and come last, under a fixed line: skim for a behaviour change the
  rule may have missed.
- **Findings in the gutter.** A critic (a model) raises findings anchored to a line; each one is
  handed to a fresh call with more of the file to refute, and only the survivors are shown (`▲`).
  `f` reads one (titled with who raised it: `▲ critic · bug · warn`), `d` dismisses it.
- **A floating box** for whatever wants explaining: `?` the chapter's intent, `f` a finding,
  `a` a question about the hunk in front of you.
- **Your editor for the real code.** `e` opens the file at the line under the cursor in a
  worktree at the PR head (`$EDITOR`, default `hx`; VS Code, Zed and vim forms are handled).
  Quit the editor and you are back where you were.
- **Notes and coverage.** `n` notes the line, `N` the whole change. `s` prints the write-up:
  notes with file and line, how much of the change you actually read, and the findings you kept.
  Everything is saved as you go; `q` and come back later.

Models: `claude -p` on your subscription by default; `--ai qwen|gemma|deepseek` for the local
servers or DeepSeek; `--no-ai` to skip the guide and critic. The guide and findings are redone
only when the PR head moves, or with `--fresh`. The critic reads each chapter `--samples N` times
(default 2) and merges the runs: a finding shows how many runs raised it (`2/3`), and the gutter marks
the worst by severity, then votes. Each run's time and cost are kept in the review's JSON.

State lives under `~/.cache/prview` (`$PRVIEW_HOME`): a worktree per review and one JSON file.
`prview done <name>` removes both.

## One document, any producer

Every review is a `prview-review/1` document: the target (repo, base, head, PR), the chapters,
the findings (each with the `source` that raised it), and your comments, dismissals, coverage
and verdict. The guide and critic are just the default producer; any reviewer that writes the
document can feed prview, and prview never asks which one did.

```sh
prview export pm-pr-42 > review.json    # the whole review, yours included
prview import review.json               # merge into the review at that head, or start one here
other-reviewer --json | prview import - # another producer's findings, beside the critic's
prview show review.json                 # import, then open
```

A document is anchored on its head commit and is refused by a review at any other head.
[`schema/`](./schema/) has the JSON Schema and what a producer needs to emit.

Not yet: posting the verdict anywhere, a blind first pass (findings hidden until you have read
the chapter), syntax colouring inside hunks.

## Checking the guide's intents

The intent line is what you read most, so its quality is measured, not assumed.
`scripts/eval-intents.ts` runs the guide on real merged changes and holds every intent to a
rubric (`rubric` in `src/guide.ts`): at most 12 words, names a concrete thing to check, no
"verify that", not a rewording of the title. It prints each chapter's title, intent and why, marks
the failures, and exits 0 when at least 90% pass.

```sh
bun scripts/eval-intents.ts                          # five pinned merges from pm, stamp-cli, bloom
bun scripts/eval-intents.ts --ai qwen                # another provider
bun scripts/eval-intents.ts ~/src/app@abc123         # your own: DIR@MERGE or DIR@BASE..HEAD
```

The defaults point at the author's clones under `~/Development`; pass your own elsewhere. It calls
the model for real, one guide call per change, so run it before and after touching `GUIDE_SYSTEM`
or the limits. When the parser has to cut an intent (over 12 words) or the summary (over two
sentences), prview asks the guide once more for just those lines; the eval shows when that happened.

## Development

```sh
bun install
bun test
bun run typecheck
```
