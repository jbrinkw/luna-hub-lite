export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
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
      live_shelf_devices: {
        Row: {
          created_at: string
          device_id: string
          device_name: string
          import_key_hash: string
          is_active: boolean
          lan_ip: string | null
          last_heartbeat_ts: string | null
          outbox_pending_count: number
          outbox_permanent_failures: number
          pending_review_count: number
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id?: string
          device_name: string
          import_key_hash: string
          is_active?: boolean
          lan_ip?: string | null
          last_heartbeat_ts?: string | null
          outbox_pending_count?: number
          outbox_permanent_failures?: number
          pending_review_count?: number
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          device_name?: string
          import_key_hash?: string
          is_active?: boolean
          lan_ip?: string | null
          last_heartbeat_ts?: string | null
          outbox_pending_count?: number
          outbox_permanent_failures?: number
          pending_review_count?: number
          user_id?: string
        }
        Relationships: []
      }
      livetrack_import_sessions: {
        Row: {
          ai_tare_confidence: string | null
          ai_tare_g: number | null
          ai_tare_product_form: Json | null
          ai_tare_reasoning: string | null
          created_at: string
          current_barcode: string | null
          current_product_id: string | null
          device_id: string
          expires_at: string
          last_error: string | null
          scale_reading_g: number | null
          scale_reading_ts: string | null
          session_id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_tare_confidence?: string | null
          ai_tare_g?: number | null
          ai_tare_product_form?: Json | null
          ai_tare_reasoning?: string | null
          created_at?: string
          current_barcode?: string | null
          current_product_id?: string | null
          device_id: string
          expires_at?: string
          last_error?: string | null
          scale_reading_g?: number | null
          scale_reading_ts?: string | null
          session_id?: string
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_tare_confidence?: string | null
          ai_tare_g?: number | null
          ai_tare_product_form?: Json | null
          ai_tare_reasoning?: string | null
          created_at?: string
          current_barcode?: string | null
          current_product_id?: string | null
          device_id?: string
          expires_at?: string
          last_error?: string | null
          scale_reading_g?: number | null
          scale_reading_ts?: string | null
          session_id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "livetrack_import_sessions_current_product_id_fkey"
            columns: ["current_product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "livetrack_import_sessions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "live_shelf_devices"
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
          meal_type: string | null
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
          meal_type?: string | null
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
          meal_type?: string | null
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
          brand: string | null
          calories_per_serving: number
          carbs_per_serving: number
          certified: boolean | null
          container_type: string | null
          created_at: string
          default_shelf_life_days: number | null
          density_g_per_ml: number | null
          description: string | null
          fat_per_serving: number
          gross_weight_g: number | null
          is_placeholder: boolean
          min_stock_amount: number
          name: string
          net_weight_g: number | null
          price: number | null
          product_id: string
          protein_per_serving: number
          serving_weight_g: number | null
          servings_per_container: number
          tare_weight_g: number | null
          unit_type: string | null
          user_id: string
          variant: string | null
          walmart_link: string | null
        }
        Insert: {
          barcode?: string | null
          brand?: string | null
          calories_per_serving?: number
          carbs_per_serving?: number
          certified?: boolean | null
          container_type?: string | null
          created_at?: string
          default_shelf_life_days?: number | null
          density_g_per_ml?: number | null
          description?: string | null
          fat_per_serving?: number
          gross_weight_g?: number | null
          is_placeholder?: boolean
          min_stock_amount?: number
          name: string
          net_weight_g?: number | null
          price?: number | null
          product_id?: string
          protein_per_serving?: number
          serving_weight_g?: number | null
          servings_per_container?: number
          tare_weight_g?: number | null
          unit_type?: string | null
          user_id: string
          variant?: string | null
          walmart_link?: string | null
        }
        Update: {
          barcode?: string | null
          brand?: string | null
          calories_per_serving?: number
          carbs_per_serving?: number
          certified?: boolean | null
          container_type?: string | null
          created_at?: string
          default_shelf_life_days?: number | null
          density_g_per_ml?: number | null
          description?: string | null
          fat_per_serving?: number
          gross_weight_g?: number | null
          is_placeholder?: boolean
          min_stock_amount?: number
          name?: string
          net_weight_g?: number | null
          price?: number | null
          product_id?: string
          protein_per_serving?: number
          serving_weight_g?: number | null
          servings_per_container?: number
          tare_weight_g?: number | null
          unit_type?: string | null
          user_id?: string
          variant?: string | null
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
          instructions: string | null
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
          instructions?: string | null
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
          instructions?: string | null
          name?: string
          recipe_id?: string
          total_time?: number | null
          user_id?: string
        }
        Relationships: []
      }
      scale_pairings: {
        Row: {
          device_id: string
          first_seen_at: string
          kind: string
          last_heartbeat_ts: string | null
          pairing_id: string
          product_id: string | null
          scale_id: string
          user_id: string
        }
        Insert: {
          device_id: string
          first_seen_at?: string
          kind: string
          last_heartbeat_ts?: string | null
          pairing_id?: string
          product_id?: string | null
          scale_id: string
          user_id: string
        }
        Update: {
          device_id?: string
          first_seen_at?: string
          kind?: string
          last_heartbeat_ts?: string | null
          pairing_id?: string
          product_id?: string | null
          scale_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scale_pairings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "live_shelf_devices"
            referencedColumns: ["device_id"]
          },
          {
            foreignKeyName: "scale_pairings_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["product_id"]
          },
        ]
      }
      shelf_event_log: {
        Row: {
          applied: boolean
          client_event_id: string
          created_at: string
          device_id: string
          event_id: string
          payload: Json
          reason: string | null
          resolved_lot_id: string | null
          user_id: string
        }
        Insert: {
          applied: boolean
          client_event_id: string
          created_at?: string
          device_id: string
          event_id?: string
          payload: Json
          reason?: string | null
          resolved_lot_id?: string | null
          user_id: string
        }
        Update: {
          applied?: boolean
          client_event_id?: string
          created_at?: string
          device_id?: string
          event_id?: string
          payload?: Json
          reason?: string | null
          resolved_lot_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shelf_event_log_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "live_shelf_devices"
            referencedColumns: ["device_id"]
          },
        ]
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
          last_update_source: string | null
          last_update_ts: string | null
          location_id: string
          lot_id: string
          product_id: string
          qty_containers: number
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_on?: string | null
          last_update_source?: string | null
          last_update_ts?: string | null
          location_id: string
          lot_id?: string
          product_id: string
          qty_containers?: number
          user_id: string
        }
        Update: {
          created_at?: string
          expires_on?: string | null
          last_update_source?: string | null
          last_update_ts?: string | null
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
      apply_shelf_event_admin: {
        Args: {
          p_client_event_id: string
          p_delta_g: number
          p_device_id: string
          p_event_kind: string
          p_kind: string
          p_occurred_at: string
          p_product_id: string
          p_scale_id: string
          p_user_id: string
        }
        Returns: Database["chefbyte"]["CompositeTypes"]["shelf_event_result"]
        SetofOptions: {
          from: "*"
          to: "shelf_event_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
      consume_product_admin: {
        Args: {
          p_log_macros: boolean
          p_logical_date: string
          p_product_id: string
          p_qty: number
          p_unit: string
          p_user_id: string
        }
        Returns: Json
      }
      get_daily_macros: { Args: { p_logical_date: string }; Returns: Json }
      get_daily_macros_admin: {
        Args: { p_logical_date: string; p_user_id: string }
        Returns: Json
      }
      heartbeat_upsert_pairings_admin: {
        Args: { p_device_id: string; p_scales: Json; p_user_id: string }
        Returns: undefined
      }
      mark_meal_done: { Args: { p_meal_id: string }; Returns: Json }
      mark_meal_done_admin: {
        Args: { p_meal_id: string; p_user_id: string }
        Returns: Json
      }
      save_recipe_ingredients: {
        Args: { p_ingredients: Json; p_recipe_id: string }
        Returns: undefined
      }
      unmark_meal_done: { Args: { p_meal_id: string }; Returns: Json }
      unmark_meal_done_admin: {
        Args: { p_meal_id: string; p_user_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      shelf_event_result: {
        resolved_lot_id: string | null
        applied: boolean | null
        reason: string | null
      }
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
          notes: string | null
          plan_date: string
          plan_id: string
          summary: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          logical_date?: string | null
          notes?: string | null
          plan_date: string
          plan_id?: string
          summary?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          logical_date?: string | null
          notes?: string | null
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
          pr_tracked_exercise_ids: Json | null
          user_id: string
        }
        Insert: {
          available_plates?: Json
          bar_weight_lbs?: number
          default_rest_seconds?: number
          pr_tracked_exercise_ids?: Json | null
          user_id: string
        }
        Update: {
          available_plates?: Json
          bar_weight_lbs?: number
          default_rest_seconds?: number
          pr_tracked_exercise_ids?: Json | null
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
      complete_next_set_admin: {
        Args: {
          p_actual_load: number
          p_actual_reps: number
          p_plan_id: string
          p_user_id: string
        }
        Returns: {
          rest_seconds: number
        }[]
      }
      ensure_daily_plan: { Args: { p_day: string }; Returns: Json }
      ensure_daily_plan_admin: {
        Args: { p_day: string; p_user_id: string }
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
      agent_settings: {
        Row: {
          anthropic_key_encrypted: string | null
          created_at: string
          system_prompt: string | null
          updated_at: string
          user_id: string
          voice_ack_delay_ms: number
          voice_ack_enabled: boolean
          voice_ack_text: string
        }
        Insert: {
          anthropic_key_encrypted?: string | null
          created_at?: string
          system_prompt?: string | null
          updated_at?: string
          user_id: string
          voice_ack_delay_ms?: number
          voice_ack_enabled?: boolean
          voice_ack_text?: string
        }
        Update: {
          anthropic_key_encrypted?: string | null
          created_at?: string
          system_prompt?: string | null
          updated_at?: string
          user_id?: string
          voice_ack_delay_ms?: number
          voice_ack_enabled?: boolean
          voice_ack_text?: string
        }
        Relationships: []
      }
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
          activation_id: string
          app_name: string
          user_id: string
        }
        Insert: {
          activated_at?: string
          activation_id?: string
          app_name: string
          user_id: string
        }
        Update: {
          activated_at?: string
          activation_id?: string
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
      mcp_tool_logs: {
        Row: {
          created_at: string
          duration_ms: number
          error_message: string | null
          id: number
          status: string
          tool_args: Json
          tool_name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          duration_ms: number
          error_message?: string | null
          id?: number
          status: string
          tool_args?: Json
          tool_name: string
          user_id: string
        }
        Update: {
          created_at?: string
          duration_ms?: number
          error_message?: string | null
          id?: number
          status?: string
          tool_args?: Json
          tool_name?: string
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
      clear_agent_anthropic_key: { Args: never; Returns: undefined }
      deactivate_app: { Args: { p_app_name: string }; Returns: undefined }
      get_agent_anthropic_key_admin: {
        Args: { p_user_id: string }
        Returns: string
      }
      get_agent_settings: {
        Args: never
        Returns: {
          has_key: boolean
          system_prompt: string
          voice_ack_delay_ms: number
          voice_ack_enabled: boolean
          voice_ack_text: string
        }[]
      }
      get_agent_system_prompt_admin: {
        Args: { p_user_id: string }
        Returns: string
      }
      get_agent_voice_ack_admin: {
        Args: { p_user_id: string }
        Returns: {
          voice_ack_delay_ms: number
          voice_ack_enabled: boolean
          voice_ack_text: string
        }[]
      }
      get_extension_credentials: {
        Args: { p_extension_name: string }
        Returns: string
      }
      get_extension_credentials_admin: {
        Args: { p_extension_name: string; p_user_id: string }
        Returns: string
      }
      reset_demo_dates: { Args: never; Returns: undefined }
      save_agent_anthropic_key: { Args: { p_key: string }; Returns: undefined }
      save_agent_system_prompt: {
        Args: { p_prompt: string }
        Returns: undefined
      }
      save_agent_voice_ack: {
        Args: { p_delay_ms: number; p_enabled: boolean; p_text: string }
        Returns: undefined
      }
      save_extension_credentials: {
        Args: { p_credentials_json: string; p_extension_name: string }
        Returns: undefined
      }
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
      apply_shelf_event: {
        Args: {
          p_client_event_id: string
          p_delta_g: number
          p_device_id: string
          p_event_kind: string
          p_kind: string
          p_occurred_at: string
          p_product_id: string
          p_scale_id: string
          p_user_id: string
        }
        Returns: Database["chefbyte"]["CompositeTypes"]["shelf_event_result"]
        SetofOptions: {
          from: "*"
          to: "shelf_event_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_next_set: {
        Args: {
          p_actual_load: number
          p_actual_reps: number
          p_plan_id: string
          p_user_id: string
        }
        Returns: {
          rest_seconds: number
        }[]
      }
      consume_product: {
        Args: {
          p_log_macros: boolean
          p_logical_date: string
          p_product_id: string
          p_qty: number
          p_unit: string
          p_user_id: string
        }
        Returns: Json
      }
      deactivate_app: {
        Args: { p_app_name: string; p_user_id: string }
        Returns: undefined
      }
      ensure_daily_plan: {
        Args: { p_day: string; p_user_id: string }
        Returns: Json
      }
      get_daily_macros: {
        Args: { p_logical_date: string; p_user_id: string }
        Returns: Json
      }
      get_extension_credentials: {
        Args: { p_extension_name: string; p_user_id: string }
        Returns: string
      }
      get_logical_date: {
        Args: { day_start_hour: number; ts: string; tz: string }
        Returns: string
      }
      mark_meal_done: {
        Args: { p_meal_id: string; p_user_id: string }
        Returns: Json
      }
      reset_demo_dates: { Args: never; Returns: undefined }
      save_extension_credentials: {
        Args: {
          p_credentials_json: string
          p_extension_name: string
          p_user_id: string
        }
        Returns: undefined
      }
      save_recipe_ingredients: {
        Args: { p_ingredients: Json; p_recipe_id: string; p_user_id: string }
        Returns: undefined
      }
      unmark_meal_done: {
        Args: { p_meal_id: string; p_user_id: string }
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
