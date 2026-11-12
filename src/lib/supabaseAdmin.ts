/**
 * @file supabaseAdmin.ts
 * @description Server-only Supabase client using the service-role key.
 * Accesses the persistent Voxtab database tables. Do not import into browser components.
 */

import 'server-only';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('Supabase server environment variables are missing');
}

export const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
