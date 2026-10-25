import { BoxIcon, MountainIcon, UserRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/common';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AssetKind } from '@/lib/types';
import { KIND_TEXT, PersonasPage } from './PersonasPage';

const TABS: Array<{ kind: AssetKind; icon: typeof UserRoundIcon }> = [
  { kind: 'character', icon: UserRoundIcon },
  { kind: 'item', icon: BoxIcon },
  { kind: 'scene', icon: MountainIcon },
];

/** The shared asset library of the workspace: characters (personas), items and scenes, each importable. */
export function LibraryPage() {
  const [kind, setKind] = useState<AssetKind>('character');
  return (
    <div className="flex flex-col">
      <PageHeader
        title="物料庫"
        description="整個 Workspace 共用的公共資產。每個項目都能用；人物在角色表裡對應到片中角色。"
      />
      <Tabs value={kind} onValueChange={(v) => setKind(v as AssetKind)} className="gap-0">
        <TabsList className="mx-5 mt-3">
          {TABS.map(({ kind: k, icon: Icon }) => (
            <TabsTrigger key={k} value={k}>
              <Icon />
              {KIND_TEXT[k].tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(({ kind: k }) => (
          <TabsContent key={k} value={k}>
            <PersonasPage kind={k} embedded />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
