# FTR Beer Production · Painel FTR

Painel FTR (First Time Right) da produção de cerveja, publicado pelo GitHub Pages em
**https://ftr-beer-production.github.io/**

## Estrutura

```
docs/index.html                       ← o painel (o GitHub Pages publica a pasta /docs do main)
supabase/functions/painel-publish/    ← Edge Function que publica os meses (Supabase)
supabase/painel_ftr.sql               ← tabelas, RLS e função SQL painel_publish (já aplicado)
supabase/painel_publicadores.sql      ← lista privada de quem pode publicar
```

## Como funciona

- **Consulta (sem login):** o painel lê `painel_current` e `painel_months` direto do Supabase
  com a chave pública; o RLS só permite leitura dessas duas tabelas.
- **Publicação (só autorizados):** o painel envia o mês para a Edge Function `painel-publish`,
  que confere o login, consulta a tabela privada `painel_publicadores`, valida os dados
  (checksum, abas, período, lotes) e grava tudo de uma vez pela função SQL `painel_publish`.
  A chave secreta nunca sai do Supabase.
- A Edge Function só aceita chamadas dos endereços autorizados no código dela
  (`DEFAULT_ORIGINS`).

## Atualizar

Cada mudança no `main` que toque a pasta `docs/` é publicada sozinha em 1 a 2 minutos.
Mudanças na Edge Function são implantadas no Supabase separadamente.

O painel guarda no navegador as importações feitas em cada endereço; os meses **publicados**
vêm sempre do Supabase.
