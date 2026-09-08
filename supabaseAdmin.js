import { createClient } from "@supabase/supabase-js";
import ws from "ws";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
        "WARNUNG: SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt in der .env - Clan-Feature wird nicht funktionieren."
    );
}

export const supabaseAdmin =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
              auth: {
                  persistSession: false,
                  autoRefreshToken: false,
              },
              realtime: {
                  transport: ws,
              },
          })
        : null;