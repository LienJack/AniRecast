import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertWithinBudget,
  assignTracklet,
  castAppearances,
  createCastMember,
  getProject,
  getShot,
  getSource,
  listCast,
  listKeyframes,
  markNotCharacter,
  projectCacheDir,
  projectDir,
  projectOfShot,
  recordCost,
  replaceAutoTracklets,
  type ShotCastResult,
  type ShotCastVerdict,
  settleCast,
  shotCast,
} from '@anirecast/core';
import { cropGrid, runSidecar } from '@anirecast/media';
import { estimateVisionCost } from '@anirecast/providers';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

/** Below this the model's pick is only shown, not assigned. */
const APPLY_FLOOR = 0.5;
/** A character not among the known ones becomes a new one only when the model is this sure. */
const NEW_FLOOR = 0.65;
const MAX_CAST = 24;

interface Verdict {
  person: number;
  kind: 'character' | 'new' | 'none';
  character?: number;
  label?: string;
  confidence?: number;
  reason?: string;
}

interface Answer {
  people?: Verdict[];
  missed?: Array<{ character?: number; label?: string; reason?: string }>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          person: { type: 'integer' },
          kind: { type: 'string', enum: ['character', 'new', 'none'] },
          character: { type: 'integer' },
          label: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['person', 'kind', 'confidence', 'reason'],
      },
    },
    missed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          character: { type: 'integer' },
          label: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  required: ['people', 'missed'],
};

/**
 * 找出這一鏡的角色: detect the people of one shot when it has none yet, then let the vision model say which of
 * the project's characters each one is (or a character not among them, or not a character at all). Its picks are
 * assigned unlocked (source codex) for the human to confirm; people the human already decided are left alone and
 * only the model's opinion is reported. Who replaces whom follows from the bindings and the shot's overrides.
 */
export const shotCastHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { shotId } = job.payload as { shotId: string };
  const shot = getShot(ws.db, shotId);
  const project = getProject(ws.db, projectOfShot(ws.db, shot.id).id);
  const source = getSource(ws.db, project.sourceId);
  const keyframes = listKeyframes(ws.db, shot.id);

  // 1. People: detect only a shot that has none (re-detecting would duplicate the ones already decided).
  let detected = 0;
  if (shotCast(ws.db, shot.id).length === 0 && keyframes.length) {
    progress(0.1, 'detecting people');
    const spec = {
      cropDir: ws.abs(`${projectDir(project)}/crops`),
      shots: [
        {
          shotId: shot.id,
          frames: keyframes.map((k) => ({ frame: k.frame, keyframeId: k.id, path: ws.abs(k.path) })),
        },
      ],
    };
    const specFile = ws.abs(`${projectCacheDir(project)}/identity/detect-shot-${job.id}.json`);
    mkdirSync(path.dirname(specFile), { recursive: true });
    writeFileSync(specFile, JSON.stringify(spec));
    const out = await runSidecar<{
      shots: Array<{ shotId: string; tracklets: Parameters<typeof replaceAutoTracklets>[2] }>;
    }>('detect-characters', ['--spec', specFile], { signal });
    for (const s of out.shots)
      detected += replaceAutoTracklets(ws.db, s.shotId, s.tracklets, (abs) => ws.rel(abs)).length;
  }

  const entries = shotCast(ws.db, shot.id);
  const tmp = ws.abs(`${projectCacheDir(project)}/shot-cast/${job.id}`);
  mkdirSync(tmp, { recursive: true });
  try {
    progress(0.4, 'comparing with the characters');
    // Frames of the shot: first, middle and last when there are more.
    const frames =
      keyframes.length <= 3
        ? keyframes
        : [keyframes[0]!, keyframes[Math.floor(keyframes.length / 2)]!, keyframes.at(-1)!];
    // One tile per detected person: full body, then the head the detector boxed.
    const people: Array<{ trackletId: string; tile: string }> = [];
    for (const [i, e] of entries.entries()) {
      const crops = [e.tracklet.bodyCropPath, e.tracklet.headCropPath].filter((p): p is string => Boolean(p));
      if (!crops.length) continue;
      const tile = path.join(tmp, `person-${i + 1}.jpg`);
      await cropGrid([crops.map((p) => ws.abs(p))], tile, { cell: 200 }, { signal });
      people.push({ trackletId: e.tracklet.id, tile });
    }
    // One tile per known character: a few heads and a body from other shots (this one only if nothing else).
    const known: Array<{ castId: string; label: string; description: string; tile: string }> = [];
    const cast = listCast(ws.db, project.id)
      .filter((c) => c.status === 'active')
      .sort((a, b) => b.shotIds.length - a.shotIds.length)
      .slice(0, MAX_CAST);
    for (const c of cast) {
      const all = castAppearances(ws, c.id, 8);
      const elsewhere = all.filter((a) => a.shotId !== shot.id);
      const pick = (elsewhere.length ? elsewhere : all).slice(0, 3);
      const crops = [...pick.map((a) => a.head), pick.find((a) => a.body)?.body].filter((p): p is string =>
        Boolean(p),
      );
      if (!crops.length) continue;
      const tile = path.join(tmp, `cast-${known.length + 1}.jpg`);
      await cropGrid([crops.map((p) => ws.abs(p))], tile, { cell: 160 }, { signal });
      known.push({ castId: c.id, label: c.label, description: c.description, tile });
    }
    if (!frames.length || (!people.length && !known.length))
      return { result: { detected, people: [], missed: [] } satisfies ShotCastResult };

    const f = frames.length;
    const p = people.length;
    const images = [
      ...frames.map((k) => ws.abs(k.path)),
      ...people.map((x) => x.tile),
      ...known.map((x) => x.tile),
    ];
    const prompt = [
      `Images 1–${f} are frames of one shot of the anime opening "${source.title}".`,
      p
        ? `Images ${f + 1}–${f + p} each show one person detected in the shot (person 1 to ${p}): the full-body crop, then the head crop. The detector sometimes boxes the wrong thing as the head (an ornament, a sign); when the full-body crop clearly shows a character, judge by the full-body crop.`
        : 'No person was detected in this shot.',
      known.length
        ? `Images ${f + p + 1}–${f + p + known.length} each show one of the known characters of this opening, several appearances side by side:`
        : 'There are no known characters yet.',
      ...known.map(
        (k, i) => `  character ${i + 1}: 「${k.label}」${k.description ? ` — ${k.description}` : ''}`,
      ),
      '',
      'For every detected person say who it is:',
      '- kind "character" with the number of the known character, when face, eyes and hair match (outfits change between scenes; the face and hair decide);',
      '- kind "new" with a short label in Traditional Chinese (for example 「黑衣男子」) when it is a real character of the anime but none of the known ones;',
      '- kind "none" when it is not a character: a poster, sign, statue, reflection, a part of the background the detector mistook, or a crowd too small to matter.',
      'Give confidence from 0 to 1 and reason: one short line in Traditional Chinese saying what decided it.',
      'Then list in "missed" any character clearly visible in the frames whom none of the detected persons covers (the known character number, or a label), each with a reason in Traditional Chinese; an empty list when everyone is covered.',
    ].join('\n');
    const model = services.config.models.vision;
    if (services.provider.name !== 'fake')
      assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, images.length));
    const answer = await metered(ctx, { model, kind: 'vision', shotId: shot.id }, () =>
      services.provider.analyzeImages<Answer>({
        model,
        prompt,
        images: images.map((path) => ({ path, mimeType: 'image/jpeg' })),
        responseSchema: SCHEMA,
        signal,
      }),
    );
    const usd = answer.provider === 'fake' ? 0 : answer.costUsd;
    recordCost(ws.db, {
      jobId: job.id,
      projectId: project.id,
      provider: answer.provider,
      model,
      usage: answer.usage,
      usd,
    });

    // 2. Apply the picks the human has not decided, report every one.
    progress(0.85, 'assigning');
    const verdicts: ShotCastVerdict[] = [];
    // A character not among the known ones is created once, and an existing one of the same name is reused.
    const byLabel = new Map(
      listCast(ws.db, project.id)
        .filter((c) => c.status === 'active')
        .map((c) => [c.label, c.id] as const),
    );
    for (const v of answer.data.people ?? []) {
      const person = people[v.person - 1];
      const entry = person && entries.find((e) => e.tracklet.id === person.trackletId);
      if (!person || !entry) continue;
      const confidence = Math.max(0, Math.min(1, Number(v.confidence ?? 0)));
      const target = v.kind === 'character' ? known[(v.character ?? 0) - 1] : undefined;
      const kind = v.kind === 'character' && !target ? 'new' : v.kind;
      const locked = entry.tracklet.assignedBy === 'user';
      const verdict: ShotCastVerdict = {
        trackletId: person.trackletId,
        kind,
        castId: target?.castId ?? null,
        label: target?.label ?? v.label?.trim() ?? null,
        confidence,
        reason: (v.reason ?? '').trim(),
        applied: false,
        locked,
      };
      const current = entry.tracklet.castMemberId;
      const opts = { reason: verdict.reason, confidence };
      if (!locked && confidence >= APPLY_FLOOR) {
        if (kind === 'character' && target && current !== target.castId) {
          assignTracklet(ws.db, person.trackletId, target.castId, 'daemon', opts);
          verdict.applied = true;
        } else if (kind === 'none' && (current || entry.tracklet.assignedBy === 'auto')) {
          markNotCharacter(ws.db, person.trackletId, 'daemon', opts);
          verdict.applied = true;
        } else if (kind === 'new' && !current && confidence >= NEW_FLOOR && verdict.label) {
          let castId = byLabel.get(verdict.label);
          if (!castId) {
            castId = createCastMember(
              ws.db,
              { projectId: project.id, label: verdict.label, thumbPath: entry.tracklet.headCropPath ?? null },
              'daemon',
            ).id;
            byLabel.set(verdict.label, castId);
          }
          assignTracklet(ws.db, person.trackletId, castId, 'daemon', opts);
          verdict.castId = castId;
          verdict.applied = true;
        }
      }
      verdicts.push(verdict);
    }
    const missed = (answer.data.missed ?? []).map((m) => {
      const k = m.character ? known[m.character - 1] : undefined;
      return {
        castId: k?.castId ?? null,
        label: k?.label ?? m.label?.trim() ?? '?',
        reason: (m.reason ?? '').trim(),
      };
    });
    const settled = settleCast(ws, project.id, [shot.id], 'characters found in the shot', 'daemon');
    return {
      result: { detected, people: verdicts, missed, ...settled } satisfies ShotCastResult & typeof settled,
      costUsd: usd,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};
