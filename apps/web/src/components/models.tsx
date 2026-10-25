import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useModels } from '@/lib/queries';

/** A model picker for one kind of generation, each option with its note (limits, price). */
export function ModelSelect({
  kind,
  value,
  onChange,
  label,
  className,
}: {
  kind: 'image' | 'video';
  value: string | undefined;
  onChange: (id: string) => void;
  label: string;
  className?: string;
}) {
  const models = useModels();
  const options = (kind === 'image' ? models.data?.image : models.data?.video) ?? [];
  const current = options.find((m) => m.id === value);
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger size="sm" className={className} aria-label={label} title={current?.note}>
        <SelectValue placeholder={value ?? '選擇模型…'}>{current?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span className="flex flex-col">
              <span>{m.label}</span>
              <span className="text-[11px] text-muted-foreground">{m.note}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
