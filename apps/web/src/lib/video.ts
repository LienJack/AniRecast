import { useEffect, useRef } from 'react';
import { type Fps, frameAtTime } from './format';

type FrameCallback = (frame: number) => void;

/**
 * Calls `onFrame` with the frame index each time the video presents a new frame: via
 * `requestVideoFrameCallback` (exact presentation timestamp) when available, else a rAF loop.
 * Seeks while paused also present a frame, so stepping updates too.
 */
export function useFrameClock(video: HTMLVideoElement | null, fps: Fps, onFrame: FrameCallback): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  const fpsNum = fps.num;
  const fpsDen = fps.den;
  useEffect(() => {
    if (!video) return;
    const rate = { num: fpsNum, den: fpsDen };
    const report = (t: number) => cb.current(frameAtTime(t, rate));
    // Belt and braces for browsers that skip a callback after a paused seek.
    const onSeeked = () => report(video.currentTime);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadeddata', onSeeked);
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const tick: VideoFrameRequestCallback = (_now, meta) => {
        report(meta.mediaTime);
        handle = video.requestVideoFrameCallback(tick);
      };
      handle = video.requestVideoFrameCallback(tick);
      return () => {
        video.cancelVideoFrameCallback(handle);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('loadeddata', onSeeked);
      };
    }
    let raf = 0;
    let last = -1;
    const loop = () => {
      const f = frameAtTime(video.currentTime, rate);
      if (f !== last) {
        last = f;
        cb.current(f);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onSeeked);
    };
  }, [video, fpsNum, fpsDen]);
}

/** True when a keyboard event comes from a text field (page shortcuts must ignore those). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement)
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(target.type);
  return target.getAttribute('role') === 'combobox' || target.getAttribute('role') === 'option';
}
