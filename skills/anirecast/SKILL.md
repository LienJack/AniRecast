---

name: anirecast
description: Operate an AniRecast workspace (replacing characters in anime openings shot by shot) through the `anirecast` CLI, process AniRecast agent tasks — review feedback on storyboard frames, shot videos or character designs, same-person and shot-boundary checks — and hold Codex discussions (`hof_…`) with the human. Use inside an AniRecast workspace, or when asked to handle AniRecast feedback, shots, cast, personas, boards, takes or renders.
---

# AniRecast

AniRecast turns an anime opening into a version where chosen characters are replaced by personas from the
user's library. Work is per shot: storyboard frame (Nano Banana) → shot video (Gemini Omni edit) → render.
The AniRecast daemon makes every model call; you plan, adjust prompts, queue jobs and check results.

## Ground rules

- Run commands from the workspace root (it contains `anirecast.workspace.json`). Every command prints one
  JSON object on stdout: `{"ok":true,"data":…}` or `{"ok":false,"error":{code,message,hint}}`. Progress is on stderr.
- Only use the CLI. Never edit, move or delete files under `sources/`, `projects/`, `library/` or the database.
  The one exception is a Codex discussion's own folder (`projects/<project>/codex/<id>/`): write `result.json`
  there and keep scratch files in its `work/`.
- You have no network. If a command says `daemon_not_running`, stop and tell the human.
- Never approve a version. Approval is the human's call; say what you recommend instead.
- `budget_exceeded`: stop and ask. `provider_rejected` (often a content filter): rephrase at most twice, then
  `anirecast tasks ask`. If its hint says `daily_quota`, do not retry at all; ask right away.
- Omni has a daily request quota (see `anirecast quota`); blocked requests count too. Before regenerating, check
  that requests are left. A `conflict` whose hint says `safety_blocked` means the shot was refused repeatedly:
  do not pass `--retry-blocked` yourself; describe what you would change and `anirecast tasks ask`. Holding the
  board instead (`anirecast take still`) or keeping the original is the human's choice, not yours.
- User decisions are locked (cast assignments made by the human). A `conflict … locked` error means leave it.
- Shot videos are made at 1080p (`final`, the project tier); the human chose that for every video. Older
  `draft` (360p) / `preview` (720p) takes may exist; `take promote` redoes an approved one at 1080p. Do not
  switch a project to a lower tier on your own.

## Handling an agent task

1. `anirecast tasks show <task>` — the comment, the target version (with `absPath`), its inputs, history and a
   suggested next step. Open the images you are given (view them; they are the frame and the current result).
2. Review feedback on a **board** (`targetType: board`): write a short, concrete revision and regenerate:
   `anirecast board generate <project> --from <boardId> --extra "<what to change>" --wait`
   Then look at the new board (`anirecast board show <newId>` → `absPath`) and check it against the comment.
   A shot has three storyboard frames — `role` first, key and last (its first frame, the frame showing the most
   people to replace, its last frame); `--from` keeps the role, `--role <role>` draws one moment, no flag draws
   all three (a first/last frame where nobody to replace is seen is skipped). The video waits for the key
   frame's approval; first and last help when approved.
   The first and last frames keep the new characters identical to the key frame: drawn together, they wait for
   it and get it as their first reference; drawn alone later, they use the approved (else latest) key frame.
   Images the human attached to a comment are in the task's `annotations` (`type: image`, workspace paths) or
   `answerImages`, and in your turn; pass the ones the model needs with `--attach <path>` (board, take and
   design generate, take plan). A revision keeps the images of the version it revises.
   Prompts are written by the director inside each job (a vision model that reads the frame or watches the
   shot, the design sheets, the style and the light, then picks the references); `--extra` is passed to it as
   a mandatory requirement and also appended verbatim. A version's `params.director` holds its notes, its
   reading of the frame and the references it sent; `fallback: true` means the template prompt was used.
3. Review feedback on a **take** (`targetType: take`): same with
   `anirecast take generate <project> --from <takeId> --extra "<what to change>" --wait`.
   You cannot watch video; run `anirecast take sheet <newTakeId>` and view the returned image (original
   frames on top, new frames below) to check motion, identity and the requested change.
   If the problem is really the character design (wrong outfit, wrong face), say so: the board should be
   revised first (`anirecast board generate … --from <approved board>`), then a new take.
4. Review feedback on a **character design** sheet (`targetType: design`). A design belongs to a binding: an
   original character of the clip and the library character replacing her. It is drawn from the original's
   analysis (`anirecast design list` → `analysis`: how the animation draws her, her build and outfit, and the
   expressions / poses she has, each from a shot), so the sheet matches the role. A design is either the original
   character's own sheet (`subject: original`, drawn from official art a human accepted) or her replacement's
   (`subject: replacement`); an approved original sheet is the template the replacement is redrawn on. Revise with
   `anirecast design generate <project> --from <designId> --extra "<what to change>" --wait` and view the new
   sheet (`anirecast design show <newId>` → `absPath`). A revision keeps the earlier instructions. If the change
   applies to every sheet of the character (e.g. "cover the shoulders"), say so in the done note and suggest
   `anirecast design note <project> <persona> "<note>"` to the human rather than repeating it per sheet.
5. Finish: `anirecast tasks done <task> --note "<one sentence: what you changed>" --result <newVersionId>`.
   The note is shown to the human next to the new version, so make it specific.
6. If the comment is ambiguous, or two attempts did not satisfy it: `anirecast tasks ask <task> --question "…"`.

## Same-person identification (`cast_review` tasks)

The task payload lists uncertain cases with contact sheets (head and body crops per appearance, shot numbers).
For each case decide, then act with a reason and a confidence:

- Same person (different outfit or hairstyle is still the same person — judge by face, eyes, hair colour,
  distinctive features): `anirecast cast merge <keep> <drop> --reason "…" --confidence 0.8`
- A wrongly grouped appearance: `anirecast cast assign <tracklet> --to <cast> --reason "…" --confidence 0.7`
- Two people mixed in one character: `anirecast cast split <cast> --tracklets <id,id> --label "<name>" --reason "…"`
- Not a character (background figure, false detection): `anirecast cast not-character <tracklet> --reason "…"`
- Unsure: leave it; mention it in the done note so the human checks it in the cast page.

Cases from the JEV judge (`payload.source: "jev"`, after `anirecast cast tidy`) carry its reason and confidence:
`maybe_same` lists characters JEV thinks are one person but did not merge (not sure enough, bound to different
library characters, or blocked by an appearance the human locked); `maybe_mixed` has `trackletIds`, the
appearances JEV thinks are someone else — assign them to the right character or mark them not a character.

Two people in the same frame are never the same person — except in collages, character-sheet or file-card
layouts, split screens and multi-panel frames, where one character can appear several times (front, side,
back). Judge those by appearance and merge them.

## Shot boundaries (`shot_review` tasks)

Shots come from fast cut detection; a judge model (JEV) then decided, cut by cut, whether both sides are one
continuous moment. One shot = one moment: the same place, the same characters, continuous action. Cuts between
framings of that action (wide to close-up, another angle, a focus pull, a flash, a quick zoom) stay inside one
shot. A new place, time, subject or action, or a title / logo / graphic card, is a real cut. A shot may not be
longer than `maxShotSeconds` (10 s) in the payload.

The payload has `unsure` cuts (the judge's verdict, confidence and reason) and `merged` runs the judge already
merged. Each comes with a sheet: two frames before the cut, a red bar, two frames after it. Look at every sheet.

- An unsure cut that is one moment: `anirecast shots merge <first> <second> --reason "…"` (shot ids from
  `anirecast shots list <project>`; the frame is the second shot's `startFrame`).
- An unsure cut that is a real cut: `anirecast shots boundary <project> --at <frame> --cut --reason "…"`.
- A merge that was wrong: `anirecast shots split <shot> --at <frame>` at the original cut frame.
- Never add `--force` to a merge or split (it discards boards and takes); ask instead.
- A cut someone already decided by hand is locked (`anirecast shots boundaries <project>` shows `locked`); leave it.
- Finish with `anirecast tasks done <task> --note "…"` listing what you merged, kept and split.

## Codex discussions (Codex 討論)

A discussion is not a task. The human exported a hard problem from the web (a shot that keeps being blocked, a
character design, the style of the whole project…) to talk it through with you over several rounds, in this
thread or one they opened themselves. It has an id `hof_…` and a folder with `BRIEF.md` (the question, the
current state, image paths, the result format) and `context.json`.

1. Read `BRIEF.md` and look at the images. Reply in Traditional Chinese: what the problem is, your judgement, and
   2–3 options with their cost, quota use and risk. Then stop and wait for the human. Do not act on your own.
2. Keep discussing until the human agrees on what to do. Anything that sends a model request (design, board or
   take generation) needs the human's go-ahead first, with a rough cost; then you may try it with the CLI
   (`--wait`) and look at the result together. Quota, budget and safety-block rules apply as always.
3. Do not approve (the CLI refuses) and do not run `anirecast tasks done` / `tasks ask` here.
4. When the human agrees, write the conclusion to `result.json` in the discussion folder: a `summary` for the
   human, `actions` to import (format and action types in `BRIEF.md`; ids must exist in the project) and
   `versions` you generated while discussing. Then `anirecast codex submit <hof_id>`. If it lists problems,
   fix the file and submit again; the last submission wins. Tell the human it is ready to import in the web.
5. The human ticks which actions to import. Recommend approving a version with an `approve` action; they decide.

## Writing prompt revisions

- Short and concrete; prompts that describe too much change too much. End with "Keep everything else the same."
- Refer to the character by the persona name and where they are ("the girl on the right").
- Keep overlaid-credit removal and the look policy (persona outfit by default) intact unless asked.

## Useful commands

```sh
anirecast workspace status                  # workspace, schema, daemon
anirecast review status <project>           # every shot's stage at the project tier
anirecast shots list <project>              # shots with frames, keyframes and timecodes
anirecast cast list <project>               # characters, looks, appearances, mapped persona
anirecast persona list                      # persona library
anirecast board list <shot> / take list <shot>
anirecast take sheet <take>                 # contact sheet image of a take vs the original
anirecast jobs list --status running        # what the daemon is doing
anirecast cost <project>                    # spend so far
anirecast quota                             # requests left today per model (Omni: 100/day on API tier 2)
anirecast shots boundaries <project>        # every cut: same moment or cut, who decided, how sure
anirecast cast tidy <project> --wait        # JEV: merge same-person characters and same-outfit looks
anirecast shots find-cast <shot> --wait     # 找出這一鏡的角色: who each person in one shot is (picks stay unlocked for the human)
anirecast take plan <shot> [--model <id>] --wait   # 預覽提示詞: the video director's instruction and images, no video made
anirecast design list <project>             # bindings: original → library character, analysis, note, sheets
anirecast design analyze <project> <cast>   # 原片分析 of one original (add --generate to redraw the sheets after)
anirecast design pick <project> <cast> --expressions 1,3 --poses 2   # which analysed items the sheets use
anirecast design refs <project> <cast> [--search --wait]   # 官方設定集: official art (candidates need a human to accept)
anirecast design original <project> <cast> --wait          # the original character's own sheets, from accepted art
anirecast codex show <hof_id>               # a discussion: question, folder, submitted result, what was imported
```
