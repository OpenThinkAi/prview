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
  what depends on it next, tests last, with one sentence per chapter on what to verify.
  Mechanical hunks (whitespace, lock files, pure moves, unchanged renames) are classified by
  rule, never by the model, and come last.
- **Findings in the gutter.** A critic (a model) raises findings anchored to a line; each one is
  handed to a fresh call with more of the file to refute, and only the survivors are shown (`▲`).
  `f` reads one, `d` dismisses it.
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
only when the PR head moves, or with `--fresh`.

State lives under `~/.cache/prview` (`$PRVIEW_HOME`): a worktree per review and one JSON file.
`prview done <name>` removes both.

Not yet: posting the verdict anywhere, a blind first pass (findings hidden until you have read
the chapter), syntax colouring inside hunks, hal9k or stamp as the findings source.

```sh
bun install
bun test
bun run typecheck
```
