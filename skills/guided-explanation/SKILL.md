---

name: guided-explanation
description: Use when the user asks to have something explained, walked through, taught, or quizzed, and the topic spans several files or steps ("explain how X works", "how does this codebase handle Y", "walk me through this branch"). Starts a guided walkthrough in the pedagogue app, where a tutor agent uses code panes, diagrams and quizzes in a browser page. Answer in the conversation instead for a single function, file or fact, or when the user asks for a brief or inline answer.
---

# Starting a walkthrough

A walkthrough runs in a separate tutor agent with its own display. Your job is to hand
it a good brief and give the user the link. You do not teach the topic yourself,
and the tutor does not see this conversation.

1. Decide whether the topic deserves a walkthrough, from the question, before you
   start answering. A topic that spans several files or steps is a walkthrough: a
   subsystem, a request's path through the code, what a branch changes, how
   the whole thing fits together. A single function, file or fact is an
   answer in the conversation. So is anything the user asked to have answered
   briefly or inline. If the user asked for a walkthrough by name, start one.

2. Write the brief. The tutor starts from nothing but this text and the
   directory, so include:
   - What the user wants to understand, in their words.
   - What you know about the user that changes how to teach it: what they
     already know, what they are trying to do with the knowledge, whether they
     asked to be quizzed.
   - Pointers you already have: the files and symbols where the topic lives,
     anything misleading you ran into, and the path of the diff file if you
     wrote one (see below). Give paths relative to the walkthrough directory. Do not
     paste code; the tutor reads the files.
     Leave the route to the tutor. A brief is a few short paragraphs.

3. Start it. `--cwd` is the directory the tutor may read; use the repository
   root unless the topic lives in one subdirectory, or the worktree you
   prepared (see below).

   ```sh
   walkthrough --cwd /path/to/project - <<'BRIEF'
   ...
   BRIEF
   ```

   The command prints the walkthrough's link.

4. Give the user the link on a line of its own and say in one sentence what the
   walkthrough covers. The conversation with the tutor happens on that page.

## What the tutor can reach

The tutor is not a full coding agent. It can read and search the files under
`--cwd` as they are on disk, and nothing else: it has no shell, no git and no
network. It cannot check out a branch, run a diff, read history or fetch a
pull request. Anything of that kind has to be on disk before the walkthrough starts,
and you are the one who puts it there.

- **The topic is the code as checked out.** Use the user's directory as it
  is. No preparation is needed.
- **The topic is another branch, commit or pull request.** Check it out into
  a worktree of its own and use that as `--cwd`. Do not switch the branch in
  the user's checkout.

  ```sh
  git worktree add --detach /tmp/pedagogue-walkthroughs/<repo>-<ref> <ref>
  ```

- **The topic is what a branch changes.** The tutor can read the new code but
  cannot see what it replaced, so make a worktree of the branch as above, even
  if the branch is the one checked out, and write the diff into it. Name the
  file in the brief.

  ```sh
  git -C <worktree> diff <base>...HEAD > <worktree>/WALKTHROUGH-CHANGES.diff
  ```

A walkthrough can be resumed for as long as its directory exists, so leave the
worktree in place. Tell the user its path and that
`git worktree remove --force <path>` deletes it when they are done with the
walkthrough.

If the command reports that no daemon is running, tell the user; it gives the
command to start one. Do not start the daemon yourself: it needs the user's API
key and keeps running after this session.
