#!/usr/bin/env bash
# Testes do banco do Painel FTR num PostgreSQL LOCAL e TEMPORÁRIO (nunca toca a produção).
# Uso: bash tests/sql/executar.sh        (requer PostgreSQL 15+ instalado: initdb, pg_ctl, psql)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="$(mktemp -d)"; PORTA="${PORTA:-54329}"
export PGHOST="$DIR" PGPORT="$PORTA" PGDATABASE=ftr_teste
RUN_AS=""; if [ "$(id -u)" = "0" ]; then chown -R postgres "$DIR"; RUN_AS="runuser -u postgres --"; export PGUSER=postgres; fi
trap '$RUN_AS "$PGBIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
$RUN_AS "$PGBIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
$RUN_AS "$PGBIN/pg_ctl" -D "$DIR/data" -o "-k $DIR -p $PORTA -c listen_addresses=''" -l "$DIR/log" start -w >/dev/null
P() { "$PGBIN/psql" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
"$PGBIN/createdb" -U postgres ftr_teste

echo "== esquema atual (painel_ftr.sql + painel_publicadores.sql) e dados fictícios"
P -f "$RAIZ/tests/sql/00_papeis_supabase.sql"
P -f "$RAIZ/supabase/painel_ftr.sql" 2>&1 | grep -v NOTIFY || true
P -f "$RAIZ/supabase/painel_publicadores.sql"
P -f "$RAIZ/tests/sql/01_dados_ficticios.sql"

echo "== migration 20261109120000 (duas vezes: deve ser idempotente)"
P -f "$RAIZ/supabase/migrations/20261109120000_painel_versoes.sql"
P -f "$RAIZ/supabase/migrations/20261109120000_painel_versoes.sql"

echo "== testes funcionais e de segurança"
P -f "$RAIZ/tests/sql/10_testes_versoes.sql" 2>&1 | sed -n -e 's/^psql:.*NOTICE:  //p' -e '/ERRO/p'

echo "== publicações simultâneas (duas sessões conferiram a mesma revisão)"
REV=$(P -At -c "select revision from painel_months where period_key='2026-09'")
( P -c "set role service_role; begin; select painel_publish_v2('2026-09','a.xlsx','conc-A','{\"a\":1}'::jsonb,null,'publicador@teste.local',false,$REV); select pg_sleep(2); commit;" >"$DIR/a.out" 2>&1; echo $? >"$DIR/a.rc" ) &
sleep 0.5
set +e; P -c "set role service_role; select painel_publish_v2('2026-09','b.xlsx','conc-B','{\"b\":1}'::jsonb,null,'publicador@teste.local',false,$REV);" >"$DIR/b.out" 2>&1; RCB=$?; set -e
wait
RCA=$(cat "$DIR/a.rc")
if [ "$RCA" = "0" ] && [ "$RCB" != "0" ] && grep -q revisao_alterada "$DIR/b.out"; then echo "ok - a primeira publicação venceu e a segunda foi recusada (revisao_alterada)"; else echo "FALHOU: concorrência (A=$RCA B=$RCB)"; cat "$DIR/a.out" "$DIR/b.out"; exit 1; fi
[ "$(P -At -c "select revision||'|'||checksum from painel_months where period_key='2026-09'")" = "$((REV+1))|conc-A" ] && echo "ok - somente a revisão $((REV+1)) foi criada" || { echo "FALHOU: estado após concorrência"; exit 1; }

echo "== recuperação durante uma publicação concorrente (mesma revisão conferida)"
REV=$(P -At -c "select revision from painel_months where period_key='2026-09'")
( P -c "set role service_role; begin; select painel_publish_v2('2026-09','c.xlsx','conc-C','{\"c\":1}'::jsonb,null,'publicador@teste.local',false,$REV); select pg_sleep(2); commit;" >"$DIR/c.out" 2>&1; echo $? >"$DIR/c.rc" ) &
sleep 0.5
set +e; P -c "set role service_role; select painel_restore_version('2026-09',1,'publicador@teste.local',false,$REV);" >"$DIR/d.out" 2>&1; RCD=$?; set -e
wait
if [ "$(cat "$DIR/c.rc")" = "0" ] && [ "$RCD" != "0" ] && grep -q revisao_alterada "$DIR/d.out"; then echo "ok - a recuperação esperou a publicação em andamento e foi recusada (revisao_alterada)"; else echo "FALHOU: recuperação concorrente"; cat "$DIR/c.out" "$DIR/d.out"; exit 1; fi
[ "$(P -At -c "select revision||'|'||checksum from painel_months where period_key='2026-09'")" = "$((REV+1))|conc-C" ] && echo "ok - só a publicação foi gravada; nenhuma revisão extra" || { echo "FALHOU: estado após recuperação concorrente"; exit 1; }

echo "== caminho de compatibilidade (v1) grava histórico completo depois da migration"
V=$(P -At -c "set role service_role; select painel_publish('2026-09','legado.xlsx','ck-legado','{\"legado\":true}'::jsonb,null,'publicador@teste.local',false)->>'revision'")
[ "$(P -At -c "select action||'|'||via||'|'||(data->>'legado')||'|'||file_name from painel_month_versions where period_key='2026-09' and revision=$V")" = "publish|v1|true|legado.xlsx" ] && echo "ok - publicação pela v1 (painel antigo) capturada com os dados completos (r$V)" || { echo "FALHOU: captura da v1"; exit 1; }

echo "== rollback (não destrutivo) e reaplicação"
IDX_ANTES=$(P -At -c "select count(*) from pg_index where indrelid='public.painel_month_versions'::regclass")
ANTES=$(P -At -c "select count(*) from painel_month_versions")
P -f "$RAIZ/supabase/rollback/20261109120000_painel_versoes_rollback.sql" 2>&1 | grep -v NOTIFY || true
T=$(P -At -c "select relname from pg_class where relname like 'painel_month_versions_rollback_%' and relkind='r'")
[ -n "$T" ] && [ "$(P -At -c "select count(*) from public.$T")" = "$ANTES" ] && echo "ok - histórico preservado em $T ($ANTES versões)" || { echo "FALHOU: histórico não preservado"; exit 1; }
[ "$(P -At -c "select count(*) from pg_index where indrelid='public.$T'::regclass")" = "$IDX_ANTES" ] && [ "$(P -At -c "select count(*) from pg_class where relname like 'painel_month_versions_id_seq_rb_%' and relkind='S'")" = "1" ] && [ -n "$(P -At -c "select pg_get_serial_sequence('public.$T','id')")" ] && echo "ok - índices ($IDX_ANTES) e sequência preservados e ligados à tabela arquivada" || { echo "FALHOU: índices/sequência"; exit 1; }
[ "$(P -At -c "select relrowsecurity from pg_class where relname='$T'")" = "t" ] && echo "ok - RLS continua ligado na tabela arquivada" || { echo "FALHOU: RLS do arquivo"; exit 1; }
[ "$(P -At -c "set role service_role; delete from public.$T" 2>&1 | grep -c 'permission denied')" = "1" ] && [ "$(P -At -c "set role service_role; select count(*) from public.$T")" = "$ANTES" ] && echo "ok - service_role só lê o arquivo (não altera nem apaga)" || { echo "FALHOU: arquivo alterável pela service_role"; exit 1; }
[ "$(P -At -c "select count(*) from information_schema.columns where table_name='painel_publications' and column_name in ('action','restored_from_revision','via')")" = "0" ] && echo "ok - colunas novas removidas" || { echo "FALHOU: colunas"; exit 1; }
[ "$(P -At -c "select count(*) from pg_proc where proname in ('painel_publish_v2','painel_restore_version','painel_capture_version','painel_block_change')")" = "0" ] && echo "ok - funções novas removidas" || { echo "FALHOU: funções"; exit 1; }
P -At -c "set role service_role; select painel_publish('2026-08','v1.xlsx','ck-v1-pos-rollback','{\"x\":1}'::jsonb,null,'publicador@teste.local',false)->>'revision'" >/dev/null && echo "ok - painel_publish v1 funciona após o rollback"
[ "$(P -At -c "set role anon; select count(*) from public.$T" 2>&1 | grep -c 'permission denied')" = "1" ] && echo "ok - tabela preservada continua privada" || { echo "FALHOU: tabela preservada acessível"; exit 1; }
P -f "$RAIZ/supabase/migrations/20261109120000_painel_versoes.sql"
[ "$(P -At -c "select count(*) from painel_month_versions where action='backfill'")" = "$(P -At -c "select count(*) from painel_months")" ] && echo "ok - migration reaplicada após o rollback sem conflito de nomes" || { echo "FALHOU: reaplicação"; exit 1; }
V=$(P -At -c "set role service_role; select painel_publish('2026-08','v1b.xlsx','ck-v1-pos-reaplicacao','{\"y\":1}'::jsonb,null,'publicador@teste.local',false)->>'revision'")
[ "$(P -At -c "select count(*) from painel_month_versions where period_key='2026-08' and revision=$V")" = "1" ] && [ "$(P -At -c "select count(*) from public.$T")" = "$ANTES" ] && echo "ok - após reaplicar, a v1 volta a gravar histórico e o arquivo segue intacto" || { echo "FALHOU: pós-reaplicação"; exit 1; }
[ "$(P -At -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','S','i') and c.relname not like 'painel\_%'")" = "0" ] && [ "$(P -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like 'painel\_%'")" = "0" ] && echo "ok - migration e rollback só criam objetos painel_* no schema public" || { echo "FALHOU: objetos fora do prefixo painel_"; exit 1; }
echo "== TODOS OS TESTES DO BANCO PASSARAM"
