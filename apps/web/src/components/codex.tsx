import { useNavigate } from '@tanstack/react-router';
import { MessagesSquareIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Field, Tag } from '@/components/common';
import { EMPTY_PROMPT, PromptBox, type PromptValue } from '@/components/prompt-box';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { Tone } from '@/lib/labels';
import { useAction } from '@/lib/queries';
import type { DiscussionView, HandoffStatus, HandoffTarget } from '@/lib/types';

export const DISCUSSION_STATUS_LABEL: Record<HandoffStatus, string> = {
  open: '討論中',
  submitted: '結論待導入',
  imported: '已導入',
  closed: '已結束',
};
export const DISCUSSION_STATUS_TONE: Record<HandoffStatus, Tone> = {
  open: 'info',
  submitted: 'warning',
  imported: 'success',
  closed: 'muted',
};

export const DiscussionBadge = ({ status }: { status: HandoffStatus }) => (
  <Tag tone={DISCUSSION_STATUS_TONE[status]}>{DISCUSSION_STATUS_LABEL[status]}</Tag>
);

/**
 * 「和 Codex 討論」: exports this thing (with its state, images and prompts) to its own Codex conversation for a
 * multi-round discussion. The conclusion comes back to the discussion page, where it is imported item by item.
 */
export function DiscussInCodex({
  projectRef,
  targetType,
  targetId,
  what,
  label = '和 Codex 討論',
  variant = 'outline',
}: {
  projectRef: string;
  targetType: HandoffTarget;
  targetId?: string | null;
  /** What is being discussed, for the dialog ("分鏡 #12"). */
  what: string;
  label?: string;
  variant?: 'outline' | 'ghost';
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<PromptValue>(EMPTY_PROMPT);
  const [openThread, setOpenThread] = useState(true);
  const _topicId = useId();
  const threadId = useId();
  const create = useAction(
    () =>
      api.post<DiscussionView>(`/api/projects/${encodeURIComponent(projectRef)}/codex`, {
        targetType,
        targetId: targetId ?? null,
        topic: topic.text.trim(),
        ...(topic.images.length ? { attachments: topic.images } : {}),
        openThread,
      }),
    {
      success: (v) =>
        v.threadId ? '已在 Codex 開好對話' : v.openError ? undefined : '已建立討論包，可以把提示詞貼到 Codex',
      invalidate: [['project'], ['codex']],
      onSuccess: (v) => {
        setOpen(false);
        setTopic(EMPTY_PROMPT);
        void navigate({
          to: '/projects/$ref/codex/$discussionId',
          params: { ref: projectRef, discussionId: v.handoff.id },
        });
      },
    },
  );
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={() => setOpen(true)}
        title="導出到 Codex，開一個對話慢慢討論"
      >
        <MessagesSquareIcon />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>導出到 Codex 討論：{what}</DialogTitle>
            <DialogDescription>
              把現況、圖片和提示詞整理成一份說明，在 Codex 開一個新對話，來回討論幾輪。討論出結論後 Codex
              會交回來，你在討論頁逐項勾選導入；導入前不會改任何東西，也不會花錢。
            </DialogDescription>
          </DialogHeader>
          <Field label="想和 Codex 討論什麼？（可以附圖：貼上、拖進來或按附加圖片）">
            <PromptBox
              projectRef={projectRef}
              value={topic}
              onChange={setTopic}
              placeholder="例如：這個分鏡已經被擋兩次，衣服要怎麼改才不會被當成不當內容，又像 DeepSeek？"
              label="想和 Codex 討論什麼"
              autoFocus
            />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id={threadId} checked={openThread} onCheckedChange={(v) => setOpenThread(v === true)} />
            <Label htmlFor={threadId} className="font-normal text-sm">
              直接在 Codex App 開對話（Codex 會先讀資料、提出幾個做法，然後等你回覆）
            </Label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!topic.text.trim() || create.isPending}
              onClick={() => create.mutate(undefined)}
            >
              <MessagesSquareIcon />
              導出到 Codex
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
