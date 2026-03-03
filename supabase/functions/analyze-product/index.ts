import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const DAILY_QUOTA = 100

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Check and increment daily quota. Returns true if under limit. */
async function checkQuota(
  supabase: any,
  userId: string,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  const key = 'analyze_quota'

  const { data: config } = await supabase
    .schema('chefbyte')
    .from('user_config')
    .select('value')
    .eq('user_id', userId)
    .eq('key', key)
    .single()

  let count = 0
  if (config?.value) {
    try {
      const parsed = JSON.parse(config.value)
      if (parsed.date === today) {
        count = parsed.count ?? 0
      }
    } catch {
      /* reset on parse error */
    }
  }

  if (count >= DAILY_QUOTA) return false

  // Upsert incremented counter
  const newValue = JSON.stringify({ date: today, count: count + 1 })
  await supabase
    .schema('chefbyte')
    .from('user_config')
    .upsert(
      { user_id: userId, key, value: newValue },
      { onConflict: 'user_id,key' },
    )

  return true
}

/** Fetch product data from OpenFoodFacts */
async function fetchOpenFoodFacts(barcode: string) {
  const resp = await fetch(
    `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`,
    { headers: { 'User-Agent': 'LunaHub/1.0 (contact@lunahub.dev)' } },
  )
  if (!resp.ok) return null
  const json = await resp.json()
  if (json.status !== 1 || !json.product) return null
  return json.product
}

/** Call Claude Haiku 4.5 to normalize OFF product data */
async function normalizeWithAI(offProduct: any): Promise<any> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured — returning raw OFF data')
    return null
  }

  const anthropic = new Anthropic({ apiKey })

  const brand = (offProduct.brands || '').toString().trim()
  const food = (offProduct.product_name || offProduct.generic_name || '')
    .toString()
    .trim()
  const proposed =
    brand && food ? `${brand} ${food}` : food || brand || 'Unknown Product'

  const systemPrompt = [
    'You normalize Open Food Facts product data into a structured JSON format.',
    'Return STRICT JSON only, no markdown, no explanation:',
    '{',
    '  "name": "<final product name>",',
    '  "servings_per_container": <number, default 1>,',
    '  "calories_per_serving": <number>,',
    '  "carbs_per_serving": <number>,',
    '  "protein_per_serving": <number>,',
    '  "fat_per_serving": <number>,',
    '  "description": "<brief 1-line description>"',
    '}',
    '',
    'Rules:',
    `- Base name: "${proposed}". Fix formatting (spacing, casing, punctuation) only.`,
    '- Nutrition must be PER SERVING. If OFF data only has per-100g, calculate using serving_size.',
    '- If serving info missing, treat 100g as one serving.',
    '- Apply 4-4-9 validation: carbs×4 + protein×4 + fat×9 should ≈ calories. If >10% off, adjust calories to match.',
    '- servings_per_container: product_quantity / serving_size, or 1 if unknown.',
    '- All numeric values rounded to 1 decimal.',
  ].join('\n')

  const userPrompt =
    'Normalize this Open Food Facts product:\n' +
    JSON.stringify({
      product_name: offProduct.product_name,
      generic_name: offProduct.generic_name,
      brands: offProduct.brands,
      categories: offProduct.categories,
      serving_size: offProduct.serving_size,
      serving_quantity: offProduct.serving_quantity,
      product_quantity: offProduct.product_quantity,
      nutriments: offProduct.nutriments,
    })

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text =
    message.content[0]?.type === 'text' ? message.content[0].text : ''
  try {
    return JSON.parse(text)
  } catch {
    console.error('Failed to parse AI response:', text)
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    // JWT auth
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing authorization header' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ error: 'Invalid token' }, 401)
    }

    // Parse body
    const { barcode } = await req.json()
    if (!barcode) {
      return jsonResponse({ error: 'Barcode is required' }, 400)
    }

    // Check if product already exists for this user
    const { data: existing } = await supabase
      .schema('chefbyte')
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('barcode', String(barcode))
      .single()

    if (existing) {
      return jsonResponse({ source: 'existing', product: existing })
    }

    // Check daily quota (100/user/day)
    const withinQuota = await checkQuota(supabase, user.id)
    if (!withinQuota) {
      return jsonResponse(
        { error: 'Limit reached — enter product manually' },
        429,
      )
    }

    // Fetch from OpenFoodFacts
    const offProduct = await fetchOpenFoodFacts(String(barcode))
    if (!offProduct) {
      return jsonResponse(
        { error: 'Product not found in OpenFoodFacts' },
        404,
      )
    }

    // Normalize with Claude Haiku 4.5
    const suggestion = await normalizeWithAI(offProduct)

    return jsonResponse({
      source: 'ai',
      suggestion,
      off: {
        product_name: offProduct.product_name,
        brands: offProduct.brands,
        image_url: offProduct.image_url,
        categories: offProduct.categories,
      },
    })
  } catch (error: any) {
    console.error('analyze-product error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
})
