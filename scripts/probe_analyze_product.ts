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
  const barcode = process.argv[2] ?? '073731004197';
  const email = `e2e-probe-${Date.now()}@test.com`;
  const { data: u, error: ue } = await admin.auth.admin.createUser({
    email,
    password: 'testpass123',
    email_confirm: true,
  });
  if (ue || !u.user) throw new Error(`createUser: ${ue?.message}`);
  const userId = u.user.id;
  try {
    const user = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signIn } = await user.auth.signInWithPassword({ email, password: 'testpass123' });
    const token = signIn.session!.access_token;
    const resp = await fetch(`${env.SUPABASE_URL}/functions/v1/analyze-product`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ barcode }),
    });
    const body = await resp.json();
    console.log('status=', resp.status);
    console.log(JSON.stringify(body, null, 2));
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
