# Recomendação técnica: guardar o arquivo Excel original (NÃO implementado)

## Situação atual

O histórico de versões guarda os **dados interpretados** de cada planilha, não os bytes do `.xlsx`. Uma versão recuperada reproduz os indicadores, os lotes e as leituras, mas não o arquivo com as outras abas, as fórmulas e a formatação. Ver a seção 2.1 de [MELHORIAS.md](MELHORIAS.md).

Para a finalidade do painel (indicadores FTR), isso basta: tudo o que o painel mostra ou exporta vem dos dados interpretados, e eles são reproduzidos exatamente. O arquivo original só seria necessário para auditoria do documento de origem, ou para reprocessar se as regras de leitura mudarem no futuro.

## Opção recomendada, se for desejado: Supabase Storage em bucket privado

1. **Bucket privado** `painel-xlsx`. Sem política de leitura pública e sem acesso para `anon`/`authenticated`. Só a Edge Function, com a chave secreta, grava e lê.
2. **Envio pela Edge Function**, junto com a publicação. O navegador manda o arquivo; a Edge confere o login, a lista de publicadores, o tamanho máximo, o tipo `.xlsx` e o sha256, e grava em `painel-xlsx/<período>/r<revisão>-<sha256>.xlsx`.
3. **Ligação com o histórico**: colunas novas `source_sha256` e `source_path` em `painel_month_versions`, preenchidas na mesma operação. Como o Storage não participa da transação do Postgres, a ordem segura é: gravar o arquivo primeiro (nome por sha256, idempotente) e depois a publicação. Arquivos órfãos de publicações recusadas podem ser limpos depois.
4. **Download** só para publicadores, por uma ação nova da Edge (por exemplo, URL assinada de curta duração).
5. **Imutabilidade**: sem sobrescrita (nome por sha256) e sem exclusão pela Edge.
6. **Backup do servidor**: os arquivos não entrariam no JSON. Seriam listados com o sha256 e baixados à parte, se necessário.

## Decisões necessárias antes de implementar

| Tema | Pergunta |
|---|---|
| Espaço | Qual o tamanho típico de cada planilha mensal? O plano gratuito do Supabase tem limite de armazenamento e de tráfego. É preciso conferir o limite atual no painel de uso do projeto, que também é usado pelo CIP. |
| Retenção | Guardar todas as revisões para sempre, ou só a última de cada mês? |
| Permissões | Quem pode baixar o arquivo original: só publicadores, ou um grupo maior? |
| Sigilo | A planilha tem abas ou informações que hoje não são publicadas e que não deveriam ficar no Supabase? |
| Custo | Se o volume ultrapassar o plano gratuito, haverá custo, o que exige sua autorização. |
| Compartilhamento | O bucket ficaria no mesmo projeto do CIP: definir nome e políticas para não interferir. |

## Alternativa sem infraestrutura nova

Manter o processo atual e guardar o `.xlsx` mensal no repositório de documentos que a área já usa (por exemplo, a rede ou o SharePoint da empresa), com o mesmo nome usado na publicação e a revisão no nome da pasta ou do arquivo. O histórico do painel guarda o nome do arquivo, a data e a revisão, o que permite associar cada versão ao arquivo guardado fora. Atenção: o "checksum" do painel identifica os **dados interpretados**, não os bytes do arquivo. Ele não serve para provar que um `.xlsx` guardado fora é exatamente o que foi publicado.
