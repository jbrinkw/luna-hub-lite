import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Toggle } from '@/components/ui/Toggle';
import { ListSkeleton } from '@/components/ui/Skeleton';

interface ToolDef {
  name: string;
  description: string;
  displayName: string;
}

interface ToolGroup {
  label: string;
  tools: ToolDef[];
}

/** Strip namespace prefix and convert snake_case to Title Case */
function humanize(toolName: string): string {
  const withoutPrefix = toolName.replace(/^[A-Z]+_/, '');
  return withoutPrefix
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function defineTool(name: string, description: string): ToolDef {
  return { name, description, displayName: humanize(name) };
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'CoachByte',
    tools: [
      defineTool('COACHBYTE_complete_next_set', 'Complete next planned set'),
      defineTool('COACHBYTE_get_today_plan', "Get today's workout plan"),
      defineTool('COACHBYTE_log_set', 'Log a completed set'),
      defineTool('COACHBYTE_get_history', 'View workout history'),
      defineTool('COACHBYTE_get_prs', 'View personal records'),
      defineTool('COACHBYTE_update_split', 'Update weekly split'),
      defineTool('COACHBYTE_get_split', 'Get weekly split'),
      defineTool('COACHBYTE_get_timer', 'Get rest timer state'),
      defineTool('COACHBYTE_set_timer', 'Set rest timer'),
      defineTool('COACHBYTE_update_plan', 'Update daily plan'),
      defineTool('COACHBYTE_update_summary', 'Update workout summary'),
    ],
  },
  {
    label: 'ChefByte',
    tools: [
      defineTool('CHEFBYTE_consume', 'Consume stock from inventory'),
      defineTool('CHEFBYTE_get_inventory', 'View current inventory'),
      defineTool('CHEFBYTE_add_stock', 'Add stock to inventory'),
      defineTool('CHEFBYTE_get_macros', 'View daily macro totals'),
      defineTool('CHEFBYTE_create_product', 'Create a new product'),
      defineTool('CHEFBYTE_get_products', 'List all products'),
      defineTool('CHEFBYTE_get_recipes', 'Browse recipes'),
      defineTool('CHEFBYTE_create_recipe', 'Create a new recipe'),
      defineTool('CHEFBYTE_get_meal_plan', 'View meal plan'),
      defineTool('CHEFBYTE_add_meal', 'Add meal to plan'),
      defineTool('CHEFBYTE_get_shopping_list', 'View shopping list'),
      defineTool('CHEFBYTE_mark_done', 'Mark shopping item done'),
      defineTool('CHEFBYTE_add_to_shopping', 'Add item to shopping list'),
      defineTool('CHEFBYTE_below_min_stock', 'Check low-stock products'),
      defineTool('CHEFBYTE_log_temp_item', 'Log a temporary food item'),
      defineTool('CHEFBYTE_set_price', 'Set product price'),
      defineTool('CHEFBYTE_clear_shopping', 'Clear shopping list'),
      defineTool('CHEFBYTE_get_product_lots', 'View product lot details'),
      defineTool('CHEFBYTE_get_cookable', 'List cookable recipes'),
    ],
  },
  {
    label: 'Obsidian',
    tools: [
      defineTool('OBSIDIAN_search_notes', 'Search vault notes'),
      defineTool('OBSIDIAN_create_note', 'Create a new note'),
      defineTool('OBSIDIAN_get_note', 'Read a note'),
      defineTool('OBSIDIAN_update_note', 'Update an existing note'),
    ],
  },
  {
    label: 'Todoist',
    tools: [
      defineTool('TODOIST_get_tasks', 'Get tasks from Todoist'),
      defineTool('TODOIST_create_task', 'Create a new task'),
      defineTool('TODOIST_complete_task', 'Mark task complete'),
      defineTool('TODOIST_get_projects', 'List Todoist projects'),
    ],
  },
  {
    label: 'Home Assistant',
    tools: [
      defineTool('HOMEASSISTANT_get_devices', 'List all devices'),
      defineTool('HOMEASSISTANT_get_entity_status', 'Get device status'),
      defineTool('HOMEASSISTANT_turn_on', 'Turn on a device'),
      defineTool('HOMEASSISTANT_turn_off', 'Turn off a device'),
      defineTool('HOMEASSISTANT_tv_remote', 'TV remote control'),
    ],
  },
];

/** Flat list of all tool names for iteration */
const ALL_TOOLS = TOOL_GROUPS.flatMap((g) => g.tools);

export function ToolsPage() {
  const { user } = useAuth();
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!user) return;

    const loadTools = async () => {
      const { data: configs } = await supabase
        .schema('hub')
        .from('user_tool_config')
        .select('tool_name, enabled')
        .eq('user_id', user.id);

      const configMap = new Map(configs?.map((c) => [c.tool_name, c.enabled]) ?? []);

      const initial: Record<string, boolean> = {};
      for (const tool of ALL_TOOLS) {
        initial[tool.name] = configMap.get(tool.name) ?? true;
      }

      setToggles(initial);
      setLoading(false);
    };

    loadTools();
  }, [user]);

  const handleToggle = async (toolName: string, enabled: boolean) => {
    if (!user) return;
    const prev = toggles[toolName];
    setToggles((s) => ({ ...s, [toolName]: enabled }));

    const { error } = await supabase
      .schema('hub')
      .from('user_tool_config')
      .upsert({ user_id: user.id, tool_name: toolName, enabled }, { onConflict: 'user_id,tool_name' });

    if (error) {
      // Rollback optimistic update
      setToggles((s) => ({ ...s, [toolName]: prev }));
    }
  };

  const toggleGroup = (label: string) => {
    setExpandedGroups((s) => ({ ...s, [label]: !s[label] }));
  };

  const searchLower = search.toLowerCase().trim();

  /** Filter groups by search, computing matching tools per group */
  type FilteredGroup = ToolGroup & { matchingTools: ToolDef[] };
  const filteredGroups: FilteredGroup[] = useMemo(() => {
    if (!searchLower) return TOOL_GROUPS.map((g) => ({ ...g, matchingTools: g.tools }));
    return TOOL_GROUPS.map((g) => ({
      ...g,
      matchingTools: g.tools.filter(
        (t) =>
          t.displayName.toLowerCase().includes(searchLower) ||
          t.description.toLowerCase().includes(searchLower) ||
          t.name.toLowerCase().includes(searchLower),
      ),
    })).filter((g) => g.matchingTools.length > 0);
  }, [searchLower]);

  /** When search is active, all matching groups are expanded */
  const isGroupExpanded = (label: string): boolean => {
    if (searchLower) return true;
    return !!expandedGroups[label];
  };

  return (
    <HubLayout title="Tools">
      {loading ? (
        <ListSkeleton count={8} />
      ) : (
        <div className="space-y-3">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search tools..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-9 py-2 text-sm border border-slate-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400
                placeholder:text-slate-400"
              aria-label="Search tools"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Tool groups */}
          {filteredGroups.map((group) => {
            const expanded = isGroupExpanded(group.label);
            const tools = group.matchingTools;
            return (
              <div key={group.label} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(group.label)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
                  aria-expanded={expanded}
                  aria-label={`${group.label} tools group`}
                >
                  <div className="flex items-center gap-2">
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-400" />
                    )}
                    <span className="text-sm font-semibold text-slate-700">{group.label}</span>
                    <span className="inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium text-slate-500 bg-slate-100 rounded-full">
                      {tools.length}
                    </span>
                  </div>
                </button>

                {/* Expanded tool list */}
                {expanded && (
                  <div className="divide-y divide-slate-100 border-t border-slate-100">
                    {tools.map((tool) => (
                      <div key={tool.name} className="flex items-center justify-between px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900">{tool.displayName}</p>
                          <p className="text-sm text-slate-500">{tool.description}</p>
                          <p className="text-xs text-slate-400 font-mono mt-0.5">{tool.name}</p>
                        </div>
                        <div className="ml-4 shrink-0">
                          <Toggle
                            checked={toggles[tool.name] ?? true}
                            onChange={(checked) => handleToggle(tool.name, checked)}
                            aria-label={`Toggle ${tool.name}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* No results */}
          {filteredGroups.length === 0 && search && (
            <p className="text-center text-sm text-slate-500 py-8">No tools match "{search}"</p>
          )}
        </div>
      )}
    </HubLayout>
  );
}
