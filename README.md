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
  `f` reads one: a bold title of at most 12 words first ("Missing test: X isn't covered"), the detail
  beneath, and a header saying who raised it (`▲ critic · bug · warn`). A finding with no title of
  its own shows its claim's first sentence.
- **Deciding on findings, one key each.** Step through them with `]f` and decide each as it opens:
  `n` not an issue, `b` block on it, `c` comment, `u` undo, `h` hide. `b` and `c` open the comment
  line at the finding's line, prefilled with its title: edit it (`ctrl-u` clears the line), Enter saves
  it as your own line comment, Esc cancels the decision. `n` takes an optional one-line reason, kept
  in the document and never posted. `h` closes the box and records nothing, like Esc. With a box open
  only the keys in the footer act (plus `[f`, Esc and paging). After each
  decision the next undecided finding opens, so a whole pass is `]f` and then one key per finding; the
  box says how far along you are (`3/9 decided`), and the `▲` counts on the rail and header are what
  is left to decide. Decisions are saved as you go (`human.decisions` in the document).
  `y` copies the open box (a finding, the `?` why, an `a` answer) as clean text: the original strings,
  no borders, padding or hard wraps. With no box open it copies the line's `path:line`. It uses `pbcopy`,
  `wl-copy` or `xclip`, else OSC 52 (works through tmux with `allow-passthrough on`, and over ssh);
  `PRVIEW_CLIPBOARD=osc52` forces the terminal route.
- **A floating box** for whatever wants explaining: `?` the chapter's intent, `f` a finding,
  `a` a question about the hunk in front of you.
- **Your editor for the real code.** `e` opens the file at the line under the cursor in a
  worktree at the PR head (`$EDITOR`, default `hx`; VS Code, Zed and vim forms are handled).
  Quit the editor and you are back where you were. Inside tmux the editor opens in a split pane
  to the right and prview stays on screen.
- **Colour and width.** Code is coloured by token (keywords, strings, comments, numbers, types); on
  added and removed lines the green or red stays and tokens differ by weight, so the diff still reads
  first. Below 100 columns the rail shrinks to chapter numbers. A long line is cut with `…`: `H`/`L`
  pan sideways, `w` wraps it instead. In an open box `PgUp`/`PgDn` (or `ctrl-u`/`ctrl-d`) page.
- **Notes and coverage.** `n` notes the line, `N` the whole change. Everything is saved as you go;
  `q` and come back later.
- **Submit.** `s` picks a verdict; Enter takes request changes when anything is blocking. The
  preview then lists any findings you have not decided, the write-up (notes with file and line, how
  much you read, the findings you kept and what you decided) and what Enter will do: write the finished document to `$PRVIEW_HOME/submitted/<name>.json`
  (and `.md`), post your verdict and comments to the PR, and, if the document asks for one, run its
  `on_submit` command. That command is shown in full and runs only if you press `x` in the preview;
  Enter alone skips it. `v` adds a line saying how much you read to the posted summary (off by
  default). On GitHub (through `gh`) this is one review: the head commit is checked first (a PR that
  moved since the review is refused), a pending review gets your line comments (right side for lines
  in the new file, left for the old), then it is submitted with your verdict and summary. A failed
  post or command is reported, and the file is kept. Only your own words are posted: a finding
  reaches the PR only as the `b`/`c` comment you saved for it.
  `--dry-run` prints the API calls a submit would make and does nothing else.
- **Blind first pass.** With `blind = true` in the config (or `--blind` for a run, `--no-blind` to turn
  it off) findings stay hidden in a chapter until you have visited every hunk in it, so you read the
  code before you read the critic. The gutter shows no `▲`, `f`, `]f` and the decision keys do nothing there, and the
  rail marks the chapter `▲?`. `F` reveals the chapter early: a box lists what the model found next to
  the comments you already left, the reveal is kept in the document (`human.revealed`), and the
  write-up notes which chapters you looked at early.

Models: named in `~/.config/prview/config.toml` (or `$PRVIEW_CONFIG`) and assigned per role. With no
config every role is `claude -p` on your subscription. `--ai NAME` uses one named model for all four
roles for a run; `--no-ai` skips the guide and critic. `prview models` lists them and checks each is
reachable. A missing credential fails before anything is fetched. The guide and findings are redone
only when the PR head moves, or with `--fresh`. The critic reads each chapter `--samples N` times
(default 2) and merges the runs: a finding shows how many runs raised it (`2/3`), and the gutter marks
the worst by severity, then votes. Each run's time and cost are kept in the review's JSON.

```toml
blind = true                 # top level, before any [table]: hide findings until a chapter is read
[models.claude]              # kinds: claude-cli | anthropic | openai-compatible
kind = "claude-cli"
[models.sonnet]
kind = "anthropic"
model = "claude-sonnet-4-5"
key_keychain = "ANTHROPIC_API_KEY"       # or key_env = "NAME"; each model names its own
[models.qwen]
kind = "openai-compatible"
endpoint = "http://localhost:8000/v1"
model = "mlx-community/Qwen3.8-27B-4bit"  # optional: defaults to the server's first model
[roles]                      # guide, critic, refute, ask; unnamed roles use "claude"
critic = "sonnet"
ask = "qwen"
```

A credential is read only from the env var or Keychain service the model itself names, never from
some ambient key, so a local server never gets a cloud key.

State lives under `~/.cache/prview` (`$PRVIEW_HOME`): a worktree per review and one JSON file.
`prview done <name>` removes both.

## One document, any producer

Every review is a `prview-review/1` document: the target (repo, base, head, PR), the chapters,
the findings (each with the `source` that raised it), and your comments, decisions on findings,
coverage and verdict (an older document's `dismissals`, and a stored `ignored` decision, load as "not an issue"). The guide and critic are just the default producer; any reviewer that writes the
document can feed prview, and prview never asks which one did.

```sh
prview export pm-pr-42 > review.json    # the whole review, yours included
prview import review.json               # merge into the review at that head, or start one here
other-reviewer --json | prview import - # another producer's findings, beside the critic's
prview show review.json                 # import, then open
```

A document is anchored on its head commit and is refused by a review at any other head.
[`schema/`](./schema/) has the JSON Schema and what a producer needs to emit.

Not yet: posting to GitLab or Azure DevOps.

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
