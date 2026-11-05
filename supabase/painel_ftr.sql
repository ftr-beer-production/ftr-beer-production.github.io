-- =====================================================================
-- Painel FTR (Heineken) · Supabase · tabelas, índices, permissões e RLS
-- Execute TUDO de uma vez em: Supabase > SQL Editor > New query > Run.
-- É seguro executar mais de uma vez (idempotente).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------

-- Um registro por mês (período AAAA-MM). Guarda o JSON completo do mês, no
-- mesmo formato que o painel já usa no IndexedDB. É o HISTÓRICO MENSAL central.
create table if not exists public.painel_months (
  period_key   text primary key
               check (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  period_year  smallint not null,
  period_month smallint not null check (period_month between 1 and 12),
  file_name    text     not null check (char_length(file_name) between 1 and 255),
  checksum     text     not null check (char_length(checksum) between 1 and 64),
  data         jsonb    not null check (jsonb_typeof(data) = 'object'),
  summary      jsonb,
  revision     integer  not null default 1,
  published_at timestamptz not null default now()
);

-- Linha ÚNICA (id = 1) que aponta para a "última importação publicada",
-- isto é, a versão corrente que todos veem ao abrir o painel.
create table if not exists public.painel_current (
  id           smallint primary key default 1 check (id = 1),
  period_key   text not null
               references public.painel_months (period_key) on delete restrict,
  file_name    text not null,
  checksum     text not null,
  published_at timestamptz not null
);

-- Auditoria PRIVADA (quem publicou o quê e quando). Nunca é lida pelo público.
create table if not exists public.painel_publications (
  id           bigint generated always as identity primary key,
  period_key   text        not null,
  file_name    text        not null,
  checksum     text        not null,
  published_by text        not null,
  set_current  boolean     not null,
  replaced     boolean     not null,
  revision     integer     not null,
  published_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. ÍNDICES
-- (a chave primária de painel_months já indexa period_key)
-- ---------------------------------------------------------------------
create index if not exists painel_months_published_at_idx
  on public.painel_months (published_at desc);
create index if not exists painel_publications_period_idx
  on public.painel_publications (period_key, published_at desc);

-- ---------------------------------------------------------------------
-- 3. RLS (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.painel_months       enable row level security;
alter table public.painel_current      enable row level security;
alter table public.painel_publications enable row level security;

-- Leitura pública SOMENTE das duas tabelas usadas na visualização do painel.
drop policy if exists painel_months_public_read  on public.painel_months;
drop policy if exists painel_current_public_read on public.painel_current;

create policy painel_months_public_read
  on public.painel_months  for select to anon, authenticated using (true);
create policy painel_current_public_read
  on public.painel_current for select to anon, authenticated using (true);

-- NÃO existe nenhuma política de INSERT/UPDATE/DELETE para anon/authenticated:
-- com RLS ligado, isso bloqueia qualquer gravação direta pelo navegador.
-- painel_publications não tem política nenhuma: o público não lê nem grava.

-- ---------------------------------------------------------------------
-- 4. PERMISSÕES (segunda barreira, além do RLS)
-- ---------------------------------------------------------------------
revoke all on public.painel_months       from anon, authenticated;
revoke all on public.painel_current      from anon, authenticated;
revoke all on public.painel_publications from anon, authenticated;

grant select on public.painel_months  to anon, authenticated;
grant select on public.painel_current to anon, authenticated;
-- painel_publications: nenhuma permissão para anon/authenticated.

-- ---------------------------------------------------------------------
-- 5. PUBLICAÇÃO ATÔMICA (usada só pela função do Netlify, com a chave secreta)
--    Tudo acontece em UMA transação: ou grava mês + versão corrente +
--    auditoria, ou não grava nada. O lock serializa publicações simultâneas.
-- ---------------------------------------------------------------------
create or replace function public.painel_publish(
  p_period_key  text,
  p_file_name   text,
  p_checksum    text,
  p_data        jsonb,
  p_summary     jsonb,
  p_published_by text,
  p_set_current boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev     integer;
  v_rev      integer;
  v_at       timestamptz := now();
  v_year     smallint;
  v_month    smallint;
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
  if p_published_by is null or p_published_by = '' then
    raise exception 'publicador ausente' using errcode = '22023';
  end if;

  v_year  := substr(p_period_key, 1, 4)::smallint;
  v_month := substr(p_period_key, 6, 2)::smallint;

  -- Uma publicação por vez (liberado automaticamente no fim da transação).
  perform pg_advisory_xact_lock(hashtext('painel_publish'));

  select revision into v_prev from public.painel_months where period_key = p_period_key;
  v_rev := coalesce(v_prev, 0) + 1;

  insert into public.painel_months
    (period_key, period_year, period_month, file_name, checksum, data, summary, revision, published_at)
  values
    (p_period_key, v_year, v_month, p_file_name, p_checksum, p_data, p_summary, v_rev, v_at)
  on conflict (period_key) do update set
    file_name    = excluded.file_name,
    checksum     = excluded.checksum,
    data         = excluded.data,
    summary      = excluded.summary,
    revision     = excluded.revision,
    published_at = excluded.published_at;

  if coalesce(p_set_current, true) then
    insert into public.painel_current (id, period_key, file_name, checksum, published_at)
    values (1, p_period_key, p_file_name, p_checksum, v_at)
    on conflict (id) do update set
      period_key   = excluded.period_key,
      file_name    = excluded.file_name,
      checksum     = excluded.checksum,
      published_at = excluded.published_at;
  end if;

  insert into public.painel_publications
    (period_key, file_name, checksum, published_by, set_current, replaced, revision, published_at)
  values
    (p_period_key, p_file_name, p_checksum, p_published_by, coalesce(p_set_current, true), v_prev is not null, v_rev, v_at);

  return jsonb_build_object(
    'period_key',   p_period_key,
    'published_at', v_at,
    'revision',     v_rev,
    'replaced',     v_prev is not null,
    'current_set',  coalesce(p_set_current, true)
  );
end;
$$;

-- Somente o servidor (chave secreta = role service_role) pode executar.
revoke all on function public.painel_publish(text, text, text, jsonb, jsonb, text, boolean) from public;
revoke all on function public.painel_publish(text, text, text, jsonb, jsonb, text, boolean) from anon, authenticated;
grant execute on function public.painel_publish(text, text, text, jsonb, jsonb, text, boolean) to service_role;

-- Atualiza o cache de esquema da API REST.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 6. VERIFICAÇÃO (opcional): rode separado para conferir as políticas.
-- ---------------------------------------------------------------------
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public' and tablename like 'painel_%' order by 1, 2;
