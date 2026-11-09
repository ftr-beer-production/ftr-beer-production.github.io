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
const { handle } = await import(join(tmp, 'edge.ts'));

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
  assert.equal(b.status, 200); assert.equal(b.j.versions.length, 1); assert.equal(b.j.exportedBy, 'pub@heiway.net');
});

const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const rotasBackup = () => ({
  'GET /rest/v1/painel_month_versions': () => J(200, [
    { period_key: '2026-10', revision: 3, checksum: DCK, data: D },
    { period_key: '2026-10', revision: 4, checksum: 'outro', data: { ...D, ftrGeral: 0.5 } }]),
  'GET /rest/v1/painel_months': () => J(200, [{ period_key: '2026-10', revision: 4 }]),
  'GET /rest/v1/painel_publications': () => J(200, [{ id: 1 }]),
  'GET /rest/v1/painel_current': () => J(200, [{ period_key: '2026-10' }]),
});
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const callEnv = async (body, e) => { const r = await handle(req(body), env(e)); const txt = await r.text(); assert.ok(!txt.includes('sb_secret') && !txt.includes(SEGREDO), 'nenhum segredo na resposta'); return { status: r.status, j: JSON.parse(txt) }; };

test('backup sem segredo configurado: sha256 por versão e SEM assinatura (autenticidade não comprovada)', async () => {
  reset(rotasBackup());
  const { status, j } = await callEnv({ action: 'backup' }, ENV);
  assert.equal(status, 200); assert.equal(j.auth, null);
  assert.equal(j.versions[0].sha256, await sha(JSON.stringify(D))); assert.ok(!('sig' in j.versions[0]));
  const curto = await callEnv({ action: 'backup' }, { ...ENV, PAINEL_BACKUP_HMAC_KEY: 'curto' });
  assert.equal(curto.j.auth, null, 'segredo curto demais é ignorado');
  const v = await callEnv({ action: 'verify_backup', versions: [{ key: '2026-10', revision: 3, checksum: DCK, sha256: j.versions[0].sha256 }] }, ENV);
  assert.equal(v.status, 200); assert.equal(v.j.configured, false);
});

test('backup assinado (HMAC-SHA256): conferência no servidor detecta adulteração e versões removidas', async () => {
  const E = { ...ENV, PAINEL_BACKUP_HMAC_KEY: SEGREDO, PAINEL_BACKUP_HMAC_KEY_ID: 'k2026' };
  reset(rotasBackup());
  const b = (await callEnv({ action: 'backup' }, E)).j;
  assert.deepEqual([b.auth.alg, b.auth.keyId, b.auth.scheme], ['HMAC-SHA256', 'k2026', 'ftr-painel-backup-v1']);
  assert.ok(b.versions.every((v) => /^[0-9a-f]{64}$/.test(v.sig) && /^[0-9a-f]{64}$/.test(v.sha256)));
  const ids = (vs) => vs.map((v) => ({ key: v.period_key, revision: v.revision, checksum: v.checksum, sha256: v.sha256, sig: v.sig }));
  const ver = (vs, extra = {}) => callEnv({ action: 'verify_backup', auth: b.auth, exportedAt: b.exportedAt, exportedBy: b.exportedBy, versions: vs, ...extra }, E);
  let r = await ver(ids(b.versions));
  assert.equal(r.j.manifestValid, true); assert.ok(r.j.versions.every((x) => x.valid), 'backup original autêntico');
  // dados alterados e sha256 recalculado pelo adulterador: a assinatura não confere
  const adult = ids(b.versions); adult[1].sha256 = await sha(JSON.stringify({ ...D, ftrGeral: 0.99 }));
  r = await ver(adult);
  assert.deepEqual(r.j.versions.map((x) => x.valid), [true, false]); assert.equal(r.j.manifestValid, false);
  // versão removida do arquivo: cada assinatura restante confere, mas a lista (manifesto) não
  r = await ver(ids(b.versions).slice(0, 1));
  assert.equal(r.j.versions[0].valid, true); assert.equal(r.j.manifestValid, false);
  // exportedBy trocado no arquivo
  r = await ver(ids(b.versions), { exportedBy: 'outra@pessoa' }); assert.equal(r.j.manifestValid, false);
  // assinatura de outra chave
  r = await ver(ids(b.versions), { auth: { ...b.auth, keyId: 'k-velha' } }); assert.equal(r.j.keyKnown, false);
  // arquivo sem assinatura
  r = await ver(ids(b.versions), { auth: null }); assert.equal(r.j.signed, false);
  // identificação inválida é recusada; nada é gravado em nenhum caso
  assert.equal((await ver([{ key: '2026-10', revision: 3, checksum: DCK, sha256: 'xyz' }])).status, 422);
  assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/rpc') || (c.method !== 'GET' && c.path.startsWith('/rest/v1/'))));
});

test('ação desconhecida e corpo inválido', async () => {
  reset();
  assert.equal((await call({ action: 'apagar' })).status, 400);
  assert.equal((await call([1, 2])).status, 400);
});
