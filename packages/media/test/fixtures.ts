import { ffmpeg } from '../src/index.ts';

export const FPS_NUM = 24000;
export const FPS_DEN = 1001;

/**
 * Synthesizes a 23.976 fps clip whose shots have known lengths (frames) and visibly different content,
 * plus a sine audio track, so cut detection and frame accounting can be asserted exactly.
 */
export async function synthesizeShots(output: string, lengths: number[], size = '640x360'): Promise<void> {
  const sources = [
    (d: number) => `testsrc2=size=${size}:rate=${FPS_NUM}/${FPS_DEN}:duration=${d}`,
    (_d: number) => `mandelbrot=size=${size}:rate=${FPS_NUM}/${FPS_DEN}`,
    (d: number) => `smptehdbars=size=${size}:rate=${FPS_NUM}/${FPS_DEN}:duration=${d}`,
    (d: number) =>
      `color=c=0x8040c0:size=${size}:rate=${FPS_NUM}/${FPS_DEN}:duration=${d},drawgrid=w=40:h=40:t=4:c=white`,
    (d: number) => `rgbtestsrc=size=${size}:rate=${FPS_NUM}/${FPS_DEN}:duration=${d}`,
  ];
  const inputs: string[] = [];
  const chains: string[] = [];
  lengths.forEach((frames, i) => {
    const seconds = (frames * FPS_DEN) / FPS_NUM + 1;
    inputs.push('-f', 'lavfi', '-i', sources[i % sources.length]!(seconds));
    chains.push(`[${i}:v]trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${i}]`);
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  const totalSeconds = (total * FPS_DEN) / FPS_NUM;
  inputs.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${totalSeconds}`);
  const concat = `${lengths.map((_, i) => `[v${i}]`).join('')}concat=n=${lengths.length}:v=1:a=0[v]`;
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${chains.join(';')};${concat}`,
    '-map',
    '[v]',
    '-map',
    `${lengths.length}:a`,
    '-r',
    `${FPS_NUM}/${FPS_DEN}`,
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-shortest',
    output,
  ]);
}
