import { CheckCheckIcon, CheckIcon, ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Thumb } from '@/components/common';
import { VersionBadge } from '@/components/domain';
import { Generating, ShimmerText, useActiveJob } from '@/components/generating';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, fileUrl } from '@/lib/api';
import { BOARD_ROLE_LABEL, BOARD_ROLES } from '@/lib/labels';
import { useAction } from '@/lib/queries';
import type { Board, BoardRole, ShotDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

type Keyframe = ShotDetail['keyframes'][number];
const busy = (b: Board | undefined) => b?.status === 'queued' || b?.status === 'generating';

/** The board shown for a moment: the one picked in the version history, else the approved one, else the latest. */
const shownBoard = (boards: Board[], role: BoardRole, selectedId: string | undefined) => {
  const own = boards.filter((b) => b.role === role);
  return own.find((b) => b.id === selectedId) ?? own.find((b) => b.status === 'approved') ?? own.at(-1);
};

/** The original frame a moment redraws: the board's own frame, else the shot's first / last keyframe or the key. */
function originalFrame(d: ShotDetail, role: BoardRole, board: Board | undefined, key: Keyframe | undefined) {
  const byFrame = board?.frame != null ? d.keyframes.find((k) => k.frame === board.frame) : undefined;
  if (byFrame) return byFrame;
  if (role === 'key') return key;
  const sorted = [...d.keyframes].sort((a, b) => a.frame - b.frame);
  return d.keyframes.find((k) => k.role === role) ?? (role === 'first' ? sorted[0] : sorted.at(-1));
}

function BoardPane({
  d,
  role,
  board,
  keyFrame,
  renderOriginal,
}: {
  d: ShotDetail;
  role: BoardRole;
  board: Board | undefined;
  keyFrame: Keyframe | undefined;
  renderOriginal: (src: string | undefined, alt: string) => React.ReactNode;
}) {
  const original = originalFrame(d, role, board, keyFrame);
  const job = useActiveJob('boardId', busy(board) ? board?.id : null);
  const label = BOARD_ROLE_LABEL[role];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          原片{label} f {original?.frame ?? '—'}
        </span>
        {renderOriginal(fileUrl(original?.path), `原片${label}`)}
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          {board ? (
            <>
              {label}分鏡圖 v{board.version} <VersionBadge status={board.status} />
            </>
          ) : (
            `還沒有${label}分鏡圖`
          )}
        </span>
        {board?.path ? (
          <Thumb
            src={fileUrl(board.path)}
            alt={`${label}分鏡圖 v${board.version}`}
            fit="contain"
            className="aspect-video w-full rounded-md"
            zoom
            gallery={[
              ...(original ? [{ src: fileUrl(original.path) ?? '', alt: `原片${label}` }] : []),
              { src: fileUrl(board.path) ?? '', alt: `${label}分鏡圖 v${board.version}` },
            ]}
          />
        ) : board && board.status !== 'failed' ? (
          <Generating
            queued={board.status === 'queued'}
            since={board.createdAt}
            progress={job?.progress}
            message={job?.message}
            backdrop={fileUrl(original?.path)}
            className="aspect-video w-full"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-md bg-muted p-3 text-center text-muted-foreground text-xs">
            {board
              ? `生成失敗${board.error ? `：${board.error}` : ''}`
              : role === 'key'
                ? '按右側「生成分鏡圖」開始（首幀、關鍵幀、尾幀三張）'
                : `這一張還沒有：按「生成分鏡圖」；${label}看不到要替換的人時不會畫`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 分鏡圖: the shot's three storyboard frames — first, key and last — in tabs, each beside the original frame it
 * redraws. Picking a tab puts its board up for review; the video waits for the key frame.
 */
export function BoardTabs({
  d,
  selectedId,
  onSelect,
  keyFrame,
  renderOriginal,
}: {
  d: ShotDetail;
  selectedId: string | undefined;
  onSelect: (boardId: string) => void;
  /** The key frame's original (the representative keyframe) before any key board exists. */
  keyFrame: Keyframe | undefined;
  renderOriginal: (src: string | undefined, alt: string) => React.ReactNode;
}) {
  const selected = d.boards.find((b) => b.id === selectedId);
  const [role, setRole] = useState<BoardRole>(selected?.role ?? 'key');
  // Picking a version in the history opens its moment.
  useEffect(() => {
    if (selected) setRole(selected.role);
  }, [selected]);
  const shown = Object.fromEntries(
    BOARD_ROLES.map((r) => [r, shownBoard(d.boards, r, selectedId)]),
  ) as Record<BoardRole, Board | undefined>;
  const ready = BOARD_ROLES.map((r) => shown[r]).filter((b): b is Board => b?.status === 'ready');
  const approveAll = useAction(
    async () => {
      for (const b of ready) await api.post('/api/reviews', { targetId: b.id, verdict: 'approve' });
    },
    { success: '已通過', invalidate: [['shot'], ['project']] },
  );
  return (
    <Card>
      <CardHeader>
        <ImageIcon className="size-4" />
        <CardTitle>分鏡圖</CardTitle>
        <span className="text-muted-foreground text-xs">
          首幀・關鍵幀・尾幀；關鍵幀通過後就能生成分鏡視頻
        </span>
        {ready.length > 1 ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={approveAll.isPending}
            onClick={() => approveAll.mutate(undefined)}
          >
            <CheckCheckIcon />
            {ready.map((b) => BOARD_ROLE_LABEL[b.role]).join('、')}都通過
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <Tabs
          value={role}
          onValueChange={(v) => {
            const r = v as BoardRole;
            setRole(r);
            const b = shown[r];
            if (b) onSelect(b.id);
          }}
        >
          <TabsList>
            {BOARD_ROLES.map((r) => {
              const b = shown[r];
              return (
                <TabsTrigger key={r} value={r} className="gap-1.5">
                  {b?.status === 'approved' ? <CheckIcon className="size-3.5 text-emerald-400" /> : null}
                  {busy(b) ? <ShimmerText>{BOARD_ROLE_LABEL[r]}</ShimmerText> : BOARD_ROLE_LABEL[r]}
                  {b?.status === 'ready' ? <span className="size-1.5 rounded-full bg-sky-400" /> : null}
                  {r === 'key' ? <span className={cn('text-[10px] text-muted-foreground')}>必要</span> : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {BOARD_ROLES.map((r) => (
            <TabsContent key={r} value={r} className="pt-3">
              <BoardPane
                d={d}
                role={r}
                board={shown[r]}
                keyFrame={keyFrame}
                renderOriginal={renderOriginal}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
