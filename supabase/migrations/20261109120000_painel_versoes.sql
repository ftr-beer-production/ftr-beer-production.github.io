-- =====================================================================
-- Painel FTR · Migration 20261109120000 · Histórico completo de versões publicadas
-- ---------------------------------------------------------------------
-- O QUE FAZ (somente alterações ADITIVAS; nada existente é removido):
--   1. painel_publications ganha as colunas "action" e "restored_from_revision".
--   2. Cria painel_month_versions: uma linha por versão publicada de cada mês,
--      com o JSON COMPLETO, arquivo, checksum, revisão, data, publicador e se
--      passou a ser a versão corrente. Tabela privada e somente-inclusão.
--   3. Copia para o histórico a versão hoje vigente de cada mês (action
--      'backfill'). Revisões já sobrescritas ANTES desta migration só têm
--      metadados em painel_publications e NÃO podem ser recuperadas.
--   4. Trigger em painel_publications: toda publicação (pela função antiga
--      painel_publish ou pelas novas) grava a versão completa automaticamente,
--      na MESMA transação. Se a cópia falhar, a publicação inteira é desfeita.
--   5. Bloqueia UPDATE/DELETE/TRUNCATE no histórico e na auditoria.
--   6. Novas funções (somente service_role):
--        painel_publish_v2      — publicação com detecção de conteúdo idêntico
--                                 e revisão esperada OBRIGATÓRIA (concorrência);
--        painel_restore_version — recupera uma versão antiga como NOVA revisão
--                                 (revisão esperada obrigatória; recusa conteúdo
--                                 idêntico por checksum OU por JSONB).
--   A v1 (painel_publish) continua existindo: é o caminho de COMPATIBILIDADE
--   usado pela Edge Function só para o painel antigo durante a transição.
--
-- O QUE NÃO FAZ: não altera painel_months, painel_current, painel_publish (v1),
-- painel_publicadores, nem nenhum objeto do CIP. Leitura pública inalterada.
--
-- ORDEM: aplicar esta migration ANTES de implantar a nova Edge Function.
-- (Sem ela, a nova Edge Function só atende o painel antigo, pelo caminho v1.)
-- ROLLBACK: supabase/rollback/20261109120000_painel_versoes_rollback.sql
-- (fora da pasta migrations para nunca ser aplicado por engano; não destrutivo).
-- Projeto Supabase COMPARTILHADO com o CIP: aplicar manualmente (SQL Editor ou
-- apply_migration) com esta mesma versão; não usar "supabase db push" deste
-- repositório, pois o histórico remoto contém migrations do CIP.
-- Idempotente: pode ser executada mais de uma vez.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Auditoria: tipo de operação (aditivo; linhas antigas = 'publish')
-- ---------------------------------------------------------------------
alter table public.painel_publications
  add column if not exists action text not null default 'publish';
alter table public.painel_publications
  add column if not exists restored_from_revision integer;
-- Por qual caminho a publicação foi gravada:
--   v1 = painel_publish (caminho de COMPATIBILIDADE do painel antigo; também todas as
--        publicações anteriores a esta migration, que só podiam ser feitas pela v1);
--   v2 = painel_publish_v2 / painel_restore_version (fluxo moderno, com revisão esperada).
alter table public.painel_publications
  add column if not exists via text not null default 'v1';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'painel_publications_via_chk') then
    alter table public.painel_publications
      add constraint painel_publications_via_chk check (via in ('v1', 'v2'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'painel_publications_action_chk') then
    alter table public.painel_publications
      add constraint painel_publications_action_chk check (action in ('publish', 'restore'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'painel_publications_restore_chk') then
    alter table public.painel_publications
      add constraint painel_publications_restore_chk
      check ((action = 'restore') = (restored_from_revision is not null));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Histórico completo de versões
-- ---------------------------------------------------------------------
create table if not exists public.painel_month_versions (
  id                     bigint generated always as identity primary key,
  period_key             text not null check (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  revision               integer not null check (revision >= 1),
  file_name              text not null check (char_length(file_name) between 1 and 255),
  checksum               text not null check (char_length(checksum) between 1 and 64),
  data                   jsonb not null check (jsonb_typeof(data) = 'object'),
  summary                jsonb,
  published_by           text not null,
  published_at           timestamptz not null,
  -- publish = publicação normal; restore = recuperação de versão antiga;
  -- backfill = versão vigente copiada quando esta migration foi aplicada
  action                 text not null check (action in ('publish', 'restore', 'backfill')),
  restored_from_revision integer,
  -- se esta publicação passou a ser a versão corrente (painel_current) no momento em que foi feita
  set_current            boolean not null,
  -- caminho da publicação (v1 = compatibilidade/painel antigo, v2 = fluxo moderno)
  via                    text not null default 'v1' check (via in ('v1', 'v2')),
  publication_id         bigint unique,
  created_at             timestamptz not null default now(),
  constraint painel_month_versions_period_rev_uq unique (period_key, revision),
  constraint painel_month_versions_restore_chk
    check ((action = 'restore') = (restored_from_revision is not null))
);
create index if not exists painel_month_versions_period_idx
  on public.painel_month_versions (period_key, revision desc);

-- Privada: sem política de RLS e sem permissão para anon/authenticated.
alter table public.painel_month_versions enable row level security;
revoke all on public.painel_month_versions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Backfill: versão vigente de cada mês (antes de ligar os gatilhos)
-- ---------------------------------------------------------------------
insert into public.painel_month_versions
  (period_key, revision, file_name, checksum, data, summary, published_by,
   published_at, action, restored_from_revision, set_current, publication_id, via)
select m.period_key, m.revision, m.file_name, m.checksum, m.data, m.summary,
       coalesce(p.published_by, 'desconhecido (anterior ao histórico de versões)'),
       m.published_at, 'backfill', null, coalesce(p.set_current, false), p.id, coalesce(p.via, 'v1')
  from public.painel_months m
  left join lateral (
        select x.id, x.published_by, x.set_current, x.via
          from public.painel_publications x
         where x.period_key = m.period_key and x.revision = m.revision
         order by x.id desc limit 1) p on true
on conflict (period_key, revision) do nothing;

-- ---------------------------------------------------------------------
-- 4. Captura automática da versão completa a cada publicação
-- ---------------------------------------------------------------------
create or replace function public.painel_capture_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_data    jsonb;
  v_summary jsonb;
begin
  select m.data, m.summary into v_data, v_summary
    from public.painel_months m
   where m.period_key = new.period_key
     and m.revision   = new.revision
     and m.checksum   = new.checksum;
  if not found then
    -- Nunca registrar auditoria sem a versão completa: aborta a transação inteira.
    raise exception 'versao_inconsistente: % r%', new.period_key, new.revision using errcode = 'P0001';
  end if;
  insert into public.painel_month_versions
    (period_key, revision, file_name, checksum, data, summary, published_by,
     published_at, action, restored_from_revision, set_current, publication_id, via)
  values
    (new.period_key, new.revision, new.file_name, new.checksum, v_data, v_summary, new.published_by,
     new.published_at, new.action, new.restored_from_revision, new.set_current, new.id, new.via);
  return new;
end;
$$;
revoke all on function public.painel_capture_version() from public, anon, authenticated;

drop trigger if exists painel_publications_capture_version on public.painel_publications;
create trigger painel_publications_capture_version
  after insert on public.painel_publications
  for each row execute function public.painel_capture_version();

-- ---------------------------------------------------------------------
-- 5. Histórico e auditoria são somente-inclusão
-- ---------------------------------------------------------------------
create or replace function public.painel_block_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'historico_somente_inclusao: % em % não é permitido', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;
revoke all on function public.painel_block_change() from public, anon, authenticated;

drop trigger if exists painel_month_versions_no_change   on public.painel_month_versions;
drop trigger if exists painel_month_versions_no_truncate on public.painel_month_versions;
drop trigger if exists painel_publications_no_change     on public.painel_publications;
drop trigger if exists painel_publications_no_truncate   on public.painel_publications;
create trigger painel_month_versions_no_change   before update or delete on public.painel_month_versions
  for each row execute function public.painel_block_change();
create trigger painel_month_versions_no_truncate before truncate on public.painel_month_versions
  for each statement execute function public.painel_block_change();
create trigger painel_publications_no_change     before update or delete on public.painel_publications
  for each row execute function public.painel_block_change();
create trigger painel_publications_no_truncate   before truncate on public.painel_publications
  for each statement execute function public.painel_block_change();

-- ---------------------------------------------------------------------
-- 6a. Publicação v2 (mesmas gravações da v1 + proteções)
--   Erros com SQLSTATE PTxxx viram o status HTTP xxx na API REST:
--     PT428 revisao_esperada_ausente — a revisão esperada é obrigatória
--     PT409 conteudo_identico  — o mês já está publicado com este mesmo conteúdo
--     PT409 revisao_alterada   — outra publicação aconteceu depois da conferência
-- ---------------------------------------------------------------------
create or replace function public.painel_publish_v2(
  p_period_key        text,
  p_file_name         text,
  p_checksum          text,
  p_data              jsonb,
  p_summary           jsonb,
  p_published_by      text,
  p_set_current       boolean default true,
  p_expected_revision integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev      integer;
  v_prev_ck   text;
  v_prev_data jsonb;
  v_rev       integer;
  v_at      timestamptz := now();
  v_set     boolean := coalesce(p_set_current, true);
begin
  if p_period_key is null or p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'periodo invalido: %', p_period_key using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'dados invalidos' using errcode = '22023';
  end if;
  if p_file_name is null or char_length(p_file_name) not between 1 and 255 then
    raise exception 'nome de arquivo invalido' using errcode = '22023';
  end if;
  if p_checksum is null or char_length(p_checksum) not between 1 and 64 then
    raise exception 'checksum invalido' using errcode = '22023';
  end if;
  if p_published_by is null or p_published_by = '' then
    raise exception 'publicador ausente' using errcode = '22023';
  end if;
  -- A v2 NUNCA publica sem conferir a revisão que o publicador viu (0 = mês novo).
  if p_expected_revision is null then
    raise exception 'revisao_esperada_ausente' using errcode = 'PT428';
  end if;
  if p_expected_revision < 0 then
    raise exception 'revisao esperada invalida' using errcode = '22023';
  end if;

  -- Mesmo bloqueio da v1: v1, v2 e recuperação nunca rodam ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext('painel_publish'));

  select revision, checksum, data into v_prev, v_prev_ck, v_prev_data
    from public.painel_months where period_key = p_period_key;

  if coalesce(v_prev, 0) <> p_expected_revision then
    raise exception 'revisao_alterada'
      using errcode = 'PT409',
            detail  = jsonb_build_object('expected', p_expected_revision, 'current', coalesce(v_prev, 0))::text;
  end if;
  -- idêntico pelo checksum OU pelo conteúdo (jsonb ignora a ordem das chaves)
  if v_prev is not null and (v_prev_ck = p_checksum or v_prev_data = p_data) then
    raise exception 'conteudo_identico'
      using errcode = 'PT409',
            detail  = jsonb_build_object('current', v_prev)::text;
  end if;

  v_rev := coalesce(v_prev, 0) + 1;

  insert into public.painel_months
    (period_key, period_year, period_month, file_name, checksum, data, summary, revision, published_at)
  values
    (p_period_key, substr(p_period_key, 1, 4)::smallint, substr(p_period_key, 6, 2)::smallint,
     p_file_name, p_checksum, p_data, p_summary, v_rev, v_at)
  on conflict (period_key) do update set
    file_name    = excluded.file_name,
    checksum     = excluded.checksum,
    data         = excluded.data,
    summary      = excluded.summary,
    revision     = excluded.revision,
    published_at = excluded.published_at;

  if v_set then
    insert into public.painel_current (id, period_key, file_name, checksum, published_at)
    values (1, p_period_key, p_file_name, p_checksum, v_at)
    on conflict (id) do update set
      period_key   = excluded.period_key,
      file_name    = excluded.file_name,
      checksum     = excluded.checksum,
      published_at = excluded.published_at;
  end if;

  -- O gatilho grava a versão completa em painel_month_versions.
  insert into public.painel_publications
    (period_key, file_name, checksum, published_by, set_current, replaced, revision, published_at, action, via)
  values
    (p_period_key, p_file_name, p_checksum, p_published_by, v_set, v_prev is not null, v_rev, v_at, 'publish', 'v2');

  return jsonb_build_object(
    'period_key',        p_period_key,
    'published_at',      v_at,
    'revision',          v_rev,
    'previous_revision', v_prev,
    'replaced',          v_prev is not null,
    'current_set',       v_set,
    'action',            'publish'
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 6b. Recuperação de versão: cria uma NOVA revisão com os dados da versão
--     escolhida. Nada é apagado; tudo em uma transação.
--     PT428 revisao_esperada_ausente (a revisão esperada é obrigatória)
--     PT404 mes_inexistente / versao_inexistente
--     PT409 conteudo_identico (a versão escolhida tem o mesmo checksum OU o
--                              mesmo conteúdo JSONB da versão vigente)
--     PT409 revisao_alterada  (outra publicação aconteceu depois da conferência)
-- ---------------------------------------------------------------------
create or replace function public.painel_restore_version(
  p_period_key        text,
  p_revision          integer,
  p_published_by      text,
  p_set_current       boolean default false,
  p_expected_revision integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month   public.painel_months%rowtype;
  v_ver     public.painel_month_versions%rowtype;
  v_rev     integer;
  v_at      timestamptz := now();
  v_set     boolean := coalesce(p_set_current, false);
begin
  if p_period_key is null or p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'periodo invalido: %', p_period_key using errcode = '22023';
  end if;
  if p_revision is null or p_revision < 1 then
    raise exception 'revisao invalida' using errcode = '22023';
  end if;
  if p_published_by is null or p_published_by = '' then
    raise exception 'publicador ausente' using errcode = '22023';
  end if;
  if p_expected_revision is null then
    raise exception 'revisao_esperada_ausente' using errcode = 'PT428';
  end if;

  perform pg_advisory_xact_lock(hashtext('painel_publish'));

  select * into v_month from public.painel_months where period_key = p_period_key;
  if not found then
    raise exception 'mes_inexistente' using errcode = 'PT404';
  end if;
  if v_month.revision <> p_expected_revision then
    raise exception 'revisao_alterada'
      using errcode = 'PT409',
            detail  = jsonb_build_object('expected', p_expected_revision, 'current', v_month.revision)::text;
  end if;

  select * into v_ver from public.painel_month_versions
   where period_key = p_period_key and revision = p_revision;
  if not found then
    raise exception 'versao_inexistente' using errcode = 'PT404';
  end if;
  -- Mesmo critério da publicação: checksum igual OU JSONB igual (o tipo jsonb
  -- normaliza a ordem das chaves, então ordem diferente não gera falsa diferença).
  if v_ver.checksum = v_month.checksum or v_ver.data = v_month.data then
    raise exception 'conteudo_identico'
      using errcode = 'PT409',
            detail  = jsonb_build_object('current', v_month.revision)::text;
  end if;

  v_rev := v_month.revision + 1;

  update public.painel_months set
    file_name    = v_ver.file_name,
    checksum     = v_ver.checksum,
    data         = v_ver.data,
    summary      = v_ver.summary,
    revision     = v_rev,
    published_at = v_at
  where period_key = p_period_key;

  if v_set then
    insert into public.painel_current (id, period_key, file_name, checksum, published_at)
    values (1, p_period_key, v_ver.file_name, v_ver.checksum, v_at)
    on conflict (id) do update set
      period_key   = excluded.period_key,
      file_name    = excluded.file_name,
      checksum     = excluded.checksum,
      published_at = excluded.published_at;
  elsif exists (select 1 from public.painel_current where id = 1 and period_key = p_period_key) then
    -- O mês recuperado já era o corrente: o ponteiro acompanha o conteúdo recuperado.
    update public.painel_current set
      file_name = v_ver.file_name, checksum = v_ver.checksum, published_at = v_at
    where id = 1;
    v_set := true;
  end if;

  insert into public.painel_publications
    (period_key, file_name, checksum, published_by, set_current, replaced, revision, published_at,
     action, restored_from_revision, via)
  values
    (p_period_key, v_ver.file_name, v_ver.checksum, p_published_by, v_set, true, v_rev, v_at,
     'restore', p_revision, 'v2');

  return jsonb_build_object(
    'period_key',             p_period_key,
    'published_at',           v_at,
    'revision',               v_rev,
    'previous_revision',      v_month.revision,
    'restored_from_revision', p_revision,
    'checksum',               v_ver.checksum,
    'file_name',              v_ver.file_name,
    'replaced',               true,
    'current_set',            v_set,
    'action',                 'restore'
  );
end;
$$;

-- Somente o servidor (chave secreta = service_role) executa as novas funções.
revoke all on function public.painel_publish_v2(text, text, text, jsonb, jsonb, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.painel_restore_version(text, integer, text, boolean, integer)               from public, anon, authenticated;
grant execute on function public.painel_publish_v2(text, text, text, jsonb, jsonb, text, boolean, integer) to service_role;
grant execute on function public.painel_restore_version(text, integer, text, boolean, integer)               to service_role;
grant select, insert on public.painel_month_versions to service_role;

commit;

notify pgrst, 'reload schema';

-- Verificação (opcional, rode separado):
-- select period_key, revision, action, set_current, published_at from public.painel_month_versions order by period_key, revision;
