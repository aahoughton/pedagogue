# Intent

## Goal

I say "explain X" to a model, and a window opens in which a tutor walks me through X.
X can be code, a document, or something else. The tutor drives the display, quizzes
me, and talks with me inside that display. I never switch screens to take part.

## What matters

1. **Minimal friction.** Asking is the whole setup. No plugin permissions, no flags,
   no port juggling, no "start this first".
2. **The model drives and quizzes.** It opens and arranges panes, highlights, asks
   questions, sets exercises, and changes course based on my answers.
3. **Interaction happens in the display.** I reply, answer, select and write where
   the material is shown.

## Shape

- A daemon on the machine that holds the material. It serves a browser UI, hosts one
  tutor agent per tour, and remembers what I have done.
- A browser UI, reachable from another machine on the tailnet. I work on a laptop
  while the agents run on a desktop.
- A skill and launcher, so a model in an existing session can start a tutor in the
  app when a topic is complex enough to deserve one. The tutor starts from a written
  brief.

## Commitments

- Several tours can run at the same time.
- Panes come from a small fixed set (code, markdown, Mermaid diagram) plus one
  freeform HTML pane for anything else the tutor wants to draw. Quizzes appear in
  the conversation.
- Selection is context for a question, in two forms: a range, and a set of lines.
- Writing is in scope. Exercises live in a scratch workspace per tour; the tutor
  reads the real repo and writes only to that workspace.
- The daemon keeps my history across tours.
- A tour can be stored as a lesson plan for other people: a directory, file pointers,
  ranges, an outline. A lesson plan can go stale, so loading one checks every pointer
  and reports what no longer resolves.
- Claude first. Codex later. No other agents planned.

## First slice

From a Claude Code session on the desktop, "explain X" produces a link. On the
laptop, the tutor walks through X with highlighted code panes; I select lines and ask
about them, and answer at least one quiz question, all on the page. Two tours can be
open at once.

After that: exercises, history, lesson plans, Codex.

## Non-goals

- An editor. The display is for learning, and exercises are its only writing surface.
- A native app, unless a link in the terminal proves to be too much friction.
- Support for every MCP agent.
