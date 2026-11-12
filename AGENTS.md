# Working in this repository

pedagogue is a daemon that hosts tutor agents and a browser UI for them. Read
the README first; this file is what an agent (or a person) needs to change the
code without breaking its conventions.

## Layout

- `src/daemon/` the daemon. `walkthrough.ts` is the core: display state, the tools a
  tutor gets, and learner input. `driver.ts` is the interface to an agent;
  `claude-driver.ts` implements it. `server.ts` is HTTP and WebSocket.
  `permissions.ts` decides every tutor tool call.
- `ui/` the browser code: plain ES modules and CSS, served as they are.
- `src/cli/`, `bin/walkthrough` the launcher.
- `skills/guided-explanation/` the skill that tells an agent how to start a walkthrough.

## Commands

```sh
pnpm test        # all tests; no API key, no network
pnpm typecheck
pnpm lint        # biome check
pnpm format      # biome check --write
```

Run all four before committing. Use these scripts, not the tools directly.

## Conventions

- **No build step.** Node runs the TypeScript directly, so use only syntax
  that can be erased (no enums, no parameter properties) and import with the
  `.ts` extension. The browser loads `ui/*.js` as written; third-party browser
  code is served from `node_modules` through the fixed list in `server.ts`.
- **Tests describe behavior.** Walkthroughs and the server are tested through
  `FakeDriver`, a scripted agent, so tests need no model. Pure browser helpers
  live in `ui/lines.js` so the same test run covers them. Add a test with
  every change; fix a bug by first writing the test that shows it.
- **Fail early and say why.** Bad configuration stops the daemon at startup
  with a message naming the variable. Tool errors tell the tutor what was
  wrong in words it can act on. No silent fallbacks.
- **Messages the program prints are ASCII, short, and prefixed** (`pedagogue:`
  or `walkthrough:`).
- **Comments describe the code as it stands**: contracts, constraints, the
  reason for something non-obvious. History belongs in commit messages.

## Rules that protect the design

- **Everything agent-specific stays behind `AgentDriver`.** `walkthrough.ts` and
  `server.ts` must not import the Agent SDK or mention Claude tool names. A
  second driver should need no change outside its own file.
- **Tutor tools are defined once in `walkthrough.ts`** as name, schema and handler.
  A handler validates its own input (paths inside the walkthrough directory, ranges
  inside the file) and throws an error the tutor can read.
- **Every tutor tool call goes through `permissions.ts`.** Do not pre-approve
  tools in a driver. Any change to what a tutor can reach needs a test there
  and an update to SECURITY.md.
- **The server serves a fixed list of files.** Never map a URL path onto the
  filesystem.
- **A tutor's wording is part of the product.** `tutor-prompt.ts` and the tool
  descriptions and results in `walkthrough.ts` steer real behavior. After changing
  them, run a real walkthrough and read what the tutor does.
- **Saved walkthroughs must keep loading.** `WalkthroughRecord` has a version. Add optional
  fields freely; anything else needs a new version and a way to read the old.

## Trying changes by hand

A real tutor needs `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and uses
paid API tokens or subscription usage per walkthrough. To try the daemon without
touching a running one or its saved walkthroughs, use another port and data
directory:

```sh
PEDAGOGUE_PORT=4273 PEDAGOGUE_HOST=127.0.0.1 \
PEDAGOGUE_PUBLIC_URL=http://127.0.0.1:4273 \
PEDAGOGUE_DATA_DIR=/tmp/pedagogue-try pnpm start
```

Stop the daemon you started by its process id. Do not kill daemons by name;
the user may have their own running.

## Commits

Conventional subjects (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`), ASCII, with a short body that says what the change accomplishes.
One logical change per commit.
