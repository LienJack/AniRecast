import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  UploadIcon,
} from 'lucide-react';
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
import { PERSONA_VIEW_LABEL, PERSONA_VIEWS } from '@/lib/labels';
import { useAction, usePersonas } from '@/lib/queries';
import type { AssetKind, Persona, PersonaImage, PersonaView } from '@/lib/types';
import { cn } from '@/lib/utils';

const INVALIDATE = [['personas'], ['shot'], ['project']];
const parseTags = (s: string) =>
  s
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter(Boolean);

/** Wording per library section. */
export const KIND_TEXT: Record<AssetKind, { noun: string; tab: string; hint: string; refs: string }> = {
  character: {
    noun: '人物',
    tab: '人物',
    hint: '可以換進片中的人設（只放動漫風格）。在角色表把片中角色對應到這裡。',
    refs: '建議包含正面全身和臉部特寫',
  },
  item: {
    noun: '物品',
    tab: '物品',
    hint: '道具、武器、小物件等物品設定。',
    refs: '建議包含正面、側面和細節',
  },
  scene: {
    noun: '場景',
    tab: '場景',
    hint: '地點與背景設定。',
    refs: '建議包含全景和幾個重點角度',
  },
};

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

function CreateDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: AssetKind;
  onClose: () => void;
  onCreated: (p: Persona) => void;
}) {
  const text = KIND_TEXT[kind];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const create = useAction(
    () =>
      api.post<Persona>('/api/personas', {
        kind,
        name: name.trim(),
        description: description.trim(),
        tags: parseTags(tags),
      }),
    {
      success: (p) => `已新增${text.noun}「${p.name}」，接著上傳參考圖`,
      invalidate: INVALIDATE,
      onSuccess: onCreated,
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增{text.noun}</DialogTitle>
          <DialogDescription>
            {text.hint} 建立後上傳 1–5 張參考圖（{text.refs}）。
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

/** Uploads one or many images; one file can carry a caption, several are captioned by file name. */
function UploadForm({ persona }: { persona: Persona }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [view, setView] = useState<PersonaView>('other');
  const [label, setLabel] = useState('');
  const [primary, setPrimary] = useState(persona.images.length === 0);
  const upload = useAction(
    async () => {
      for (const [i, file] of files.entries()) {
        const form = new FormData();
        form.append('file', file);
        form.append('view', view);
        form.append('primary', String(primary && i === 0));
        form.append(
          'label',
          files.length === 1 && label.trim() ? label.trim() : file.name.replace(/\.[^.]+$/, ''),
        );
        await api.upload<PersonaImage>(`/api/personas/${persona.id}/images`, form);
      }
      return files.length;
    },
    {
      success: (n) => `已上傳 ${n} 張參考圖`,
      invalidate: INVALIDATE,
      onSuccess: () => {
        setFiles([]);
        setLabel('');
        setPrimary(false);
        if (fileRef.current) fileRef.current.value = '';
      },
    },
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/40 p-2.5">
      <Label htmlFor={fileId}>上傳參考圖（目前 {persona.images.length} 張，不限數量，可一次選多張）</Label>
      <Input
        id={fileId}
        ref={fileRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => setFiles([...(e.target.files ?? [])])}
      />
      {files.length <= 1 ? (
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="說明這張圖是什麼，例如「表情範圍」「表演動作」（生成時用來挑參考圖）"
          aria-label="圖片說明"
        />
      ) : (
        <span className="text-muted-foreground text-xs">多張上傳時，以檔名當說明，之後可以逐張修改。</span>
      )}
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
          disabled={!files.length || upload.isPending}
          onClick={() => upload.mutate(undefined)}
        >
          <UploadIcon />
          上傳{files.length > 1 ? ` ${files.length} 張` : ''}
        </Button>
      </div>
    </div>
  );
}

/** The caption under a reference image; click the pencil to change it. */
function ImageCaption({ img }: { img: PersonaImage }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(img.label);
  const save = useAction(() => api.patch(`/api/persona-images/${img.id}`, { label: text.trim() }), {
    success: '已更新說明',
    invalidate: INVALIDATE,
    onSuccess: () => setEditing(false),
  });
  if (editing)
    return (
      <form
        className="flex min-w-0 flex-1 gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-7 text-xs"
          aria-label="圖片說明"
          autoFocus
        />
        <Button size="sm" type="submit" disabled={save.isPending}>
          存
        </Button>
      </form>
    );
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground">
      <span className="truncate" title={img.label || undefined}>
        {img.label || '（沒有說明）'} · {PERSONA_VIEW_LABEL[img.view]}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="修改說明"
        title="修改說明"
        onClick={() => {
          setText(img.label);
          setEditing(true);
        }}
      >
        <PencilIcon />
      </Button>
    </span>
  );
}

/** Name, description, tags, archive, and the reference images (zoomable, set primary, upload). */
function PersonaEditor({ persona }: { persona: Persona }) {
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
  const gallery = persona.images.map((img) => ({
    src: fileUrl(img.path) ?? '',
    alt: `${persona.name} · ${img.label || PERSONA_VIEW_LABEL[img.view]}`,
  }));
  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[360px_minmax(0,1fr)]">
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
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
                  alt={`${persona.name} · ${img.label || PERSONA_VIEW_LABEL[img.view]}`}
                  fit="contain"
                  className="aspect-[3/4] w-full"
                  zoom
                  gallery={gallery}
                />
                {img.isPrimary ? (
                  <span className="absolute top-1 left-1 rounded bg-amber-400 px-1 text-[10px] text-black">
                    主圖
                  </span>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-1">
                <ImageCaption img={img} />
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
  );
}

/** One library entry on its own page (opened from the 物料庫 cards). */
export function PersonaDetailPage() {
  const { personaId } = useParams({ from: '/library/$personaId' });
  const persona = useQuery({
    queryKey: ['personas', 'one', personaId],
    queryFn: () => api.get<Persona>(`/api/personas/${encodeURIComponent(personaId)}`),
  });
  if (persona.isPending) return <Loading />;
  if (persona.isError) return <ErrorState error={persona.error} />;
  const p = persona.data;
  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {p.name}
            <Tag tone="info">{KIND_TEXT[p.kind].noun}</Tag>
            {p.archived ? <Tag tone="muted">已封存</Tag> : null}
          </span>
        }
        description="點圖片可以放大；Codex 可以用 `anirecast persona list` 看到這裡的資料。"
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/library">
              <ArrowLeftIcon />
              物料庫
            </Link>
          </Button>
        }
      />
      <PersonaEditor key={p.id + p.updatedAt} persona={p} />
    </div>
  );
}

/** One section of the library (characters, items or scenes); `embedded` drops the page header. */
export function PersonasPage({
  kind = 'character',
  embedded = false,
}: {
  kind?: AssetKind;
  embedded?: boolean;
}) {
  const text = KIND_TEXT[kind];
  const [showArchived, setShowArchived] = useState(false);
  const personas = usePersonas(showArchived, kind);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const open = (id: string) => void navigate({ to: '/library/$personaId', params: { personaId: id } });
  const switchId = useId();
  if (personas.isPending) return <Loading />;
  if (personas.isError) return <ErrorState error={personas.error} />;
  return (
    <div className="flex flex-col">
      {(() => {
        const actions = (
          <>
            <Switch id={switchId} checked={showArchived} onCheckedChange={setShowArchived} />
            <Label htmlFor={switchId}>顯示已封存</Label>
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              新增{text.noun}
            </Button>
          </>
        );
        return embedded ? (
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <span className="text-muted-foreground text-xs">{text.hint}</span>
            <div className="flex items-center gap-2">{actions}</div>
          </div>
        ) : (
          <PageHeader title={`物料庫 · ${text.tab}`} description={text.hint} actions={actions} />
        );
      })()}
      <div className="p-5">
        {personas.data.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {personas.data.map((p) => (
              <Card key={p.id} className={cn('overflow-hidden', p.archived && 'opacity-60')}>
                <button type="button" className="text-left" onClick={() => open(p.id)}>
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
          <EmptyState>
            還沒有{text.noun}。按「新增{text.noun}」建立第一個。
          </EmptyState>
        )}
      </div>
      {creating ? (
        <CreateDialog
          kind={kind}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            open(p.id);
          }}
        />
      ) : null}
    </div>
  );
}
