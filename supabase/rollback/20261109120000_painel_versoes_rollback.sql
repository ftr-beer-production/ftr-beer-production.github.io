-- =====================================================================
-- Painel FTR · ROLLBACK da Migration 20261109120000 (histórico de versões)
-- Fica FORA de supabase/migrations de propósito: nunca deve ser aplicado por
-- "db push". Executar manualmente, só com autorização.
-- ---------------------------------------------------------------------
-- Volta o esquema ao estado anterior SEM perder dados:
--   * o histórico capturado (painel_month_versions) NÃO é apagado: a tabela é
--     renomeada para painel_month_versions_rollback_AAAAMMDDHH24MISS e
--     continua privada (RLS ligado, sem permissões para anon/authenticated;
--     service_role passa a ter só leitura: o arquivo não pode ser alterado pela API);
--   * remove gatilhos e as funções novas;
--   * remove as colunas action/restored_from_revision/via de painel_publications
--     (a informação continua na tabela renomeada).
--
-- ROLLBACK NÃO APAGA o histórico novo: desativa as funcionalidades novas e
-- arquiva os dados. Reaplicar a migration depois cria um histórico novo (só com
-- a versão vigente de cada mês); o arquivo pode ser consultado ou reincorporado
-- manualmente (ver documentacao/MELHORIAS.md).
-- ANTES de executar: volte a Edge Function e o painel para a versão do main.
-- (A Edge nova, sem a migration, só atende o painel antigo pelo caminho v1.)
-- painel_months, painel_current, painel_publish (v1) e painel_publicadores
-- não são tocados. Nenhum objeto do CIP é tocado.
-- =====================================================================
begin;

drop trigger if exists painel_publications_capture_version on public.painel_publications;
drop trigger if exists painel_publications_no_change       on public.painel_publications;
drop trigger if exists painel_publications_no_truncate     on public.painel_publications;

do $$
declare
  v_sfx  text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  v_name text := 'painel_month_versions_rollback_' || v_sfx;
  v_seq  text;
  r      record;
begin
  if to_regclass('public.painel_month_versions') is not null then
    execute 'drop trigger if exists painel_month_versions_no_change on public.painel_month_versions';
    execute 'drop trigger if exists painel_month_versions_no_truncate on public.painel_month_versions';
    -- índices (e as restrições unique/pkey ligadas a eles) e a sequência também
    -- são renomeados, para que a migration possa ser reaplicada sem conflito de nomes
    for r in select ic.relname from pg_index i join pg_class ic on ic.oid = i.indexrelid
              where i.indrelid = 'public.painel_month_versions'::regclass loop
      execute format('alter index public.%I rename to %I', r.relname, left(r.relname, 40) || '_rb_' || v_sfx);
    end loop;
    v_seq := pg_get_serial_sequence('public.painel_month_versions', 'id');
    if v_seq is not null then
      execute format('alter sequence %s rename to %I', v_seq, 'painel_month_versions_id_seq_rb_' || v_sfx);
    end if;
    execute format('alter table public.painel_month_versions rename to %I', v_name);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_name);
    execute format('grant select on public.%I to service_role', v_name);
    raise notice 'histórico preservado em public.%', v_name;
  end if;
end $$;

drop function if exists public.painel_restore_version(text, integer, text, boolean, integer);
drop function if exists public.painel_publish_v2(text, text, text, jsonb, jsonb, text, boolean, integer);
drop function if exists public.painel_capture_version();
drop function if exists public.painel_block_change();

alter table public.painel_publications drop constraint if exists painel_publications_restore_chk;
alter table public.painel_publications drop constraint if exists painel_publications_action_chk;
alter table public.painel_publications drop constraint if exists painel_publications_via_chk;
alter table public.painel_publications drop column if exists via;
alter table public.painel_publications drop column if exists restored_from_revision;
alter table public.painel_publications drop column if exists action;

commit;

notify pgrst, 'reload schema';
