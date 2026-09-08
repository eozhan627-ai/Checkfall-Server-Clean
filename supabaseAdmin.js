import { createClient } from "@supabase/supabase-js";

// WICHTIG: Der SERVICE_ROLE_KEY ist ein Admin-Key und umgeht alle
// Row-Level-Security-Policies. Er gehört NUR auf den Server (.env),
// niemals in die App / niemals ins Git-Repo committen.
//
// In der .env des Servers:
// SUPABASE_URL=https://xxxx.supabase.co
// SUPABASE_SERVICE_ROLE_KEY=eyJ...

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
        "WARNUNG: SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt in der .env - Clan-Feature wird nicht funktionieren."
    );
}

export const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    }
);