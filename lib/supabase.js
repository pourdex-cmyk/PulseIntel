import { createClient } from '@supabase/supabase-js';

// Server-side client — uses service key, bypasses RLS when needed
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// Creates a user-scoped client from a JWT token
export function supabaseForUser(token) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false }
    }
  );
}
