#!/usr/bin/env bash
# Executa todas as suítes de teste do painel, em ambiente isolado (nada toca o Supabase de produção).
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== 1/4 Banco (PostgreSQL temporário)"; bash tests/sql/executar.sh
echo "== 2/4 Edge Function (fetch simulado)"; node --experimental-strip-types --no-warnings --test tests/edge.test.mjs
echo "== 3/4 Funções do painel (regressão e novas)"; node --test tests/painel.test.mjs
echo "== 4/4 Ponta a ponta (navegador + banco temporário)"; node --experimental-strip-types --no-warnings tests/e2e/painel.e2e.mjs
echo "== TODAS AS SUÍTES PASSARAM"
