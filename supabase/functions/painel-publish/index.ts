// @ts-nocheck -- funções puras copiadas do painel (JS); tipagem relaxada de propósito
// Supabase Edge Function: painel-publish
// URL: https://krscjbdphymgzjteclif.supabase.co/functions/v1/painel-publish
// Operações PROTEGIDAS do Painel FTR. A autorização é validada AQUI, no servidor, para todas:
//   1) o token do usuário (Supabase Auth) é conferido no Supabase;
//   2) o e-mail precisa estar confirmado e constar na tabela privada public.painel_publicadores;
//   3) a origem do navegador precisa estar em DEFAULT_ORIGINS (ou ALLOWED_ORIGINS).
// Ações (campo "action" do corpo JSON; ausente = "publish"):
//   publish  — publica um mês. Dois caminhos, escolhidos pelo CORPO da requisição:
//     * MODERNO (painel novo): corpo com "protocol": 2 e/ou o campo "expectedRevision".
//       A revisão esperada é OBRIGATÓRIA (inteiro >= 0; 0 = mês novo). Sem ela: 428.
//       Grava por painel_publish_v2 (recusa conteúdo idêntico e conferência desatualizada).
//       Se a v2 não existir no banco: 501 — NUNCA cai para a v1 sem conferência.
//     * COMPATIBILIDADE (painel antigo do main, durante a transição): corpo sem "protocol"
//       e sem "expectedRevision". Grava por painel_publish v1, exatamente como antes; com a
//       migration aplicada, o gatilho captura a versão completa (via = 'v1'). A resposta
//       traz legacy: true e path: 'compatibilidade'. Desligável com PAINEL_LEGACY_PUBLISH=off
//       (só depois de o painel novo estar publicado).
//   restore  — recupera uma versão antiga como NOVA revisão (painel_restore_version);
//              revisão esperada sempre obrigatória
//   versions — lista o histórico de versões (metadados; sem os dados)
//   version  — dados completos de uma versão, para prévia
//   backup   — o ARQUIVO de backup completo, montado aqui (formato 2 assinado por HMAC-SHA256 sobre o
//              conteúdo integral, quando PAINEL_BACKUP_HMAC_KEY existe; senão formato 1, sem assinatura)
//   verify_backup — confere a assinatura do conteúdo integral de um backup (só o servidor tem o segredo)
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


// ---- autenticidade dos backups (HMAC-SHA256 com segredo que só existe no servidor) ----
// Esquema ftr-painel-backup-v2: a assinatura cobre o CONTEÚDO INTEGRAL do backup (tudo, exceto o próprio
// envelope "auth"), em representação canônica RFC 8785 (JCS):
//   contentSha256 = SHA-256( JCS(backup sem "auth") )
//   sig           = HMAC-SHA256( segredo, "ftr-painel-backup-v2\nHMAC-SHA256\n<keyId>\n<contentSha256>" )
// Esquema, algoritmo e identificador da chave entram na mensagem assinada: trocar qualquer um invalida.
// Ativada só com PAINEL_BACKUP_HMAC_KEY (>= 32 caracteres). Sem ela, o backup sai no formato 1, SEM
// assinatura (identificado como não autenticado). O navegador nunca recebe o segredo.
// PAINEL_BACKUP_HMAC_PREVIOUS_KEYS (opcional, JSON {"<keyId>":"<segredo>"}): chaves antigas usadas
// SOMENTE para conferir backups assinados antes de uma rotação; nunca para assinar.
const SCHEME = 'ftr-painel-backup-v2';
const ALG = 'HMAC-SHA256';
const SBK_FMT = 'ftr-painel-server-backup';
const DATA_FMT = 2; // mesmo FMT do painel (formato interno dos dados)
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function sha256hex(s: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function hmacHex(key: CryptoKey, msg: string): Promise<string> { return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg))); }
function sameHex(a: unknown, b: string): boolean { // comparação em tempo constante
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// JSON canônico (RFC 8785 / JCS). MESMA implementação do painel (docs/index.html, função jcs) —
// o teste tests/painel.test.mjs confere que as duas produzem o mesmo texto.
// Propriedades ordenadas por unidades UTF-16; arrays na ordem original; números no formato do
// ECMAScript (o mesmo de JSON.stringify); textos com o escape do JSON.stringify. Recusa números não
// finitos, undefined, funções, BigInt, objetos não simples e textos com surrogates isolados.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function canonical(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': if (!Number.isFinite(v)) throw new Error('JCS: número não finito'); return JSON.stringify(v);
    case 'string': if (LONE_SURROGATE.test(v)) throw new Error('JCS: texto com caractere Unicode inválido'); return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      if (Object.prototype.toString.call(v) !== '[object Object]') throw new Error('JCS: objeto não suportado');
      const o = v as Record<string, unknown>;
      return '{' + Object.keys(o).sort().map((k) => canonical(k) + ':' + canonical(o[k])).join(',') + '}';
    }
    default: throw new Error('JCS: tipo não suportado (' + typeof v + ')');
  }
}
const signedMsg = (scheme: string, alg: string, keyId: string, contentSha256: string) => [scheme, alg, keyId, contentSha256].join('\n');
function backupSecret(env: Env): { secret: string; keyId: string } | null {
  const secret = (env('PAINEL_BACKUP_HMAC_KEY') || '').trim();
  if (secret.length < 32) return null;
  return { secret, keyId: (env('PAINEL_BACKUP_HMAC_KEY_ID') || 'k1').trim().slice(0, 32) };
}
// chave (atual ou antiga) que corresponde a um keyId, só para conferência
function verifySecret(env: Env, keyId: string): { secret: string; current: boolean } | null {
  const cur = backupSecret(env);
  if (cur && cur.keyId === keyId) return { secret: cur.secret, current: true };
  try {
    const prev = JSON.parse(env('PAINEL_BACKUP_HMAC_PREVIOUS_KEYS') || '{}');
    const s = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev[keyId] : null;
    if (typeof s === 'string' && s.trim().length >= 32) return { secret: s.trim(), current: false };
  } catch (_e) { /* JSON inválido = sem chaves antigas */ }
  return null;
}
const nn = (x: unknown) => (x === undefined ? null : x);
// Conteúdo INTEGRAL do backup (o que é assinado). Todos os campos que o arquivo leva estão aqui.
// deno-lint-ignore no-explicit-any
export async function backupContent(r: any, version: 1 | 2) {
  // deno-lint-ignore no-explicit-any
  const versions = await Promise.all((r.versions || []).map(async (v: any) => {
    const dataJson = JSON.stringify(v.data);
    return {
      id: nn(v.id), publicationId: nn(v.publication_id), key: v.period_key, revision: v.revision, file: v.file_name,
      checksum: v.checksum, publishedBy: v.published_by, publishedAt: v.published_at, createdAt: nn(v.created_at),
      action: v.action, restoredFromRevision: nn(v.restored_from_revision), setCurrent: nn(v.set_current), via: nn(v.via),
      integrity: fnv(dataJson), sha256: await sha256hex(dataJson), dataJson, summaryJson: JSON.stringify(nn(v.summary)),
    };
  }));
  const c = r.current;
  return {
    format: SBK_FMT, version, dataFormat: DATA_FMT, exportedAt: r.exportedAt, exportedBy: r.exportedBy,
    current: c ? { key: c.period_key, file: nn(c.file_name), checksum: nn(c.checksum), publishedAt: nn(c.published_at) } : null,
    // deno-lint-ignore no-explicit-any
    months: (r.months || []).map((m: any) => ({ key: m.period_key, revision: m.revision, checksum: m.checksum, file: m.file_name, publishedAt: m.published_at })),
    // deno-lint-ignore no-explicit-any
    publications: (r.publications || []).map((p: any) => ({
      id: p.id, key: p.period_key, revision: p.revision, file: p.file_name, checksum: p.checksum, publishedBy: p.published_by,
      publishedAt: p.published_at, setCurrent: p.set_current, replaced: p.replaced, action: p.action || 'publish',
      restoredFromRevision: nn(p.restored_from_revision), via: nn(p.via),
    })),
    versions,
  };
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
  if (body.protocol != null && body.protocol !== 2) return reply(400, { ok: false, error: 'Versão de protocolo não suportada.' });
  // Cliente moderno: declara o protocolo 2 OU envia o campo expectedRevision (mesmo que null).
  const modern = body.protocol === 2 || Object.prototype.hasOwnProperty.call(body, 'expectedRevision');
  const api = (path: string, init: RequestInit = {}) => fetch(SB + '/rest/v1/' + path, { ...init, headers: { ...adm, ...(init.headers || {}) } });
  const expectedOf = (v: unknown) => (v == null ? null : Number.isInteger(v) && (v as number) >= 0 ? (v as number) : NaN);
  const revOf = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : NaN);
  const MIGRACAO = { ok: false, code: 'migracao_pendente', error: 'O histórico de versões ainda não foi ativado no banco (migration pendente). Nada foi gravado.' };
  const SEM_REVISAO = { ok: false, code: 'revisao_esperada_ausente', error: 'A revisão vigente conferida (expectedRevision) é obrigatória. Nada foi gravado: atualize o painel e confira novamente.' };
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
    if (res.status === 428 && msg.includes('revisao_esperada_ausente')) return reply(428, SEM_REVISAO);
    console.error('rpc falhou', res.status, txt.slice(0, 500));
    return reply(502, { ok: false, error: 'Falha ao gravar no banco. A versão anterior foi preservada.' });
  };
  const missingObject = (status: number, txt: string) => status === 404 && /PGRST20[25]|42P01|42883|Could not find/i.test(txt);
  const keyOk = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);
  const VCOLS = 'id,period_key,revision,file_name,checksum,published_by,published_at,action,restored_from_revision,set_current,via';

  // ---------------------------------------------------------------- publicar
  if (action === 'publish') {
    const { file, periodKey, checksum, dataJson } = body;
    const setCurrent = body.setCurrent === false ? false : true;
    const expected = expectedOf(body.expectedRevision);
    if (!modern && (env('PAINEL_LEGACY_PUBLISH') || '').trim().toLowerCase() === 'off')
      return reply(426, { ok: false, code: 'cliente_desatualizado', error: 'Esta versão do painel está desatualizada. Recarregue a página (Ctrl+F5) e publique novamente.' });
    if (modern && expected == null) return reply(428, SEM_REVISAO);
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

    // 4) gravação atômica
    const args = { p_period_key: periodKey, p_file_name: file.trim(), p_checksum: checksum, p_data: d, p_summary: summary, p_published_by: email, p_set_current: setCurrent };
    let res: Response;
    try {
      if (modern) {
        // fluxo moderno: SOMENTE a v2, com a revisão esperada; falha nunca vira publicação sem conferência
        res = await api('rpc/painel_publish_v2', { method: 'POST', body: JSON.stringify({ ...args, p_expected_revision: expected }) });
        if (res.status === 404 && missingObject(404, await res.clone().text())) return reply(501, MIGRACAO);
      } else {
        // caminho de compatibilidade (painel antigo): v1, como sempre foi
        console.warn('publicação pelo caminho de compatibilidade (v1)', periodKey, email);
        res = await api('rpc/painel_publish', { method: 'POST', body: JSON.stringify(args) });
      }
    } catch (_e) {
      return reply(502, { ok: false, error: 'Sem conexão com o Supabase. A versão anterior foi preservada.' });
    }
    if (!res.ok) return rpcError(res);
    const out = await res.json();
    return reply(200, {
      ok: true, key: periodKey, checksum, publishedAt: out.published_at, revision: out.revision,
      previousRevision: out.previous_revision ?? null, replaced: !!out.replaced, currentSet: !!out.current_set,
      action: 'publish', legacy: !modern, path: modern ? 'moderno' : 'compatibilidade',
      ...(modern ? {} : { notice: 'Publicado pelo caminho de compatibilidade (painel antigo): sem conferência de revisão e sem detecção de conteúdo idêntico.' }),
    });
  }

  // ------------------------------------------------- recuperar versão antiga
  if (action === 'restore') {
    const { periodKey } = body;
    const revision = revOf(body.revision), expected = expectedOf(body.expectedRevision);
    if (!keyOk(periodKey)) return reply(422, { ok: false, error: 'Período inválido.' });
    if (Number.isNaN(revision)) return reply(422, { ok: false, error: 'Revisão inválida.' });
    if (expected == null) return reply(428, SEM_REVISAO);
    if (Number.isNaN(expected)) return reply(422, { ok: false, error: 'Revisão esperada inválida.' });
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
        get('painel_month_versions?select=' + VCOLS + ',data,summary,publication_id,created_at&order=period_key.asc,revision.asc'),
        get('painel_months?select=period_key,revision,checksum,file_name,published_at&order=period_key.asc'),
        get('painel_publications?select=*&order=id.asc'),
        get('painel_current?select=period_key,file_name,checksum,published_at&id=eq.1'),
      ]);
      if (v.status === 501) return reply(501, MIGRACAO);
      if ([v, m, p, c].some((x) => x.status !== 200)) return reply(502, { ok: false, error: 'Não foi possível ler os dados para o backup.' });
      // O SERVIDOR monta o arquivo inteiro; o navegador só o salva. Com o segredo: formato 2 assinado
      // (a assinatura é obrigatória nesse formato). Sem o segredo: formato 1, sem assinatura.
      const bs = backupSecret(env);
      const content = await backupContent({ exportedAt: new Date().toISOString(), exportedBy: email, current: c.rows[0] || null, months: m.rows, publications: p.rows, versions: v.rows }, bs ? 2 : 1);
      let backup: Record<string, unknown> = content;
      if (bs) {
        const contentSha256 = await sha256hex(canonical(content));
        const sig = await hmacHex(await hmacKey(bs.secret), signedMsg(SCHEME, ALG, bs.keyId, contentSha256));
        backup = { ...content, auth: { alg: ALG, scheme: SCHEME, keyId: bs.keyId, contentSha256, sig } };
      }
      return reply(200, { ok: true, backup });
    } catch (_e) {
      return reply(502, { ok: false, error: 'Sem conexão com o Supabase.' });
    }
  }

  // ------------------------------- autenticidade de um backup (só o servidor tem o segredo)
  // Recebe o envelope "auth" do arquivo e o SHA-256 que o NAVEGADOR calculou sobre a representação
  // canônica do arquivo inteiro (sem "auth"). O servidor NÃO confia nesse resumo: recalcula o HMAC sobre
  // ele e compara com a assinatura. Quem adultera o arquivo consegue recalcular o SHA-256, mas não a
  // assinatura. Não recebe os dados e não grava nada.
  if (action === 'verify_backup') {
    const configured = !!backupSecret(env);
    const a = body.auth, h = body.contentSha256;
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return reply(422, { ok: false, error: 'Resumo SHA-256 do conteúdo inválido.' });
    if (!a || typeof a !== 'object') return reply(200, { ok: true, configured, signed: false, valid: false });
    if (a.alg !== ALG || a.scheme !== SCHEME || typeof a.sig !== 'string' || typeof a.keyId !== 'string')
      return reply(200, { ok: true, configured, signed: true, schemeOk: false, valid: false });
    const ks = verifySecret(env, a.keyId);
    if (!ks) return reply(200, { ok: true, configured, signed: true, schemeOk: true, keyKnown: false, keyId: a.keyId, valid: false });
    const valid = sameHex(a.sig, await hmacHex(await hmacKey(ks.secret), signedMsg(SCHEME, ALG, a.keyId, h)));
    return reply(200, { ok: true, configured, signed: true, schemeOk: true, keyKnown: true, keyId: a.keyId, keyCurrent: ks.current, valid });
  }

  return reply(400, { ok: false, error: 'Ação desconhecida.' });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === 'function') D.serve((req: Request) => handle(req, (k: string) => D.env.get(k)));
