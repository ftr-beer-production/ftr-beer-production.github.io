// Testes da Edge Function painel-publish com o Supabase simulado (sem rede, sem produção).
// Uso: node --experimental-strip-types --no-warnings --test tests/edge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'edge-'));
copyFileSync(join(RAIZ, 'supabase/functions/painel-publish/index.ts'), join(tmp, 'edge.ts'));
const { handle, canonical } = await import(join(tmp, 'edge.ts'));
import { ambiente } from './lib/painel.mjs';

// Dados reais embutidos no painel (outubro/2026), usados como carga de publicação
function dadosEmbutidos() {
  const html = readFileSync(join(RAIZ, 'docs/index.html'), 'utf8');
  const i = html.indexOf('let D={') + 6;
  let n = 0, j = i, s = false, e = false;
  for (; j < html.length; j++) {
    const c = html[j];
    if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; }
    if (c === '"') s = true; else if (c === '{') n++; else if (c === '}' && --n === 0) break;
  }
  return JSON.parse(html.slice(i, j + 1));
}
const D = dadosEmbutidos();
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const DJSON = JSON.stringify(D), DCK = fnv(DJSON);
const O = 'https://ftr-beer-production.github.io';
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_a"}', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_NUNCA_EXPOR"}' };
const env = (o = ENV) => (k) => o[k];

// Supabase simulado: rotas -> respostas; registra as chamadas
let calls = [], routes = {};
const J = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (u, o = {}) => {
  const url = new URL(u), method = o.method || 'GET';
  calls.push({ path: url.pathname, search: decodeURIComponent(url.search), method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
  if (url.pathname === '/auth/v1/user') {
    const a = o.headers.Authorization;
    if (a === 'Bearer bom') return J(200, { email: 'Pub@Heiway.net', email_confirmed_at: 'x' });
    if (a === 'Bearer outro') return J(200, { email: 'z@x.com', email_confirmed_at: 'x' });
    if (a === 'Bearer naoconf') return J(200, { email: 'pub@heiway.net' });
    return J(401, {});
  }
  if (url.pathname === '/rest/v1/painel_publicadores') return J(200, url.search.includes(encodeURIComponent('pub@heiway.net')) ? [{ email: 'pub@heiway.net' }] : []);
  const key = method + ' ' + url.pathname;
  const r = routes[key];
  if (!r) return J(404, { code: 'PGRST202', message: 'Could not find the function ' + key });
  return typeof r === 'function' ? r(url, o) : J(...r);
};
const reset = (r = {}) => { calls = []; routes = r; };
const req = (body, { tok = 'bom', origin = O, method = 'POST' } = {}) => new Request('https://x.supabase.co/functions/v1/painel-publish', {
  method, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: method === 'POST' ? JSON.stringify(body) : undefined });
const call = async (body, opt) => { const r = await handle(req(body, opt), env()); const txt = await r.text(); assert.ok(!txt.includes('sb_secret'), 'resposta nunca contém a chave secreta'); return { status: r.status, j: txt ? JSON.parse(txt) : null, r }; };
const pub = (extra = {}) => ({ file: D.file, periodKey: '2026-10', checksum: DCK, dataJson: DJSON, ...extra });
const okPublish = () => J(200, { period_key: '2026-10', published_at: '2026-11-06T20:00:00Z', revision: 4, previous_revision: 3, replaced: true, current_set: true, action: 'publish' });

test('preflight e origem', async () => {
  reset();
  let r = await handle(req(null, { method: 'OPTIONS' }), env()); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), O);
  r = await handle(req(null, { method: 'OPTIONS', origin: 'https://mal.com' }), env()); assert.equal(r.status, 403);
  assert.equal((await call(pub(), { origin: 'https://mal.com' })).status, 403);
  assert.equal((await call(pub(), { method: 'GET' })).status, 405);
});

test('autenticação e autorização valem para TODAS as ações', async () => {
  for (const action of ['publish', 'restore', 'versions', 'version', 'backup', 'verify_backup']) {
    reset();
    assert.equal((await call({ action }, { tok: null })).status, 401, action + ' sem login');
    assert.equal((await call({ action }, { tok: 'ruim' })).status, 401, action + ' token inválido');
    assert.equal((await call({ action }, { tok: 'outro' })).status, 403, action + ' não autorizado');
    assert.equal((await call({ action }, { tok: 'naoconf' })).status, 403, action + ' e-mail não confirmado');
    assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc') || c.path.includes('versions')), action + ': nada consultado/gravado sem autorização');
  }
});

test('publicar: usa painel_publish_v2 com revisão esperada e resumo calculado no servidor', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': okPublish });
  const { status, j } = await call(pub({ expectedRevision: 3 }));
  assert.equal(status, 200); assert.equal(j.revision, 4); assert.equal(j.previousRevision, 3); assert.equal(j.legacy, false);
  const rpc = calls.find((c) => c.path === '/rest/v1/rpc/painel_publish_v2');
  assert.equal(rpc.body.p_expected_revision, 3); assert.equal(rpc.body.p_published_by, 'pub@heiway.net'); assert.equal(rpc.body.p_set_current, true);
  assert.equal(rpc.body.p_summary.key, '2026-10'); assert.ok(rpc.body.p_summary.stages.bh.lots > 0);
  assert.equal(rpc.headers.apikey, 'sb_secret_NUNCA_EXPOR'); assert.ok(!rpc.headers.Authorization, 'chave sb_secret vai só no apikey');
});

test('publicar: conteúdo idêntico e conferência desatualizada viram 409 com código', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': [409, { code: 'PT409', message: 'conteudo_identico', details: '{"current": 3}', hint: null }] });
  let { status, j } = await call(pub({ expectedRevision: 3 }));
  assert.equal(status, 409); assert.equal(j.code, 'conteudo_identico'); assert.equal(j.currentRevision, 3);
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': [409, { code: 'PT409', message: 'revisao_alterada', details: '{"expected": 3, "current": 4}', hint: null }] });
  ({ status, j } = await call(pub({ expectedRevision: 3 })));
  assert.equal(status, 409); assert.equal(j.code, 'revisao_alterada'); assert.equal(j.currentRevision, 4); assert.equal(j.expectedRevision, 3);
});

test('publicar (moderno): protocolo 2 sem revisão esperada é recusado com 428 e nada é gravado', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': okPublish, 'POST /rest/v1/rpc/painel_publish': okPublish });
  for (const extra of [{ protocol: 2 }, { protocol: 2, expectedRevision: null }, { expectedRevision: null }, { expectedRevision: undefined, protocol: 2 }]) {
    const { status, j } = await call(pub(extra));
    assert.equal(status, 428, JSON.stringify(extra)); assert.equal(j.code, 'revisao_esperada_ausente');
  }
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc')), 'nem a v2 nem a v1 foram chamadas');
});

test('publicar (moderno): com revisão correta usa só a v2 e informa o caminho moderno', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': okPublish });
  const { status, j } = await call(pub({ protocol: 2, expectedRevision: 3 }));
  assert.equal(status, 200); assert.equal(j.legacy, false); assert.equal(j.path, 'moderno'); assert.ok(!j.notice);
  assert.ok(!calls.some((c) => c.path === '/rest/v1/rpc/painel_publish'));
});

test('publicar (moderno): v2 ausente no banco ou falha de rede NUNCA viram publicação sem conferência', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish': okPublish }); // v2 inexistente (migration pendente)
  let { status, j } = await call(pub({ protocol: 2, expectedRevision: 3 }));
  assert.equal(status, 501); assert.equal(j.code, 'migracao_pendente');
  assert.ok(!calls.some((c) => c.path === '/rest/v1/rpc/painel_publish'), 'não caiu para a v1');
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': () => { throw new TypeError('fetch failed'); }, 'POST /rest/v1/rpc/painel_publish': okPublish });
  ({ status, j } = await call(pub({ protocol: 2, expectedRevision: 3 })));
  assert.equal(status, 502); assert.ok(!calls.some((c) => c.path === '/rest/v1/rpc/painel_publish'), 'falha de rede não autoriza a v1');
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': [428, { code: 'PT428', message: 'revisao_esperada_ausente', details: null }] });
  ({ status, j } = await call(pub({ protocol: 2, expectedRevision: 3 })));
  assert.equal(status, 428); assert.equal(j.code, 'revisao_esperada_ausente');
});

test('publicar (compatibilidade): corpo do painel antigo (main) usa a v1, identificado como legado', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish': okPublish, 'POST /rest/v1/rpc/painel_publish_v2': okPublish });
  // exatamente o corpo que o publishData do main envia: {file, periodKey, checksum, dataJson, setCurrent}
  const antigo = { file: D.file, periodKey: '2026-10', checksum: DCK, dataJson: DJSON, setCurrent: true };
  const { status, j } = await call(antigo);
  assert.equal(status, 200); assert.equal(j.ok, true); assert.equal(j.revision, 4);
  assert.equal(j.legacy, true); assert.equal(j.path, 'compatibilidade'); assert.match(j.notice, /compatibilidade/);
  const v1 = calls.find((c) => c.path === '/rest/v1/rpc/painel_publish');
  assert.deepEqual(Object.keys(v1.body).sort(), ['p_checksum', 'p_data', 'p_file_name', 'p_period_key', 'p_published_by', 'p_set_current', 'p_summary'], 'v1 recebe os mesmos argumentos de antes');
  assert.ok(!calls.some((c) => c.path === '/rest/v1/rpc/painel_publish_v2'));
});

test('publicar (compatibilidade): pode ser desligado depois da transição (PAINEL_LEGACY_PUBLISH=off)', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish': okPublish, 'POST /rest/v1/rpc/painel_publish_v2': okPublish });
  const r = await handle(req(pub()), env({ ...ENV, PAINEL_LEGACY_PUBLISH: 'off' }));
  const j = await r.json(); assert.equal(r.status, 426); assert.equal(j.code, 'cliente_desatualizado');
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc')));
  const r2 = await handle(req(pub({ protocol: 2, expectedRevision: 3 })), env({ ...ENV, PAINEL_LEGACY_PUBLISH: 'off' }));
  assert.equal(r2.status, 200, 'o fluxo moderno continua funcionando');
  assert.equal((await call(pub({ protocol: 3, expectedRevision: 3 }))).status, 400, 'protocolo desconhecido recusado');
});

test('publicar: validações preservadas (checksum, período, revisão esperada)', async () => {
  reset({ 'POST /rest/v1/rpc/painel_publish_v2': okPublish });
  assert.equal((await call(pub({ checksum: '0' }))).status, 422);
  const r = await call(pub({ periodKey: '2026-11' })); assert.equal(r.status, 422); assert.ok(r.j.details.some((x) => x.includes('não confere')));
  assert.equal((await call(pub({ expectedRevision: -1 }))).status, 422);
  assert.equal((await call(pub({ expectedRevision: 1.5 }))).status, 422);
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc')), 'nada gravado quando a validação falha');
});

test('recuperar: exige revisão vigente conferida e mapeia os erros', async () => {
  reset();
  assert.equal((await call({ action: 'restore', periodKey: '2026-10', revision: 2 })).status, 428, 'sem revisão esperada');
  assert.equal((await call({ action: 'restore', periodKey: '2026-10', revision: 2, expectedRevision: null, protocol: 2 })).status, 428, 'revisão esperada nula');
  assert.equal((await call({ action: 'restore', periodKey: '2026-10', revision: 2, expectedRevision: 'x' })).status, 422);
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc')), 'recuperação sem conferência não chama o banco');
  assert.equal((await call({ action: 'restore', periodKey: '2026-10', revision: 0, expectedRevision: 3 })).status, 422);
  reset({ 'POST /rest/v1/rpc/painel_restore_version': () => J(200, { period_key: '2026-10', revision: 5, previous_revision: 4, restored_from_revision: 2, checksum: 'abc', file_name: 'f.xlsx', published_at: 't', current_set: false, action: 'restore' }) });
  let { status, j } = await call({ action: 'restore', periodKey: '2026-10', revision: 2, expectedRevision: 4, setCurrent: false });
  assert.equal(status, 200); assert.equal(j.revision, 5); assert.equal(j.restoredFromRevision, 2);
  const rpc = calls.find((c) => c.path === '/rest/v1/rpc/painel_restore_version');
  assert.deepEqual([rpc.body.p_revision, rpc.body.p_expected_revision, rpc.body.p_set_current, rpc.body.p_published_by], [2, 4, false, 'pub@heiway.net']);
  reset({ 'POST /rest/v1/rpc/painel_restore_version': [404, { code: 'PT404', message: 'versao_inexistente', details: null }] });
  ({ status, j } = await call({ action: 'restore', periodKey: '2026-10', revision: 1, expectedRevision: 4 }));
  assert.equal(status, 404); assert.equal(j.code, 'versao_inexistente');
  reset({ 'POST /rest/v1/rpc/painel_restore_version': [409, { code: 'PT409', message: 'conteudo_identico', details: '{"current":4}' }] });
  assert.equal((await call({ action: 'restore', periodKey: '2026-10', revision: 3, expectedRevision: 4 })).j.code, 'conteudo_identico');
  reset(); // função inexistente = migration pendente
  ({ status, j } = await call({ action: 'restore', periodKey: '2026-10', revision: 3, expectedRevision: 4 }));
  assert.equal(status, 501); assert.equal(j.code, 'migracao_pendente');
});

test('versões: lista metadados e identifica revisões anteriores ao histórico', async () => {
  const base = {
    'GET /rest/v1/painel_month_versions': () => J(200, [{ period_key: '2026-10', revision: 3, action: 'backfill' }]),
    'GET /rest/v1/painel_months': () => J(200, [{ period_key: '2026-10', revision: 3, checksum: 'c3' }]),
    'GET /rest/v1/painel_publications': () => J(200, [{ period_key: '2026-10', revision: 1 }, { period_key: '2026-10', revision: 2 }, { period_key: '2026-10', revision: 3 }]),
    'GET /rest/v1/painel_current': () => J(200, [{ period_key: '2026-11', checksum: 'x' }]),
  };
  reset(base);
  const { status, j } = await call({ action: 'versions', periodKey: '2026-10' });
  assert.equal(status, 200); assert.equal(j.versions.length, 1); assert.deepEqual(j.lost.map((x) => x.revision), [1, 2]);
  const q = calls.find((c) => c.path === '/rest/v1/painel_month_versions');
  assert.ok(!q.search.includes('data'), 'a listagem não traz os dados completos');
  assert.ok(q.search.includes('period_key=eq.2026-10'));
  assert.equal((await call({ action: 'versions', periodKey: '2026-13' })).status, 422);
  reset({ ...base, 'GET /rest/v1/painel_month_versions': [404, { code: 'PGRST205', message: "Could not find the table 'public.painel_month_versions'" }] });
  assert.equal((await call({ action: 'versions' })).j.code, 'migracao_pendente');
});

test('versão e backup: dados completos só para publicadores', async () => {
  reset({ 'GET /rest/v1/painel_month_versions': () => J(200, []) });
  assert.equal((await call({ action: 'version', periodKey: '2026-10', revision: 9 })).status, 404);
  reset({ 'GET /rest/v1/painel_month_versions': () => J(200, [{ period_key: '2026-10', revision: 3, data: D, summary: {} }]) });
  const v = await call({ action: 'version', periodKey: '2026-10', revision: 3 });
  assert.equal(v.status, 200); assert.equal(v.j.version.data.file, D.file);
  reset({
    'GET /rest/v1/painel_month_versions': () => J(200, [{ period_key: '2026-10', revision: 3, data: D }]),
    'GET /rest/v1/painel_months': () => J(200, [{ period_key: '2026-10', revision: 3 }]),
    'GET /rest/v1/painel_publications': () => J(200, [{ id: 1 }]),
    'GET /rest/v1/painel_current': () => J(200, [{ period_key: '2026-10' }]),
  });
  const b = await call({ action: 'backup' });
  assert.equal(b.status, 200); assert.equal(b.j.backup.versions.length, 1); assert.equal(b.j.backup.exportedBy, 'pub@heiway.net'); assert.equal(b.j.backup.versions[0].dataJson, JSON.stringify(D));
});

// ------------------------------------------------------------------ backups: assinatura do conteúdo integral
const PN = ambiente(readFileSync(join(RAIZ, 'docs/index.html'), 'utf8')); // funções puras do painel (lado do navegador)
const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres!!', SEGREDO2 = 'outro-segredo-de-teste-com-mais-de-32-caracteres';
const ESIG = { ...ENV, PAINEL_BACKUP_HMAC_KEY: SEGREDO, PAINEL_BACKUP_HMAC_KEY_ID: 'k2026' };
const D2 = { ...D, ftrGeral: 0.5 }, ck1 = fnv(JSON.stringify(D)), ck2 = fnv(JSON.stringify(D2));
// histórico realista: r1 (carga inicial), r2 (publicação moderna), r3 (recuperação da r1, vigente e corrente)
const rotasBackup = () => ({
  'GET /rest/v1/painel_month_versions': () => J(200, [
    { id: 1, publication_id: 1, period_key: '2026-10', revision: 1, file_name: 'out.xlsx', checksum: ck1, published_by: 'a@x', published_at: '2026-10-05T10:00:00+00:00', action: 'backfill', restored_from_revision: null, set_current: true, via: 'v1', created_at: '2026-11-09T12:00:00+00:00', data: D, summary: { k: 1 } },
    { id: 2, publication_id: 2, period_key: '2026-10', revision: 2, file_name: 'out-v2.xlsx', checksum: ck2, published_by: 'b@x', published_at: '2026-11-07T10:00:00+00:00', action: 'publish', restored_from_revision: null, set_current: true, via: 'v2', created_at: '2026-11-07T10:00:00+00:00', data: D2, summary: { k: 2 } },
    { id: 3, publication_id: 3, period_key: '2026-10', revision: 3, file_name: 'out.xlsx', checksum: ck1, published_by: 'c@x', published_at: '2026-11-08T10:00:00+00:00', action: 'restore', restored_from_revision: 1, set_current: true, via: 'v2', created_at: '2026-11-08T10:00:00+00:00', data: D, summary: { k: 1 } }]),
  'GET /rest/v1/painel_months': () => J(200, [{ period_key: '2026-10', revision: 3, checksum: ck1, file_name: 'out.xlsx', published_at: '2026-11-08T10:00:00+00:00' }]),
  'GET /rest/v1/painel_publications': () => J(200, [
    { id: 1, period_key: '2026-10', revision: 1, file_name: 'out.xlsx', checksum: ck1, published_by: 'a@x', published_at: '2026-10-05T10:00:00+00:00', set_current: true, replaced: false, action: 'publish', restored_from_revision: null, via: 'v1' },
    { id: 2, period_key: '2026-10', revision: 2, file_name: 'out-v2.xlsx', checksum: ck2, published_by: 'b@x', published_at: '2026-11-07T10:00:00+00:00', set_current: true, replaced: true, action: 'publish', restored_from_revision: null, via: 'v2' },
    { id: 3, period_key: '2026-10', revision: 3, file_name: 'out.xlsx', checksum: ck1, published_by: 'c@x', published_at: '2026-11-08T10:00:00+00:00', set_current: true, replaced: true, action: 'restore', restored_from_revision: 1, via: 'v2' }]),
  'GET /rest/v1/painel_current': () => J(200, [{ period_key: '2026-10', file_name: 'out.xlsx', checksum: ck1, published_at: '2026-11-08T10:00:00+00:00' }]),
});
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const callEnv = async (body, e) => { const r = await handle(req(body), env(e)); const txt = await r.text(); assert.ok(!txt.includes('sb_secret') && !txt.includes(SEGREDO) && !txt.includes(SEGREDO2), 'nenhum segredo na resposta'); return { status: r.status, j: JSON.parse(txt) }; };
const backupAssinado = async (e = ESIG) => { reset(rotasBackup()); const r = await callEnv({ action: 'backup' }, e); assert.equal(r.status, 200); return r.j.backup; };
// o que o NAVEGADOR faz: sha256 de cada versão + sha256 do JSON canônico do arquivo sem "auth" (função do painel)
const local = async (b) => { let shaOk = true; for (const v of b.versions) if (v.sha256 != null && await sha(v.dataJson) !== v.sha256) shaOk = false; return { contentSha256: await sha(PN.jcs(PN.backupBody(b))), shaOk }; };
const verificar = async (b, e = ESIG, hash) => (await callEnv({ action: 'verify_backup', auth: b.auth, contentSha256: hash || (await local(b)).contentSha256 }, e)).j;
// estado completo, como a tela do painel calcula
const estado = async (b, e = ESIG) => { const ck = PN.checkServerBackup(plainJ(b)), loc = await local(b), st0 = PN.classifyBackup(plainJ(b), ck, loc, null);
  if (st0 !== 'pendente') return { st: st0, ck }; const srv = await verificar(b, e); return { st: PN.classifyBackup(plainJ(b), ck, loc, srv), ck, srv }; };
const plainJ = (x) => JSON.parse(JSON.stringify(x));
// adulterador que conhece o formato: altera, recalcula FNV-1a, sha256 de cada versão e o contentSha256, e MANTÉM a assinatura
const adulterar = async (b, f) => { const x = plainJ(b); f(x); for (const v of x.versions) { v.integrity = fnv(v.dataJson); v.sha256 = await sha(v.dataJson); }
  if (x.auth) x.auth.contentSha256 = await sha(canonical(PN.backupBody(x))); return x; };

test('JSON canônico: Edge Function e painel produzem exatamente o mesmo texto', async () => {
  const b = await backupAssinado();
  const casos = [b, PN.backupBody(b), D, { z: 'ação ✓ 😀 €', a: [3, 1, 2], m: { y: 1e30, x: 1.5e-7, w: -0, v: null, u: true } },
    JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}')];
  for (const c of casos) assert.equal(canonical(c), PN.jcs(c));
  for (const ruim of [NaN, Infinity, undefined, { a: '\ud800' }]) { assert.throws(() => canonical(ruim), /JCS/); assert.throws(() => PN.jcs(ruim), /JCS/); }
});

test('backup sem segredo: formato 1, sem assinatura, identificado como não autenticado', async () => {
  reset(rotasBackup());
  const { status, j } = await callEnv({ action: 'backup' }, ENV);
  assert.equal(status, 200); assert.equal(j.backup.version, 1); assert.ok(!('auth' in j.backup));
  const { st, ck } = await estado(j.backup, ENV);
  eq0(ck.P); assert.equal(st, 'legado');
  assert.equal((await callEnv({ action: 'backup' }, { ...ENV, PAINEL_BACKUP_HMAC_KEY: 'curto' })).j.backup.version, 1, 'segredo curto demais é ignorado');
  assert.equal((await verificar({ auth: { alg: 'HMAC-SHA256', scheme: 'ftr-painel-backup-v2', keyId: 'k1', sig: 'a'.repeat(64) }, versions: [] }, ENV, 'b'.repeat(64))).configured, false);
});
const eq0 = (a) => assert.deepEqual(plainJ(a), []);

test('backup assinado (formato 2): o servidor monta o arquivo inteiro e assina o conteúdo integral', async () => {
  const b = await backupAssinado();
  assert.equal(b.version, 2); assert.deepEqual(Object.keys(b.auth).sort(), ['alg', 'contentSha256', 'keyId', 'scheme', 'sig']);
  assert.deepEqual([b.auth.alg, b.auth.scheme, b.auth.keyId], ['HMAC-SHA256', 'ftr-painel-backup-v2', 'k2026']);
  assert.equal(b.auth.contentSha256, await sha(canonical(PN.backupBody(b))), 'resumo = SHA-256 do JSON canônico do arquivo sem "auth"');
  // todos os campos do arquivo estão no conteúdo assinado (só "auth" fica de fora)
  assert.deepEqual(Object.keys(PN.backupBody(b)).sort(), ['current', 'dataFormat', 'exportedAt', 'exportedBy', 'format', 'months', 'publications', 'version', 'versions']);
  assert.deepEqual(Object.keys(b.versions[0]).sort(), ['action', 'checksum', 'createdAt', 'dataJson', 'file', 'id', 'integrity', 'key', 'publicationId', 'publishedAt', 'publishedBy', 'restoredFromRevision', 'revision', 'setCurrent', 'sha256', 'summaryJson', 'via']);
  assert.deepEqual(Object.keys(b.publications[0]).sort(), ['action', 'checksum', 'file', 'id', 'key', 'publishedAt', 'publishedBy', 'replaced', 'restoredFromRevision', 'revision', 'setCurrent', 'via']);
  const { st, ck, srv } = await estado(b);
  eq0(ck.P); assert.equal(srv.valid, true); assert.equal(srv.keyCurrent, true); assert.equal(st, 'autentico');
  assert.equal(PN.sbkCanRepublish(st), 'sim');
});

// cada cenário: altera, recalcula FNV-1a e SHA-256 (como faria um adulterador), mantém a assinatura original
const CENARIOS = [
  ['1. nome do arquivo de origem', (x) => { x.versions[2].file = 'falso.xlsx'; x.publications[2].file = 'falso.xlsx'; x.months[0].file = 'falso.xlsx'; x.current.file = 'falso.xlsx'; }],
  ['2. nome do publicador', (x) => { x.versions[1].publishedBy = 'outra@x'; x.publications[1].publishedBy = 'outra@x'; }],
  ['3. data e horário da publicação', (x) => { x.versions[1].publishedAt = '2026-11-01T10:00:00+00:00'; x.publications[1].publishedAt = '2026-11-01T10:00:00+00:00'; }],
  ['4. data e horário da exportação', (x) => { x.exportedAt = '2027-01-01T00:00:00.000Z'; }],
  ['5. tipo de operação', (x) => { x.versions[2].action = 'publish'; x.versions[2].restoredFromRevision = null; x.publications[2].action = 'publish'; x.publications[2].restoredFromRevision = null; }],
  ['6. revisão de origem', (x) => { x.versions[2].restoredFromRevision = 2; x.publications[2].restoredFromRevision = 2; }],
  ['7. caminho v1/v2', (x) => { x.versions[1].via = 'v1'; x.publications[1].via = 'v1'; }],
  ['8. indicação de versão corrente', (x) => { x.versions[1].setCurrent = false; x.publications[1].setCurrent = false; }],
  ['9. checksum', (x) => { x.versions[1].checksum = 'abc123'; x.publications[1].checksum = 'abc123'; }],
  ['10. dados interpretados (indicador alterado)', (x) => { x.versions[1].dataJson = JSON.stringify({ ...JSON.parse(x.versions[1].dataJson), ftrGeral: 0.99 }); }],
  ['11. lista de meses', (x) => { x.months.push({ key: '2026-09', revision: 1, checksum: ck1, file: 'out.xlsx', publishedAt: '2026-10-01T00:00:00+00:00' }); }],
  ['12. lista de publicações', (x) => { x.publications[1].replaced = false; }],
  ['12b. publicação removida', (x) => { x.publications.splice(1, 1); x.versions[1].publicationId = null; }],
  ['13. revisões renumeradas', (x) => { x.versions[1].revision = 9; x.publications[1].revision = 9; }],
  ['14. mês corrente', (x) => { x.current.key = '2026-09'; x.months.push({ key: '2026-09', revision: 3, checksum: ck1, file: 'out.xlsx', publishedAt: x.months[0].publishedAt }); }],
  ['15. metadados gerais (quem exportou)', (x) => { x.exportedBy = 'invasor@x'; }],
  ['15b. metadados gerais (formato interno declarado)', (x) => { x.format = 'ftr-painel-server-backup'; x.dataFormat = 2; x.extra = 'campo novo'; }],
  ['resumo de uma versão (summaryJson)', (x) => { x.versions[0].summaryJson = '{"k":99}'; }],
  ['identificadores internos (id e createdAt)', (x) => { x.versions[0].id = 77; x.versions[0].createdAt = '2020-01-01T00:00:00+00:00'; }],
  ['versão removida', (x) => { x.versions.splice(1, 1); }],
  ['versão duplicada', (x) => { x.versions.push(plainJ(x.versions[0])); }],
  ['ordem das versões trocada', (x) => { x.versions.reverse(); }],
  ['metadados alterados sem mudar indicadores (troca de publicador e data na r1)', (x) => { x.versions[0].publishedBy = 'z@x'; x.publications[0].publishedBy = 'z@x'; x.versions[0].publishedAt = x.publications[0].publishedAt = '2026-10-06T10:00:00+00:00'; }],
];

test('adulteração de QUALQUER informação protegida invalida a assinatura (com FNV-1a e SHA-256 recalculados)', async () => {
  const b = await backupAssinado();
  for (const [nome, f] of CENARIOS) {
    const x = await adulterar(b, f);
    assert.notEqual(canonical(PN.backupBody(x)), canonical(PN.backupBody(b)), nome + ': o cenário alterou o conteúdo');
    const loc = await local(x);
    assert.ok(loc.shaOk && loc.contentSha256 === x.auth.contentSha256, nome + ': os resumos recalculados conferem (o adulterador "acertou" os hashes)');
    const srv = await verificar(x);
    assert.equal(srv.valid, false, nome + ': o servidor recusa a assinatura');
    const st = PN.classifyBackup(plainJ(x), PN.checkServerBackup(plainJ(x)), loc, srv);
    assert.ok(['invalida', 'integridade'].includes(st) && PN.sbkCanRepublish(st) === 'nao', nome + ': estado ' + st + ', republicação bloqueada');
  }
});

test('ordem das propriedades JSON alterada sem mudar o conteúdo: continua autêntico', async () => {
  const b = await backupAssinado();
  const inv = (v) => Array.isArray(v) ? v.map(inv) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, inv(v[k])])) : v;
  const r = inv(b); assert.notEqual(JSON.stringify(r), JSON.stringify(b));
  assert.equal((await estado(r)).st, 'autentico');
});

test('envelope da assinatura: remoção, chave, algoritmo, esquema, resumo e assinatura forjada', async () => {
  const b = await backupAssinado();
  const sem = plainJ(b); delete sem.auth;
  assert.equal((await estado(sem)).st, 'assinatura_ausente', 'formato 2 sem assinatura não passa despercebido');
  const chave = plainJ(b); chave.auth.keyId = 'outra';
  let r = await estado(chave); assert.equal(r.st, 'chave_desconhecida'); assert.equal(r.srv.valid, false);
  const alg = plainJ(b); alg.auth.alg = 'HMAC-SHA1';
  assert.equal((await estado(alg)).st, 'esquema_invalido');
  assert.equal((await verificar(alg)).schemeOk, false, 'o servidor também recusa o algoritmo trocado');
  const esq = plainJ(b); esq.auth.scheme = 'ftr-painel-backup-v1';
  assert.equal((await estado(esq)).st, 'esquema_invalido'); assert.equal((await verificar(esq)).valid, false);
  // resumo do envelope alterado sem mexer no conteúdo: o navegador acusa integridade; o servidor recusa esse resumo
  const man = plainJ(b); man.auth.contentSha256 = 'f'.repeat(64);
  assert.equal((await estado(man)).st, 'integridade'); assert.equal((await verificar(man, ESIG, man.auth.contentSha256)).valid, false);
  // o servidor não confia no resumo enviado: um SHA-256 arbitrário com a assinatura original é recusado
  assert.equal((await verificar(b, ESIG, '0'.repeat(64))).valid, false);
  // assinatura forjada (HMAC com outro segredo sobre o conteúdo adulterado) é recusada
  const forj = await adulterar(b, (x) => { x.exportedBy = 'invasor@x'; });
  const { createHmac } = await import('node:crypto');
  forj.auth.sig = createHmac('sha256', 'segredo-chutado-pelo-invasor-1234567890').update(['ftr-painel-backup-v2', 'HMAC-SHA256', 'k2026', forj.auth.contentSha256].join('\n')).digest('hex');
  assert.equal((await verificar(forj)).valid, false);
  // rebaixar para o formato 1 (removendo a assinatura) nunca resulta em "autêntico": vira legado não autenticado
  const leg = plainJ(b); delete leg.auth; leg.version = 1;
  const rl = await estado(leg); assert.equal(rl.st, 'legado'); assert.equal(PN.sbkCanRepublish(rl.st), 'confirmar');
  assert.equal((await callEnv({ action: 'verify_backup', auth: b.auth, contentSha256: 'xyz' }, ESIG)).status, 422, 'resumo mal formado recusado');
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc') || (c.method !== 'GET' && c.path.startsWith('/rest/v1/'))), 'nada é gravado');
});

test('rotação de chave: backups assinados com a chave anterior só conferem se ela for mantida para verificação', async () => {
  const b = await backupAssinado(); // chave k2026
  const nova = { ...ENV, PAINEL_BACKUP_HMAC_KEY: SEGREDO2, PAINEL_BACKUP_HMAC_KEY_ID: 'k2027' };
  assert.equal((await estado(b, nova)).st, 'chave_desconhecida', 'sem a chave anterior: autenticidade não comprovada');
  const comAnterior = { ...nova, PAINEL_BACKUP_HMAC_PREVIOUS_KEYS: JSON.stringify({ k2026: SEGREDO }) };
  const r = await estado(b, comAnterior); assert.equal(r.st, 'autentico'); assert.equal(r.srv.keyCurrent, false);
  const novo = await backupAssinado(comAnterior); assert.equal(novo.auth.keyId, 'k2027', 'a chave anterior nunca assina');
  // trocar o keyId de um backup para outra chave conhecida também invalida (o keyId está na mensagem assinada)
  const troca = plainJ(b); troca.auth.keyId = 'k2027'; assert.equal((await estado(troca, comAnterior)).st, 'invalida');
  assert.equal((await estado(b, { ...nova, PAINEL_BACKUP_HMAC_PREVIOUS_KEYS: '{inválido' })).st, 'chave_desconhecida');
});

test('ação desconhecida e corpo inválido', async () => {
  reset();
  assert.equal((await call({ action: 'apagar' })).status, 400);
  assert.equal((await call([1, 2])).status, 400);
});
