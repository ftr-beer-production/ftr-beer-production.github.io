-- Testes automatizados da migration 20261109120000 (executar em banco ISOLADO, nunca em produção).
-- Cada bloco falha com exceção se o resultado não for o esperado.
\set ON_ERROR_STOP on
create schema if not exists teste;
create or replace function teste.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is distinct from true then raise exception 'FALHOU: %', msg; end if; raise notice 'ok - %', msg; end $$;
-- executa SQL esperando um erro com SQLSTATE e trecho de mensagem
create or replace function teste.erro(sql text, estado text, trecho text, msg text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if sqlstate = estado and position(trecho in sqlerrm) > 0 then raise notice 'ok - %', msg; return; end if;
    raise exception 'FALHOU: % (veio % "%")', msg, sqlstate, sqlerrm;
  end;
  raise exception 'FALHOU: % (nenhum erro)', msg;
end $$;
grant usage on schema teste to anon, authenticated, service_role;
grant execute on all functions in schema teste to anon, authenticated, service_role;

-- T1 · backfill: a versão vigente de cada mês foi copiada com os dados completos
select teste.ok((select count(*) from painel_month_versions) = 11, 'T1 backfill criou 11 versões (uma por mês)');
select teste.ok(not exists (select 1 from painel_months m join painel_month_versions v using (period_key)
                 where v.revision <> m.revision or v.data <> m.data or v.checksum <> m.checksum or v.file_name <> m.file_name
                    or v.action <> 'backfill'), 'T1 versões copiadas são idênticas a painel_months (revisão, dados, checksum, arquivo)');
select teste.ok((select published_by from painel_month_versions where period_key = '2026-11') = 'publicador@teste.local',
                'T1 publicador recuperado da auditoria');
select teste.ok(not exists (select 1 from painel_month_versions where period_key = '2026-10' and revision < 3),
                'T1 revisões sobrescritas antes da migration não são inventadas');
select teste.ok((select count(*) from painel_publications where action = 'publish') = 16, 'T1 auditoria antiga marcada como publish');

-- T2 · permissões públicas inalteradas e histórico privado
set role anon;
select teste.ok((select count(*) from painel_months) = 11, 'T2 anon lê painel_months');
select teste.ok((select count(*) from painel_current) = 1, 'T2 anon lê painel_current');
select teste.erro('select * from painel_month_versions', '42501', 'permission denied', 'T2 anon NÃO lê painel_month_versions');
select teste.erro('select * from painel_publications', '42501', 'permission denied', 'T2 anon NÃO lê painel_publications');
select teste.erro('select * from painel_publicadores', '42501', 'permission denied', 'T2 anon NÃO lê painel_publicadores');
select teste.erro($q$select painel_publish_v2('2026-12','x.xlsx','c','{}'::jsonb,null,'a@b')$q$, '42501', 'permission denied', 'T2 anon NÃO executa painel_publish_v2');
select teste.erro($q$select painel_restore_version('2026-11',4,'a@b')$q$, '42501', 'permission denied', 'T2 anon NÃO executa painel_restore_version');
select teste.erro($q$select painel_publish('2026-12','x.xlsx','c','{}'::jsonb,null,'a@b')$q$, '42501', 'permission denied', 'T2 anon NÃO executa painel_publish (v1)');
select teste.erro($q$update painel_months set revision = 99$q$, '42501', 'permission denied', 'T2 anon NÃO grava em painel_months');
reset role;
set role authenticated;
select teste.erro('select * from painel_month_versions', '42501', 'permission denied', 'T2 authenticated NÃO lê painel_month_versions');
select teste.erro($q$select painel_restore_version('2026-11',4,'a@b')$q$, '42501', 'permission denied', 'T2 authenticated NÃO executa painel_restore_version');
reset role;

set role service_role;
-- T3 · publicação de um mês novo
select teste.ok((painel_publish_v2('2026-12','arquivo 12.xlsx','ck12r1','{"file":"arquivo 12.xlsx","period":{"m":11,"y":2026}}'::jsonb,'{"key":"2026-12"}'::jsonb,'publicador@teste.local',true,0)->>'revision')::int = 1,
                'T3 mês novo publicado como revisão 1 (revisão esperada 0)');
select teste.ok((select action || '|' || set_current || '|' || (data->>'file') from painel_month_versions where period_key='2026-12' and revision=1) = 'publish|true|arquivo 12.xlsx',
                'T3 versão completa gravada pelo gatilho');
select teste.ok((select period_key from painel_current) = '2026-12', 'T3 versão corrente atualizada');

-- T4 · nova revisão preserva as anteriores
select teste.ok((painel_publish_v2('2026-11','arquivo 11 corrigido.xlsx','ck11r5','{"file":"arquivo 11 corrigido.xlsx","period":{"m":10,"y":2026},"ftrGeral":0.93}'::jsonb,null,'publicador@teste.local',true,4)->>'revision')::int = 5,
                'T4 nova revisão 5 de 2026-11');
select teste.ok((select data->>'ftrGeral' from painel_month_versions where period_key='2026-11' and revision=4) = '0.88', 'T4 dados da revisão 4 preservados');
select teste.ok((select via from painel_month_versions where period_key='2026-11' and revision=5) = 'v2'
            and (select via from painel_publications where period_key='2026-11' and revision=5) = 'v2', 'T4 publicação moderna registrada com via = v2');
select teste.ok((select data->>'ftrGeral' from painel_month_versions where period_key='2026-11' and revision=5) = '0.93', 'T4 dados da revisão 5 gravados');
select teste.ok((select data->>'ftrGeral' from painel_months where period_key='2026-11') = '0.93', 'T4 painel_months mostra a revisão 5');

-- T5 · conteúdo idêntico é recusado e nada muda
select teste.erro($q$select painel_publish_v2('2026-11','outro nome.xlsx','ck11r5','{"a":1}'::jsonb,null,'publicador@teste.local',true,5)$q$, 'PT409', 'conteudo_identico', 'T5 republicação idêntica recusada');
select teste.erro($q$select painel_publish_v2('2026-11','x.xlsx','checksum-diferente','{"ftrGeral":0.93,"period":{"y":2026,"m":10},"file":"arquivo 11 corrigido.xlsx"}'::jsonb,null,'publicador@teste.local',true,5)$q$, 'PT409', 'conteudo_identico', 'T5 mesmo conteúdo com outro checksum (chaves em outra ordem) recusado');
select teste.ok((select revision from painel_months where period_key='2026-11') = 5 and (select count(*) from painel_month_versions where period_key='2026-11') = 2,
                'T5 nenhuma revisão criada pela tentativa idêntica');

-- T6a · fluxo moderno sem revisão esperada é recusado (nunca publica "às cegas")
select teste.erro($q$select painel_publish_v2('2026-11','x.xlsx','ck11sem','{"a":1}'::jsonb,null,'publicador@teste.local',true,null)$q$, 'PT428', 'revisao_esperada_ausente', 'T6a v2 sem revisão esperada recusada');
select teste.erro($q$select painel_publish_v2('2026-11','x.xlsx','ck11sem','{"a":1}'::jsonb,null,'publicador@teste.local')$q$, 'PT428', 'revisao_esperada_ausente', 'T6a v2 com revisão esperada omitida recusada');
select teste.erro($q$select painel_restore_version('2026-11',4,'publicador@teste.local',false,null)$q$, 'PT428', 'revisao_esperada_ausente', 'T6a recuperação sem revisão esperada recusada');
select teste.ok((select revision from painel_months where period_key='2026-11') = 5, 'T6a nada foi gravado sem revisão esperada');

-- T6 · revisão esperada desatualizada (publicação concorrente) é recusada
select teste.erro($q$select painel_publish_v2('2026-11','x.xlsx','ck11novo','{"a":1}'::jsonb,null,'publicador@teste.local',true,4)$q$, 'PT409', 'revisao_alterada', 'T6 conferência desatualizada recusada');
select teste.ok((select revision from painel_months where period_key='2026-11') = 5, 'T6 nada foi gravado');

-- T7 · recuperação de versão antiga vira NOVA revisão
select teste.ok((painel_restore_version('2026-11',4,'publicador@teste.local',false,5)->>'revision')::int = 6, 'T7 recuperação da r4 criou a revisão 6');
select teste.ok((select action || '|' || restored_from_revision || '|' || checksum from painel_month_versions where period_key='2026-11' and revision=6) = 'restore|4|ck11r4',
                'T7 versão 6 registrada como recuperação da r4');
select teste.ok((select data from painel_months where period_key='2026-11') = (select data from painel_month_versions where period_key='2026-11' and revision=4),
                'T7 dados vigentes = dados da r4');
select teste.ok((select count(*) from painel_month_versions where period_key='2026-11') = 3, 'T7 versões 4 e 5 preservadas');
select teste.ok((select action || '|' || restored_from_revision from painel_publications where period_key='2026-11' order by id desc limit 1) = 'restore|4',
                'T7 auditoria registra a recuperação');
-- 2026-11 voltou a ser o corrente no T4: o ponteiro acompanha o conteúdo recuperado
select teste.ok((select period_key || '|' || checksum from painel_current) = '2026-11|ck11r4', 'T7 corrente acompanha o conteúdo recuperado do próprio mês');

-- T8 · recuperar o conteúdo que já está vigente é recusado
select teste.erro($q$select painel_restore_version('2026-11',4,'publicador@teste.local',false,6)$q$, 'PT409', 'conteudo_identico', 'T8 recuperação idêntica ao vigente recusada');

-- T9 · versões e meses inexistentes
select teste.erro($q$select painel_restore_version('2026-10',1,'publicador@teste.local',false,3)$q$, 'PT404', 'versao_inexistente', 'T9 revisão sobrescrita antes da migration não existe para recuperação');
select teste.erro($q$select painel_restore_version('2030-01',1,'publicador@teste.local',false,0)$q$, 'PT404', 'mes_inexistente', 'T9 mês inexistente');
select teste.erro($q$select painel_restore_version('2026-11',5,'publicador@teste.local',false,99)$q$, 'PT409', 'revisao_alterada', 'T9 recuperação com conferência desatualizada recusada');

-- T10 · histórico e auditoria são somente-inclusão (inclusive para o servidor)
select teste.erro($q$update painel_month_versions set data='{}' where period_key='2026-11'$q$, '42501', 'historico_somente_inclusao', 'T10 UPDATE no histórico bloqueado');
select teste.erro($q$delete from painel_month_versions where period_key='2026-11'$q$, '42501', 'historico_somente_inclusao', 'T10 DELETE no histórico bloqueado');
select teste.erro($q$truncate painel_month_versions$q$, '42501', 'historico_somente_inclusao', 'T10 TRUNCATE no histórico bloqueado');
select teste.erro($q$delete from painel_publications$q$, '42501', 'historico_somente_inclusao', 'T10 DELETE na auditoria bloqueado');
select teste.erro($q$update painel_publications set published_by='x'$q$, '42501', 'historico_somente_inclusao', 'T10 UPDATE na auditoria bloqueado');

-- T11 · a função antiga (v1) continua funcionando e também gera versão completa
select teste.ok((painel_publish('2026-10','arquivo 10 v4.xlsx','ck10r4','{"file":"arquivo 10 v4.xlsx","period":{"m":9,"y":2026}}'::jsonb,null,'publicador@teste.local',false)->>'revision')::int = 4,
                'T11 painel_publish v1 compatível');
select teste.ok((select action || '|' || (data->>'file') from painel_month_versions where period_key='2026-10' and revision=4) = 'publish|arquivo 10 v4.xlsx',
                'T11 publicação pela v1 capturada no histórico');
select teste.ok((select via from painel_month_versions where period_key='2026-10' and revision=4) = 'v1', 'T11 publicação pelo caminho de compatibilidade identificada (via = v1)');
-- recuperar um mês que NÃO é o corrente, sem pedir troca: o corrente não muda
select teste.ok((painel_restore_version('2026-10',3,'publicador@teste.local',false,4)->>'current_set')::boolean is false, 'T11 recuperação de mês não corrente');
select teste.ok((select period_key || '|' || checksum from painel_current) = '2026-11|ck11r4', 'T11 corrente preservado ao recuperar mês não corrente');

-- T12 · atomicidade: auditoria sem versão correspondente aborta tudo
select teste.erro($q$insert into painel_publications (period_key,file_name,checksum,published_by,set_current,replaced,revision) values ('2026-10','x','nao-confere','a',false,true,5)$q$,
                'P0001', 'versao_inconsistente', 'T12 auditoria inconsistente recusada pelo gatilho');
select teste.ok(not exists (select 1 from painel_publications where checksum='nao-confere'), 'T12 nenhuma linha gravada');

-- T13 · recuperar o mês corrente mantém o ponteiro coerente
select painel_publish_v2('2026-12','arquivo 12 v2.xlsx','ck12r2','{"file":"arquivo 12 v2.xlsx","period":{"m":11,"y":2026}}'::jsonb,null,'publicador@teste.local',true,1);
select teste.ok((painel_restore_version('2026-12',1,'publicador@teste.local',false,2)->>'current_set')::boolean, 'T13 recuperar o mês corrente atualiza o ponteiro');
select teste.ok((select checksum from painel_current) = 'ck12r1', 'T13 painel_current aponta para o conteúdo recuperado');

-- T15 · recuperação: mesmo critério de conteúdo idêntico da publicação (checksum OU JSONB)
--   preparação pela v1 (que não recusa idênticos), para montar versões com checksum e
--   conteúdo combinados de propósito:
--   r1 ck 'A' dados d1 · r2 ck 'A' dados d2 · r3 ck 'B' d2 com chaves em outra ordem · r4 ck 'C' d2 idêntico
select painel_publish('2027-01','j1.xlsx','ckA','{"a":1,"b":{"x":1,"y":2},"period":{"m":0,"y":2027}}'::jsonb,null,'publicador@teste.local',false);
select painel_publish('2027-01','j2.xlsx','ckA','{"a":2,"b":{"x":1,"y":2},"period":{"m":0,"y":2027}}'::jsonb,null,'publicador@teste.local',false);
select teste.erro($q$select painel_restore_version('2027-01',1,'publicador@teste.local',false,2)$q$, 'PT409', 'conteudo_identico', 'T15.2 checksum igual ao vigente (dados diferentes): recuperação recusada');
select painel_publish('2027-01','j3.xlsx','ckB','{"period":{"y":2027,"m":0},"b":{"y":2,"x":1},"a":2}'::jsonb,null,'publicador@teste.local',false);
select teste.erro($q$select painel_restore_version('2027-01',2,'publicador@teste.local',false,3)$q$, 'PT409', 'conteudo_identico', 'T15.4 JSONB igual com chaves em outra ordem e checksum diferente: recusada');
select painel_publish('2027-01','j4.xlsx','ckC','{"a":2,"b":{"x":1,"y":2},"period":{"m":0,"y":2027}}'::jsonb,null,'publicador@teste.local',false);
select teste.erro($q$select painel_restore_version('2027-01',3,'publicador@teste.local',false,4)$q$, 'PT409', 'conteudo_identico', 'T15.3 checksum diferente e JSONB igual: recusada');
select teste.ok((select revision from painel_months where period_key='2027-01') = 4, 'T15 nenhuma revisão criada pelas tentativas idênticas');
select teste.ok((painel_restore_version('2027-01',1,'publicador@teste.local',false,4)->>'revision')::int = 5, 'T15.1 versão realmente diferente: nova revisão 5');
select teste.ok((select (data->>'a') || '|' || checksum from painel_months where period_key='2027-01') = '1|ckA', 'T15.1 conteúdo da r1 vigente na r5');
select teste.erro($q$select painel_restore_version('2027-01',2,'publicador@teste.local',false,4)$q$, 'PT409', 'revisao_alterada', 'T15.5 recuperação após publicação concorrente recusada');
select teste.ok((select count(*) from painel_month_versions where period_key='2027-01') = 5
            and (select string_agg(revision || ':' || (data->>'a'), ',' order by revision) from painel_month_versions where period_key='2027-01') = '1:1,2:2,3:2,4:2,5:1'
            and (select count(*) from painel_publications where period_key='2027-01') = 5,
                'T15.6 histórico completo preservado (r1–r5 com os dados originais)');
reset role;

-- T14 · coerência final da leitura pública
set role anon;
select teste.ok((select c.checksum = m.checksum and c.file_name = m.file_name from painel_current c join painel_months m using (period_key)),
                'T14 painel_current coerente com painel_months');
reset role;
select teste.ok((select count(*) from painel_publications p where not exists
                  (select 1 from painel_month_versions v where v.publication_id = p.id)) = 5,
                'T14 toda publicação tem versão completa, exceto as 5 revisões já sobrescritas antes da migration');
