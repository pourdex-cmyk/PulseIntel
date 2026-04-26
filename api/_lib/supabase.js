// api/_lib/supabase.js
// Server-side client using SERVICE_KEY (bypasses RLS).
// Import createSupabaseClient from here — never instantiate Supabase inline in a route.

import { createClient } from '@supabase/supabase-js';

export function createSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}
