# Security

pedagogue is built for one person on machines they control. This page says
what it protects, what it does not, and how to report a problem.

## Who can do what

**The daemon has no login.** Anyone who can reach its port can:

- start a walkthrough in any directory the daemon's user can read, which lets them
  read those files through a tutor, at the cost of your API key or
  subscription usage;
- open any existing walkthrough and read its panes and conversation, which include
  the contents of the files the tutor showed.

So the network boundary is the only access control. The daemon listens on
`127.0.0.1` by default. Add an address to `PEDAGOGUE_HOST` only if every
machine that can reach it is yours, as on a tailnet. Do not put it on a shared
LAN or the internet, and do not run it on a machine with other users you do
not trust: loopback is reachable by every local user.

Traffic is plain HTTP. A tailnet encrypts it in transit; an ordinary network
does not.

## What the daemon defends against

- **Other websites.** A page in your browser cannot drive the daemon. Requests
  are refused unless the `Host` header names one of the daemon's own
  addresses (which stops DNS rebinding), and writes and WebSocket connections
  are refused if they carry another site's `Origin`.
- **File serving.** The daemon serves a fixed list of its own assets. It does
  not serve files by path.

## What a tutor can do

A tutor is a Claude Code process started through the Agent SDK with your API
key. It does not load your Claude Code settings, hooks or MCP servers.

- It can read files in the walkthrough's directory and in its own scratch directory.
- It can write files in its scratch directory only.
- It has no shell and no web tools.
- Every tool call is checked by the daemon, with symlinks resolved, and
  refused otherwise. The check is `src/daemon/permissions.ts`.

**Anything a tutor reads is sent to Anthropic's API**, under the terms of the
account your API key or subscription token belongs to. Do not start a walkthrough in a directory whose contents you may not
send there.

## Untrusted content in the directory being explained

Files in the walkthrough's directory can contain text that tries to instruct the
tutor. The limits above bound the damage: the tutor still cannot read outside
the directory, write outside scratch, run anything, or reach the network.
What such text can do is change what the tutor shows you:

- Markdown from the tutor is sanitized before display.
- HTML panes run in a sandboxed frame with scripts allowed and no network
  access, in an origin separate from the page.
- Links in the tutor's replies open in a new tab. A link could carry text from
  the directory in its URL, so look at where a link goes before following one
  you did not expect.

## What is stored

- `~/.config/pedagogue/env` holds your API key or subscription token. The daemon refuses to read it
  unless only you can read it.
- `~/.local/share/pedagogue` holds every walkthrough unencrypted: its conversation
  and the full text of each file the tutor showed.
- The Agent SDK keeps each tutor's conversation under `~/.claude/projects`,
  which is how a walkthrough resumes.

## Reporting a problem

Report a vulnerability through the repository's private vulnerability
reporting on GitHub (Security tab, "Report a vulnerability") instead of a
public issue. This is a personal project with no response-time commitment.
