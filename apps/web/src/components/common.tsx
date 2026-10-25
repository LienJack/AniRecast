import { AlertTriangleIcon, ImageOffIcon, Loader2Icon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorText } from '@/lib/api';
import type { Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3 border-b px-5 py-3', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {description ? <div className="mt-0.5 text-muted-foreground text-xs">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Tag({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <Badge tone={tone} className={className}>
      {children}
    </Badge>
  );
}

export function Loading({ label = '載入中…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 p-6 text-muted-foreground', className)}>
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({ error, className }: { error: unknown; className?: string }) {
  return (
    <div
      className={cn(
        'm-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-200',
        className,
      )}
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="whitespace-pre-wrap break-words">{errorText(error)}</div>
    </div>
  );
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Image with a neutral placeholder when the path is missing or fails to load. */
export function Thumb({
  src,
  alt,
  className,
  fit = 'cover',
}: {
  src: string | undefined;
  alt: string;
  className?: string;
  fit?: 'cover' | 'contain';
}) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  if (!src || failed === src)
    return (
      <div
        role="img"
        aria-label={alt}
        className={cn('flex items-center justify-center bg-muted text-muted-foreground', className)}
      >
        <ImageOffIcon className="size-5 opacity-60" />
      </div>
    );
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(src)}
      className={cn('bg-black', fit === 'cover' ? 'object-cover' : 'object-contain', className)}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 bg-muted px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  );
}

/** Controlled confirmation dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '確認',
  destructive,
  pending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
