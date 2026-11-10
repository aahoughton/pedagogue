# pedagogy

Ask a model to explain something and get a page where a tutor walks you through
it: code panes with highlights, questions about the lines you select, quizzes.
[INTENT.md](INTENT.md) has the goal.

## Run

Needs Node 26 and pnpm (`mise install`), and an Anthropic API key.

```sh
pnpm install
ANTHROPIC_API_KEY=... pnpm start
```

The daemon listens on `127.0.0.1:4270`. To use tours from another machine on
your tailnet, add this machine's tailnet address and say what links should
look like:

```sh
PEDAGOGY_HOST=127.0.0.1,100.x.y.z \
PEDAGOGY_PUBLIC_URL=http://desk.your-tailnet.ts.net:4270 \
ANTHROPIC_API_KEY=... pnpm start
```

The daemon answers only on the addresses in `PEDAGOGY_HOST` and has no login,
so list only addresses that your own machines can reach.
`src/daemon/config.ts` documents every variable.

## Start a tour

- Open the daemon's URL in a browser and fill in the form, or
- run `bin/tour --cwd <dir> "<what you want to understand>"`, which prints the
  tour's link, or
- install `skills/tour` for your agent and put `bin/tour` on your `PATH`; then
  "walk me through X" in a session starts a tour and gives you the link.

On the tour page, click a line number to select it, drag or Shift-click for a
range, and Cmd/Ctrl-click to pick separate lines. The selection goes to the
tutor with your next message.

## Develop

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.
