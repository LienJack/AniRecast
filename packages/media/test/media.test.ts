import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  composeReference,
  conformByTime,
  conformTake,
  decodedFrames,
  exec,
  extractAudioSegment,
  extractFrame,
  extractVideoSegment,
  ffmpeg,
  formatTimecode,
  parseTimecode,
  probe,
  runSidecar,
  scaleForUpload,
  sceneChanges,
  stillClip,
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
    expect(await decodedFrames(seg)).toBe(30);
    // The synthetic source cuts after 30, 75 and 95 frames.
    const cuts = (await sceneChanges(source)).filter((c) => c.kind === 'cut').map((c) => c.frame);
    expect(cuts).toEqual([30, 75, 95]);
    // A damaged copy keeps its packets but not its frames.
    const damaged = path.join(dir, 'damaged.mp4');
    const bytes = readFileSync(seg);
    bytes.fill(0x55, Math.floor(bytes.length * 0.3), Math.floor(bytes.length * 0.6));
    writeFileSync(damaged, bytes);
    expect(await decodedFrames(damaged)).toBeLessThan(30);
    expect(await scaleForUpload(seg, up, 180, { frameStep: 4 })).toEqual({ frames: 30, padded: 2 });
    expect((await probe(up, { countFrames: true })).frameCount).toBe(32);
    // A model with a minimum rate: every frame restamped to 24 fps, held to the minimum length.
    const up24 = path.join(dir, 'up24.mp4');
    expect(await scaleForUpload(seg, up24, 180, { frameStep: 1, minFrames: 48, fps: 24 })).toEqual({
      frames: 30,
      padded: 18,
    });
    expect(await probe(up24, { countFrames: true })).toMatchObject({ fpsNum: 24, fpsDen: 1, frameCount: 48 });

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

  it('pads short uploads to a model minimum and conforms a re-timed output by time', async () => {
    const seg = path.join(dir, 'brief.mp4');
    await extractVideoSegment(source, seg, {
      startFrame: 0,
      frameCount: 30,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    const up = path.join(dir, 'brief-up.mp4');
    expect(await scaleForUpload(seg, up, 180, { minFrames: 48 })).toEqual({ frames: 30, padded: 18 });
    expect((await probe(up, { countFrames: true })).frameCount).toBe(48);
    const inputSeconds = (48 * FPS_DEN) / FPS_NUM;
    // A model that answers at 30 fps and 5% slower than the upload.
    const out = path.join(dir, 'brief-30fps.mp4');
    await ffmpeg(['-i', up, '-vf', 'setpts=1.05*PTS', '-r', '30', out]);
    const spec = { frames: 30, fpsNum: FPS_NUM, fpsDen: FPS_DEN, width: 320, height: 180, inputSeconds };
    const fit = await conformByTime(out, path.join(dir, 'brief-fit.mp4'), spec);
    expect(fit.speed).toBeGreaterThan(1.02);
    expect(fit.speed).toBeLessThan(1.08);
    expect(await probe(path.join(dir, 'brief-fit.mp4'), { countFrames: true })).toMatchObject({
      frameCount: 30,
    });
    const slow = path.join(dir, 'brief-slow.mp4');
    await ffmpeg(['-i', up, '-vf', 'setpts=1.5*PTS', '-r', '30', slow]);
    await expect(conformByTime(slow, path.join(dir, 'x2.mp4'), spec)).rejects.toThrow(/the upload was/);
  }, 60_000);

  it('holds a still image for an exact frame count without camera motion', async () => {
    const still = path.join(dir, 'still.jpg');
    await extractFrame(source, still, 40, FPS_NUM, FPS_DEN);
    const out = path.join(dir, 'still.mp4');
    await stillClip(still, out, { frames: 31, fpsNum: FPS_NUM, fpsDen: FPS_DEN, width: 320, height: 180 });
    expect(await probe(out, { countFrames: true })).toMatchObject({
      frameCount: 31,
      width: 320,
      height: 180,
      fpsNum: FPS_NUM,
      fpsDen: FPS_DEN,
    });
    const { stderr } = await exec('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-i',
      out,
      '-filter_complex',
      '[0:v]split[a][b];[a]trim=end_frame=1,setpts=PTS-STARTPTS[first];' +
        '[b]trim=start_frame=30,setpts=PTS-STARTPTS[last];[first][last]psnr',
      '-f',
      'null',
      '-',
    ]);
    const psnr = /PSNR y:(inf|[\d.]+)/.exec(stderr)?.[1];
    expect(psnr).toBeDefined();
    // Permit H.264 compression noise, but reject any push-in on the detailed still.
    expect(psnr === 'inf' ? Number.POSITIVE_INFINITY : Number(psnr)).toBeGreaterThan(50);
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

describe('reference composites', () => {
  it('lays images out by shape so nothing is letterboxed', async () => {
    const pic = async (name: string, size: string) => {
      const file = path.join(dir, name);
      await ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);
      return file;
    };
    const wide = [await pic('w1.png', '1600x900'), await pic('w2.png', '800x450')];
    const tall = [await pic('t1.png', '600x900'), await pic('t2.png', '300x450')];
    const out = path.join(dir, 'composite.jpg');
    await composeReference(wide, out, { size: 1280 });
    expect(await probe(out)).toMatchObject({ width: 1280, height: 1440 });
    await composeReference(tall, out, { size: 1280 });
    expect(await probe(out)).toMatchObject({ width: 1704, height: 1280 });
    await composeReference([wide[0]!, tall[0]!], out, { size: 1280 });
    expect(await probe(out)).toMatchObject({ width: 1280, height: 640 });
  }, 60_000);
});
