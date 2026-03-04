import { useEffect, useState } from 'react';
import { IonItem, IonItemDivider, IonLabel, IonSpinner, IonToggle } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

interface ToolDef {
  name: string;
  description: string;
}

interface ToolGroup {
  label: string;
  tools: ToolDef[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'CoachByte',
    tools: [
      { name: 'COACHBYTE_complete_next_set', description: 'Complete next planned set' },
      { name: 'COACHBYTE_get_today_plan', description: "Get today's workout plan" },
      { name: 'COACHBYTE_log_set', description: 'Log a completed set' },
      { name: 'COACHBYTE_get_history', description: 'View workout history' },
      { name: 'COACHBYTE_get_prs', description: 'View personal records' },
      { name: 'COACHBYTE_update_split', description: 'Update weekly split' },
      { name: 'COACHBYTE_get_split', description: 'Get weekly split' },
      { name: 'COACHBYTE_get_timer', description: 'Get rest timer state' },
      { name: 'COACHBYTE_set_timer', description: 'Set rest timer' },
      { name: 'COACHBYTE_update_plan', description: 'Update daily plan' },
      { name: 'COACHBYTE_update_summary', description: 'Update workout summary' },
    ],
  },
  {
    label: 'ChefByte',
    tools: [
      { name: 'CHEFBYTE_consume', description: 'Consume stock from inventory' },
      { name: 'CHEFBYTE_get_inventory', description: 'View current inventory' },
      { name: 'CHEFBYTE_add_stock', description: 'Add stock to inventory' },
      { name: 'CHEFBYTE_get_macros', description: 'View daily macro totals' },
      { name: 'CHEFBYTE_create_product', description: 'Create a new product' },
      { name: 'CHEFBYTE_get_products', description: 'List all products' },
      { name: 'CHEFBYTE_get_recipes', description: 'Browse recipes' },
      { name: 'CHEFBYTE_create_recipe', description: 'Create a new recipe' },
      { name: 'CHEFBYTE_get_meal_plan', description: 'View meal plan' },
      { name: 'CHEFBYTE_add_meal', description: 'Add meal to plan' },
      { name: 'CHEFBYTE_get_shopping_list', description: 'View shopping list' },
      { name: 'CHEFBYTE_mark_done', description: 'Mark shopping item done' },
      { name: 'CHEFBYTE_add_to_shopping', description: 'Add item to shopping list' },
      { name: 'CHEFBYTE_below_min_stock', description: 'Check low-stock products' },
      { name: 'CHEFBYTE_log_temp_item', description: 'Log a temporary food item' },
      { name: 'CHEFBYTE_set_price', description: 'Set product price' },
      { name: 'CHEFBYTE_clear_shopping', description: 'Clear shopping list' },
      { name: 'CHEFBYTE_get_product_lots', description: 'View product lot details' },
      { name: 'CHEFBYTE_get_cookable', description: 'List cookable recipes' },
    ],
  },
  {
    label: 'Obsidian',
    tools: [
      { name: 'OBSIDIAN_search_notes', description: 'Search vault notes' },
      { name: 'OBSIDIAN_create_note', description: 'Create a new note' },
      { name: 'OBSIDIAN_get_note', description: 'Read a note' },
      { name: 'OBSIDIAN_update_note', description: 'Update an existing note' },
    ],
  },
  {
    label: 'Todoist',
    tools: [
      { name: 'TODOIST_get_tasks', description: 'Get tasks from Todoist' },
      { name: 'TODOIST_create_task', description: 'Create a new task' },
      { name: 'TODOIST_complete_task', description: 'Mark task complete' },
      { name: 'TODOIST_get_projects', description: 'List Todoist projects' },
    ],
  },
  {
    label: 'Home Assistant',
    tools: [
      { name: 'HOMEASSISTANT_get_entity_state', description: 'Get entity state' },
      { name: 'HOMEASSISTANT_call_service', description: 'Call a HA service' },
      { name: 'HOMEASSISTANT_get_entities', description: 'List all entities' },
    ],
  },
];

/** Flat list of all tool names for iteration */
const ALL_TOOLS = TOOL_GROUPS.flatMap((g) => g.tools);

export function ToolsPage() {
  const { user } = useAuth();
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

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

  return (
    <HubLayout title="Tools">
      {loading ? (
        <IonSpinner />
      ) : (
        <div>
          {TOOL_GROUPS.map((group) => (
            <div key={group.label}>
              <IonItemDivider>
                <IonLabel>{group.label}</IonLabel>
              </IonItemDivider>
              {group.tools.map((tool) => (
                <IonItem key={tool.name}>
                  <IonLabel>
                    <h2>{tool.name}</h2>
                    <p>{tool.description}</p>
                  </IonLabel>
                  <IonToggle
                    checked={toggles[tool.name] ?? true}
                    onIonChange={(e) => handleToggle(tool.name, e.detail.checked)}
                    aria-label={`Toggle ${tool.name}`}
                  />
                </IonItem>
              ))}
            </div>
          ))}
        </div>
      )}
    </HubLayout>
  );
}
