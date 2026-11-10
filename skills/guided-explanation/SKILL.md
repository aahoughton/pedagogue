---

name: guided-explanation
description: Use when the user asks to have something explained, walked through, taught, or quizzed, and the topic spans several files or steps ("explain how X works", "how does this codebase handle Y", "walk me through this branch"). Starts a guided tour in the pedagogue app, where a tutor agent uses code panes, diagrams and quizzes in a browser page. Answer in the conversation instead for a single function, file or fact, or when the user asks for a brief or inline answer.
---

# Starting a tour

A tour runs in a separate tutor agent with its own display. Your job is to hand
it a good brief and give the user the link. You do not teach the topic yourself,
and the tutor does not see this conversation.

1. Decide whether the topic deserves a tour, from the question, before you
   start answering. A topic that spans several files or steps is a tour: a
   subsystem, a request's path through the code, what a branch changes, how
   the whole thing fits together. A single function, file or fact is an
   answer in the conversation. So is anything the user asked to have answered
   briefly or inline. If the user asked for a tour by name, start one.

2. Write the brief. The tutor starts from nothing but this text and the
   directory, so include:
   - What the user wants to understand, in their words.
   - What you know about the user that changes how to teach it: what they
     already know, what they are trying to do with the knowledge, whether they
     asked to be quizzed.
   - Pointers you already have: the files and symbols where the topic lives, a
     base branch for "what does this branch change", anything misleading you
     ran into. Give paths relative to the tour directory. Do not paste code;
     the tutor reads the files.
     Leave the route to the tutor. A brief is a few short paragraphs.

3. Start it. `--cwd` is the directory the tutor may read; use the repository
   root unless the topic lives in one subdirectory.

   ```sh
   tour --cwd /path/to/project - <<'BRIEF'
   ...
   BRIEF
   ```

   The command prints the tour's link.

4. Give the user the link on a line of its own and say in one sentence what the
   tour covers. The conversation with the tutor happens on that page.

If the command reports that no daemon is running, tell the user; it gives the
command to start one. Do not start the daemon yourself: it needs the user's API
key and keeps running after this session.
