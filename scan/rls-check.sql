-- Shepherd — Supabase RLS check
-- Can't be grepped (lives in the DB, not the repo). Run in the Supabase SQL editor.
-- Any row with rls_enabled = false is a PUBLIC table: anyone with the anon key
-- can read/write it. This is the scariest, highest-converting demo.

SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rls_enabled;   -- false rows first = wide open
