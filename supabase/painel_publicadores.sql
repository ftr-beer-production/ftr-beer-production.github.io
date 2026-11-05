-- Lista PRIVADA de e-mails autorizados a publicar o Painel FTR.
-- Lida só pela Edge Function painel-publish (chave secreta). Sem políticas: o público não lê nem grava.
create table if not exists public.painel_publicadores (
  email      text primary key check (email = lower(email) and position('@' in email) > 1),
  criado_em  timestamptz not null default now()
);
alter table public.painel_publicadores enable row level security;
revoke all on public.painel_publicadores from anon, authenticated;

-- Para autorizar alguém (rode no SQL Editor, com o e-mail em minúsculas):
--   insert into public.painel_publicadores (email) values ('nome@empresa.com');
-- Para remover:
--   delete from public.painel_publicadores where email = 'nome@empresa.com';
