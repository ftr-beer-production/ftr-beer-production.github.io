// Teste de PONTA A PONTA, 100% local e isolado (nunca toca a produção):
//   navegador (Chromium/Playwright) → painel docs/index.html → Edge Function REAL (index.ts) →
//   API REST simulada (tradução mínima para SQL) → PostgreSQL LOCAL com o esquema atual + migration 20261109120000.
// A biblioteca SheetJS é substituída por um "shim" mínimo que entrega a planilha sintética (o CDN não é acessível aqui).
// Inclui o painel ATUAL de produção (main) publicando pela Edge nova (janela de transição).
// Uso: node --experimental-strip-types --no-warnings tests/e2e/painel.e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // instalação global do Playwright
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, chownSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { planilha } from '../fixtures/planilha.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SB = 'https://krscjbdphymgzjteclif.supabase.co';
let passou = 0; const ok = (c, m) => { assert.ok(c, m); passou++; console.log('ok - ' + m); };

// ---------------------------------------------------------------- PostgreSQL local temporário
const PGBIN = execFileSync('bash', ['-c', 'ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1']).toString().trim();
const DIR = mkdtempSync(join(tmpdir(), 'ftr-e2e-')), PORT = '54331', root = process.getuid && process.getuid() === 0;
if (root) execFileSync('chown', ['-R', 'postgres', DIR]);
const asPg = (bin, args) => execFileSync(root ? 'runuser' : join(PGBIN, bin), root ? ['-u', 'postgres', '--', join(PGBIN, bin), ...args] : args, { stdio: 'pipe' });
asPg('initdb', ['-D', DIR + '/data', '-A', 'trust', '-U', 'postgres']);
asPg('pg_ctl', ['-D', DIR + '/data', '-o', `-k ${DIR} -p ${PORT} -c listen_addresses=''`, '-l', DIR + '/log', 'start', '-w']);
const PGENV = { ...process.env, PGHOST: DIR, PGPORT: PORT, PGUSER: 'postgres', PGDATABASE: 'postgres' };
const psql = (args, input) => spawnSync(join(PGBIN, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { env: PGENV, input, encoding: 'utf8' });
const sqlFile = (f) => { const r = psql(['-f', f]); if (r.status) throw new Error(f + ': ' + r.stderr); };
const fim = () => { try { asPg('pg_ctl', ['-D', DIR + '/data', 'stop', '-m', 'immediate']); } catch (_) {} rmSync(DIR, { recursive: true, force: true }); };
process.on('exit', fim);

// dados reais embutidos no painel, usados como meses já publicados
const HTML = readFileSync(join(RAIZ, 'docs/index.html'), 'utf8');
const REAL = (() => { const i = HTML.indexOf('let D={') + 6; let n = 0, j = i, s = false, e = false;
  for (; j < HTML.length; j++) { const c = HTML[j]; if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; } if (c === '"') s = true; else if (c === '{') n++; else if (c === '}' && --n === 0) break; }
  return JSON.parse(HTML.slice(i, j + 1)); })();
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const lit = (v) => { if (v == null) return 'NULL'; if (typeof v === 'number' || typeof v === 'boolean') return String(v); if (typeof v === 'object') { const j = JSON.stringify(v); let tag = 'j'; while (j.includes('$' + tag + '$')) tag += 'x'; return `$${tag}$${j}$${tag}$::jsonb`; } return "'" + String(v).replace(/'/g, "''") + "'"; };
const q1 = (sql) => { const r = psql(['-At', '-c', sql]); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };

sqlFile(join(RAIZ, 'tests/sql/00_papeis_supabase.sql'));
sqlFile(join(RAIZ, 'supabase/painel_ftr.sql'));
sqlFile(join(RAIZ, 'supabase/painel_publicadores.sql'));
q1(`grant all on public.painel_months, public.painel_current, public.painel_publications, public.painel_publicadores to service_role; insert into painel_publicadores values ('pub@teste.local', now())`);
// setembro e outubro publicados com a função ANTIGA (v1), antes da migration — como em produção
const sept = { ...REAL, period: { m: 8, y: 2026 }, file: '09. Setembro 26.xlsx' };
for (const [k, d] of [['2026-09', sept], ['2026-10', REAL]]) q1(`select painel_publish(${lit(k)}, ${lit(d.file)}, ${lit(fnv(JSON.stringify(d)))}, ${lit(d)}, NULL, 'pub@teste.local', true)`);
sqlFile(join(RAIZ, 'supabase/migrations/20261109120000_painel_versoes.sql'));
ok(q1(`select count(*) from painel_month_versions where action='backfill'`) === '2', 'migration aplicada sobre dados publicados pela v1 (2 versões copiadas)');

// ---------------------------------------------------------------- API REST simulada (mínimo usado pelo painel e pela função)
function rest(method, url, headers, bodyTxt) {
  const role = String(headers.apikey || '').startsWith('sb_publishable') ? 'anon' : 'service_role';
  const p = url.pathname.replace('/rest/v1/', '');
  if (method === 'POST' && p.startsWith('rpc/')) {
    const fn = p.slice(4).replace(/[^a-z0-9_]/g, ''), args = JSON.parse(bodyTxt || '{}');
    const sql = `select to_json(public.${fn}(${Object.entries(args).map(([k, v]) => k.replace(/[^a-z_]/g, '') + ' := ' + lit(v)).join(', ')}))`;
    const r = psql(['-At', '-v', 'VERBOSITY=verbose', '-c', `set role ${role}`, '-c', '\\set VERBOSITY verbose', '-c', sql]);
    if (!r.status) return [200, r.stdout.trim()];
    const m = /ERROR:\s+(\w+):\s+([^\n]*)/.exec(r.stderr) || [], det = /DETAIL:\s+([^\n]*)/.exec(r.stderr);
    if (/function .* does not exist/.test(r.stderr)) return [404, JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' })];
    const st = /^PT(\d{3})$/.test(m[1]) ? +m[1].slice(2) : m[1] === '42501' ? 403 : 400;
    return [st, JSON.stringify({ code: m[1], message: m[2], details: det ? det[1] : null })];
  }
  if (method !== 'GET') return [405, '{}'];
  const tbl = p.replace(/[^a-z_]/g, ''), sp = url.searchParams, cols = (sp.get('select') || '*').replace(/[^a-z_,*]/g, '');
  const where = [], order = [];
  for (const [k, v] of sp) { if (k === 'select') continue; if (k === 'order') { v.split(',').forEach((o) => { const [c, d] = o.split('.'); order.push(c.replace(/[^a-z_]/g, '') + (d === 'desc' ? ' desc' : ' asc')); }); continue; }
    if (v.startsWith('eq.')) where.push(k.replace(/[^a-z_]/g, '') + ' = ' + lit(v.slice(3))); }
  const sql = `select coalesce(json_agg(t), '[]'::json) from (select ${cols} from public.${tbl}${where.length ? ' where ' + where.join(' and ') : ''}${order.length ? ' order by ' + order.join(', ') : ''}) t`;
  const r = psql(['-At', '-c', `set role ${role}`, '-c', sql]);
  if (r.status) return /does not exist/.test(r.stderr) ? [404, JSON.stringify({ code: 'PGRST205', message: 'Could not find the table' })] : [/permission denied/.test(r.stderr) ? 401 : 400, JSON.stringify({ message: r.stderr })];
  return [200, r.stdout.trim()];
}
const USERS = { 'pub@teste.local': 'tok-pub', 'outro@teste.local': 'tok-outro' };
function auth(url, headers, bodyTxt) {
  if (url.pathname === '/auth/v1/token') { const b = JSON.parse(bodyTxt || '{}'), tok = b.email && b.password === 'senha-teste' ? USERS[b.email] : (b.refresh_token ? 'tok-pub' : null);
    return tok ? [200, JSON.stringify({ access_token: tok, refresh_token: 'r-' + tok, expires_in: 3600, user: { email: b.email || 'pub@teste.local' } })] : [400, JSON.stringify({ error_description: 'Invalid login credentials' })]; }
  if (url.pathname === '/auth/v1/user') { const t = String(headers.authorization || headers.Authorization || '').replace(/^Bearer /, ''), em = Object.keys(USERS).find((e) => USERS[e] === t);
    return em ? [200, JSON.stringify({ email: em, email_confirmed_at: '2026-01-01' })] : [401, '{}']; }
  return [404, '{}'];
}

// ---------------------------------------------------------------- Edge Function REAL (index.ts), com fetch apontando para a API simulada
const tmp = mkdtempSync(join(tmpdir(), 'edge-')); copyFileSync(join(RAIZ, 'supabase/functions/painel-publish/index.ts'), join(tmp, 'edge.ts'));
const { handle, canonical } = await import(join(tmp, 'edge.ts'));
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => { const url = new URL(u); if (url.host !== 'fake.supabase.co') return realFetch(u, o);
  const h = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const [st, body] = url.pathname.startsWith('/auth/') ? auth(url, h, o.body) : rest(o.method || 'GET', url, h, o.body);
  return new Response(body, { status: st, headers: { 'content-type': 'application/json' } }); };

// ---------------------------------------------------------------- servidor local do painel
// "/" = painel novo (branch); "/antigo" = painel ATUAL de produção (docs/index.html do main), para a janela de transição
const HTML_ANTIGO = execFileSync('git', ['-C', RAIZ, 'show', 'main:docs/index.html']);
const srv = createServer((req, res) => { const u = req.url.split('?')[0], body = u === '/' ? readFileSync(join(RAIZ, 'docs/index.html')) : u === '/antigo' ? HTML_ANTIGO : null;
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ORIGEM = 'http://127.0.0.1:' + srv.address().port;
const EDGE_ENV = { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_teste"}', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_teste"}', ALLOWED_ORIGINS: ORIGEM,
  // segredo FICTÍCIO, só deste teste local: liga a assinatura HMAC dos backups
  PAINEL_BACKUP_HMAC_KEY: 'segredo-local-de-teste-e2e-0123456789abcdef', PAINEL_BACKUP_HMAC_KEY_ID: 'e2e' };

const SHIM = `window.XLSX={read(buf,o){const S=window.__WB;return{SheetNames:Object.keys(S),Sheets:Object.fromEntries(Object.keys(S).map(n=>[n,{__a:S[n]}]))}},
 utils:{sheet_to_json(ws){return ws.__a.map(r=>r.slice())},book_new(){return{SheetNames:[],Sheets:{}}},book_append_sheet(wb,ws,n){wb.SheetNames.push(n);wb.Sheets[n]=ws},
  encode_cell({r,c}){let s='';c++;while(c){const m=(c-1)%26;s=String.fromCharCode(65+m)+s;c=Math.floor((c-1)/26)}return s+(r+1)},encode_range(x){return this.encode_cell(x.s)+':'+this.encode_cell(x.e)}},
 write(wb){window.__LASTWB=JSON.parse(JSON.stringify(wb));return new TextEncoder().encode('xlsx-teste').buffer}};`;

const browser = await chromium.launch();
const erros = [], edgeResp = [];
async function novaPagina() {
const ctx = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
const page = await ctx.newPage();
page.on('pageerror', (e) => erros.push(e.message));
if (process.env.E2E_DEBUG) { page.on('console', (m) => console.log('[página]', m.text())); page.on('response', async (r) => { if (r.url().includes('functions/v1')) { let b = ''; try { b = (await r.text()).slice(0, 300); } catch (_) {} console.log('[resp]', r.status(), b); } }); }
await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: SHIM }));
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '' }));
await page.route(SB + '/**', async (route) => {
  const rq = route.request(), url = new URL(rq.url()), h = rq.headers();
  if (rq.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': ORIGEM, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  let st, body, extra = {};
  if (url.pathname === '/functions/v1/painel-publish') {
    const resp = await handle(new Request('https://fake.supabase.co/functions/v1/painel-publish', { method: rq.method(), headers: { ...h, origin: ORIGEM }, body: rq.postData() }), (k) => EDGE_ENV[k]);
    st = resp.status; body = await resp.text(); extra = Object.fromEntries(resp.headers); edgeResp.push({ st, body });
  } else if (url.pathname.startsWith('/auth/')) [st, body] = auth(url, h, rq.postData());
  else [st, body] = rest(rq.method(), url, h, rq.postData());
  route.fulfill({ status: st, contentType: 'application/json', body, headers: { 'access-control-allow-origin': '*', ...extra } });
});
await page.addInitScript((wb) => { window.__WB = wb; }, { ...planilha(), FERMENTSP: [['outra aba']] });
return page; }
let page = await novaPagina();

const dlgTxt = () => page.locator('#dlg:not([hidden]) #db').innerText();
const clicar = async (txt) => { await page.locator('#dlg:not([hidden]) #db button', { hasText: txt }).first().click(); };
const esperaDlg = async (txt) => { await page.waitForFunction((t) => { const d = document.getElementById('dlg'); return d && !d.hidden && document.getElementById('db').innerText.includes(t); }, txt, { timeout: 15000 }); };
const login = async (email) => { await esperaDlg('Entrar para publicar'); await page.fill('#lgm', email); await page.fill('#lgp', 'senha-teste'); await clicar('Entrar e publicar'); };
const importar = async () => { await page.setInputFiles('#fimp', { name: '10. Outubro 26.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }); };

try {
  // 1 · consulta pública: sem login, mostra a versão publicada no servidor
  await page.goto(ORIGEM + '/');
  await page.waitForFunction(() => /Publicado no servidor|Conectado/.test(document.body.innerText), null, { timeout: 15000 });
  await page.click('[data-p="8"]');
  await page.waitForSelector('text=GESTÃO DA PUBLICAÇÃO');
  ok((await page.locator('body').innerText()).includes('Outubro/2026'), 'consulta pública carrega a versão corrente do servidor, sem login');
  ok(/Publicado deste mês\s*r1/.test(await page.locator('.card', { hasText: 'GESTÃO DA PUBLICAÇÃO' }).innerText()), 'quadro de gestão mostra a revisão publicada (r1) e a próxima');

  // 2 · importação com conferência: erros x avisos, comparação, confirmação explícita da nova revisão
  await importar(); await esperaDlg('Conferência antes de publicar');
  let t = await dlgTxt();
  ok(t.includes('Nenhum erro impeditivo') && t.includes('Valores inválidos em BREWHOUSE 1') && t.includes('Abas inesperadas') && t.includes('FERMENTSP'), 'conferência lista avisos (valores inválidos, aba inesperada) sem erro impeditivo');
  ok(t.includes('Comparação com a publicação vigente (r1)') && t.includes('Próxima revisão'), 'conferência compara com a revisão publicada e mostra a próxima revisão');
  ok(q1(`select revision from painel_months where period_key='2026-10'`) === '1', 'nada é gravado enquanto a conferência está aberta');
  await clicar('Publicar como revisão 2'); await esperaDlg('Confirmar nova revisão');
  ok((await dlgTxt()).includes('continua guardada no histórico de versões'), 'confirmação explícita antes de substituir a versão publicada');
  await clicar('Confirmar e publicar'); await login('pub@teste.local');
  await page.waitForFunction(() => /publicada para todos/i.test(document.getElementById('imp').innerText), null, { timeout: 15000 });
  ok(q1(`select string_agg(revision||':'||action, ',' order by revision) from painel_month_versions where period_key='2026-10'`) === '1:backfill,2:publish', 'nova revisão 2 publicada e a revisão 1 preservada com os dados completos');
  ok(q1(`select (data->>'file') from painel_month_versions where period_key='2026-10' and revision=1`) === REAL.file, 'dados da revisão 1 intactos no histórico');
  ok(q1(`select via from painel_month_versions where period_key='2026-10' and revision=2`) === 'v2' && edgeResp.some((x) => /"revision":2/.test(x.body) && /"path":"moderno"/.test(x.body)), 'painel novo publica pelo fluxo moderno (v2, com revisão esperada)');

  // 3 · reimportar o mesmo arquivo: conteúdo idêntico, sem botão de publicar
  await importar(); await esperaDlg('Conferência antes de publicar');
  t = await dlgTxt(); const btns = await page.locator('#dlg #db .dbtn button').allInnerTexts();
  ok(t.includes('idêntico') && !btns.some((b) => b.startsWith('Publicar')), 'conteúdo idêntico identificado; publicação acidental evitada');
  await clicar('Cancelar');

  // 4 · histórico de versões e recuperação segura
  await page.locator('#adm summary').click(); await page.locator('.menu button[data-vers]').click();
  await esperaDlg('Escolha o mês'); await clicar('Outubro/2026'); await esperaDlg('Versões publicadas · Outubro/2026');
  t = await dlgTxt(); ok(t.includes('VIGENTE') && t.includes('Versão vigente na ativação do histórico'), 'histórico de versões lista r1 (anterior) e r2 (vigente)');
  await page.locator('#dlg #db button[data-dr="v:1"]').click(); await esperaDlg('revisão 1');
  ok((await dlgTxt()).includes('Comparação: vigente r2'), 'visualização da versão antiga com comparação');
  await clicar('Recuperar esta versão'); await esperaDlg('Recuperar Outubro/2026 · revisão 1?');
  ok((await dlgTxt()).includes('nova revisão 3'), 'recuperação pede confirmação e informa a nova revisão');
  await clicar('Confirmar recuperação');
  await page.waitForFunction(() => /Versões publicadas · Outubro\/2026/.test(document.getElementById('db').innerText) && /r3/.test(document.getElementById('db').innerText), null, { timeout: 15000 });
  ok(q1(`select action||':'||restored_from_revision||':'||(data->>'file') from painel_month_versions where period_key='2026-10' and revision=3`) === 'restore:1:' + REAL.file, 'recuperação gravada como revisão 3 (dados da r1), sem apagar nada');
  ok(q1(`select count(*) from painel_month_versions where period_key='2026-10'`) === '3' && q1(`select checksum from painel_current`) === q1(`select checksum from painel_months where period_key='2026-10'`), 'histórico com 3 versões e versão corrente coerente');
  await clicar('Fechar');

  // 5 · publicações simultâneas: outra pessoa publica enquanto esta conferência está aberta
  await importar(); await esperaDlg('Conferência antes de publicar');
  q1(`set role service_role; select painel_publish_v2('2026-10','outro.xlsx','outro-ck',${lit({ ...REAL, file: 'outro.xlsx', ftrGeral: 0.95 })},null,'pub@teste.local',true,3)`);
  await clicar('Publicar como revisão 4'); await esperaDlg('Confirmar nova revisão'); await clicar('Confirmar e publicar');
  await page.waitForFunction(() => /NÃO publicado/.test(document.getElementById('imp').innerText), null, { timeout: 15000 });
  ok((await page.locator('#imp').innerText()).includes('Outra publicação deste mês aconteceu'), 'publicação simultânea detectada: a segunda é recusada com aviso claro');
  ok(q1(`select revision||':'||file_name from painel_months where period_key='2026-10'`) === '4:outro.xlsx', 'somente a primeira publicação foi gravada');

  // 6 · usuário sem autorização: o servidor recusa
  await page.evaluate(() => { sessionStorage.clear(); }); await page.locator('#adm summary').click(); await page.locator('.menu button', { hasText: 'Sair da sessão' }).click();
  await page.waitForFunction(() => REMOTE_META.get('2026-10') && REMOTE_META.get('2026-10').revision === 4, null, { timeout: 15000 });
  ok(true, 'após a recusa, o painel atualiza sozinho a revisão real do servidor (r4)');
  await page.click('[data-pubpend="1"]'); await esperaDlg('como revisão 5'); await clicar('Publicar revisão 5'); await login('outro@teste.local');
  await page.waitForFunction(() => /não está autorizado/.test(document.getElementById('msg').innerText), null, { timeout: 15000 });
  ok(q1(`select revision from painel_months where period_key='2026-10'`) === '4', 'usuário não autorizado não publica (403) e nada é gravado');

  // 7 · exportações Excel e CSV
  await page.evaluate(() => { sessionStorage.clear(); clearAuth(); });
  await page.locator('#adm summary').click(); await page.locator('.menu button', { hasText: 'Exportar dados (Excel)' }).click();
  await page.waitForFunction(() => !!window.__LASTWB, null, { timeout: 10000 });
  const wb = await page.evaluate(() => window.__LASTWB);
  ok(wb.SheetNames.length === 8 && wb.SheetNames.includes('Lotes com desvios'), 'Excel com as 8 abas de dados');
  ok(Object.values(wb.Sheets).every((ws) => Object.entries(ws).every(([k, c]) => k.startsWith('!') || !c || !('f' in c))), 'nenhuma célula do Excel contém fórmula');
  await page.locator('#adm summary').click(); await page.locator('.menu button', { hasText: 'Exportar dados (CSV)' }).click();
  await esperaDlg('Exportar dados (CSV)');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#dlg #db button[data-dr="c:1"]').click()]);
  const csv = readFileSync(await dl.path(), 'utf8');
  ok(csv.startsWith('﻿Etapa;FTR oficial;') && /;\d+,\d/.test(csv), 'CSV “Por etapa” com separador ; e vírgula decimal');

  // 8 · backup completo do servidor e verificação (prévia, sem gravar)
  await page.locator('#adm summary').click();
  if (process.env.E2E_DEBUG) console.log('[debug] menu aberto?', await page.evaluate(() => $('adm').open), 'diálogo visível?', await page.evaluate(() => !$('dlg').hidden), 'botões:', await page.locator('.menu button', { hasText: 'Backup completo do servidor' }).count());
  if (process.env.E2E_DEBUG) { try { await page.locator('.menu button', { hasText: 'Backup completo do servidor' }).click({ trial: true, timeout: 4000 }); console.log('[debug] clicável'); } catch (e) { console.log('[debug] clique:', e.message.split('\n').slice(0, 12).join(' | ')); } }
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), (async () => { await page.locator('.menu button', { hasText: 'Backup completo do servidor' }).click(); await login('pub@teste.local'); })()]);
  const bk = JSON.parse(readFileSync(await dl2.path(), 'utf8'));
  const sha = (s) => createHash('sha256').update(s).digest('hex'), corpo = (o) => { const c = { ...o }; delete c.auth; return c; };
  ok(bk.format === 'ftr-painel-server-backup' && bk.version === 2 && bk.versions.length === 5, `backup do servidor no formato 2 com todas as versões (${bk.versions.length}: setembro r1 e outubro r1 a r4)`);
  ok(bk.auth && bk.auth.alg === 'HMAC-SHA256' && bk.auth.scheme === 'ftr-painel-backup-v2' && bk.auth.contentSha256 === sha(canonical(corpo(bk))) && !JSON.stringify(bk).includes(EDGE_ENV.PAINEL_BACKUP_HMAC_KEY),
    'assinatura do servidor cobre o JSON canônico do arquivo inteiro; o segredo não está no arquivo');
  ok(bk.versions.every((v) => v.sha256 === sha(v.dataJson)) && bk.publications.every((p) => 'via' in p) && bk.current && bk.current.key, 'arquivo traz versões, publicações (com o caminho v1/v2), meses e versão corrente');
  const bkf = join(tmp, 'backup.json'), abrir = async (o) => { writeFileSync(bkf, JSON.stringify(o)); await page.setInputFiles('#fsbk', bkf); await esperaDlg('Verificar backup do servidor'); return dlgTxt(); };
  const nRep = () => page.locator('#dlg #db button', { hasText: 'Republicar como nova revisão' }).count();
  let tx = await abrir(bk);
  ok(tx.includes('Estrutura e integridade conferidas') && tx.includes('autenticidade ainda não conferida') && !tx.includes('Autêntico') && await nRep() === 0,
    'antes da conferência no servidor: íntegro, mas não "autêntico", e a republicação fica bloqueada');
  await clicar('Conferir autenticidade no servidor'); await esperaDlg('Autêntico:');
  ok(await nRep() === bk.versions.length, 'autenticidade do conteúdo integral conferida no servidor: republicação liberada');
  // republicar a r1 de outubro a partir do backup autêntico: nova revisão, pelo fluxo moderno
  const revR = +q1(`select revision from painel_months where period_key='2026-10'`), iR1 = bk.versions.findIndex((v) => v.key === '2026-10' && v.revision === 1);
  await page.locator(`#dlg #db button[data-dr="rp:${iR1}"]`).click(); await esperaDlg('Republicar Outubro/2026 a partir do backup?');
  ok((await dlgTxt()).includes('Backup autêntico'), 'confirmação da republicação informa que o backup é autêntico');
  await clicar('Republicar');
  await page.waitForFunction(() => /republicado como revisão/.test(document.getElementById('msg').innerText), null, { timeout: 15000 });
  ok(q1(`select revision||'|'||via||'|'||action from painel_month_versions where period_key='2026-10' order by revision desc limit 1`) === `${revR + 1}|v2|publish` && q1(`select count(*) from painel_month_versions where period_key='2026-10'`) === String(revR + 1),
    `republicação criou a revisão ${revR + 1} (fluxo moderno), sem apagar nenhuma versão`);
  const antes = q1(`select count(*) from painel_month_versions`);
  const refaz = (o) => { for (const v of o.versions) { v.integrity = fnv(v.dataJson); v.sha256 = sha(v.dataJson); } if (o.auth) o.auth.contentSha256 = sha(canonical(corpo(o))); return o; };
  const copia = () => JSON.parse(JSON.stringify(bk));
  // (a) edição sem recalcular: integridade inválida
  const ed = copia(); ed.versions[0].dataJson = ed.versions[0].dataJson.replace('"meta":92', '"meta":10');
  tx = await abrir(ed); ok(tx.includes('Integridade inválida') && await nRep() === 0, 'arquivo editado sem recalcular: "Integridade inválida", nada pode ser republicado');
  await clicar('Fechar');
  // (b) adulteração DELIBERADA só de metadados (publicador e data), com FNV, SHA-256 e resumo do conteúdo recalculados
  const ad = copia(), vi = ad.versions.findIndex((v) => v.key === '2026-10' && v.revision === 2), pi = ad.publications.findIndex((p) => p.id === ad.versions[vi].publicationId);
  ad.versions[vi].publishedBy = ad.publications[pi].publishedBy = 'outra.pessoa@teste.local'; refaz(ad);
  tx = await abrir(ad);
  ok(tx.includes('Estrutura e integridade conferidas') && !tx.includes('Autêntico'), 'adulteração com hashes recalculados passa na integridade, mas não aparece como autêntica');
  await clicar('Conferir autenticidade no servidor'); await esperaDlg('Assinatura inválida');
  ok(await nRep() === 0, 'servidor recusa a assinatura: "Assinatura inválida" e nenhuma versão pode ser republicada');
  await clicar('Fechar');
  // (c) assinatura removida de um backup formato 2
  const sem = copia(); delete sem.auth;
  tx = await abrir(sem); ok(tx.includes('a assinatura foi removida') && await nRep() === 0, 'assinatura removida não passa despercebida');
  await clicar('Fechar');
  // (d) chave desconhecida
  const ch = copia(); ch.auth.keyId = 'chave-antiga';
  await abrir(ch); await clicar('Conferir autenticidade no servidor'); await esperaDlg('chave desconhecida');
  ok(await nRep() === 0, 'chave desconhecida: autenticidade não comprovada');
  await clicar('Fechar');
  // (e) backup legado (formato 1, sem assinatura): lido, nunca "autêntico", republicação só com confirmação consciente
  const leg = copia(); delete leg.auth; leg.version = 1;
  tx = await abrir(leg); ok(tx.includes('backup legado, sem assinatura') && !tx.includes('Autêntico'), 'backup legado identificado como sem autenticidade comprovada');
  await page.locator(`#dlg #db button[data-dr="rp:${iR1}"]`).click(); await esperaDlg('Entendo que a autenticidade deste backup não foi comprovada');
  await clicar('Republicar'); await esperaDlg('Marque a confirmação');
  ok(true, 'republicação de legado exige confirmação consciente');
  await clicar('Voltar'); await esperaDlg('Verificar backup do servidor'); await clicar('Fechar');
  ok(q1(`select count(*) from painel_month_versions`) === antes, 'verificações e tentativas recusadas não gravam nada no banco');

  // 9 · painel público, gráficos, histórico, relatório PDF e modo TV continuam funcionando
  await page.click('[data-p="0"]'); ok(await page.locator('.main svg').count() > 0, 'visão geral com gráficos');
  await page.click('[data-p="9"]'); await page.waitForSelector('text=MESES ARQUIVADOS'); ok(await page.locator('[data-vers]').count() > 0, 'histórico mensal com acesso às versões');
  await page.evaluate(() => openReport()); ok(await page.locator('#rpt:not([hidden])').count() === 1 || (await page.locator('body').innerText()).includes('Imprimir'), 'relatório PDF abre a prévia');
  await page.evaluate(() => closeReport());
  await page.evaluate(() => toggleTV()); ok(await page.evaluate(() => document.body.classList.contains('tv')), 'modo TV ativa'); await page.evaluate(() => toggleTV());

  // 10 · TRANSIÇÃO: o painel ATUAL de produção (main) publica pela Edge Function nova + migration
  const nAntes = edgeResp.length, revAntes = +q1(`select revision from painel_months where period_key='2026-10'`);
  page = await novaPagina();
  await page.goto(ORIGEM + '/antigo');
  await page.waitForFunction(() => /Publicado no servidor|Conectado/.test(document.body.innerText), null, { timeout: 15000 });
  await importar(); await esperaDlg('Este mês já está arquivado'); await clicar('Substituir registro existente'); await login('pub@teste.local');
  await page.waitForFunction(() => /Publicado para todos/i.test(document.getElementById('imp').innerText), null, { timeout: 15000 });
  ok(q1(`select revision from painel_months where period_key='2026-10'`) === String(revAntes + 1), `painel antigo continua publicando durante a transição (r${revAntes + 1})`);
  ok(q1(`select action||'|'||via||'|'||(data->>'file') from painel_month_versions where period_key='2026-10' and revision=${revAntes + 1}`) === 'publish|v1|10. Outubro 26.xlsx', 'publicação do painel antigo capturada no histórico com os dados completos, marcada como caminho de compatibilidade (v1)');
  const ra = edgeResp.slice(nAntes).map((x) => JSON.parse(x.body)).find((j) => j.revision === revAntes + 1);
  ok(ra && ra.legacy === true && ra.path === 'compatibilidade', 'a Edge Function informa que a operação foi feita pelo caminho legado');
  ok(erros.length === 0, 'nenhum erro de JavaScript nas páginas' + (erros.length ? ': ' + erros.join(' | ') : ''));
  console.log(`== TESTE DE PONTA A PONTA: ${passou} verificações passaram`);
} catch (e) {
  console.error('FALHOU:', e.message); if (erros.length) console.error('Erros na página:', erros);
  try { console.error('Mensagem:', await page.locator('#msg').innerText()); } catch (_) {}
  try { console.error('Diálogo:', (await page.locator('#db').innerText()).slice(0, 1500)); console.error('Aviso:', (await page.locator('#imp').innerText()).slice(0, 800)); } catch (_) {}
  process.exitCode = 1;
} finally { await browser.close(); srv.close(); }
