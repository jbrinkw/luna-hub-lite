import { useEffect, useState } from 'react';
import { IonSpinner } from '@ionic/react';
import { HubLayout } from '@/components/hub/HubLayout';
import { ToolToggle } from '@/components/hub/ToolToggle';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

// Default tool definitions (will be populated from activated apps)
const TOOL_DEFINITIONS: Record<string, { description: string }> = {
  COACHBYTE_LOG_SET: { description: 'Log a completed set' },
  COACHBYTE_GET_PLAN: { description: 'Get today\'s workout plan' },
  COACHBYTE_GET_HISTORY: { description: 'View workout history' },
  COACHBYTE_GET_PRS: { description: 'View personal records' },
  CHEFBYTE_SCAN_BARCODE: { description: 'Scan a product barcode' },
  CHEFBYTE_GET_INVENTORY: { description: 'View current inventory' },
  CHEFBYTE_LOG_MEAL: { description: 'Log a meal or food item' },
  CHEFBYTE_GET_MACROS: { description: 'View daily macro totals' },
  CHEFBYTE_GET_RECIPES: { description: 'Browse recipes' },
  CHEFBYTE_GET_SHOPPING: { description: 'View shopping list' },
};

interface ToolConfig {
  tool_name: string;
  description: string;
  enabled: boolean;
}

export function ToolsPage() {
  const { user } = useAuth();
  const [tools, setTools] = useState<ToolConfig[]>([]);
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

      const toolList = Object.entries(TOOL_DEFINITIONS).map(([name, def]) => ({
        tool_name: name,
        description: def.description,
        enabled: configMap.get(name) ?? true,
      }));

      setTools(toolList);
      setLoading(false);
    };

    loadTools();
  }, [user]);

  const handleToggle = async (toolName: string, enabled: boolean) => {
    if (!user) return;
    setTools((prev) => prev.map((t) => t.tool_name === toolName ? { ...t, enabled } : t));

    await supabase
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: user.id, tool_name: toolName, enabled },
        { onConflict: 'user_id,tool_name' },
      );
  };

  return (
    <HubLayout title="Tools">
      {loading ? <IonSpinner /> : <ToolToggle tools={tools} onToggle={handleToggle} />}
    </HubLayout>
  );
}
