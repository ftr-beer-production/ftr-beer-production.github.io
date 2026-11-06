# Auditoria de segurança: Painel FTR (Supabase compartilhado com o CIP)

Feita em 06/11/2026, **somente leitura** na produção (consultas a catálogo e advisors). Nenhum objeto do CIP foi lido em detalhe nem alterado.

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

Dados: 11 meses publicados, 16 publicações. As revisões 2026-10 r1–r2 e 2026-11 r1–r3 já perderam os dados (só restam os metadados). As r2 e r3 de 2026-11 têm o mesmo conteúdo, ou seja, foram uma republicação acidental. A nova detecção de conteúdo idêntico impede isso.

## O que a melhoria acrescenta

- O histórico (`painel_month_versions`) e as publicações ficam **só-inclusão**, por triggers. Nem a `service_role` altera ou apaga uma linha.
- O histórico fica fora da API pública: RLS sem políticas e acesso revogado de `public`, `anon` e `authenticated`. O teste T2 confirma.
- As funções novas são SECURITY DEFINER com `search_path = public, pg_temp`, e o EXECUTE é só da `service_role`.
- Concorrência: o advisory lock é único para v1, v2 e restauração, e cada operação confere a revisão esperada.
- A Edge Function aplica o login, a lista de publicadores e a origem a **todas** as ações, inclusive leitura de versões e backup. O corpo da requisição só é lido depois da autorização.
- Mensagens de erro não expõem detalhes internos. Os testes confirmam que nenhuma resposta contém chave secreta.
- Exportações e o backup local são gerados no navegador. Nenhum serviço externo ou pago foi incluído.

## Limitações conhecidas

- A integridade do backup usa FNV-1a, que detecta corrupção ou edição acidental, mas **não** adulteração deliberada com recálculo.
- "Quem publicou" vem só pela Edge Function, para publicadores logados. Quem consulta sem login não vê nomes nem e-mails.
- As exportações não exigem login, porque só contêm dados que o painel já mostra publicamente.
