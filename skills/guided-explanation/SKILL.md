---

name: guided-explanation
description: Start a guided tour in the pedagogue app, where a tutor agent walks the user through a topic with code panes, questions and quizzes in a browser page. Use when the user asks to be walked through, taught, or quizzed on something ("explain how X works", "walk me through this branch", "quiz me on Y") and the topic spans several files or ideas. Answer in the conversation instead when a few paragraphs would do.
---

# Starting a tour

A tour runs in a separate tutor agent with its own display. Your job is to hand
it a good brief and give the user the link. You do not teach the topic yourself,
and the tutor does not see this conversation.

1. Decide whether the topic deserves a tour. One function or one concept is an
   answer in the conversation. A subsystem, a request's path through several
   files, or "how does this whole thing fit together" is a tour. If the user
   asked for a tour by name, start one.

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
