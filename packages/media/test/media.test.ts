import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conformTake,
  extractAudioSegment,
  extractFrame,
  extractVideoSegment,
  formatTimecode,
  parseTimecode,
  probe,
  runSidecar,
  scaleForUpload,
} from '../src/index.ts';
import { FPS_DEN, FPS_NUM, synthesizeShots } from './fixtures.ts';

let dir: string;
let source: string;
const LENGTHS = [30, 45, 20, 60];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'anirecast-media-'));
  source = path.join(dir, 'source.mp4');
  await synthesizeShots(source, LENGTHS);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('timecodes', () => {
  it('parses seconds, m:s, h:m:s and explicit frames at 23.976', () => {
    expect(parseTimecode('83.5', FPS_NUM, FPS_DEN)).toBe(2002);
    expect(parseTimecode('1:23.5', FPS_NUM, FPS_DEN)).toBe(2002);
    expect(parseTimecode('00:01:23.500', FPS_NUM, FPS_DEN)).toBe(2002);
    expect(parseTimecode('f:1992', FPS_NUM, FPS_DEN)).toBe(1992);
    expect(() => parseTimecode('1:2:3:4', FPS_NUM, FPS_DEN)).toThrow(/Bad timecode/);
    expect(formatTimecode(2002, FPS_NUM, FPS_DEN)).toBe('00:01:23.500');
  });
});

describe('media', () => {
  it('probes the synthesized clip exactly', async () => {
    const p = await probe(source, { countFrames: true });
    expect(p).toMatchObject({
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
      width: 640,
      height: 360,
      frameCount: 155,
      hasAudio: true,
    });
  });

  it('extracts an exact frame range as CFR video and matching audio', async () => {
    const out = path.join(dir, 'seg.mp4');
    await extractVideoSegment(source, out, {
      startFrame: 10,
      frameCount: 100,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    const p = await probe(out, { countFrames: true });
    expect(p).toMatchObject({ frameCount: 100, fpsNum: FPS_NUM, fpsDen: FPS_DEN, hasAudio: false });
    const wav = path.join(dir, 'seg.wav');
    await extractAudioSegment(source, wav, {
      startFrame: 10,
      frameCount: 100,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    const a = await probe(path.join(dir, 'seg.mp4'));
    expect(a.durationMs).toBeGreaterThan(4100);
    await extractFrame(source, path.join(dir, 'f.jpg'), 80, FPS_NUM, FPS_DEN, { maxWidth: 320 });
  }, 60_000);

  it('pads uploads to a 4-frame step and absorbs small end differences when conforming', async () => {
    const seg = path.join(dir, 'odd.mp4');
    await extractVideoSegment(source, seg, {
      startFrame: 0,
      frameCount: 30,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    const up = path.join(dir, 'up.mp4');
    expect(await scaleForUpload(seg, up, 180, { frameStep: 4 })).toEqual({ frames: 30, padded: 2 });
    expect((await probe(up, { countFrames: true })).frameCount).toBe(32);

    const spec = { frames: 30, fpsNum: FPS_NUM, fpsDen: FPS_DEN, width: 320, height: 180, endTolerance: 3 };
    const trimmed = await conformTake(up, path.join(dir, 'trim.mp4'), spec);
    expect(trimmed).toMatchObject({ framesOut: 32, endAdjust: 2 });
    expect((await probe(path.join(dir, 'trim.mp4'), { countFrames: true })).frameCount).toBe(30);

    const short = path.join(dir, 'short.mp4');
    await extractVideoSegment(source, short, {
      startFrame: 0,
      frameCount: 28,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    expect(await conformTake(short, path.join(dir, 'held.mp4'), spec)).toMatchObject({ endAdjust: -2 });
    expect((await probe(path.join(dir, 'held.mp4'), { countFrames: true })).frameCount).toBe(30);

    await expect(conformTake(short, path.join(dir, 'x.mp4'), { ...spec, frames: 40 })).rejects.toThrow(
      /28 frames, the shot has 40/,
    );
  }, 60_000);

  it('detects the known cuts with the Python sidecar', async () => {
    const result = await runSidecar<{
      frameCount: number;
      cuts: number[];
      shots: { start: number; end: number }[];
    }>('detect-shots', ['--video', source]);
    expect(result.frameCount).toBe(155);
    expect(result.cuts).toEqual([30, 75, 95]);
    expect(result.shots.at(-1)).toEqual({ start: 95, end: 154 });
  }, 120_000);
});
