# pedagogy

Ask a model to explain something and get a page where a tutor walks you through
it: code panes with highlights, questions about the lines you select, quizzes.
[INTENT.md](INTENT.md) has the goal.

## Run

Needs Node 26 and pnpm (`mise install`), and an Anthropic API key.

```sh
pnpm install
mkdir -p ~/.config/pedagogy
install -m 600 env.example ~/.config/pedagogy/env   # then add your API key
pnpm start
```

Settings live in `~/.config/pedagogy/env` (or the file `PEDAGOGY_ENV_FILE`
names). Variables set in the shell win over the file. The file must be mode
600 because it holds the key.

The daemon listens on `127.0.0.1:4270`. To use tours from another machine on
your tailnet, set `PEDAGOGY_HOST` to include this machine's tailnet address and
`PEDAGOGY_PUBLIC_URL` to what links should look like; `env.example` shows both.
The daemon answers only on the addresses in `PEDAGOGY_HOST` and has no login,
so list only addresses that your own machines can reach.

To start the daemon at login, see [docs/launchd.md](docs/launchd.md).

## Start a tour

- Open the daemon's URL in a browser and fill in the form, or
- run `bin/tour --cwd <dir> "<what you want to understand>"`, which prints the
  tour's link, or
- ask an agent that has the tour skill: "walk me through X" starts a tour and
  gives you the link.

To set up the last one for Claude Code, link the skill and the launcher from
this checkout so they follow it:

```sh
ln -s "$(pwd)/skills/tour" ~/.claude/skills/tour
ln -s "$(pwd)/bin/tour" ~/.local/bin/tour    # or any directory on your PATH
```

Tours are saved under `~/.local/share/pedagogy` and listed on the daemon's
index page. They survive a restart: a tutor that has been idle for 15 minutes,
or whose daemon restarted, is stopped and wakes with its conversation when you
next send it something.

On the tour page, click a line number to select it, drag or Shift-click for a
range, and Cmd/Ctrl-click to pick separate lines. The selection goes to the
tutor with your next message.

## Develop

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.
