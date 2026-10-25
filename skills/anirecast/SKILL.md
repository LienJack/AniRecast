---

name: anirecast
description: Operate an AniRecast workspace (replacing characters in anime openings shot by shot) through the `anirecast` CLI, and process AniRecast agent tasks — review feedback on storyboard frames or shot videos, and same-person identification checks. Use inside an AniRecast workspace, or when asked to handle AniRecast feedback, shots, cast, personas, boards, takes or renders.
---

# AniRecast

AniRecast turns an anime opening into a version where chosen characters are replaced by personas from the
user's library. Work is per shot: storyboard frame (Nano Banana) → shot video (Gemini Omni edit) → render.
The AniRecast daemon makes every model call; you plan, adjust prompts, queue jobs and check results.

## Ground rules

- Run commands from the workspace root (it contains `anirecast.workspace.json`). Every command prints one
  JSON object on stdout: `{"ok":true,"data":…}` or `{"ok":false,"error":{code,message,hint}}`. Progress is on stderr.
- Only use the CLI. Never edit, move or delete files under `sources/`, `projects/`, `library/` or the database.
- You have no network. If a command says `daemon_not_running`, stop and tell the human.
- Never approve a version. Approval is the human's call; say what you recommend instead.
- `budget_exceeded`: stop and ask. `provider_rejected` (often a content filter): rephrase at most twice, then
  `anirecast tasks ask`. If its hint says `daily_quota`, do not retry at all; ask right away.
- User decisions are locked (cast assignments made by the human). A `conflict … locked` error means leave it.
- Generation tiers: `draft` (360p, cheapest, for iterating), `preview` (720p), `final` (1080p). Stay on the
  project tier unless the task says otherwise; never jump to `final` on your own.

## Handling an agent task

1. `anirecast tasks show <task>` — the comment, the target version (with `absPath`), its inputs, history and a
   suggested next step. Open the images you are given (view them; they are the frame and the current result).
2. Review feedback on a **board** (`targetType: board`): write a short, concrete revision and regenerate:
   `anirecast board generate <project> --from <boardId> --extra "<what to change>" --wait`
   Then look at the new board (`anirecast board show <newId>` → `absPath`) and check it against the comment.
3. Review feedback on a **take** (`targetType: take`): same with
   `anirecast take generate <project> --from <takeId> --extra "<what to change>" --wait`.
   You cannot watch video; run `anirecast take sheet <newTakeId>` and view the returned image (original
   frames on top, new frames below) to check motion, identity and the requested change.
   If the problem is really the character design (wrong outfit, wrong face), say so: the board should be
   revised first (`anirecast board generate … --from <approved board>`), then a new take.
4. Finish: `anirecast tasks done <task> --note "<one sentence: what you changed>" --result <newVersionId>`.
   The note is shown to the human next to the new version, so make it specific.
5. If the comment is ambiguous, or two attempts did not satisfy it: `anirecast tasks ask <task> --question "…"`.

## Same-person identification (`cast_review` tasks)

The task payload lists uncertain cases with contact sheets (head and body crops per appearance, shot numbers).
For each case decide, then act with a reason and a confidence:

- Same person (different outfit or hairstyle is still the same person — judge by face, eyes, hair colour,
  distinctive features): `anirecast cast merge <keep> <drop> --reason "…" --confidence 0.8`
- A wrongly grouped appearance: `anirecast cast assign <tracklet> --to <cast> --reason "…" --confidence 0.7`
- Two people mixed in one character: `anirecast cast split <cast> --tracklets <id,id> --label "<name>" --reason "…"`
- Not a character (background figure, false detection): `anirecast cast not-character <tracklet> --reason "…"`
- Unsure: leave it; mention it in the done note so the human checks it in the cast page.

Two people in the same frame are never the same person — except in collages, character-sheet or file-card
layouts, split screens and multi-panel frames, where one character can appear several times (front, side,
back). Judge those by appearance and merge them.

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
```
