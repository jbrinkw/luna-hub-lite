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
      food_logs: {
        Row: {
          calories: number
          carbs: number
          created_at: string
          fat: number
          log_id: string
          logical_date: string
          meal_id: string | null
          product_id: string
          protein: number
          qty_consumed: number
          unit: string
          user_id: string
        }
        Insert: {
          calories: number
          carbs: number
          created_at?: string
          fat: number
          log_id?: string
          logical_date: string
          meal_id?: string | null
          product_id: string
          protein: number
          qty_consumed: number
          unit: string
          user_id: string
        }
        Update: {
          calories?: number
          carbs?: number
          created_at?: string
          fat?: number
          log_id?: string
          logical_date?: string
          meal_id?: string | null
          product_id?: string
          protein?: number
          qty_consumed?: number
          unit?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "food_logs_meal_id_fkey"
            columns: ["meal_id"]
            isOneToOne: false
            referencedRelation: "meal_plan_entries"
            referencedColumns: ["meal_id"]
          },
          {
            foreignKeyName: "food_logs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
        ]
      }
      liquidtrack_devices: {
        Row: {
          created_at: string
          device_id: string
          device_name: string
          import_key_hash: string
          is_active: boolean
          product_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id?: string
          device_name: string
          import_key_hash: string
          is_active?: boolean
          product_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          device_name?: string
          import_key_hash?: string
          is_active?: boolean
          product_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "liquidtrack_devices_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
        ]
      }
      liquidtrack_events: {
        Row: {
          calories: number | null
          carbs: number | null
          consumption: number
          created_at: string
          device_id: string
          event_id: string
          fat: number | null
          is_refill: boolean
          logical_date: string
          protein: number | null
          user_id: string
          weight_after: number
          weight_before: number
        }
        Insert: {
          calories?: number | null
          carbs?: number | null
          consumption: number
          created_at?: string
          device_id: string
          event_id?: string
          fat?: number | null
          is_refill?: boolean
          logical_date: string
          protein?: number | null
          user_id: string
          weight_after: number
          weight_before: number
        }
        Update: {
          calories?: number | null
          carbs?: number | null
          consumption?: number
          created_at?: string
          device_id?: string
          event_id?: string
          fat?: number | null
          is_refill?: boolean
          logical_date?: string
          protein?: number | null
          user_id?: string
          weight_after?: number
          weight_before?: number
        }
        Relationships: [
          {
            foreignKeyName: "liquidtrack_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "liquidtrack_devices"
            referencedColumns: ["device_id"]
          },
        ]
      }
      locations: {
        Row: {
          created_at: string
          location_id: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          location_id?: string
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          location_id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      meal_plan_entries: {
        Row: {
          completed_at: string | null
          created_at: string
          logical_date: string
          meal_id: string
          meal_prep: boolean
          product_id: string | null
          recipe_id: string | null
          servings: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          logical_date: string
          meal_id?: string
          meal_prep?: boolean
          product_id?: string | null
          recipe_id?: string | null
          servings?: number
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          logical_date?: string
          meal_id?: string
          meal_prep?: boolean
          product_id?: string | null
          recipe_id?: string | null
          servings?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_plan_entries_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "meal_plan_entries_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["recipe_id"]
          },
        ]
      }
      products: {
        Row: {
          barcode: string | null
          calories_per_serving: number
          carbs_per_serving: number
          created_at: string
          description: string | null
          fat_per_serving: number
          is_placeholder: boolean
          min_stock_amount: number
          name: string
          price: number | null
          product_id: string
          protein_per_serving: number
          servings_per_container: number
          user_id: string
          walmart_link: string | null
        }
        Insert: {
          barcode?: string | null
          calories_per_serving?: number
          carbs_per_serving?: number
          created_at?: string
          description?: string | null
          fat_per_serving?: number
          is_placeholder?: boolean
          min_stock_amount?: number
          name: string
          price?: number | null
          product_id?: string
          protein_per_serving?: number
          servings_per_container?: number
          user_id: string
          walmart_link?: string | null
        }
        Update: {
          barcode?: string | null
          calories_per_serving?: number
          carbs_per_serving?: number
          created_at?: string
          description?: string | null
          fat_per_serving?: number
          is_placeholder?: boolean
          min_stock_amount?: number
          name?: string
          price?: number | null
          product_id?: string
          protein_per_serving?: number
          servings_per_container?: number
          user_id?: string
          walmart_link?: string | null
        }
        Relationships: []
      }
      recipe_ingredients: {
        Row: {
          created_at: string
          ingredient_id: string
          note: string | null
          product_id: string
          quantity: number
          recipe_id: string
          unit: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ingredient_id?: string
          note?: string | null
          product_id: string
          quantity: number
          recipe_id: string
          unit: string
          user_id: string
        }
        Update: {
          created_at?: string
          ingredient_id?: string
          note?: string | null
          product_id?: string
          quantity?: number
          recipe_id?: string
          unit?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "recipe_ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["recipe_id"]
          },
        ]
      }
      recipes: {
        Row: {
          active_time: number | null
          base_servings: number
          created_at: string
          description: string | null
          name: string
          recipe_id: string
          total_time: number | null
          user_id: string
        }
        Insert: {
          active_time?: number | null
          base_servings?: number
          created_at?: string
          description?: string | null
          name: string
          recipe_id?: string
          total_time?: number | null
          user_id: string
        }
        Update: {
          active_time?: number | null
          base_servings?: number
          created_at?: string
          description?: string | null
          name?: string
          recipe_id?: string
          total_time?: number | null
          user_id?: string
        }
        Relationships: []
      }
      shopping_list: {
        Row: {
          cart_item_id: string
          created_at: string
          product_id: string
          purchased: boolean
          qty_containers: number
          user_id: string
        }
        Insert: {
          cart_item_id?: string
          created_at?: string
          product_id: string
          purchased?: boolean
          qty_containers: number
          user_id: string
        }
        Update: {
          cart_item_id?: string
          created_at?: string
          product_id?: string
          purchased?: boolean
          qty_containers?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
        ]
      }
      stock_lots: {
        Row: {
          created_at: string
          expires_on: string | null
          location_id: string
          lot_id: string
          product_id: string
          qty_containers: number
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_on?: string | null
          location_id: string
          lot_id?: string
          product_id: string
          qty_containers?: number
          user_id: string
        }
        Update: {
          created_at?: string
          expires_on?: string | null
          location_id?: string
          lot_id?: string
          product_id?: string
          qty_containers?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_lots_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "stock_lots_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
        ]
      }
      temp_items: {
        Row: {
          calories: number
          carbs: number
          created_at: string
          fat: number
          logical_date: string
          name: string
          protein: number
          temp_id: string
          user_id: string
        }
        Insert: {
          calories: number
          carbs: number
          created_at?: string
          fat: number
          logical_date: string
          name: string
          protein: number
          temp_id?: string
          user_id: string
        }
        Update: {
          calories?: number
          carbs?: number
          created_at?: string
          fat?: number
          logical_date?: string
          name?: string
          protein?: number
          temp_id?: string
          user_id?: string
        }
        Relationships: []
      }
      user_config: {
        Row: {
          config_id: string
          created_at: string
          key: string
          user_id: string
          value: string
        }
        Insert: {
          config_id?: string
          created_at?: string
          key: string
          user_id: string
          value: string
        }
        Update: {
          config_id?: string
          created_at?: string
          key?: string
          user_id?: string
          value?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      consume_product: {
        Args: {
          p_log_macros: boolean
          p_logical_date: string
          p_product_id: string
          p_qty: number
          p_unit: string
        }
        Returns: Json
      }
      get_daily_macros: { Args: { p_logical_date: string }; Returns: Json }
      mark_meal_done: { Args: { p_meal_id: string }; Returns: Json }
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
      complete_next_set: {
        Args: { p_load: number; p_plan_id: string; p_reps: number }
        Returns: {
          rest_seconds: number
        }[]
      }
      ensure_daily_plan: { Args: { p_day: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
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
  public: {
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
  graphql_public: {
    Enums: {},
  },
  hub: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

