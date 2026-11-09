# Auditoria de segurança: Painel FTR (Supabase compartilhado com o CIP)

Feita em 06/11/2026 e revisada em 09/11/2026, **somente leitura** na produção (consultas a catálogo, advisors e lista de migrations). Nenhum objeto do CIP foi lido em detalhe nem alterado.

## Situação encontrada (produção)

| Item | Situação | Avaliação |
|---|---|---|
| `painel_months`, `painel_current` | RLS ativo; política só de SELECT para `anon` e `authenticated` | OK: a leitura pública é intencional e não existe escrita pelo navegador. |
| `painel_publications` | RLS ativo, sem políticas | OK: inacessível pela chave pública. O advisor dá INFO "RLS sem política", o que é intencional. |
| `painel_publicadores` | RLS ativo, sem políticas | OK: a lista de publicadores não é exposta. Mesmo INFO intencional. |
| `painel_publish` (SECURITY DEFINER) | `search_path` fixo; EXECUTE só para `service_role` | OK: o corpo é idêntico ao do repositório. |
| Edge Function `painel-publish` | `verify_jwt=false`, com o login conferido no código (`/auth/v1/user`), a lista `painel_publicadores` e as origens permitidas | OK: a chave secreta só existe no ambiente da função. |
| Chaves no navegador | Só a chave publicável (`sb_publishable_…`) | OK: nenhuma `service_role` ou `sb_secret` em `docs/`. |
| Auth | O advisor recomenda ativar a proteção contra senhas vazadas | **Recomendação**: é uma opção gratuita do painel de Auth e afeta também o CIP. Depende de decisão sua. |
| Funções SECURITY DEFINER do CIP | O advisor aponta avisos | Pertencem ao CIP: **não foram tocadas**. |

Dados (09/11/2026, antes da implantação): 11 meses publicados, 17 publicações. As revisões 2026-10 r1–r2 e 2026-11 r1–r4 já perderam os dados (só restam os metadados). As r2 e r3 de 2026-11 têm o mesmo conteúdo, ou seja, foram uma republicação acidental. A nova detecção de conteúdo idêntico impede isso.

## Revisão corretiva (09/11/2026)

| Ponto | Encontrado | Corrigido |
|---|---|---|
| Conteúdo idêntico na recuperação | `painel_restore_version` comparava só o checksum | Agora compara checksum **ou** JSONB (sem falsa diferença por ordem de chaves), igual à publicação. Testes T15.1 a T15.6. |
| Revisão esperada opcional | A Edge aceitava publicação moderna com `expectedRevision` nulo ou ausente e chamava a v2 sem conferência. Se a v2 não existisse, caía para a v1. | Fluxo moderno exige a revisão esperada (428), na Edge **e** no banco (PT428 na v2 e na recuperação). Nunca cai para a v1. O caminho de compatibilidade é explícito, identificado na resposta (`legacy`, `path`) e no histórico (`via = 'v1'`), e pode ser desligado. |
| Falha de comunicação | O painel enviava revisão 0 quando a lista do servidor não tinha sido carregada | O painel não publica sem a lista do servidor. A Edge responde 502 em falha de rede, sem tentar outro caminho. |
| Versão da migration | `20261106_001_…`: a CLI do Supabase leria a versão `20261106`, a mesma do rollback (conflito), e anterior às migrations do CIP | Renomeada para `20261109120000_painel_versoes.sql`. O rollback foi para `supabase/rollback/`. Aplicação manual documentada (sem `db push`). |
| Tabela arquivada pelo rollback | Privada para `anon`/`authenticated`, mas `service_role` ainda podia alterá-la | `service_role` passa a ter só leitura no arquivo. Testado. |
| Integridade x autenticidade | O FNV-1a podia ser confundido com proteção contra adulteração | Documentação e interface deixam claro que integridade não é autenticidade. Assinatura HMAC-SHA256 opcional, com segredo só no servidor (preparada e testada, **não configurada**). |
| Arquivo Excel original | Textos podiam sugerir que o arquivo era guardado | Confirmado que os bytes nunca são guardados. Textos corrigidos e limitação documentada. |

## Correção da assinatura dos backups (09/11/2026)

| Ponto | Encontrado | Corrigido |
|---|---|---|
| Cobertura da assinatura | O esquema `ftr-painel-backup-v1` assinava, por versão, só período, revisão, checksum e sha256 dos dados, mais um manifesto com data, autor e lista de versões. Arquivo de origem, publicador e data de cada versão, tipo de operação, revisão de origem, caminho v1/v2, versão corrente, meses, publicações e versão corrente ficavam **fora** da proteção. | Esquema `ftr-painel-backup-v2`: HMAC-SHA256 sobre o SHA-256 do **JSON canônico RFC 8785 do arquivo inteiro** (tudo exceto o envelope `auth`). O arquivo é montado pelo servidor. Esquema, algoritmo e `keyId` entram na mensagem assinada. |
| Verificação | O servidor conferia assinaturas por versão; um backup com versões válidas e outros campos adulterados podia passar parcialmente | `verify_backup` confere uma única assinatura: o HMAC do resumo do conteúdo integral, resumo que o **navegador** calcula a partir do arquivo. A correspondência arquivo ↔ resumo é conferida no navegador, não no servidor. A tela só mostra "Autêntico" com os dois passos aprovados. |
| Assinatura removida | Um backup sem `auth` era só "sem assinatura" | No formato 2 a assinatura é obrigatória: sem ela, "Assinatura inválida: a assinatura foi removida", e a republicação fica bloqueada |
| Republicação | Bloqueada só para versões com assinatura inválida | Liberada só para backup autêntico, ou legado com confirmação consciente |
| Testes | Adulteração de dados e de lista de versões | 23 cenários de adulteração com FNV-1a e SHA-256 recalculados (todos os campos pedidos e mais), todos recusados pelo servidor, mais testes de envelope, ordem de propriedades, rebaixamento e rotação |

## Proteções em vigor com a melhoria

- O histórico (`painel_month_versions`) e as publicações ficam **só-inclusão**, por triggers. Nem a `service_role` altera ou apaga uma linha.
- O histórico fica fora da API pública: RLS sem políticas e acesso revogado de `public`, `anon` e `authenticated`. O teste T2 confirma.
- As funções novas são SECURITY DEFINER com `search_path = public, pg_temp`. Ninguém além de `service_role` executa `painel_publish_v2` e `painel_restore_version`.
- Concorrência: o advisory lock é único para v1, v2 e recuperação, e o fluxo moderno sempre confere a revisão esperada dentro da transação.
- A Edge Function aplica o login, a lista de publicadores e a origem a **todas** as ações, inclusive leitura de versões, backup e `verify_backup`. O corpo da requisição só é lido depois da autorização.
- Segredos: a chave secreta do projeto e o segredo HMAC (quando configurado) existem só no ambiente da Edge Function. Os testes confirmam que nenhuma resposta contém `sb_secret` ou o segredo HMAC. O `docs/` contém só a chave publicável.
- `verify_backup` recebe só o envelope da assinatura e o SHA-256 canônico calculado pelo navegador (não os dados). Recalcula o HMAC sobre esse resumo, compara em tempo constante e não grava nada. **O servidor não confere de forma independente que esse resumo corresponde ao arquivo:** isso é feito no navegador. O bloqueio da republicação de backups não autenticados também é da interface.

## Análise de contorno pela API (auditoria final, 09/11/2026)

- Sem login de publicador autorizado, todas as ações (`publish`, `restore`, `versions`, `version`, `backup`, `verify_backup`) respondem 401/403 antes de ler o corpo.
- Um publicador autorizado pode chamar a API sem o painel: enviar à `verify_backup` o resumo de um backup legítimo e, separadamente, publicar outro conteúdo. Isso não amplia o que ele já pode fazer (publicar qualquer conteúdo válido, sempre como nova revisão, com validação do servidor, conferência de revisão e registro do publicador no histórico só-inclusão). Ou seja, a assinatura protege a confiança no backup contra quem não tem o segredo; não é um controle de autorização.
- A `verify_backup` não é um "oráculo de assinatura": responde só verdadeiro/falso, nunca devolve uma assinatura. A ação `backup` assina apenas o conteúdo que o servidor lê do próprio banco.
- Os logs da Edge Function (`console.error`/`console.warn`) registram status e respostas do PostgREST, e o e-mail de quem publica pelo caminho de compatibilidade. Nunca registram chaves ou o segredo HMAC.
- Isolamento do CIP: um teste confirma que migration e rollback só criam objetos `painel_*`. Nenhum objeto do CIP é alterado.
- Exportações e o backup são gerados no navegador ou na Edge Function existente. Nenhum serviço externo ou pago foi incluído.

## Limitações conhecidas

- **Sem o segredo HMAC configurado, não há autenticidade:** a integridade (FNV-1a e sha256) detecta corrupção e alterações acidentais, mas **não** impede adulteração deliberada com recálculo. Backups gerados antes da configuração do segredo nunca terão assinatura.
- A assinatura é simétrica (HMAC): só o servidor confere. Uma assinatura assimétrica permitiria conferência offline, mas não foi necessária.
- Um backup formato 2 que tenha a assinatura removida **e** a versão trocada para 1 aparece como "backup legado, sem assinatura": nunca como autêntico, e republicar exige confirmação consciente. Mas não é possível provar que ele já foi assinado.
- O bloqueio de republicação a partir de backups não autenticados é da interface. Um publicador autorizado continua podendo publicar dados novos pelo fluxo normal.
- Uma chave de assinatura perdida torna impossível autenticar os backups dela; não há recuperação.
- O caminho de compatibilidade (v1) não confere revisão nem conteúdo idêntico. Ele existe só durante a transição e deve ser desligado (`PAINEL_LEGACY_PUBLISH=off`) depois que o painel novo estiver publicado.
- O histórico guarda os dados interpretados, **não** o arquivo Excel original. Ver [RECOMENDACAO_EXCEL_ORIGINAL.md](RECOMENDACAO_EXCEL_ORIGINAL.md).
- "Quem publicou" vem só pela Edge Function, para publicadores logados. Quem consulta sem login não vê nomes nem e-mails.
- As exportações não exigem login, porque só contêm dados que o painel já mostra publicamente.
