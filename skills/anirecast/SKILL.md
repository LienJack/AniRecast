---

name: anirecast
description: Operate an AniRecast workspace (replacing characters in anime openings shot by shot) through the `anirecast` CLI, process AniRecast agent tasks — review feedback on storyboard frames, shot videos or character designs, same-person and shot-boundary checks — and hold Codex discussions (`hof_…`) with the human. Use inside an AniRecast workspace, or when asked to handle AniRecast feedback, shots, cast, personas, boards, takes or renders.
---

# AniRecast

AniRecast turns an anime opening into a version where chosen characters are replaced by personas from the
user's library. Work is per shot: storyboard frames (GPT Image 2.5 Sunburst by default) → shot video (Wan 3.0
reference-to-video by default, 1080p) → render. A project may choose other models (`anirecast project models`).
Wan 3.0 redraws the whole frame from the original shot (it is not a pixel edit): motion and framing follow the
original closely, but text in the scene and people the instruction forgets can come out wrong.
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
- Omni, when a project uses it, has a daily request quota (see `anirecast quota`); blocked requests count too. Before regenerating, check
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
   When the human says part of a take is right ("74 到 164 幀可以", "only the start is wrong"), do not redo the
   whole shot: redo only the other frames with `--range a-b --keep <takeId>` (see "Partial takes" below).
   Shots with several people, camera moves, cuts inside them or fights: follow "Hard shots" below.
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

## Hard shots (several people, camera moves, cuts, fights)

What worked on shot 11 (a camera move past five people) and shot 17 (three cuts and a gunfight) of the Lycoris OP,
after several plain regenerations had failed:

1. **Is the source sound?** `anirecast take generate` refuses a shot whose source segment does not decode every
   frame (`conflict … damaged`). `anirecast shots prepare <shot>` cuts it again from the clip (no model cost).
2. **Read what the last version actually sent** before writing anything: `anirecast take show <take>` →
   `prompt` and `params.director` (`references`, `critique`, `notes`). Most failures are an instruction that
   leaves someone out or pins them to the wrong seconds ("at 0–1 s replace the bartender" — and he stayed
   himself in his close-up later). The director's brief carries a timeline from the detections (who is on screen
   when, where and how close); detections are sampled and can miss small or partly hidden people, so check the
   frames yourself.
3. **Find the cuts inside the shot**: `anirecast shots cuts <shot>` → `cuts` (hard cuts) and `parts` (the frame
   ranges between them); `kind: motion` entries are whip pans or fast action, not cuts.
4. **List every person per part**, from the shot's frames: original → replacement, the frames they are in view
   (also tiny, distant, out of focus, only a hand or sleeve showing), and what they do. Put the people the last
   version missed into `--extra` with their seconds and place ("the girl on the tatami at the bottom right,
   0–0.5 s, is the blonde gothic girl"). Name people the human wants kept ("the gunman in the red beret is not
   replaced").
5. **Anchor the hardest moment with a still**: approved storyboard frames are sent automatically. Draw one for a
   crowded first or last moment with `anirecast board generate <project> <shot> --role first|last --force --wait`,
   look at it, then pass it with `--attach <absolute path of the board image>` and say in `--extra` what it is
   ("the attached image is frame 0 of this part with all five people already replaced: open exactly like it").
6. **Preview before paying**: `anirecast take plan <shot> [--range a-b --keep <take>] --attach … --extra "…" --wait`
   (one vision call) and read the instruction: every person, every part, the right images. Fix `--extra` until
   it is right, then generate.
7. **Check every part and every person**: `anirecast take sheet <take>`; a person left unchanged for half a second
   is a rejection. Redo only what is wrong (next section), smallest range first.

## Partial takes (分段／局部重做)

`anirecast take generate <project> <shot> --range a-b --keep <take>` redoes only frames a–b of the shot (0 = its
first frame) and keeps every other frame of `<take>`; `take plan` takes the same flags. The part is cut from the
shot, directed and generated on its own (the director also sees the kept frames right before and after it), then
put in place; the new take has the shot's full length. `conform.kept.psnrDb` above ~40 dB confirms the kept frames
are untouched. Notes:

- Put the boundaries at a cut (`shots cuts`): the join is then invisible. Inside continuous motion, prefer a fast
  movement or a whip pan; a join in a slow, steady stretch may show a jump.
- One shot at a time; the kept take must be a finished take of the same tier.
- Wan bills whole seconds of the part (at least 2 s), so a 12-frame redo costs as much as 2 s; group nearby fixes.
- Chain them: keep the newest good take each time (v4 kept v3's 74–164, v5 kept v4's 12–164).
- Video jobs run up to three at a time. Several parts of one shot can be made side by side from the same base
  (each `--range … --keep <base>`, with `--seams none` where the neighbouring frames are being redone too, so the
  director is not shown frames that are about to change), then joined with no model call:
  `anirecast take merge <base> <partTake…> --wait` (the parts may not overlap).
- A part that starts or ends at a cut gets no kept frame on that side; the director is told it is its own set-up.
- **Rapid cuts, 2–4-frame flashes, graphic montages (strips, colour bars, split panels)**: a video model smooths
  them over or invents another layout. Redraw them frame by frame instead:
  `anirecast take frames <project> <shot> --range a-b --keep <take> --extra "<who is who in this part>" --wait`
  — each drawing goes through the image model with the replacement's sheets (held frames share one edit), the
  frames are assembled and put in place like any part; a frame the safety filter refuses keeps the previous edit
  (listed in `conform.frames.fallbacks`). About one image per drawing. Join it with Wan parts by `take merge`.
- Shot 34 of the Lycoris OP: the street turn (42–52) came out right from Wan; the montage (27–41), the pillar
  (53–62) and the flashes (63–80) needed `take frames`.

## Handing a task to Claude

Your sandbox writes only the workspace; you cannot change AniRecast's code. When a task needs a code change (a
missing CLI feature, a bug in a job), or keeps failing for a reason the CLI cannot reach, do not stall and do not
loop on paid regenerations:

```sh
anirecast tasks handoff <task> --to claude --reason "<why you cannot finish it>" \
  --tried "<versions you made, with ids, and what was still wrong>" --plan "<how you would solve it>"
```

It writes a brief for Claude Code under `projects/<project>/claude/<task>.md` (the request, the shot, every version
with model, range and cost, the last instruction and references, your notes) and asks the human to start Claude on
it with one command (also a button on the review page). Then end your turn.

Routing: feedback on a shot video goes to Claude instead of you when the shot is hard — three or more people to
replace, cuts inside the shot, or its videos were sent back twice already — or when the human picked Claude. The
tasks you get are the ones judged simple (or ones the human gave you explicitly); if one turns out hard after all,
hand it over the same way rather than spending on attempts.

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
anirecast take plan <shot> [--model <id>] [--range a-b --keep <take>] --wait   # 預覽提示詞: the director's instruction and images, no video made
anirecast take generate <project> <shot> --range a-b --keep <take>   # redo only frames a–b, keep the rest of <take>
anirecast shots cuts <shot>                 # hard cuts and fast motion inside a shot; `parts` are ranges for --range
anirecast take merge <base> <parts...>      # join partial takes made side by side from <base> (no model, no cost)
anirecast take frames <project> <shot> --range a-b --keep <take>   # 逐格重繪: redraw each drawing with the image model
anirecast take still <project> <shot> [--board <board>]   # hold a board for the shot's length (no model, no cost); --board names one the human asked to hold, even one sent back
anirecast review reject <version>           # (human) 拒絕: out of 待評審, nothing more to do
anirecast shots prepare <shot...>           # cut a damaged source segment again from the clip
anirecast project prune <project> [--dry-run]   # (human's call) delete failed/cancelled versions; files go to trash/versions/
anirecast tasks handoff <task> --to claude --reason "…"   # hand a task that needs code to Claude Code
anirecast design list <project>             # bindings: original → library character, analysis, note, sheets
anirecast design analyze <project> <cast>   # 原片分析 of one original (add --generate to redraw the sheets after)
anirecast design pick <project> <cast> --expressions 1,3 --poses 2   # which analysed items the sheets use
anirecast design refs <project> <cast> [--search --wait]   # 官方設定集: official art (candidates need a human to accept)
anirecast design original <project> <cast> --wait          # the original character's own sheets, from accepted art
anirecast codex show <hof_id>               # a discussion: question, folder, submitted result, what was imported
```
