import { KeyRoundIcon } from 'lucide-react';
import { ErrorState, Loading, PageHeader, Tag } from '@/components/common';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import { useSettings } from '@/lib/queries';
import { WorkspacePage } from './WorkspacePage';

const KEY_HELP: Record<string, string> = {
  gemini: 'pbpaste | anirecast auth set-key',
  fal: 'anirecast auth set-key --provider fal --from-env-file .env',
  jev: 'anirecast auth set-key --provider jev --from-env-file .env',
};

/** Settings: model services and their keys, models and limits, and the workspace itself. */
export function SettingsPage() {
  const settings = useSettings();
  return (
    <div className="flex flex-col">
      <PageHeader title="設定" description="模型服務與金鑰、使用的模型與限制，以及 Workspace。" />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        {settings.isPending ? (
          <Loading />
        ) : settings.isError ? (
          <ErrorState error={settings.error} />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>模型服務</CardTitle>
                <span className="ml-auto text-muted-foreground text-xs">金鑰存在 macOS 鑰匙圈，不會顯示</span>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {settings.data.keys.map((k) => (
                  <div key={k.provider} className="flex items-center gap-2">
                    <KeyRoundIcon className="size-4 text-muted-foreground" />
                    <span className="w-56 truncate">{k.label}</span>
                    {k.source === 'missing' ? (
                      <span className="flex flex-col gap-0.5">
                        <Tag tone="warning">未設定</Tag>
                        <code className="text-[11px] text-muted-foreground">{KEY_HELP[k.provider]}</code>
                      </span>
                    ) : (
                      <Tag tone="success">{k.source === 'keychain' ? '鑰匙圈' : '環境變數'}</Tag>
                    )}
                  </div>
                ))}
                <span className="text-muted-foreground text-xs">JEV 位址：{settings.data.jevBaseUrl}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>模型與限制</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-xs">
                <Row label="分鏡圖" value={settings.data.models.image} />
                <Row label="分鏡視頻" value={settings.data.models.video} />
                <Row label="畫面分析" value={settings.data.models.vision} />
                <Row label="切點判斷" value={settings.data.models.continuity} />
                <Row
                  label="切點合併"
                  value={`${settings.data.continuity.enabled ? '開啟' : '關閉'} · 自動合併 ≥ ${settings.data.continuity.autoMerge} · Codex 複查 ≥ ${settings.data.continuity.review} · 最長 ${settings.data.continuity.maxShotSeconds} 秒`}
                />
                <Row
                  label="安全擋下上限"
                  value={`同一分鏡 ${settings.data.limits.maxSafetyBlocks} 次後不再自動送出`}
                />
                <Row
                  label="預算上限"
                  value={
                    settings.data.budget.capUsd === null ? '未設定' : `USD ${settings.data.budget.capUsd}`
                  }
                />
                <Row label="Codex 自動派發" value={settings.data.codex.autoDispatch ? '開啟' : '關閉'} />
                {settings.data.quota
                  .filter((q) => q.limit !== null)
                  .map((q) => (
                    <Row
                      key={q.model}
                      label="今日配額"
                      value={`${q.model} ${q.used}/${q.limit}${q.exhausted ? '（已用完）' : ''} · ${formatTime(q.resetsAt)} 重置`}
                    />
                  ))}
                <span className="pt-1 text-muted-foreground">
                  設定檔在 ~/.config/anirecast/config.json；改完重新啟動服務生效。
                </span>
              </CardContent>
            </Card>
          </>
        )}
      </div>
      <WorkspacePage />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-mono">{value}</span>
    </div>
  );
}
