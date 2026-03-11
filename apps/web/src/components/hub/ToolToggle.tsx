import { Toggle } from '@/components/ui/Toggle';
import { Skeleton } from '@/components/ui/Skeleton';

interface Tool {
  tool_name: string;
  description: string;
  enabled: boolean;
}

interface ToolToggleProps {
  tools: Tool[];
  loading?: boolean;
  onToggle: (toolName: string, enabled: boolean) => void;
}

export function ToolToggle({ tools, loading, onToggle }: ToolToggleProps) {
  return (
    <div>
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {!loading && (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {tools.map((tool) => (
            <div key={tool.tool_name} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 truncate">{tool.tool_name}</p>
                <p className="text-sm text-slate-500">{tool.description}</p>
              </div>
              <div className="ml-4 shrink-0">
                <Toggle
                  checked={tool.enabled}
                  onChange={(checked) => onToggle(tool.tool_name, checked)}
                  aria-label={`Toggle ${tool.tool_name}`}
                />
              </div>
            </div>
          ))}
          {tools.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-slate-500">No tools configured. Activate an app first.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
