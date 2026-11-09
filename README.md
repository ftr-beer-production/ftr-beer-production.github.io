# FTR Beer Production · Painel FTR

Painel FTR (First Time Right) da produção de cerveja, publicado pelo GitHub Pages em
**https://ftr-beer-production.github.io/**

## Estrutura

```
docs/index.html                       ← o painel (o GitHub Pages publica a pasta /docs do main)
supabase/functions/painel-publish/    ← Edge Function que publica os meses (Supabase)
supabase/painel_ftr.sql               ← tabelas, RLS e função SQL painel_publish (já aplicado)
supabase/painel_publicadores.sql      ← lista privada de quem pode publicar
supabase/migrations/                  ← migration do histórico de versões (aplicação manual: projeto compartilhado com o CIP)
supabase/rollback/                    ← rollback não destrutivo (fora de migrations/ de propósito)
tests/                                ← testes (banco temporário, Edge, painel e ponta a ponta)
documentacao/                         ← documentação das melhorias e auditoria (não é publicada)
```

Testes: `bash tests/executar_todos.sh` (não acessa o Supabase de produção).
Melhorias de versões, backup, revisão da importação e exportações: veja `documentacao/MELHORIAS.md`.
Implantação, janela de transição com o painel antigo e rollback: `documentacao/IMPLANTACAO.md`.

Pontos importantes:
- O histórico guarda os **dados interpretados** de cada planilha, não o arquivo Excel original.
- Integridade do backup (FNV-1a/sha256) detecta corrupção e alterações acidentais; **autenticidade** só com a
  assinatura HMAC-SHA256 do servidor sobre o conteúdo integral do arquivo (JSON canônico RFC 8785, formato 2),
  que exige o segredo `PAINEL_BACKUP_HMAC_KEY`, ainda não configurado. Sem ele, os backups saem no formato 1 e
  aparecem como "sem autenticidade comprovada".
- Rollback não apaga o histórico: desativa as funções novas e arquiva os dados.
- Não use `supabase db push` deste repositório: o histórico de migrations remoto é compartilhado com o CIP.

## Como funciona

- **Consulta (sem login):** o painel lê `painel_current` e `painel_months` direto do Supabase
  com a chave pública; o RLS só permite leitura dessas duas tabelas.
- **Publicação (só autorizados):** o painel envia o mês para a Edge Function `painel-publish`,
  que confere o login, consulta a tabela privada `painel_publicadores`, valida os dados
  (checksum, abas, período, lotes) e grava tudo de uma vez. O painel novo usa `painel_publish_v2`, com a
  revisão conferida obrigatória; o painel antigo usa `painel_publish` (caminho de compatibilidade da transição).
  A chave secreta nunca sai do Supabase.
- A Edge Function só aceita chamadas dos endereços autorizados no código dela
  (`DEFAULT_ORIGINS`).

## Atualizar

Cada mudança no `main` que toque a pasta `docs/` é publicada sozinha em 1 a 2 minutos.
Mudanças na Edge Function são implantadas no Supabase separadamente.

O painel guarda no navegador as importações feitas em cada endereço; os meses **publicados**
vêm sempre do Supabase.
