# Implantação e rollback: Painel FTR (versões, concorrência e backups)

> **Nada disto foi executado em produção.** Cada passo marcado 🔒 depende de autorização explícita.
> O projeto Supabase é **compartilhado com o CIP**: leia a seção 9 de [MELHORIAS.md](MELHORIAS.md) antes de começar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `supabase/migrations/20261109120000_painel_versoes.sql` | Migration aditiva, idempotente e transacional |
| `supabase/rollback/20261109120000_painel_versoes_rollback.sql` | Rollback não destrutivo. Fica fora de `migrations/` de propósito. |
| `supabase/functions/painel-publish/index.ts` | Edge Function: fluxo moderno, caminho de compatibilidade, versões, backup e `verify_backup` |
| `docs/index.html` | Painel novo, publicado pelo GitHub Pages a partir do `main` |

## Ordem de implantação

| # | Passo | Por quê | Como conferir |
|---|---|---|---|
| 0 | Rodar `bash tests/executar_todos.sh` na branch | Garante que tudo passa antes | "TODAS AS SUÍTES PASSARAM" |
| 1 🔒 | Backup do banco: Dashboard ▸ Database ▸ Backups, ou exportar as tabelas `painel_*` | Ponto de retorno | Arquivo guardado |
| 2 🔒 | Aplicar a **migration** pelo SQL Editor (colar o arquivo inteiro) ou por `apply_migration`, com o nome `painel_versoes` e a versão `20261109120000`. **Não usar `supabase db push`.** | O histórico remoto tem migrations do CIP que este repositório não conhece | `select period_key, revision, action, via from painel_month_versions order by 1,2;` mostra uma linha `backfill` por mês |
| 3 🔒 | Implantar a **Edge Function** `painel-publish` (verify_jwt = false) | Com a migration aplicada, o painel antigo (ainda no ar) passa a publicar pelo caminho de compatibilidade, e o histórico já é capturado | Publicar pelo site oficial (ainda o antigo) funciona; a nova revisão aparece em `painel_month_versions` com `via = 'v1'` |
| 4 🔒 | Merge da branch no `main`, o que publica o painel novo pelo GitHub Pages | O painel novo usa o fluxo moderno | Publicar pelo site: `via = 'v2'` e resposta com `path: 'moderno'` |
| 5 🔒 (opcional) | Configurar o segredo `PAINEL_BACKUP_HMAC_KEY` (e opcionalmente `PAINEL_BACKUP_HMAC_KEY_ID`) | Liga a assinatura dos backups | Backup novo mostra "Assinado pelo servidor"; "Conferir autenticidade" mostra "Autêntico" |
| 6 🔒 (opcional, depois de dias de uso) | Configurar `PAINEL_LEGACY_PUBLISH=off` | Desliga o caminho de compatibilidade quando ninguém mais usa o painel antigo (cache de navegador) | Uma publicação com corpo antigo recebe 426 `cliente_desatualizado` |

### Janela de transição (entre os passos 3 e 4)

- O site oficial continua servindo o `main` antigo. Ele envia o corpo antigo (`file`, `periodKey`, `checksum`, `dataJson`, `setCurrent`), sem `protocol` nem `expectedRevision`.
- A Edge nova reconhece esse corpo e usa a **v1**, exatamente como antes. A resposta traz `legacy: true` e `path: 'compatibilidade'`, campos que o painel antigo simplesmente ignora.
- Com a migration aplicada, a trigger grava a versão completa (`via = 'v1'`). Nada se perde no histórico.
- O teste de ponta a ponta executa exatamente esse cenário: o `docs/index.html` do `main` publicando pela Edge nova num banco com a migration.
- **Não desligue o caminho de compatibilidade (passo 6) antes do passo 4.**

### O que acontece se a ordem for trocada

| Situação | Efeito |
|---|---|
| Edge nova **sem** a migration | Painel antigo: publica pela v1, sem histórico (como hoje). Painel novo: publicação recebe 501 `migracao_pendente`, e nada é gravado. Nunca cai para a v1 sem conferência. |
| Painel novo com a Edge **antiga** | A Edge antiga não conhece `protocol`/`expectedRevision` e publica pela v1, sem conferência de revisão. **Evite**: implante a Edge antes do painel. |
| Migration aplicada, Edge antiga | A Edge antiga usa a v1, e a trigger já captura o histórico. Seguro. |

## Segredos da Edge Function (todos opcionais, configurados só com autorização)

| Segredo | Efeito | Observação |
|---|---|---|
| `PAINEL_BACKUP_HMAC_KEY` | Liga a assinatura HMAC-SHA256 dos backups e a conferência `verify_backup` | Mínimo de 32 caracteres aleatórios. Fica **só** nos segredos da Edge Function, nunca no `docs/`. Sem ele, o backup sai sem assinatura (comportamento atual). |
| `PAINEL_BACKUP_HMAC_KEY_ID` | Identificador da chave, gravado no backup (padrão `k1`) | Troque ao rotacionar a chave. Backups com outro identificador são informados como "outra chave". |
| `PAINEL_LEGACY_PUBLISH` | `off` desliga o caminho de compatibilidade | Só depois de o painel novo estar no ar |
| `ALLOWED_ORIGINS` | Já existia: origens extras permitidas | Sem mudança |

Para gerar um segredo forte sem serviço externo, use por exemplo, num terminal: `openssl rand -hex 32`. Configure em Dashboard ▸ Edge Functions ▸ Secrets. Não há custo adicional.

## Rollback

Ordem inversa:

1. 🔒 Voltar o `main` para a versão anterior (revert do merge). O painel antigo volta ao ar.
2. 🔒 Reimplantar a Edge Function do `main` antigo. Se a Edge nova ficar no ar, ela continua atendendo o painel antigo pela v1.
3. 🔒 Executar `supabase/rollback/20261109120000_painel_versoes_rollback.sql` no SQL Editor.
4. Conferir:
   - `select relname from pg_class where relname like 'painel_month_versions_rollback_%';` mostra a tabela arquivada;
   - uma publicação pelo painel antigo funciona (v1).

O que o rollback faz e não faz:
- **Preserva** todo o histórico capturado, na tabela `painel_month_versions_rollback_<data>`, com índices e sequência, privada e somente leitura para `service_role`.
- **Remove** as funções `painel_publish_v2`, `painel_restore_version`, `painel_capture_version` e `painel_block_change`, as triggers e as colunas `action`, `restored_from_revision` e `via` de `painel_publications`.
- **Não toca** `painel_months`, `painel_current`, `painel_publicadores`, a v1, nem nenhum objeto do CIP.
- Se a migration for aplicada de novo depois, ela funciona. O histórico novo começa do zero (só a versão vigente de cada mês), e o arquivo continua ao lado.
- Se for preciso registrar o rollback no histórico de migrations remoto, faça manualmente e com autorização, para não afetar o registro do CIP.

## Checklist pós-implantação

- [ ] Consulta pública sem login funciona (meses, gráficos, PDF, modo TV)
- [ ] Publicação pelo painel novo: revisão + 1, `via = 'v2'`
- [ ] Reimportar a mesma planilha: "Conteúdo idêntico"
- [ ] Versões publicadas: lista, prévia e recuperação como nova revisão
- [ ] Backup do servidor e verificação; autenticidade (se o segredo foi configurado)
- [ ] `get_advisors` (segurança): nenhum alerta novo para objetos `painel_*` além do INFO intencional "RLS sem política"
