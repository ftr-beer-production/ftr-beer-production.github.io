# Painel FTR: proteção, versões e gestão

Esta pasta **não** é publicada (o GitHub Pages publica só `docs/`).

## 1. O que mudou

| Área | Antes | Agora |
|---|---|---|
| Histórico | `painel_months` guardava só a revisão vigente de cada mês; as anteriores eram sobrescritas. | Toda versão publicada fica em `painel_month_versions`: JSON completo, arquivo, checksum, revisão, data, quem publicou, se virou a corrente e a origem (publicação, restauração ou carga inicial). |
| Recuperação | Não existia. | Lista de versões por mês, prévia, revisão vigente em destaque e confirmação. A restauração vira uma **nova** revisão, com a revisão de origem registrada. Nada é apagado. |
| Backup | Backup local do navegador. | Também há um **backup completo do servidor** (todas as versões, com verificação de integridade) e uma verificação do arquivo, com prévia e sem gravar nada. |
| Importação | Publicava após uma confirmação simples. | Uma revisão aparece **antes** de qualquer gravação. Ela separa erros (que bloqueiam) de avisos, compara com a última publicação, detecta conteúdo idêntico e pede uma segunda confirmação para a nova revisão. |
| Concorrência | A última publicação vencia. | Cada publicação informa a revisão que o publicador viu. Se outra pessoa publicou antes, a publicação é recusada (`revisao_alterada`) e o painel recarrega o estado. |
| Exportação | Não existia. | Excel e CSV com 8 tabelas, respeitando os filtros, sem fórmulas e com proteção contra injeção de fórmula no CSV. |
| Gestão | Não existia. | O cartão "Gestão da publicação" mostra o mês, a versão publicada, a próxima revisão, a última publicação, quem publicou (só para publicadores logados) e os avisos. |

As regras de negócio **não mudaram**: abas CONSOL., Brewhouse 1/3, Ferment e Bright Beer, e o tratamento de `#REF!` e `n.a.`. O teste de regressão confirma que `parseWorkbook`, `jsonOf`, o checksum e o resumo produzem o mesmo resultado da versão em produção (`main`). A única diferença é o novo campo `qv`, que conta valores inválidos por aba e fica fora do JSON publicado.

Não foram criadas metas, limites, fórmulas, indicadores, critérios ou exclusões.

## 2. Estrutura do histórico

`painel_month_versions` (migration `20261106_001`):

- `period_key`, `revision` (únicos juntos), `file_name`, `checksum`, `data jsonb`, `summary`
- `published_by`, `published_at`, `set_current`
- `action`: `publish` | `restore` | `backfill`
- `restored_from_revision`, `publication_id` (ligação 1:1 com `painel_publications`)

Proteções:
- Uma trigger em `painel_publications` (AFTER INSERT) captura a versão. Por isso **até a função antiga `painel_publish` (v1) gera histórico**. Se os dados não conferirem com `painel_months` (chave, revisão e checksum), a publicação inteira é desfeita (`versao_inconsistente`).
- Triggers bloqueiam UPDATE, DELETE e TRUNCATE em `painel_month_versions` e em `painel_publications` (`historico_somente_inclusao`). Isso vale inclusive para `service_role`.
- RLS ativo **sem políticas**, e sem acesso para `anon` e `authenticated`. Só a Edge Function, com a chave secreta, lê o histórico.
- Todas as operações de escrita usam o mesmo advisory lock (`hashtext('painel_publish')`), então v1, v2 e restauração nunca se cruzam.

A carga inicial (`backfill`) copia a revisão vigente de cada mês já publicado.

> **Revisões perdidas:** em produção, 2026-10 r1–r2 e 2026-11 r1–r3 foram sobrescritas antes desta melhoria. Só os metadados delas existem em `painel_publications`. O painel lista essas revisões como "sem dados (anterior ao histórico)". Elas **não podem ser recuperadas**.

## 3. Publicar (fluxo novo)

1. Escolher a planilha. O painel lê tudo no navegador.
2. Aparece a **Revisão da importação**, com: período, arquivo, data, FTR, etapas, lotes, registros válidos, desvios, abas reconhecidas e valores inválidos.
   - **Erros**, que bloqueiam: período não identificado, aba obrigatória ausente ou com estrutura não reconhecida, nenhum lote em Brewhouse ou em Ferment, ou estrutura de dados inválida.
   - **Avisos**: abas inesperadas no arquivo; período do nome do arquivo diferente do da CONSOL.; abas ou CONSOL. sem dados; inconsistências apontadas pela leitura (como lotes repetidos); células com texto onde se espera número; divergência com a coluna GOOD/WRONG ou com as contagens da CONSOL.; e diferenças em relação à revisão publicada.
   - **Comparação** com a última publicação do mês, indicador por indicador.
   - **Conteúdo idêntico**: avisa e não oferece "Publicar".
3. Os botões são: **Publicar** (pede uma segunda confirmação com a revisão nova), **Só salvar neste navegador** (fica pendente) ou **Cancelar** (nada muda).
4. A Edge Function confere o login, a lista `painel_publicadores`, a origem, os dados e a revisão esperada, e grava tudo atomicamente.

## 4. Recuperar uma versão

Os caminhos são: Menu ▸ **Versões publicadas**, ou o botão **Versões** no Histórico mensal.

1. Escolher o mês. Aparece a lista com a revisão vigente marcada, quem publicou, quando e o tipo de operação.
2. **Ver** abre a prévia dos indicadores daquela versão, comparada com a vigente.
3. **Restaurar como nova revisão** pede uma confirmação. Ela informa a revisão nova e a de origem, e oferece uma opção para tornar o mês o corrente. Se o mês já é o corrente, ele continua corrente.
4. A restauração é recusada se outra pessoa publicou nesse meio-tempo (revisão esperada), se a versão é idêntica à vigente, ou se a versão ou o mês não existem.

## 5. Backup e verificação

- **Backup completo do servidor** (só publicadores): um arquivo `.json` com todas as versões, meses, publicações e a versão corrente. Cada versão leva `integrity` = FNV-1a do JSON. O backup **nunca é bloqueado**. Se alguma versão tiver problema, o arquivo é salvo assim mesmo e o problema aparece como aviso.
- **Verificar backup do servidor**: abre o arquivo e confere formato, integridade, períodos, duplicidades e dados, **sem gravar nada**. A partir da prévia, um publicador pode republicar uma versão do backup. Ela entra como **nova revisão**, pelo fluxo normal de publicação, nunca por cima do histórico.
- O FNV-1a detecta corrupção e edição acidental. **Não é criptográfico**: não protege contra alguém que recalcule o valor de propósito.

## 6. Exportações

Menu ▸ **Exportar dados (Excel)** (um arquivo com 8 abas) ou **(CSV)** (escolhe-se a tabela). As tabelas são: Indicadores gerais, Por etapa, Histórico mensal, Lotes analisados, Lotes com desvios, Parâmetros, Comparação entre períodos e Informações (data, período, arquivo e filtros aplicados).

- Lotes e desvios seguem os filtros ativos do painel; o período é o mês exibido.
- Nenhuma célula contém fórmula. No Excel, percentuais são números com formato % e datas são datas do Excel.
- CSV: separador `;`, vírgula decimal, percentuais em % (ex.: 95,2), BOM UTF-8, horário de São Paulo. Textos que começam com `= + - @` recebem um apóstrofo, para não virarem fórmula.
- As exportações não exigem login, porque os dados já são públicos no painel. Veja o ponto para decisão no relatório.

## 7. Migrations e rollback

| Ordem | Passo | Observação |
|---|---|---|
| 1 | Backup do banco (Dashboard ▸ Database ▸ Backups, ou `pg_dump` das tabelas `painel_*`) | |
| 2 | `supabase/migrations/20261106_001_painel_versoes.sql` | Aditiva, idempotente e transacional. Não altera objetos do CIP. A função v1 continua funcionando. |
| 3 | Conferir `select period_key, revision, action from painel_month_versions order by 1,2;` (deve ter uma linha por mês) | |
| 4 | Implantar a Edge Function `painel-publish` (verify_jwt = false) | Se a migration não estiver aplicada, a função usa a v1 automaticamente (`legacy: true`). A restauração responde 501 `migracao_pendente`. |
| 5 | Publicar `docs/index.html` (merge no `main`) | Com a Edge antiga, o painel continua publicando. Só "Versões" e "Backup do servidor" mostram erro. |

**Rollback:** `20261106_001_painel_versoes_rollback.sql`. Ele **não apaga** o histórico: renomeia a tabela para `painel_month_versions_rollback_<data>` e remove só as funções, triggers e colunas novas. A v1 volta a ser a única. Para voltar a Edge, reimplante a versão do `main`.

## 8. Testes

Para rodar todos: `bash tests/executar_todos.sh`. Nada é enviado ao Supabase de produção.

| Suíte | O que cobre |
|---|---|
| `tests/sql/executar.sh` | Um PostgreSQL temporário com o esquema real e dados fictícios espelhando a produção. Cobre: migration aplicada 2×; T1–T14 (carga inicial, permissões de anon e authenticated, publicação nova e nova revisão, idêntico por checksum e por JSON com outra ordem de chaves, revisão desatualizada, restauração, histórico só-inclusão, compatibilidade v1, atomicidade, ponteiro corrente, coerência); duas sessões publicando ao mesmo tempo; rollback e reaplicação. |
| `tests/edge.test.mjs` | A Edge Function real com fetch simulado. Cobre: origem, login, publicador, cada ação, mapeamento de erros, fallback v1, e confirma que nenhuma resposta contém chave secreta. |
| `tests/painel.test.mjs` | Regressão contra `main` (`parseWorkbook`, `jsonOf`, checksum, resumo) e as funções novas (revisão da importação, exportações, CSV, células do Excel, backup). |
| `tests/e2e/painel.e2e.mjs` | Navegador real (Playwright) com o painel, a Edge real e o banco temporário. Cobre 31 verificações: consulta pública, revisão, nada gravado antes da confirmação, publicação, idêntico, versões, restauração, concorrência, usuário não autorizado, Excel, CSV, backup, backup adulterado, gráficos, histórico, PDF, modo TV e ausência de erros de JS. |

No e2e, a biblioteca SheetJS (cdnjs) é substituída por um simulador, porque o ambiente de teste não acessa a internet. Em produção, o painel usa a SheetJS real, como antes.

## 9. Validação manual sugerida (após autorização)

1. Abrir o painel sem login: os meses e gráficos aparecem como antes.
2. Entrar como publicador e importar a planilha do mês vigente: a revisão aparece e "Cancelar" não muda nada.
3. Importar a mesma planilha já publicada: aparece "Conteúdo idêntico".
4. Versões publicadas ▸ mês vigente: aparece r(n), com as revisões antigas marcadas "sem dados".
5. Exportar Excel e CSV e abrir no Excel: números, % e datas corretos, sem fórmulas.
6. Backup completo do servidor e depois Verificar backup: "integridade confirmada".
