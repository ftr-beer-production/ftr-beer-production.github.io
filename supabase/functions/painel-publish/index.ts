// @ts-nocheck -- funções puras copiadas do painel (JS); tipagem relaxada de propósito
// Supabase Edge Function: painel-publish
// URL: https://krscjbdphymgzjteclif.supabase.co/functions/v1/painel-publish
// Operações PROTEGIDAS do Painel FTR. A autorização é validada AQUI, no servidor, para todas:
//   1) o token do usuário (Supabase Auth) é conferido no Supabase;
//   2) o e-mail precisa estar confirmado e constar na tabela privada public.painel_publicadores;
//   3) a origem do navegador precisa estar em DEFAULT_ORIGINS (ou ALLOWED_ORIGINS).
// Ações (campo "action" do corpo JSON; ausente = "publish", compatível com o painel antigo):
//   publish  — publica um mês (painel_publish_v2: recusa conteúdo idêntico e conferência
//              desatualizada via expectedRevision; sem a migration 001, usa painel_publish v1)
//   restore  — recupera uma versão antiga como NOVA revisão (painel_restore_version)
//   versions — lista o histórico de versões (metadados; sem os dados)
//   version  — dados completos de uma versão, para prévia
//   backup   — todas as versões completas + metadados, para backup
// A gravação usa a chave secreta do próprio projeto (variável padrão das Edge Functions),
// que nunca sai do Supabase. Implantar com verify_jwt = false: o login é conferido no código.
// Validação dos dados idêntica à antiga função do Netlify (netlify/functions/painel-publish.mjs).

const MAX_BODY = 5 * 1024 * 1024;
const SLOTS = ['CONSOL.', 'BREWHOUSE 1', 'BREWHOUSE 3', 'FERMENTHP', 'FERMENTAMSTELPRAY', 'BRIGHT BEER'];
const KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
// Sites que podem chamar esta função pelo navegador.
const DEFAULT_ORIGINS = ['https://ftr-beer-production.github.io'];

type Env = (k: string) => string | undefined;

function keyFrom(env: Env, jsonName: string, legacyName: string): string {
  const raw = env(jsonName);
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o.default === 'string') return o.default;
      const first = Object.values(o || {}).find((v) => typeof v === 'string');
      if (first) return first as string;
    } catch (_e) { /* cai para a chave legada */ }
  }
  return (env(legacyName) || '').trim();
}

// ---- mesmas funções puras do painel (checksum, classificação, resumo) ----
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
const pkeyOf = (p) =>
  p && Number.isInteger(p.m) && Number.isInteger(p.y) && p.m >= 0 && p.m < 12 ? p.y + '-' + String(p.m + 1).padStart(2, '0') : null;

function cls(x, p) {
  if (x == null) return 'ausente';
  if (p.lo == null && p.hi == null) return 'sem limite';
  return (p.lo == null || x >= p.lo) && (p.hi == null || x <= p.hi) ? 'dentro' : 'fora';
}
function agg(rs) {
  const a = { dentro: 0, fora: 0 }, ev = new Set(), bad = new Set();
  rs.forEach((r) => {
    if (r.st === 'dentro') { a.dentro++; ev.add(r.l); }
    else if (r.st === 'fora') { a.fora++; ev.add(r.l); bad.add(r.l); }
  });
  a.lots = ev.size; a.lotsBad = bad.size;
  a.ftr = ev.size ? ((ev.size - bad.size) / ev.size) * 100 : null;
  return a;
}
function readings(groups, lots) {
  const o = [];
  lots.forEach((l) => {
    const G = groups[l.g];
    l.v.forEach((x, i) => {
      if (l.ig && l.ig[i]) return;
      if (x == null && G.sparse) return;
      const p = G.p[i];
      o.push({ l, st: cls(x, p) });
    });
  });
  return o;
}
function summarize(d) {
  const R = {
    bh: readings(d.groups, d.lots),
    fe: readings(d.fe.groups, d.fe.lots),
    bb: readings(d.bb.groups, d.bb.lots),
  };
  const C = d.consol || [];
  const rx = { bh: /^FTR Brewhouse/, fe: /^FTR Fermentation/, bb: /^FTR Bright Beer/ };
  const o = {
    key: pkeyOf(d.period),
    meta: d.meta ?? null,
    ftrGeral: d.ftrGeral != null ? d.ftrGeral * 100 : null,
    stages: {},
    tot: { lots: 0, lotsBad: 0, fora: 0 },
  };
  for (const k of ['bh', 'fe', 'bb']) {
    const a = agg(R[k]), row = C.find((x) => rx[k].test(x.l));
    o.stages[k] = { off: row ? row.p * 100 : null, rec: a.ftr, lots: a.lots, lotsBad: a.lotsBad, fora: a.fora };
    o.tot.lots += a.lots; o.tot.lotsBad += a.lotsBad; o.tot.fora += a.fora;
  }
  return o;
}

// ---- validação do payload (estrutura, tipos e consistência) ----
function validateLots(name, groups, lots, errs) {
  if (!Array.isArray(groups) || !Array.isArray(lots)) { errs.push(name + ': grupos/lotes ausentes'); return; }
  if (lots.length > 5000 || groups.length > 500) errs.push(name + ': volume acima do limite');
  groups.forEach((g, i) => {
    if (!g || typeof g.mosto !== 'string' || !Array.isArray(g.p)) { errs.push(name + ': grupo ' + i + ' inválido'); return; }
    g.p.forEach((p) => {
      if (!p || typeof p.n !== 'string') errs.push(name + ': parâmetro inválido no grupo ' + i);
      else for (const k of ['t', 'lo', 'hi']) if (p[k] != null && typeof p[k] !== 'number') errs.push(name + ': limite não numérico em ' + p.n);
    });
  });
  for (const l of lots) {
    const G = groups[l && l.g];
    if (!G) { errs.push(name + ': lote sem grupo'); break; }
    if (typeof l.ref !== 'string' || !Array.isArray(l.v) || l.v.length !== G.p.length) { errs.push(name + ': lote ' + (l && l.ref) + ' inconsistente'); break; }
    if (l.v.some((x) => x != null && typeof x !== 'number')) { errs.push(name + ': valor não numérico no lote ' + l.ref); break; }
    if (l.s && (!Array.isArray(l.s) || l.s.length !== l.v.length)) { errs.push(name + ': sentenças inconsistentes no lote ' + l.ref); break; }
  }
}
function validatePayload(d, key) {
  const errs = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['dados ausentes'];
  if (typeof d.file !== 'string' || !d.file) errs.push('nome do arquivo ausente');
  if (!d.fe || !d.bb) return ['estrutura de fermentação/bright beer ausente'];
  if (!Array.isArray(d.sources) || !SLOTS.every((n) => d.sources.some((x) => x && x.name === n && x.state === 'ok')))
    errs.push('as 6 abas obrigatórias precisam estar reconhecidas (' + SLOTS.join(', ') + ')');
  const pk = pkeyOf(d.period);
  if (!pk) errs.push('período não identificado');
  else if (pk !== key) errs.push('o período dos dados (' + pk + ') não confere com o informado (' + key + ')');
  else if (d.period.y < 2000 || d.period.y > 2100) errs.push('ano fora do intervalo esperado');
  if (d.ftrGeral != null && !(typeof d.ftrGeral === 'number' && d.ftrGeral >= 0 && d.ftrGeral <= 1.5)) errs.push('FTR geral fora do intervalo');
  if (d.meta != null && !(typeof d.meta === 'number' && d.meta >= 0 && d.meta <= 100)) errs.push('meta fora do intervalo');
  if (!Array.isArray(d.consol) || !d.consol.length) errs.push('CONSOL. sem indicadores');
  else if (d.consol.some((r) => !r || typeof r.l !== 'string' || typeof r.p !== 'number')) errs.push('indicador da CONSOL. inválido');
  validateLots('Brewhouse', d.groups, d.lots, errs);
  validateLots('Fermentação', d.fe.groups, d.fe.lots, errs);
  validateLots('Bright Beer', d.bb.groups, d.bb.lots, errs);
  if (Array.isArray(d.lots) && !d.lots.length) errs.push('nenhum lote de Brewhouse');
  if (d.fe && Array.isArray(d.fe.lots) && !d.fe.lots.length) errs.push('nenhum lote de fermentação');
  return errs;
}


function cors(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const extra = (env('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = extra.length ? extra : DEFAULT_ORIGINS;
  const origin = req.headers.get('origin');
  const ch = cors(origin, allowed);
  const reply = (status: number, obj: unknown) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...ch },
    });

  if (req.method === 'OPTIONS') return new Response(null, { status: origin && allowed.includes(origin) ? 204 : 403, headers: ch });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'Método não permitido.' });
  if (origin && !allowed.includes(origin)) return reply(403, { ok: false, error: 'Origem não permitida.' });

  const SB = (env('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const PUB = keyFrom(env, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const SEC = keyFrom(env, 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!SB || !PUB || !SEC) return reply(500, { ok: false, error: 'Servidor sem configuração completa (chaves do projeto).' });
  const adm: Record<string, string> = { apikey: SEC, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(SEC)) adm.Authorization = 'Bearer ' + SEC; // chave legada service_role (JWT)

  // 1) autenticação: token do Supabase Auth conferido no servidor
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  if (!m) return reply(401, { ok: false, error: 'Login necessário para publicar.' });
  // deno-lint-ignore no-explicit-any
  let user: any;
  try {
    const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: PUB, Authorization: 'Bearer ' + m[1] } });
    if (!r.ok) return reply(401, { ok: false, error: 'Sessão inválida ou expirada. Entre novamente.' });
    user = await r.json();
  } catch (_e) {
    return reply(502, { ok: false, error: 'Não foi possível validar o login no Supabase.' });
  }
  const email = String((user && user.email) || '').toLowerCase();
  if (!email || !(user.email_confirmed_at || user.confirmed_at)) return reply(403, { ok: false, error: 'E-mail do usuário não confirmado.' });

  // 2) autorização: lista privada de publicadores no banco
  try {
    const r = await fetch(SB + '/rest/v1/painel_publicadores?select=email&email=eq.' + encodeURIComponent(email), { headers: adm });
    if (!r.ok) return reply(502, { ok: false, error: 'Não foi possível conferir a autorização no banco.' });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return reply(403, { ok: false, error: 'Este usuário não está autorizado a publicar.' });
  } catch (_e) {
    return reply(502, { ok: false, error: 'Não foi possível conferir a autorização no banco.' });
  }

  // 3) payload (lido só depois da autenticação e da autorização)
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return reply(413, { ok: false, error: 'Arquivo grande demais para publicar.' });
  let raw: string;
  try { raw = await req.text(); } catch (_e) { return reply(400, { ok: false, error: 'Corpo da requisição ilegível.' }); }
  if (raw.length > MAX_BODY) return reply(413, { ok: false, error: 'Arquivo grande demais para publicar.' });
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw); } catch (_e) { return reply(400, { ok: false, error: 'JSON inválido.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'Requisição inválida.' });

  const action = body.action == null ? 'publish' : String(body.action);
  const api = (path: string, init: RequestInit = {}) => fetch(SB + '/rest/v1/' + path, { ...init, headers: { ...adm, ...(init.headers || {}) } });
  const expectedOf = (v: unknown) => (v == null ? null : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : NaN);
  const revOf = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : NaN);
  const MIGRACAO = { ok: false, code: 'migracao_pendente', error: 'O histórico de versões ainda não foi ativado no banco (migration 001 pendente).' };
  // Erros PTxxx das funções SQL chegam com o status HTTP xxx e { code, message, details }.
  // deno-lint-ignore no-explicit-any
  const rpcError = async (res: Response): Promise<Response> => {
    // deno-lint-ignore no-explicit-any
    let j: any = null; const txt = await res.text();
    try { j = JSON.parse(txt); } catch (_e) { /* corpo não JSON */ }
    const msg = String((j && j.message) || '');
    // deno-lint-ignore no-explicit-any
    let det: any = null; try { det = j && j.details ? JSON.parse(j.details) : null; } catch (_e) { det = null; }
    if (res.status === 409 && msg.includes('conteudo_identico'))
      return reply(409, { ok: false, code: 'conteudo_identico', currentRevision: det && det.current, error: 'O conteúdo é idêntico ao que já está publicado para este mês. Nenhuma revisão foi criada.' });
    if (res.status === 409 && msg.includes('revisao_alterada'))
      return reply(409, { ok: false, code: 'revisao_alterada', currentRevision: det && det.current, expectedRevision: det && det.expected, error: 'Outra publicação deste mês aconteceu depois da sua conferência. Nada foi gravado: atualize e confira novamente.' });
    if (res.status === 404 && msg.includes('versao_inexistente')) return reply(404, { ok: false, code: 'versao_inexistente', error: 'Esta versão não existe no histórico.' });
    if (res.status === 404 && msg.includes('mes_inexistente')) return reply(404, { ok: false, code: 'mes_inexistente', error: 'Este mês ainda não foi publicado.' });
    console.error('rpc falhou', res.status, txt.slice(0, 500));
    return reply(502, { ok: false, error: 'Falha ao gravar no banco. A versão anterior foi preservada.' });
  };
  const missingObject = (status: number, txt: string) => status === 404 && /PGRST20[25]|42P01|42883|Could not find/i.test(txt);
  const keyOk = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);
  const VCOLS = 'id,period_key,revision,file_name,checksum,published_by,published_at,action,restored_from_revision,set_current';

  // ---------------------------------------------------------------- publicar
  if (action === 'publish') {
    const { file, periodKey, checksum, dataJson } = body;
    const setCurrent = body.setCurrent === false ? false : true;
    const expected = expectedOf(body.expectedRevision);
    if (!keyOk(periodKey)) return reply(422, { ok: false, error: 'Período inválido.' });
    if (typeof file !== 'string' || !file.trim() || file.length > 255 || /[\u0000-\u001f]/.test(file)) return reply(422, { ok: false, error: 'Nome de arquivo inválido.' });
    if (typeof dataJson !== 'string' || typeof checksum !== 'string') return reply(422, { ok: false, error: 'Dados ausentes.' });
    if (Number.isNaN(expected)) return reply(422, { ok: false, error: 'Revisão esperada inválida.' });
    if (fnv(dataJson) !== checksum) return reply(422, { ok: false, error: 'Verificação de integridade falhou (checksum).' });

    // deno-lint-ignore no-explicit-any
    let d: any;
    try { d = JSON.parse(dataJson); } catch (_e) { return reply(422, { ok: false, error: 'Dados ilegíveis.' }); }
    const errs = validatePayload(d, periodKey);
    if (errs.length) return reply(422, { ok: false, error: 'A validação do servidor recusou os dados. A versão anterior foi preservada.', details: errs.slice(0, 20) });

    // deno-lint-ignore no-explicit-any
    let summary: any = null;
    try { summary = summarize(d); } catch (_e) { return reply(422, { ok: false, error: 'Não foi possível calcular o resumo dos dados.' }); }

    // 4) gravação atômica: painel_publish_v2 (conteúdo idêntico + concorrência); sem a migration, cai para a v1
    const args = { p_period_key: periodKey, p_file_name: file.trim(), p_checksum: checksum, p_data: d, p_summary: summary, p_published_by: email, p_set_current: setCurrent };
    let res: Response, legacy = false;
    try {
      res = await api('rpc/painel_publish_v2', { method: 'POST', body: JSON.stringify({ ...args, p_expected_revision: expected }) });
      if (res.status === 404) {
        const txt = await res.clone().text();
        if (missingObject(404, txt)) { legacy = true; res = await api('rpc/painel_publish', { method: 'POST', body: JSON.stringify(args) }); }
      }
    } catch (_e) {
      return reply(502, { ok: false, error: 'Sem conexão com o Supabase. A versão anterior foi preservada.' });
    }
    if (!res.ok) return rpcError(res);
    const out = await res.json();
    return reply(200, {
      ok: true, key: periodKey, checksum, publishedAt: out.published_at, revision: out.revision,
      previousRevision: out.previous_revision ?? null, replaced: !!out.replaced, currentSet: !!out.current_set,
      action: 'publish', legacy,
    });
  }

  // ------------------------------------------------- recuperar versão antiga
  if (action === 'restore') {
    const { periodKey } = body;
    const revision = revOf(body.revision), expected = expectedOf(body.expectedRevision);
    if (!keyOk(periodKey)) return reply(422, { ok: false, error: 'Período inválido.' });
    if (Number.isNaN(revision)) return reply(422, { ok: false, error: 'Revisão inválida.' });
    if (expected == null || Number.isNaN(expected)) return reply(422, { ok: false, error: 'Informe a revisão vigente conferida (expectedRevision).' });
    let res: Response;
    try {
      res = await api('rpc/painel_restore_version', { method: 'POST', body: JSON.stringify({
        p_period_key: periodKey, p_revision: revision, p_published_by: email, p_set_current: body.setCurrent === true, p_expected_revision: expected }) });
    } catch (_e) {
      return reply(502, { ok: false, error: 'Sem conexão com o Supabase. Nada foi alterado.' });
    }
    if (res.status === 404) { const txt = await res.clone().text(); if (missingObject(404, txt) && !/versao_inexistente|mes_inexistente/.test(txt)) return reply(501, MIGRACAO); }
    if (!res.ok) return rpcError(res);
    const out = await res.json();
    return reply(200, {
      ok: true, key: periodKey, action: 'restore', revision: out.revision, previousRevision: out.previous_revision,
      restoredFromRevision: out.restored_from_revision, checksum: out.checksum, file: out.file_name,
      publishedAt: out.published_at, replaced: true, currentSet: !!out.current_set,
    });
  }

  // --------------------------------------------- consultas do histórico
  if (action === 'versions' || action === 'version' || action === 'backup') {
    // deno-lint-ignore no-explicit-any
    const get = async (path: string): Promise<{ status: number; rows: any }> => {
      const r = await api(path, { headers: { Accept: 'application/json' } });
      const txt = await r.text();
      if (missingObject(r.status, txt)) return { status: 501, rows: null };
      if (!r.ok) { console.error('consulta falhou', r.status, txt.slice(0, 300)); return { status: 502, rows: null }; }
      return { status: 200, rows: JSON.parse(txt) };
    };
    try {
      if (action === 'versions') {
        const periodKey = body.periodKey;
        if (periodKey != null && !keyOk(periodKey)) return reply(422, { ok: false, error: 'Período inválido.' });
        const f = periodKey ? '&period_key=eq.' + encodeURIComponent(periodKey) : '';
        const [v, m, p, c] = await Promise.all([
          get('painel_month_versions?select=' + VCOLS + f + '&order=period_key.asc,revision.desc'),
          get('painel_months?select=period_key,revision,checksum,file_name,published_at' + f + '&order=period_key.asc'),
          get('painel_publications?select=period_key,revision,checksum,file_name,published_by,published_at' + f + '&order=id.asc'),
          get('painel_current?select=period_key,checksum&id=eq.1'),
        ]);
        if (v.status === 501) return reply(501, MIGRACAO);
        if ([v, m, p, c].some((x) => x.status !== 200)) return reply(502, { ok: false, error: 'Não foi possível consultar o histórico no banco.' });
        // revisões publicadas antes do histórico de versões: só metadados (dados já sobrescritos)
        // deno-lint-ignore no-explicit-any
        const have = new Set(v.rows.map((x: any) => x.period_key + '|' + x.revision));
        // deno-lint-ignore no-explicit-any
        const lost = p.rows.filter((x: any) => !have.has(x.period_key + '|' + x.revision));
        return reply(200, { ok: true, periodKey: periodKey || null, current: c.rows[0] || null, months: m.rows, versions: v.rows, lost });
      }
      if (action === 'version') {
        const periodKey = body.periodKey, revision = revOf(body.revision);
        if (!keyOk(periodKey)) return reply(422, { ok: false, error: 'Período inválido.' });
        if (Number.isNaN(revision)) return reply(422, { ok: false, error: 'Revisão inválida.' });
        const v = await get('painel_month_versions?select=' + VCOLS + ',data,summary&period_key=eq.' + encodeURIComponent(periodKey) + '&revision=eq.' + revision);
        if (v.status === 501) return reply(501, MIGRACAO);
        if (v.status !== 200) return reply(502, { ok: false, error: 'Não foi possível consultar a versão.' });
        if (!v.rows.length) return reply(404, { ok: false, code: 'versao_inexistente', error: 'Esta versão não existe no histórico.' });
        return reply(200, { ok: true, version: v.rows[0] });
      }
      // backup: todas as versões completas + metadados (somente publicadores autorizados)
      const [v, m, p, c] = await Promise.all([
        get('painel_month_versions?select=' + VCOLS + ',data,summary&order=period_key.asc,revision.asc'),
        get('painel_months?select=period_key,revision,checksum,file_name,published_at&order=period_key.asc'),
        get('painel_publications?select=*&order=id.asc'),
        get('painel_current?select=period_key,file_name,checksum,published_at&id=eq.1'),
      ]);
      if (v.status === 501) return reply(501, MIGRACAO);
      if ([v, m, p, c].some((x) => x.status !== 200)) return reply(502, { ok: false, error: 'Não foi possível ler os dados para o backup.' });
      return reply(200, { ok: true, exportedAt: new Date().toISOString(), exportedBy: email, current: c.rows[0] || null, months: m.rows, publications: p.rows, versions: v.rows });
    } catch (_e) {
      return reply(502, { ok: false, error: 'Sem conexão com o Supabase.' });
    }
  }

  return reply(400, { ok: false, error: 'Ação desconhecida.' });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === 'function') D.serve((req: Request) => handle(req, (k: string) => D.env.get(k)));
