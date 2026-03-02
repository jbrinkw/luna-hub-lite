import { IonItem, IonLabel, IonToggle, IonSpinner } from '@ionic/react';

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
      {loading && <IonSpinner />}
      {tools.map((tool) => (
        <IonItem key={tool.tool_name}>
          <IonLabel>
            <h2>{tool.tool_name}</h2>
            <p>{tool.description}</p>
          </IonLabel>
          <IonToggle
            checked={tool.enabled}
            onIonChange={(e) => onToggle(tool.tool_name, e.detail.checked)}
            aria-label={`Toggle ${tool.tool_name}`}
          />
        </IonItem>
      ))}
      {!loading && tools.length === 0 && (
        <IonItem>
          <IonLabel color="medium">No tools configured. Activate an app first.</IonLabel>
        </IonItem>
      )}
    </div>
  );
}
