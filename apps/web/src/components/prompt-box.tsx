import { ImagePlusIcon, XIcon } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Thumb } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, errorText, fileUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

/** What the human tells an agent or a model: words, and images that go with them. */
export interface PromptValue {
  text: string;
  /** Workspace paths of attached images (projects/<slug>/attachments/…). */
  images: string[];
}

export const EMPTY_PROMPT: PromptValue = { text: '', images: [] };
const MAX_IMAGES = 6;

/** The request fields for a prompt: `extra` or `comment` text plus `attachments`. */
export const promptFields = (
  v: PromptValue,
  textKey: 'extra' | 'comment' | 'topic' | 'answer' = 'extra',
) => ({
  ...(v.text.trim() ? { [textKey]: v.text.trim() } : {}),
  ...(v.images.length ? { attachments: v.images } : {}),
});

/**
 * A text box for talking to an agent, with images: 附加圖片, paste (⌘V) or drop them in; they are uploaded to the
 * project and go to the model with the words.
 */
export function PromptBox({
  projectRef,
  value,
  onChange,
  placeholder,
  label,
  className,
  autoFocus,
  onSubmit,
}: {
  projectRef: string;
  value: PromptValue;
  onChange: (v: PromptValue) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  autoFocus?: boolean;
  /** ⌘↵ / Ctrl↵. */
  onSubmit?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const latest = useRef(value);
  latest.current = value;

  const upload = async (files: File[]) => {
    const images = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (images.length < files.length) toast.error('只能附加 PNG、JPEG 或 WebP 圖片');
    const room = MAX_IMAGES - latest.current.images.length;
    if (images.length > room) toast.error(`最多附加 ${MAX_IMAGES} 張圖片`);
    for (const file of images.slice(0, Math.max(0, room))) {
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', file);
        const { path } = await api.upload<{ path: string }>(
          `/api/projects/${encodeURIComponent(projectRef)}/attachments`,
          form,
        );
        onChange({ ...latest.current, images: [...latest.current.images, path] });
      } catch (error) {
        toast.error('圖片上傳失敗', { description: errorText(error) });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    void upload(files);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setOver(false);
    void upload([...e.dataTransfer.files]);
  };

  return (
    <section
      aria-label={`${label ?? placeholder ?? '輸入'}（可以把圖片拖進來）`}
      className={cn(
        'flex flex-col gap-1.5 rounded-md',
        over && 'outline outline-2 outline-primary/60',
        className,
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Textarea
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        className="min-h-14 text-xs"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {value.images.map((p, i) => (
          <span key={p} className="relative">
            <Thumb
              src={fileUrl(p)}
              alt={`附加圖片 ${i + 1}`}
              fit="contain"
              className="size-14 rounded"
              zoom
            />
            <button
              type="button"
              aria-label={`移除附加圖片 ${i + 1}`}
              onClick={() => onChange({ ...value, images: value.images.filter((x) => x !== p) })}
              className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        {Array.from({ length: uploading }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders for uploads in flight
          <span key={i} className="skeleton size-14" />
        ))}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px] text-muted-foreground"
          disabled={value.images.length >= MAX_IMAGES}
          title="附加圖片：會跟文字一起交給 AI（也可以直接貼上或拖進來）"
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlusIcon />
          附加圖片
        </Button>
      </div>
    </section>
  );
}
