import { ArchiveIcon, ArchiveRestoreIcon, PlusIcon, StarIcon, UploadIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { EmptyState, ErrorState, Field, Loading, PageHeader, Tag, Thumb } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, fileUrl } from '@/lib/api';
import { MAX_PERSONA_IMAGES, PERSONA_VIEW_LABEL, PERSONA_VIEWS } from '@/lib/labels';
import { useAction, usePersonas } from '@/lib/queries';
import type { Persona, PersonaImage, PersonaView } from '@/lib/types';
import { cn } from '@/lib/utils';

const INVALIDATE = [['personas'], ['shot'], ['project']];
const parseTags = (s: string) =>
  s
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter(Boolean);

const primaryImage = (p: Persona): PersonaImage | undefined =>
  p.images.find((i) => i.isPrimary) ?? p.images[0];

function PersonaFields({
  name,
  setName,
  description,
  setDescription,
  tags,
  setTags,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  tags: string;
  setTags: (v: string) => void;
}) {
  return (
    <>
      <Field label="名稱">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="名稱" />
      </Field>
      <Field label="外觀描述（髮型、髮色、眼睛、服裝、特徵）">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="外觀描述"
          className="min-h-20"
        />
      </Field>
      <Field label="標籤（逗號分隔）">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="標籤" />
      </Field>
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Persona) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const create = useAction(
    () =>
      api.post<Persona>('/api/personas', {
        name: name.trim(),
        description: description.trim(),
        tags: parseTags(tags),
      }),
    {
      success: (p) => `已新增人設「${p.name}」，接著上傳參考圖`,
      invalidate: INVALIDATE,
      onSuccess: onCreated,
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增人設</DialogTitle>
          <DialogDescription>
            只放動漫風格的人設。建立後上傳 1–5 張參考圖（建議包含正面全身和臉部特寫）。
          </DialogDescription>
        </DialogHeader>
        <PersonaFields
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          tags={tags}
          setTags={setTags}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate(undefined)}>
            建立
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({ persona }: { persona: Persona }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<PersonaView>('full');
  const [primary, setPrimary] = useState(persona.images.length === 0);
  const upload = useAction(
    () => {
      const form = new FormData();
      if (file) form.append('file', file);
      form.append('view', view);
      form.append('primary', String(primary));
      return api.upload<PersonaImage>(`/api/personas/${persona.id}/images`, form);
    },
    {
      success: '已上傳參考圖',
      invalidate: INVALIDATE,
      onSuccess: () => {
        setFile(null);
        setPrimary(false);
        if (fileRef.current) fileRef.current.value = '';
      },
    },
  );
  const full = persona.images.length >= MAX_PERSONA_IMAGES;
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/40 p-2.5">
      <Label htmlFor={fileId}>
        上傳參考圖（{persona.images.length}/{MAX_PERSONA_IMAGES}）
      </Label>
      <Input
        id={fileId}
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={full}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Select value={view} onValueChange={(v) => setView(v as PersonaView)}>
          <SelectTrigger size="sm" aria-label="視角">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERSONA_VIEWS.map((v) => (
              <SelectItem key={v} value={v}>
                {PERSONA_VIEW_LABEL[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="text-xs">
          <Checkbox checked={primary} onCheckedChange={(v) => setPrimary(v === true)} />
          設為主圖
        </Label>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!file || full || upload.isPending}
          onClick={() => upload.mutate(undefined)}
        >
          <UploadIcon />
          上傳
        </Button>
      </div>
      {full ? <span className="text-amber-300 text-xs">已達 {MAX_PERSONA_IMAGES} 張上限。</span> : null}
    </div>
  );
}

function EditDialog({ persona, onClose }: { persona: Persona; onClose: () => void }) {
  const [name, setName] = useState(persona.name);
  const [description, setDescription] = useState(persona.description);
  const [tags, setTags] = useState(persona.tags.join(', '));
  const save = useAction(
    (patch: Partial<Pick<Persona, 'name' | 'description' | 'tags' | 'archived'>>) =>
      api.patch<Persona>(`/api/personas/${persona.id}`, patch),
    { success: (p) => (p.archived ? '已封存' : '已儲存'), invalidate: INVALIDATE },
  );
  const setPrimary = useAction((id: string) => api.post(`/api/persona-images/${id}/primary`), {
    success: '已設為主圖',
    invalidate: INVALIDATE,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {persona.name}
            {persona.archived ? <Tag tone="muted">已封存</Tag> : null}
          </DialogTitle>
          <DialogDescription>Codex 可以用 `anirecast persona list --json` 看到這裡的人設。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <PersonaFields
              name={name}
              setName={setName}
              description={description}
              setDescription={setDescription}
              tags={tags}
              setTags={setTags}
            />
            <div className="flex gap-2">
              <Button
                disabled={!name.trim() || save.isPending}
                onClick={() =>
                  save.mutate({ name: name.trim(), description: description.trim(), tags: parseTags(tags) })
                }
              >
                儲存
              </Button>
              <Button
                variant="outline"
                disabled={save.isPending}
                onClick={() => save.mutate({ archived: !persona.archived })}
              >
                {persona.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {persona.archived ? '取消封存' : '封存'}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2">
              {persona.images.map((img) => (
                <div key={img.id} className="flex flex-col gap-1">
                  <div
                    className={cn(
                      'relative overflow-hidden rounded-md border',
                      img.isPrimary && 'border-amber-400',
                    )}
                  >
                    <Thumb
                      src={fileUrl(img.path)}
                      alt={PERSONA_VIEW_LABEL[img.view]}
                      fit="contain"
                      className="aspect-[3/4] w-full"
                    />
                    {img.isPrimary ? (
                      <span className="absolute top-1 left-1 rounded bg-amber-400 px-1 text-[10px] text-black">
                        主圖
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">{PERSONA_VIEW_LABEL[img.view]}</span>
                    {!img.isPrimary ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="設為主圖"
                        title="設為主圖"
                        disabled={setPrimary.isPending}
                        onClick={() => setPrimary.mutate(img.id)}
                      >
                        <StarIcon />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            {!persona.images.length ? <EmptyState className="p-4">還沒有參考圖</EmptyState> : null}
            <UploadForm persona={persona} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PersonasPage() {
  const [showArchived, setShowArchived] = useState(false);
  const personas = usePersonas(showArchived);
  // The editor looks personas up including archived ones, so archiving keeps the dialog open.
  const everyone = usePersonas(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const switchId = useId();
  if (personas.isPending) return <Loading />;
  if (personas.isError) return <ErrorState error={personas.error} />;
  const editing = (everyone.data ?? personas.data).find((p) => p.id === editingId);
  return (
    <div className="flex flex-col">
      <PageHeader
        title="素材庫"
        description="Workspace 共用的人設（只放動漫風格）。在角色表把片中角色對應到這裡的人設。"
        actions={
          <>
            <Switch id={switchId} checked={showArchived} onCheckedChange={setShowArchived} />
            <Label htmlFor={switchId}>顯示已封存</Label>
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              新增人設
            </Button>
          </>
        }
      />
      <div className="p-5">
        {personas.data.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {personas.data.map((p) => (
              <Card key={p.id} className={cn('overflow-hidden', p.archived && 'opacity-60')}>
                <button type="button" className="text-left" onClick={() => setEditingId(p.id)}>
                  <Thumb
                    src={fileUrl(primaryImage(p)?.path)}
                    alt={p.name}
                    fit="contain"
                    className="aspect-[3/4] w-full"
                  />
                  <div className="flex flex-col gap-1 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="flex-1 truncate font-medium">{p.name}</span>
                      {p.archived ? <Tag tone="muted">已封存</Tag> : null}
                    </div>
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {p.description || '（沒有描述）'}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      <Tag tone={p.images.length ? 'neutral' : 'warning'}>{p.images.length} 張參考圖</Tag>
                      {p.tags.map((t) => (
                        <Tag key={t} tone="muted">
                          {t}
                        </Tag>
                      ))}
                    </div>
                  </div>
                </button>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState>還沒有人設。按「新增人設」建立第一個。</EmptyState>
        )}
      </div>
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            setEditingId(p.id);
          }}
        />
      ) : null}
      {editing ? <EditDialog key={editing.id} persona={editing} onClose={() => setEditingId(null)} /> : null}
    </div>
  );
}
