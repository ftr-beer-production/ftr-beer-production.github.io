-- Emula os papéis do Supabase num PostgreSQL local (somente para testes isolados).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
-- No Supabase o service_role tem acesso total às tabelas do schema public.
alter default privileges in schema public grant all on tables to service_role;
