# Painel FTR: proteção, versões e gestão

Esta pasta **não** é publicada (o GitHub Pages publica só `docs/`).
A implantação e o rollback, passo a passo, estão em [IMPLANTACAO.md](IMPLANTACAO.md).
A auditoria de segurança está em [AUDITORIA_SEGURANCA.md](AUDITORIA_SEGURANCA.md).

## 1. O que mudou

| Área | Antes | Agora |
|---|---|---|
| Histórico | `painel_months` guardava só a revisão vigente de cada mês; as anteriores eram sobrescritas. | Toda versão publicada fica em `painel_month_versions`: os **dados interpretados** completos (JSON), o nome do arquivo, o checksum, a revisão, a data, quem publicou, se virou a corrente, a origem (publicação, recuperação ou carga inicial) e o caminho usado (`via`). |
| Recuperação | Não existia. | Lista de versões por mês, prévia, revisão vigente em destaque e confirmação. A recuperação vira uma **nova** revisão, com a revisão de origem registrada. Nada é apagado. |
| Backup | Backup local do navegador. | Também há um **backup completo do servidor**, com verificação de integridade e, quando o segredo estiver configurado, **assinatura do servidor** (HMAC) para comprovar autenticidade. |
| Importação | Publicava após uma confirmação simples. | Uma revisão aparece **antes** de qualquer gravação. Ela separa erros (que bloqueiam) de avisos, compara com a última publicação, detecta conteúdo idêntico e pede uma segunda confirmação para a nova revisão. |
| Concorrência | A última publicação vencia. | Toda publicação e recuperação do painel novo confere a revisão que o publicador viu. Se outra pessoa publicou antes, a operação é recusada (`revisao_alterada`) e o painel recarrega o estado. |
| Exportação | Não existia. | Excel e CSV com 8 tabelas, respeitando os filtros, sem fórmulas e com proteção contra injeção de fórmula no CSV. |
| Gestão | Não existia. | O cartão "Gestão da publicação" mostra o mês, a versão publicada, a próxima revisão, a última publicação, quem publicou (só para publicadores logados) e os avisos. |

As regras de negócio **não mudaram**: abas CONSOL., Brewhouse 1/3, Ferment e Bright Beer, e o tratamento de `#REF!` e `n.a.`. O teste de regressão confirma que `parseWorkbook`, `jsonOf`, o checksum e o resumo produzem o mesmo resultado da versão em produção (`main`). A única diferença é o campo `qv`, que conta valores inválidos por aba e fica fora do JSON publicado.

Não foram criadas metas, limites, fórmulas, indicadores, critérios ou exclusões.

## 2. Estrutura do histórico

`painel_month_versions` (migration `20261109120000_painel_versoes.sql`):

- `period_key` e `revision` (únicos juntos), `file_name`, `checksum`, `data jsonb`, `summary`
- `published_by`, `published_at`, `set_current`
- `action`: `publish` | `restore` | `backfill`
- `restored_from_revision`
- `via`: `v1` (caminho de compatibilidade do painel antigo) | `v2` (fluxo moderno)
- `publication_id` (ligação 1:1 com `painel_publications`, que também ganhou `action`, `restored_from_revision` e `via`)

Proteções:
- Uma trigger em `painel_publications` (AFTER INSERT) captura a versão. Por isso **até a função antiga `painel_publish` (v1) gera histórico completo**. Se os dados não conferirem com `painel_months` (chave, revisão e checksum), a publicação inteira é desfeita (`versao_inconsistente`).
- Triggers bloqueiam UPDATE, DELETE e TRUNCATE em `painel_month_versions` e em `painel_publications` (`historico_somente_inclusao`). Isso vale inclusive para `service_role`.
- RLS ativo **sem políticas**, e sem acesso para `anon` e `authenticated`. Só a Edge Function, com a chave secreta, lê o histórico.
- Todas as operações de escrita usam o mesmo advisory lock (`hashtext('painel_publish')`), então v1, v2 e recuperação nunca rodam ao mesmo tempo.

A carga inicial (`backfill`) copia a revisão vigente de cada mês já publicado.

> **Revisões perdidas:** em produção, 2026-10 r1–r2 e 2026-11 r1–r3 foram sobrescritas antes desta melhoria. Só os metadados delas existem em `painel_publications`. A tela de versões as lista em "revisões anteriores ao histórico de versões (somente metadados)". Elas **não podem ser recuperadas**.

### 2.1 O que o histórico NÃO guarda: o arquivo Excel original

O histórico guarda os **dados interpretados** de cada planilha (indicadores da CONSOL., grupos, lotes, leituras, limites e fontes), mais o **nome** do arquivo, o checksum, a revisão, a data, quem publicou e o resumo.

**Os bytes do arquivo `.xlsx` original não são guardados em nenhum lugar.** Verifiquei o projeto inteiro:
- o painel lê o arquivo só na memória do navegador (`f.arrayBuffer()` → SheetJS) e descarta os bytes;
- o IndexedDB do navegador guarda os registros interpretados, não o arquivo;
- a Edge Function e o banco recebem só o JSON interpretado;
- não há uso de Supabase Storage nem de outro serviço de arquivos.

Consequência: recuperar uma versão devolve os **mesmos dados e indicadores** daquela publicação, mas **não** o arquivo Excel com suas outras abas, fórmulas e formatação. Abas e colunas que o painel não lê não fazem parte do histórico.

Para não induzir ao erro, a interface agora diz isso:
- a coluna "Arquivo" virou "Arquivo de origem (nome)";
- a tela de versões, a prévia de uma versão, o backup e a verificação do backup avisam que guardam os dados lidos, não o arquivo Excel;
- os textos do histórico local ("Nenhum arquivo importado e arquivado ainda", "cada importação ... é arquivada") foram reescritos para falar dos dados lidos.

A recomendação técnica para guardar o arquivo original, se for desejado, está separada em [RECOMENDACAO_EXCEL_ORIGINAL.md](RECOMENDACAO_EXCEL_ORIGINAL.md). **Nada foi implementado nesse sentido.**

## 3. Publicar: fluxo moderno e caminho de compatibilidade

A Edge Function `painel-publish` decide o caminho pelo **corpo** da requisição:

| | Fluxo moderno (painel novo) | Caminho de compatibilidade (painel antigo do `main`) |
|---|---|---|
| Como é identificado | `"protocol": 2` e/ou o campo `expectedRevision` presente | sem `protocol` e sem `expectedRevision` |
| Revisão esperada | **Obrigatória** (inteiro ≥ 0; 0 = mês novo). Ausente ou nula: **428** `revisao_esperada_ausente`, nada é gravado. | Não existe (o painel antigo não envia). |
| Função SQL | `painel_publish_v2` (que também recusa revisão esperada nula: PT428) | `painel_publish` (v1), exatamente como antes |
| Conteúdo idêntico | Recusado (checksum OU JSONB) | Não verificado (comportamento antigo) |
| Histórico | Capturado pela trigger, `via = 'v2'` | Capturado pela trigger, `via = 'v1'` |
| Resposta | `legacy: false`, `path: 'moderno'` | `legacy: true`, `path: 'compatibilidade'`, mais um aviso (`notice`) |
| Se a v2 não existir no banco | **501** `migracao_pendente`. **Nunca** cai para a v1. | (usa a v1) |
| Falha de rede ou do banco | 502, nada gravado. Nunca vira publicação sem conferência. | 502 |

Regras de segurança do fluxo moderno:
- o servidor **não** aceita publicação moderna sem a revisão conferida, nem por omissão nem por `null`;
- no navegador, o painel novo só publica se a lista de meses do servidor foi carregada com sucesso. Sem ela, por exemplo numa falha de conexão, o painel **não presume** revisão nenhuma: recusa e pede para atualizar;
- uma falha de comunicação nunca é tratada como autorização para ignorar a revisão.

O caminho de compatibilidade existe **só** para a janela de transição, quando a Edge nova já estiver implantada mas o site oficial ainda servir o `main` antigo. Ele pode ser desligado depois com o segredo `PAINEL_LEGACY_PUBLISH=off`. A partir daí o painel antigo recebe **426** `cliente_desatualizado` e é orientado a recarregar a página. **Não desligue antes de o painel novo estar publicado.** Ver [IMPLANTACAO.md](IMPLANTACAO.md).

As publicações feitas pelo caminho de compatibilidade aparecem na tela de versões com a etiqueta **PAINEL ANTIGO**.

### 3.1 Passos para o publicador (painel novo)

1. Escolher a planilha. O painel lê tudo no navegador.
2. Aparece a **Revisão da importação**, com: período, arquivo, data, FTR, etapas, lotes, registros válidos, desvios, abas reconhecidas e valores inválidos.
   - **Erros**, que bloqueiam: período não identificado, aba obrigatória ausente ou com estrutura não reconhecida, nenhum lote em Brewhouse ou em Ferment, ou estrutura de dados inválida.
   - **Avisos**: abas inesperadas no arquivo; período do nome do arquivo diferente do da CONSOL.; abas ou CONSOL. sem dados; inconsistências apontadas pela leitura (como lotes repetidos); células com texto onde se espera número; divergência com a coluna GOOD/WRONG ou com as contagens da CONSOL.; e diferenças em relação à revisão publicada.
   - **Comparação** com a última publicação do mês, indicador por indicador.
   - **Conteúdo idêntico**: avisa e não oferece "Publicar".
3. Os botões são: **Publicar** (pede uma segunda confirmação com a revisão nova), **Só salvar neste navegador** (fica pendente) ou **Cancelar** (nada muda).
4. A Edge Function confere o login, a lista `painel_publicadores`, a origem, os dados e a revisão esperada, e grava tudo atomicamente.

## 4. Controle de concorrência

- Cada publicação e cada recuperação do fluxo moderno levam a revisão vigente que o publicador viu.
- No banco, `painel_publish_v2` e `painel_restore_version` pegam o mesmo advisory lock da v1 e comparam a revisão esperada com a atual **dentro da transação**. Se forem diferentes, recusam com `revisao_alterada` (PT409 → HTTP 409) e nada é gravado.
- Duas pessoas publicando ao mesmo tempo: a primeira grava, e a segunda espera o lock e é recusada. O mesmo vale para uma recuperação durante uma publicação.
- Depois de uma recusa, o painel recarrega sozinho a revisão real do servidor.
- O caminho de compatibilidade (v1) não confere revisão, como sempre foi. Mas ele também pega o lock, então nunca se mistura com uma operação moderna em andamento.

## 5. Recuperar uma versão

Os caminhos são: Menu ▸ **Versões publicadas**, ou o botão **Versões** no Histórico mensal.

1. Escolher o mês. Aparece a lista com a revisão vigente marcada, quem publicou, quando, o tipo de operação e o caminho (etiqueta PAINEL ANTIGO para a v1).
2. **Ver** abre a prévia dos indicadores daquela versão, comparada com a vigente.
3. **Recuperar** pede confirmação: informa a revisão nova e a de origem, e oferece uma opção para tornar o mês o corrente. Se o mês já é o corrente, ele continua corrente.
4. A recuperação **sempre** exige a revisão esperada (no servidor e no banco) e é recusada quando:
   - outra pessoa publicou nesse meio-tempo (`revisao_alterada`);
   - a versão escolhida tem o **mesmo checksum OU o mesmo conteúdo JSONB** da vigente (`conteudo_identico`). O tipo `jsonb` normaliza a ordem das chaves, então ordem diferente não gera falsa diferença. É o mesmo critério da publicação;
   - a versão ou o mês não existem.

### Diferença entre versão recuperada e publicação nova

| | Publicação nova | Versão recuperada |
|---|---|---|
| Origem dos dados | Uma planilha importada agora | Os dados de uma revisão que já está no histórico |
| Registro | `action = 'publish'` | `action = 'restore'` e `restored_from_revision = N` |
| Revisão | Nova revisão (vigente + 1) | Nova revisão (vigente + 1). Nunca "volta" o número nem apaga as revisões posteriores. |
| Arquivo e checksum | Os da planilha importada | Os da versão de origem |
| Validação dos dados | Validação completa da Edge Function | Os dados já foram validados quando publicados. A recuperação só copia a versão do histórico. |

## 6. Backup: integridade e autenticidade

**Backup completo do servidor** (só publicadores): o arquivo `.json` é **montado pela Edge Function**; o navegador só confere e salva. O backup **nunca é bloqueado**: problemas aparecem como aviso.

**Verificar backup do servidor**: abre o arquivo e confere estrutura, integridade, correspondências e, quando houver assinatura, a autenticidade no servidor, **sem gravar nada**.

### 6.1 Formatos

| Formato | Quando é gerado | Assinatura | Como a tela trata |
|---|---|---|---|
| **2** | Servidor com `PAINEL_BACKUP_HMAC_KEY` configurado | **Obrigatória**: HMAC-SHA256 do conteúdo integral (`auth`) | "Autêntico" somente depois de o servidor conferir a assinatura |
| **1** | Backups antigos, e servidor sem o segredo | Nenhuma | Lido normalmente, mas sempre "sem autenticidade comprovada (backup legado)" |

O formato 1 com o envelope do esquema anterior (`ftr-painel-backup-v1`, que assinava só versões e um manifesto parcial e nunca foi implantado) é tratado como "esquema de assinatura antigo": também sem autenticidade comprovada.

### 6.2 Canonicalização

A assinatura é calculada sobre o **JSON canônico RFC 8785 (JCS)** do arquivo inteiro, **exceto o envelope `auth`** (para evitar recursão):
- propriedades dos objetos ordenadas por unidades UTF-16, em todos os níveis;
- arrays preservados na ordem original (por isso trocar a ordem das versões invalida a assinatura);
- números no formato do ECMAScript (o mesmo de `JSON.stringify`): `4.50` vira `4.5`, `1E30` vira `1e+30`, `-0` vira `0`;
- textos com o escape do `JSON.stringify`, com acentos e emoji preservados em UTF-8;
- recusados: números não finitos, `undefined`, funções, objetos não simples (como datas) e textos com surrogates Unicode isolados.

A mesma função existe na Edge Function (`canonical`) e no painel (`jcs`). Um teste confere que as duas produzem o mesmo texto, inclusive nos vetores de exemplo da RFC 8785. Os dados de cada versão vão no arquivo como texto (`dataJson`), então seus números não passam por reformatação.

### 6.3 Assinatura (no servidor)

1. A Edge monta o conteúdo completo (seção 6.4).
2. `contentSha256` = SHA-256 do JSON canônico desse conteúdo.
3. `sig` = HMAC-SHA256(segredo, `ftr-painel-backup-v2` ⏎ `HMAC-SHA256` ⏎ `<keyId>` ⏎ `<contentSha256>`). Esquema, algoritmo e identificador da chave fazem parte da mensagem assinada: trocar qualquer um deles invalida a assinatura.
4. O arquivo recebe `auth = {alg, scheme, keyId, contentSha256, sig}`.

O segredo existe só nos segredos da Edge Function. Ele nunca vai para o JavaScript público, o HTML, o GitHub Pages ou as respostas da API (os testes procuram o segredo em todas as respostas).

### 6.4 Campos protegidos

**Todos os campos do arquivo**, exceto o próprio envelope `auth`. Acrescentar, remover ou alterar qualquer campo, em qualquer nível, invalida a assinatura.

| Parte | Campos |
|---|---|
| Informações gerais | `format`, `version`, `dataFormat`, `exportedAt`, `exportedBy` |
| Versão corrente (`current`) | `key`, `file`, `checksum`, `publishedAt` |
| Meses (`months[]`) | `key`, `revision` (vigente), `checksum`, `file`, `publishedAt`; e a própria lista |
| Publicações (`publications[]`) | `id`, `key`, `revision`, `file`, `checksum`, `publishedBy`, `publishedAt`, `setCurrent`, `replaced`, `action`, `restoredFromRevision`, `via`; e a lista com sua ordem |
| Versões (`versions[]`) | `id`, `publicationId`, `key`, `revision`, `file`, `checksum`, `publishedBy`, `publishedAt`, `createdAt`, `action`, `restoredFromRevision`, `setCurrent`, `via`, `integrity` (FNV-1a), `sha256`, `dataJson` (dados interpretados completos), `summaryJson` (resumo dos indicadores); e a lista com sua ordem |
| Envelope (`auth`) | Não é assinado (é a assinatura). Mas `alg`, `scheme` e `keyId` entram na mensagem do HMAC, e `contentSha256` é conferido. |

Como a associação entre cada versão e seus metadados está toda no mesmo conteúdo assinado, trocar dados de uma versão para outra também invalida a assinatura.

### 6.5 Verificação

1. **No navegador:**
   - estrutura e integridade: formato, FNV-1a e sha256 de cada versão, dados válidos, versões duplicadas;
   - correspondências: versão ↔ publicação (mesmo período, revisão, arquivo, checksum, publicador, operação, origem, caminho e corrente), mês ↔ versão vigente, e mês corrente na lista de meses;
   - cálculo do SHA-256 canônico do arquivo sem `auth`, comparado com o `contentSha256` registrado.
2. **No servidor** (`verify_backup`, só publicadores): o navegador envia o envelope `auth` e o SHA-256 **que ele mesmo calculou**, sem os dados. O servidor **não confia** nesse resumo: recalcula o HMAC sobre ele e compara com `sig`, em tempo constante. Quem adultera o arquivo consegue recalcular os SHA-256, mas não produzir um HMAC válido sem o segredo.
3. "Autêntico" só aparece quando os dois passos passam.

Estados mostrados na tela:

| Estado | Significa | Republicar |
|---|---|---|
| **Autêntico** | HMAC do conteúdo integral conferido pelo servidor | Liberado |
| **Assinatura inválida: alguma informação protegida foi alterada** | O conteúdo não corresponde ao que o servidor assinou | Bloqueado |
| **Assinatura inválida: a assinatura foi removida** | Formato 2 sem `auth` | Bloqueado |
| **Assinatura inválida: algoritmo ou esquema alterado** | Envelope diferente de `ftr-painel-backup-v2` / `HMAC-SHA256` | Bloqueado |
| **Assinado pelo servidor: autenticidade ainda não conferida** | Falta clicar em "Conferir autenticidade no servidor" | Bloqueado até conferir |
| **Autenticidade não comprovada: chave desconhecida** | Assinado com uma chave que o servidor não tem (antiga ou de outro ambiente) | Bloqueado |
| **Autenticidade não comprovada: o servidor não tem a chave configurada** | Formato 2, mas o servidor está sem segredo | Bloqueado |
| **Íntegro, mas sem autenticidade comprovada (backup legado, sem assinatura)** | Formato 1 | Só com confirmação consciente (caixa "Entendo que a autenticidade deste backup não foi comprovada") |
| **Integridade inválida** | Arquivo corrompido, estrutura ou correspondências inconsistentes, ou resumo diferente do registrado | Bloqueado |

### 6.6 Republicação a partir do backup

- Só para backup **autêntico** (verificado no servidor nesta mesma tela) ou **legado** com confirmação explícita.
- Nunca para backup com assinatura inválida, assinatura removida, chave desconhecida ou integridade inválida.
- Sempre cria uma **nova revisão**, pelo fluxo moderno (revisão esperada, conteúdo idêntico e validação da Edge Function). Nada é apagado ou sobrescrito.

### 6.7 Limitações que continuam

- **Rebaixamento para legado:** quem tira a assinatura de um backup formato 2 **e** muda `version` para 1 obtém um arquivo que a tela mostra como "backup legado, sem assinatura". Ele **nunca** aparece como autêntico, e republicar exige confirmação consciente. Mas o sistema não consegue provar que aquele arquivo já foi assinado: sem assinatura, não há o que conferir.
- **O bloqueio da republicação é da interface.** Um publicador autorizado sempre pode publicar dados novos pelo fluxo normal (importando uma planilha). A assinatura protege a confiança no **backup**, não substitui a autorização de publicar.
- **HMAC é simétrico:** só o servidor confere; não há verificação offline. Uma assinatura assimétrica (Ed25519) permitiria isso, mas exigiria gerir uma chave privada e publicar a pública. Não foi necessário.
- **Sem o segredo, não há autenticidade:** a integridade detecta corrupção e alterações acidentais, mas não adulteração deliberada com recálculo.
- **Perda da chave:** backups assinados com uma chave perdida não podem mais ser autenticados. Não há como recuperar ou refazer essas assinaturas; os arquivos continuam legíveis, como não autenticados.

### 6.8 Rotação de chaves

1. Gerar uma chave nova: `openssl rand -hex 32` (no mínimo 32 caracteres aleatórios).
2. Escolher um identificador novo, por exemplo `k2027`.
3. Guardar a chave atual em `PAINEL_BACKUP_HMAC_PREVIOUS_KEYS`, como JSON `{"k2026":"<segredo antigo>"}`. Ela será usada **só para conferir** backups antigos, nunca para assinar.
4. Configurar `PAINEL_BACKUP_HMAC_KEY` com a chave nova e `PAINEL_BACKUP_HMAC_KEY_ID` com o identificador novo.
5. A partir daí, backups novos saem com `k2027`. Backups `k2026` aparecem como "Autêntico (assinado com a chave anterior)" enquanto ela estiver em `PAINEL_BACKUP_HMAC_PREVIOUS_KEYS`. Sem ela, aparecem como "chave desconhecida".
6. Riscos:
   - perder uma chave torna impossível autenticar os backups dela;
   - substituir a chave sem guardar a anterior tem o mesmo efeito;
   - vazar uma chave permite forjar backups com aquele `keyId`. Nesse caso, remova-a também de `PAINEL_BACKUP_HMAC_PREVIOUS_KEYS` e trate os backups dela como não autenticados.

## 7. Exportações

Menu ▸ **Exportar dados (Excel)** (um arquivo com 8 abas) ou **(CSV)** (escolhe-se a tabela). As tabelas são: Indicadores gerais, Por etapa, Histórico mensal, Lotes analisados, Lotes com desvios, Parâmetros, Comparação entre períodos e Informações (data, período, arquivo e filtros aplicados).

- Lotes e desvios seguem os filtros ativos do painel; o período é o mês exibido.
- Nenhuma célula contém fórmula. No Excel, percentuais são números com formato % e datas são datas do Excel.
- CSV: separador `;`, vírgula decimal, percentuais em % (ex.: 95,2), BOM UTF-8, horário de São Paulo. Textos que começam com `= + - @` recebem um apóstrofo, para não virarem fórmula.
- As exportações não exigem login, porque os dados já são públicos no painel.

## 8. Rollback

**Rollback não apaga o histórico novo.** Ele **desativa** as funcionalidades novas e **arquiva** os dados:
- `painel_month_versions` é renomeada para `painel_month_versions_rollback_<data e hora>`, com todas as linhas;
- os índices e a sequência são renomeados junto (o teste confirma que continuam ligados à tabela arquivada), para que a migration possa ser reaplicada sem conflito de nomes;
- a tabela arquivada continua **privada**: RLS ligado, sem acesso para `anon` e `authenticated`, e `service_role` só com leitura (não altera nem apaga pela API);
- as funções novas, as triggers e as colunas `action`, `restored_from_revision` e `via` de `painel_publications` são removidas. Essas informações continuam na tabela arquivada;
- `painel_months`, `painel_current`, `painel_publicadores` e a v1 **não são tocados**. A v1 continua funcionando (testado);
- nenhum objeto do CIP é tocado.

Reaplicar a migration depois do rollback funciona (testado). O histórico novo começa só com a revisão vigente de cada mês (`backfill`), e o arquivo continua intacto ao lado. Para reincorporar o arquivo, seria preciso um script específico, com autorização. Ele não é automático de propósito, para não misturar históricos sem conferência.

O script fica em `supabase/rollback/`, **fora** de `supabase/migrations/`, para nunca ser aplicado por engano. Detalhes em [IMPLANTACAO.md](IMPLANTACAO.md).

## 9. Supabase compartilhado com o CIP

- A migration só cria e altera objetos `painel_*` no schema `public`. Um teste automatizado confirma que migration e rollback não criam nenhum objeto fora desse prefixo. Nenhum objeto do CIP é lido em detalhe, alterado ou removido.
- Funções SECURITY DEFINER novas: `painel_capture_version`, `painel_publish_v2` e `painel_restore_version`, todas com `search_path = public, pg_temp`. Ninguém além de `service_role` executa as duas últimas. `painel_block_change` não é SECURITY DEFINER.
- **Histórico de migrations remoto é misto.** A lista de migrations do projeto (consultada em modo só leitura em 09/11/2026) tem, em ordem: `schema_inicial_sistema_cip`, `hardening_pos_schema`, `painel_ftr_tabelas_rls_e_publish`, `corrigir_divergencias_da_migracao_inicial`, `painel_publicadores`, `cip_backup_pre_v8`, `cip_v8_tipo_osam`, `cip_v8_estrutura` (a última é `20261106140500`).
- **Não use `supabase db push` a partir deste repositório.** Este repositório não tem as migrations do CIP, e o CIP não tem as do FTR. O `db push` compara a pasta local com o histórico remoto e acusaria migrations remotas desconhecidas, ou tentaria reconciliar o histórico (`migration repair`), o que pode afetar o registro do CIP. Migrations de repositórios diferentes **não** podem ser aplicadas de forma automática e isolada no mesmo banco.
- Por isso a migration foi versionada como `20261109120000`, **depois** da última migration remota, no formato `AAAAMMDDHHMMSS_nome.sql` do Supabase. O nome antigo `20261106_001_…` era incompatível: a CLI leria a versão `20261106` tanto na migration quanto no rollback (conflito de versão), e essa versão seria anterior às migrations do CIP.
- **Antes de uma implantação conjunta com o CIP**, organize o histórico remoto: decida qual repositório é a fonte das migrations do projeto (ou crie um repositório só de banco com as duas séries), e só então use a CLI. Até lá, aplique manualmente (SQL Editor ou `apply_migration`) com a versão `20261109120000`, como descrito em [IMPLANTACAO.md](IMPLANTACAO.md).

## 10. Testes

Para rodar todos: `bash tests/executar_todos.sh`. Nada é enviado ao Supabase de produção.

| Suíte | O que cobre |
|---|---|
| `tests/sql/executar.sh` | PostgreSQL temporário com o esquema real e dados fictícios espelhando a produção. Cobre: migration aplicada 2×; T1–T15 (carga inicial; permissões; publicação; idêntico; revisão esperada obrigatória; revisão desatualizada; recuperação; idêntico na recuperação por checksum, por JSONB e por JSONB com outra ordem de chaves; histórico só-inclusão; v1 compatível e capturada com `via`; atomicidade; ponteiro corrente; coerência); duas publicações simultâneas; recuperação durante uma publicação; captura do caminho legado; rollback completo (histórico, índices, sequência, privacidade, v1); reaplicação; e confirmação de que só objetos `painel_*` são criados. |
| `tests/edge.test.mjs` | A Edge Function real com fetch simulado, mais as funções puras do painel (lado do navegador). Cobre: origem, login, publicador (todas as ações, inclusive `verify_backup`); fluxo moderno com e sem revisão esperada; v2 ausente e falha de rede sem cair para a v1; corpo exato do painel antigo pela v1, identificado como legado; desligamento do legado; recuperação sempre com revisão esperada; JSON canônico idêntico na Edge e no painel; backup formato 1 (sem segredo) e formato 2 (assinado); **23 cenários de adulteração** com FNV-1a e SHA-256 recalculados, todos recusados; ordem de propriedades (continua autêntico); remoção, chave, algoritmo, esquema, resumo e assinatura forjada; rebaixamento para legado; rotação de chave; nenhum segredo nas respostas. |
| `tests/painel.test.mjs` | Regressão contra `main` (`parseWorkbook`, `jsonOf`, checksum, resumo) e as funções novas (revisão da importação, exportações, CSV, células do Excel, backup, limitação do FNV com recálculo, backup legado, vetores da RFC 8785 e todos os estados de autenticidade). |
| `tests/e2e/painel.e2e.mjs` | Navegador real com o painel, a Edge real e o banco temporário (46 verificações). Cobre: consulta pública; revisão da importação; publicação moderna (v2); idêntico; versões e recuperação; concorrência; usuário não autorizado; Excel e CSV; backup formato 2 assinado; republicação bloqueada até conferir; autenticidade conferida e republicação como nova revisão; edição sem recalcular (integridade inválida); adulteração de metadados com hashes recalculados (assinatura inválida); assinatura removida; chave desconhecida; legado com confirmação consciente; gráficos; histórico; PDF; modo TV; **o painel atual de produção (`main`) publicando pela Edge nova com a migration**, capturado no histórico como `via = v1`; nenhum erro de JS. |

No e2e, a biblioteca SheetJS (cdnjs) é substituída por um simulador, porque o ambiente de teste não acessa a internet. Em produção, o painel usa a SheetJS real, como antes. O segredo HMAC do e2e é fictício e só existe no teste.

## 11. Validação manual sugerida (após autorização)

1. Abrir o painel sem login: os meses e gráficos aparecem como antes.
2. Entrar como publicador e importar a planilha do mês vigente: a revisão aparece, e "Cancelar" não muda nada.
3. Importar a mesma planilha já publicada: aparece "Conteúdo idêntico".
4. Versões publicadas ▸ mês vigente: a revisão vigente aparece marcada, e as revisões antigas sem dados aparecem em "anteriores ao histórico (somente metadados)".
5. Exportar Excel e CSV e abrir no Excel: números, % e datas corretos, sem fórmulas.
6. Backup completo do servidor e depois Verificar backup. Sem o segredo, deve aparecer "Íntegro, mas sem autenticidade comprovada (backup legado…)". Com o segredo configurado, "Conferir autenticidade no servidor" deve mostrar "Autêntico".
