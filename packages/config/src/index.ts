export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    supabaseUrl: overrides.supabaseUrl ?? '',
    supabaseAnonKey: overrides.supabaseAnonKey ?? '',
  };
}
