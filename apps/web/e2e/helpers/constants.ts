import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'http://127.0.0.1:54321';
export const SERVICE_ROLE_KEY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.fDBVbcn1yiwrN85kw3c70Yhm__37cMWWZPhf8cqMY5QJ46pzGo5MfHQ-jPzgXLKecXWTRrW261e0ALQQqx-rUw';
export const ANON_KEY =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjQ5MjY3MTcyNjEsImlhdCI6MTc3MzExNzI2MSwicm9sZSI6ImFub24ifQ.P9z45GEzGXk9RpkTeiFK1jgzU0N1T-w6rvXILbKT7BP4uNhe6hbyojDijLra28qrOc3GmcSDxmFFNPEZz6YU8w';

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
