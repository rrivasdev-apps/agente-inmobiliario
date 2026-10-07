-- Reproduce lo mínimo de Supabase para probar la migración en Postgres puro.
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated, service_role;
-- Supabase Vault: vista de secretos descifrados.
create schema vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
