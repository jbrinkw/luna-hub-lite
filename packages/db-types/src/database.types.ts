export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  chefbyte: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  coachbyte: {
    Tables: {
      completed_sets: {
        Row: {
          actual_load: number
          actual_reps: number
          completed_at: string
          completed_set_id: string
          exercise_id: string
          logical_date: string | null
          plan_id: string
          planned_set_id: string | null
          user_id: string
        }
        Insert: {
          actual_load: number
          actual_reps: number
          completed_at?: string
          completed_set_id?: string
          exercise_id: string
          logical_date?: string | null
          plan_id: string
          planned_set_id?: string | null
          user_id: string
        }
        Update: {
          actual_load?: number
          actual_reps?: number
          completed_at?: string
          completed_set_id?: string
          exercise_id?: string
          logical_date?: string | null
          plan_id?: string
          planned_set_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "completed_sets_exercise_id_fkey"
            columns: ["exercise_id"]
            isOneToOne: false
            referencedRelation: "exercises"
            referencedColumns: ["exercise_id"]
          },
          {
            foreignKeyName: "completed_sets_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "daily_plans"
            referencedColumns: ["plan_id"]
          },
          {
            foreignKeyName: "completed_sets_planned_set_id_fkey"
            columns: ["planned_set_id"]
            isOneToOne: false
            referencedRelation: "planned_sets"
            referencedColumns: ["planned_set_id"]
          },
        ]
      }
      daily_plans: {
        Row: {
          created_at: string
          logical_date: string | null
          plan_date: string
          plan_id: string
          summary: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          logical_date?: string | null
          plan_date: string
          plan_id?: string
          summary?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          logical_date?: string | null
          plan_date?: string
          plan_id?: string
          summary?: string | null
          user_id?: string
        }
        Relationships: []
      }
      exercises: {
        Row: {
          created_at: string
          exercise_id: string
          name: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          exercise_id?: string
          name: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          exercise_id?: string
          name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      planned_sets: {
        Row: {
          exercise_id: string
          order: number
          plan_id: string
          planned_set_id: string
          rest_seconds: number | null
          target_load: number | null
          target_load_percentage: number | null
          target_reps: number | null
          user_id: string
        }
        Insert: {
          exercise_id: string
          order: number
          plan_id: string
          planned_set_id?: string
          rest_seconds?: number | null
          target_load?: number | null
          target_load_percentage?: number | null
          target_reps?: number | null
          user_id: string
        }
        Update: {
          exercise_id?: string
          order?: number
          plan_id?: string
          planned_set_id?: string
          rest_seconds?: number | null
          target_load?: number | null
          target_load_percentage?: number | null
          target_reps?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "planned_sets_exercise_id_fkey"
            columns: ["exercise_id"]
            isOneToOne: false
            referencedRelation: "exercises"
            referencedColumns: ["exercise_id"]
          },
          {
            foreignKeyName: "planned_sets_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "daily_plans"
            referencedColumns: ["plan_id"]
          },
        ]
      }
      splits: {
        Row: {
          split_id: string
          split_notes: string | null
          template_sets: Json | null
          user_id: string
          weekday: number
        }
        Insert: {
          split_id?: string
          split_notes?: string | null
          template_sets?: Json | null
          user_id: string
          weekday: number
        }
        Update: {
          split_id?: string
          split_notes?: string | null
          template_sets?: Json | null
          user_id?: string
          weekday?: number
        }
        Relationships: []
      }
      timers: {
        Row: {
          duration_seconds: number
          elapsed_before_pause: number
          end_time: string | null
          paused_at: string | null
          state: string
          timer_id: string
          user_id: string
        }
        Insert: {
          duration_seconds: number
          elapsed_before_pause?: number
          end_time?: string | null
          paused_at?: string | null
          state: string
          timer_id?: string
          user_id: string
        }
        Update: {
          duration_seconds?: number
          elapsed_before_pause?: number
          end_time?: string | null
          paused_at?: string | null
          state?: string
          timer_id?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          available_plates: Json
          bar_weight_lbs: number
          default_rest_seconds: number
          user_id: string
        }
        Insert: {
          available_plates?: Json
          bar_weight_lbs?: number
          default_rest_seconds?: number
          user_id: string
        }
        Update: {
          available_plates?: Json
          bar_weight_lbs?: number
          default_rest_seconds?: number
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  hub: {
    Tables: {
      api_keys: {
        Row: {
          api_key_hash: string
          created_at: string
          id: string
          label: string | null
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          api_key_hash: string
          created_at?: string
          id?: string
          label?: string | null
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          api_key_hash?: string
          created_at?: string
          id?: string
          label?: string | null
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      app_activations: {
        Row: {
          activated_at: string
          app_name: string
          user_id: string
        }
        Insert: {
          activated_at?: string
          app_name: string
          user_id: string
        }
        Update: {
          activated_at?: string
          app_name?: string
          user_id?: string
        }
        Relationships: []
      }
      extension_settings: {
        Row: {
          credentials_encrypted: string | null
          enabled: boolean
          extension_name: string
          id: string
          user_id: string
        }
        Insert: {
          credentials_encrypted?: string | null
          enabled?: boolean
          extension_name: string
          id?: string
          user_id: string
        }
        Update: {
          credentials_encrypted?: string | null
          enabled?: boolean
          extension_name?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          day_start_hour: number
          display_name: string | null
          timezone: string
          user_id: string
        }
        Insert: {
          created_at?: string
          day_start_hour?: number
          display_name?: string | null
          timezone?: string
          user_id: string
        }
        Update: {
          created_at?: string
          day_start_hour?: number
          display_name?: string | null
          timezone?: string
          user_id?: string
        }
        Relationships: []
      }
      user_tool_config: {
        Row: {
          enabled: boolean
          id: string
          tool_name: string
          user_id: string
        }
        Insert: {
          enabled?: boolean
          id?: string
          tool_name: string
          user_id: string
        }
        Update: {
          enabled?: boolean
          id?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_app: { Args: { p_app_name: string }; Returns: undefined }
      deactivate_app: { Args: { p_app_name: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  private: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_app: {
        Args: { p_app_name: string; p_user_id: string }
        Returns: undefined
      }
      deactivate_app: {
        Args: { p_app_name: string; p_user_id: string }
        Returns: undefined
      }
      get_logical_date: {
        Args: { day_start_hour: number; ts: string; tz: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  chefbyte: {
    Enums: {},
  },
  coachbyte: {
    Enums: {},
  },
  hub: {
    Enums: {},
  },
  private: {
    Enums: {},
  },
} as const

