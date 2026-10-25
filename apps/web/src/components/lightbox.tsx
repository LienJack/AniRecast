import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export interface LightboxImage {
  src: string;
  alt: string;
}

interface State {
  images: LightboxImage[];
  index: number;
}

const LightboxContext = createContext<(images: LightboxImage[], index?: number) => void>(() => {});

/** Opens an image (or one of a set) full screen. */
export const useLightbox = () => useContext(LightboxContext);

/** Full-screen image viewer for the whole app: click outside or Esc closes, arrows step through a set. */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const open = useCallback((images: LightboxImage[], index = 0) => {
    if (images.length) setState({ images, index: Math.min(Math.max(0, index), images.length - 1) });
  }, []);
  const step = useCallback(
    (d: number) =>
      setState((s) => (s ? { ...s, index: (s.index + d + s.images.length) % s.images.length } : s)),
    [],
  );
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, step]);
  const current = state?.images[state.index];
  const many = (state?.images.length ?? 0) > 1;
  return (
    <LightboxContext.Provider value={open}>
      {children}
      {state && current ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={current.alt}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-4"
        >
          {/* The backdrop is the close control; the image and caption sit above it. */}
          <button
            type="button"
            aria-label="關閉放大檢視"
            className="absolute inset-0 cursor-zoom-out bg-black/90"
            onClick={() => setState(null)}
          />
          <button
            type="button"
            aria-label="關閉"
            className="absolute top-3 right-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setState(null)}
          >
            <XIcon className="size-5" />
          </button>
          <img
            src={current.src}
            alt={current.alt}
            className="relative max-h-[88vh] max-w-[94vw] object-contain"
          />
          <div className="relative mt-2 flex items-center gap-3 text-sm text-white/80">
            {many ? (
              <button
                type="button"
                aria-label="上一張"
                className="rounded p-1 hover:bg-white/10"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon className="size-5" />
              </button>
            ) : null}
            <span>
              {current.alt}
              {many ? `　${state.index + 1} / ${state.images.length}` : ''}
            </span>
            {many ? (
              <button
                type="button"
                aria-label="下一張"
                className="rounded p-1 hover:bg-white/10"
                onClick={() => step(1)}
              >
                <ChevronRightIcon className="size-5" />
              </button>
            ) : null}
            <a href={current.src} target="_blank" rel="noreferrer" className="text-xs underline">
              原圖
            </a>
          </div>
        </div>
      ) : null}
    </LightboxContext.Provider>
  );
}
