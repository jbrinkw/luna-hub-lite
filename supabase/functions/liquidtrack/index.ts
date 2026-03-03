import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** SHA-256 hash using Web Crypto API, returns hex string */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    // API key auth (no JWT — verify_jwt = false in config.toml)
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return jsonResponse({ error: 'Missing API key' }, 401)
    }

    const keyHash = await sha256(apiKey)

    // Service role client — bypasses RLS for cross-user event insertion
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Look up device by hashed import key
    const { data: device, error: deviceError } = await supabase
      .schema('chefbyte')
      .from('liquidtrack_devices')
      .select('device_id, user_id, product_id')
      .eq('import_key_hash', keyHash)
      .eq('is_active', true)
      .single()

    if (deviceError || !device) {
      return jsonResponse({ error: 'Invalid API key' }, 401)
    }

    // Fetch linked product nutrition for macro calculation
    let nutrition: {
      calories_per_serving: number
      carbs_per_serving: number
      protein_per_serving: number
      fat_per_serving: number
    } | null = null

    if (device.product_id) {
      const { data: product } = await supabase
        .schema('chefbyte')
        .from('products')
        .select(
          'calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving',
        )
        .eq('product_id', device.product_id)
        .single()
      nutrition = product
    }

    // Compute logical date from user's profile (timezone + day_start_hour)
    // private.get_logical_date isn't exposed via PostgREST, so compute in TS
    const { data: profile } = await supabase
      .schema('hub')
      .from('profiles')
      .select('timezone, day_start_hour')
      .eq('user_id', device.user_id)
      .single()

    const tz = profile?.timezone || 'America/New_York'
    const dayStart = profile?.day_start_hour ?? 6
    const now = new Date()
    const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
    )
    const logicalDate = localHour < dayStart
      ? new Date(new Date(localDateStr).getTime() - 86400000).toISOString().slice(0, 10)
      : localDateStr

    // Parse events from body
    const { events } = await req.json()
    if (!events || !Array.isArray(events) || events.length === 0) {
      return jsonResponse({ error: 'events array required' }, 400)
    }

    // Build event rows with macro calculation
    const rows = events.map((evt: any) => {
      const consumption = Math.max(
        0,
        (evt.weight_before ?? 0) - (evt.weight_after ?? 0),
      )

      // Accept pre-calculated macros from ESP, or compute from linked product
      let calories = evt.calories ?? null
      let carbs = evt.carbs ?? null
      let protein = evt.protein ?? null
      let fat = evt.fat ?? null

      if (nutrition && calories === null) {
        // For liquids: nutrition is per serving, treat 100g/mL as one serving
        // factor = consumption_grams / 100
        const factor = consumption / 100
        calories = nutrition.calories_per_serving * factor
        carbs = nutrition.carbs_per_serving * factor
        protein = nutrition.protein_per_serving * factor
        fat = nutrition.fat_per_serving * factor
      }

      return {
        user_id: device.user_id,
        device_id: device.device_id,
        weight_before: evt.weight_before,
        weight_after: evt.weight_after,
        consumption,
        is_refill: evt.is_refill ?? false,
        calories,
        carbs,
        protein,
        fat,
        logical_date: logicalDate,
      }
    })

    // Insert events
    const { data: inserted, error: insertError } = await supabase
      .schema('chefbyte')
      .from('liquidtrack_events')
      .insert(rows)
      .select('event_id')

    if (insertError) {
      // Handle duplicate constraint (device_id, created_at) gracefully
      if (insertError.code === '23505') {
        return jsonResponse({
          success: true,
          message: 'Some events already recorded',
          count: 0,
        })
      }
      throw insertError
    }

    return jsonResponse({ success: true, count: inserted?.length ?? 0 })
  } catch (error: any) {
    console.error('liquidtrack error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
})
