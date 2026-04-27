import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env: any = {};
for (const l of readFileSync('/home/jeremy/luna-hub-lite/.env', 'utf-8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
async function main() {
  const { data } = await admin
    .schema('chefbyte')
    .from('live_shelf_devices')
    .select('device_id, user_id, device_name, is_active, last_heartbeat_ts, pending_review_count');
  console.log(JSON.stringify(data, null, 2));
}
main();
