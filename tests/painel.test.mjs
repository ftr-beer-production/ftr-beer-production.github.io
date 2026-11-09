// Testes das funções puras do painel (leitura do Excel, conferência, comparação, exportações e backup do servidor).
// Uso: node --test tests/painel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambiente } from './lib/painel.mjs';
import { planilha } from './fixtures/planilha.mjs';

// valores criados dentro do contexto vm têm outro protótipo: compara pelo conteúdo
const plain = (x) => JSON.parse(JSON.stringify(x));
const eq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(RAIZ, 'docs/index.html'), 'utf8');
const N = ambiente(HTML);
let ANT = null; // versão anterior (main), para regressão
try { ANT = ambiente(execFileSync('git', ['-C', RAIZ, 'show', 'main:docs/index.html'], { encoding: 'utf8', maxBuffer: 1 << 26 })); } catch (_) { ANT = null; }

const semQv = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.qv; if (c.fe) delete c.fe.qv; if (c.bb) delete c.bb.qv; return c; };

test('regressão: leitura do Excel idêntica à versão anterior (mesmos lotes, cálculos e checksum)', { skip: !ANT && 'branch main indisponível' }, () => {
  for (const op of [{}, { invalidos: false }, { mesConsol: null }]) {
    const S = planilha(op), f = op.mesConsol === null ? '11. Novembro 2026.xlsx' : '10. Outubro 26.xlsx';
    const a = ANT.parseWorkbook(S, f), b = N.parseWorkbook(S, f);
    eq(semQv(b), semQv(a), 'parseWorkbook');
    assert.equal(N.jsonOf(b), ANT.jsonOf(a), 'JSON publicado idêntico');
    assert.equal(N.fnv(N.jsonOf(b)), ANT.fnv(ANT.jsonOf(a)), 'checksum idêntico');
    eq(JSON.parse(JSON.stringify(N.summarize(b))), JSON.parse(JSON.stringify(ANT.summarize(a))), 'resumo idêntico');
  }
});

test('leitura conta valores inválidos sem mudar o cálculo; #REF! e n.a. seguem ignorados', () => {
  const d = N.parseWorkbook(planilha(), '10. Outubro 26.xlsx');
  assert.equal(d.qv['BREWHOUSE 1'], 1); assert.equal(d.qv['BREWHOUSE 3'], 1);
  assert.equal(d.qv.FERMENTHP, 1); assert.equal(d.qv['BRIGHT BEER'], 1); assert.ok(!d.qv.FERMENTAMSTELPRAY || d.qv.FERMENTAMSTELPRAY === 1);
  assert.ok(Object.keys(d.dq.ign).some((k) => k.includes('#REF!')) && Object.keys(d.dq.ign).some((k) => k.includes('n.a.')));
  assert.ok(!N.jsonOf(d).includes('"qv"'), 'diagnóstico não vai para o JSON publicado');
  assert.equal(N.parseWorkbook(planilha({ invalidos: false }), 'x.xlsx').qv['BREWHOUSE 1'], undefined);
});

test('conferência: separa erros impeditivos de avisos e calcula os números da prévia', () => {
  const d = N.parseWorkbook(planilha(), '10. Outubro 26.xlsx');
  const rv = N.reviewImport(d, { file: '10. Outubro 26.xlsx', ignoredSheets: ['FERMENTSP'], chk: N.chk(d, N.mkReadings(d)), validate: N.validateData, checksum: 'abc' });
  eq(rv.errors, []); assert.equal(rv.key, '2026-10'); assert.equal(rv.nextRevision, 1); assert.equal(rv.identical, false);
  assert.ok(rv.warnings.some((w) => w.startsWith('Abas inesperadas') && w.includes('FERMENTSP')));
  assert.ok(rv.warnings.some((w) => w.startsWith('Valores inválidos em BREWHOUSE 1')));
  assert.ok(rv.warnings.some((w) => w.includes('duplicado')), 'lote duplicado vira aviso');
  assert.ok(rv.info.some((x) => x.includes('#REF!')), '#REF! informado, não tratado como erro');
  assert.equal(rv.stats.lotsRead, d.lots.length + d.fe.lots.length + d.bb.lots.length);
  assert.ok(rv.stats.valid > 0 && rv.stats.fora > 0 && rv.stats.lotsBad > 0);
});

test('conferência: períodos incompatíveis, período ausente e estrutura inválida', () => {
  let d = N.parseWorkbook(planilha(), '11. Novembro 2026.xlsx');
  assert.ok(N.reviewImport(d, { file: '11. Novembro 2026.xlsx' }).warnings.some((w) => w.startsWith('Períodos incompatíveis')));
  d = N.parseWorkbook(planilha({ mesConsol: null }), 'planilha.xlsx');
  assert.ok(N.reviewImport(d, { file: 'planilha.xlsx', validate: N.validateData }).errors.some((e) => e.startsWith('Período não identificado')));
  d = N.parseWorkbook(planilha(), '10. Outubro 26.xlsx'); d.lots[0].v = [1];
  assert.ok(N.reviewImport(d, { validate: N.validateData }).errors.some((e) => e.startsWith('Estrutura dos dados inválida')));
});

test('conferência: conteúdo idêntico e comparação com a publicação vigente', () => {
  const d = N.parseWorkbook(planilha(), '10. Outubro 26.xlsx'), ck = N.fnv(N.jsonOf(d)), s = N.summarize(d);
  const igual = N.reviewImport(d, { checksum: ck, published: { revision: 3, checksum: ck, sum: s } });
  assert.equal(igual.identical, true); assert.equal(igual.nextRevision, 4);
  const antigo = JSON.parse(JSON.stringify(s)); antigo.ftrGeral = 80; antigo.stages.bh.lotsBad = 0;
  const rv = N.reviewImport(d, { checksum: ck, published: { revision: 3, checksum: 'outro', sum: antigo } });
  assert.equal(rv.identical, false); const ch = rv.diff.filter((x) => x.changed).map((x) => x.l);
  assert.ok(ch.includes('FTR geral (oficial)') && ch.includes('Lotes com desvio · Brewhouse'));
  assert.ok(rv.warnings.some((w) => w.startsWith('Diferenças em relação à publicação vigente')));
  const dif = N.summaryDiff(antigo, s).find((x) => x.l === 'FTR geral (oficial)'); assert.equal(Math.round(dif.d * 10) / 10, 11);
});

// Dados reais embutidos no painel (outubro/2026)
function dadosEmbutidos() { const i = HTML.indexOf('let D={') + 6; let n = 0, j = i, s = false, e = false;
  for (; j < HTML.length; j++) { const c = HTML[j]; if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; } if (c === '"') s = true; else if (c === '{') n++; else if (c === '}' && --n === 0) break; }
  return JSON.parse(HTML.slice(i, j + 1)); }
const REAL = dadosEmbutidos();

test('exportações: tabelas completas, tipos coerentes e filtros respeitados', () => {
  const R = N.stageReadings(REAL), sum = N.summarize(REAL);
  const T = N.exportTables({ D: REAL, sum, R, hist: [{ key: '2026-09', file: 'a', savedAt: '2026-10-28T18:36:02Z', central: true, sum }, { key: '2026-10', file: 'b', savedAt: '2026-11-05T17:31:13Z', central: true, sum }],
    cmp: { a: { key: '2026-09', sum }, b: { key: '2026-10', sum } }, filters: 'nenhum', generatedAt: '2026-11-06T20:00:00Z' });
  eq(T.map((t) => t.name), ['Indicadores gerais', 'Por etapa', 'Histórico mensal', 'Lotes analisados', 'Lotes com desvios', 'Parâmetros', 'Comparação', 'Informações']);
  T.forEach((t) => t.rows.forEach((r) => assert.equal(r.length, t.cols.length, t.name + ': linha com número de colunas correto')));
  T.forEach((t) => t.rows.forEach((r) => r.forEach((v, i) => { const ty = t.cols[i][1]; if (v != null && 'npi'.includes(ty)) assert.equal(typeof v, 'number', t.name + '/' + t.cols[i][0]); })));
  const fora = T[4].rows.length, ocorr = ['bh', 'fe', 'bb'].reduce((s2, k) => s2 + sum.stages[k].fora, 0);
  assert.equal(fora, ocorr, 'lotes com desvios = ocorrências fora do resumo');
  const so = { bh: R.bh.filter((r) => r.st === 'fora'), fe: [], bb: [] }; // recorte filtrado
  const T2 = N.exportTables({ D: REAL, sum, R: so, hist: [], cmp: null, filters: 'Brewhouse: Somente fora', generatedAt: '2026-11-06T20:00:00Z' });
  assert.ok(T2[3].rows.every((r) => r[0] === 'Brewhouse' && r[7] === 'Com desvio'), 'lotes respeitam o recorte');
  assert.equal(T2[6].rows[0][0], 'São necessários ao menos dois meses no histórico para comparar.');
});

test('CSV: separador, vírgula decimal, BOM e proteção contra fórmulas', () => {
  const t = { cols: [['Texto', 's'], ['Número', 'n'], ['Percentual', 'p'], ['Inteiro', 'i'], ['Data', 'd']],
    rows: [['=HYPERLINK("http://x")', -1.5, 91.25, 3, '2026-10-28T18:34:48Z'], ['+cmd', 0, null, null, null], ['@soma', 2, 0, 0, ''], ['-texto', 1, 1, 1, null], ['a;b "c"', 1, 1, 1, null]] };
  const csv = N.toCsv(t), L = csv.slice(1).split('\r\n');
  assert.equal(csv[0], '﻿'); assert.equal(L[0], 'Texto;Número;Percentual;Inteiro;Data');
  assert.ok(L[1].startsWith(`"'=HYPERLINK(""http://x"")"`), 'fórmula vira texto');
  assert.ok(L[1].includes(';-1,5;91,25;3;28/10/2026 15:34'), 'número negativo continua número; data em São Paulo');
  assert.ok(L[2].startsWith("'+cmd;") && L[3].startsWith("'@soma;") && L[4].startsWith("'-texto;"));
  assert.ok(L[5].startsWith('"a;b ""c"""'));
});

test('planilha: nenhuma célula com fórmula; percentuais e datas no formato do Excel', () => {
  const t = { title: 'T', cols: [['Texto', 's'], ['Pct', 'p'], ['Data', 'd'], ['N', 'n']], rows: [['=1+1', 91.5, '2026-10-28T18:34:48Z', 2], [null, null, 'inválida', null]] };
  const rows = N.sheetCells(t), cells = rows.flat().filter(Boolean);
  assert.ok(cells.every((c) => !('f' in c)), 'sem fórmulas'); eq(rows[3][0], { t: 's', v: '=1+1' });
  assert.equal(rows[3][1].v, 0.915); assert.equal(rows[3][1].z, '0.0%');
  const esperado = Date.UTC(2026, 9, 28, 15, 34, 48) / 864e5 + 25569; assert.ok(Math.abs(rows[3][2].v - esperado) < 1e-9, 'data em horário de São Paulo');
  eq(rows[4][2], { t: 's', v: 'inválida' });
});

test('backup do servidor: gerado, validado e com integridade verificada', () => {
  const v = (rev, action, data = REAL) => ({ period_key: '2026-10', revision: rev, file_name: 'f' + rev + '.xlsx', checksum: 'ck' + rev, published_by: 'p@x', published_at: '2026-11-0' + rev + 'T10:00:00Z', action, restored_from_revision: action === 'restore' ? 1 : null, set_current: true, data });
  const resp = { exportedAt: '2026-11-06T20:00:00Z', exportedBy: 'p@x', current: { period_key: '2026-10' }, months: [{ period_key: '2026-10', revision: 3, checksum: 'ck3', file_name: 'f3.xlsx', published_at: 't' }], publications: [{ id: 1, period_key: '2026-10', revision: 1 }], versions: [v(1, 'backfill'), v(2, 'publish'), v(3, 'restore')] };
  const o = JSON.parse(JSON.stringify(N.buildServerBackup(resp)));
  let r = N.checkServerBackup(o); eq(r.P, []); eq(r.W, []); assert.equal(r.V.length, 3);
  const adulterado = JSON.parse(JSON.stringify(o)); adulterado.versions[1].dataJson = adulterado.versions[1].dataJson.replace('"meta":92', '"meta":99');
  assert.ok(N.checkServerBackup(adulterado).P.some((x) => x.includes('integridade')), 'alteração detectada');
  const rep = JSON.parse(JSON.stringify(o)); rep.versions.push(rep.versions[0]); assert.ok(N.checkServerBackup(rep).P.some((x) => x.includes('repetida')));
  const per = JSON.parse(JSON.stringify(o)); per.versions[0].key = '2026-09'; assert.ok(N.checkServerBackup(per).P.some((x) => x.includes('período dos dados não confere')));
  const falta = JSON.parse(JSON.stringify(o)); falta.months[0].revision = 9; assert.ok(N.checkServerBackup(falta).W.some((x) => x.includes('r9')));
  assert.ok(N.checkServerBackup({ format: 'outro' }).P.length > 0);
  // limitação: adulteração com recálculo do FNV passa na integridade (por isso existe a assinatura do servidor)
  const recalc = JSON.parse(JSON.stringify(o)); const vr = recalc.versions[1]; vr.dataJson = vr.dataJson.replace('"meta":92', '"meta":99'); vr.integrity = N.fnv(vr.dataJson);
  eq(N.checkServerBackup(recalc).P, []);
});

test('backup legado (formato 1): continua lido, mas nunca é tratado como autêntico', () => {
  const resp = { exportedAt: '2026-11-06T20:00:00Z', exportedBy: 'p@x', months: [{ period_key: '2026-10', revision: 1, checksum: 'ck', file_name: 'f.xlsx' }], publications: [],
    versions: [{ period_key: '2026-10', revision: 1, file_name: 'f.xlsx', checksum: 'ck', published_by: 'p', published_at: 't', action: 'publish', set_current: true, data: REAL }] };
  const o = plain(N.buildServerBackup(resp));
  assert.equal(o.version, 1); assert.ok(!('auth' in o));
  const ck = N.checkServerBackup(o); eq(ck.P, []);
  const loc = { contentSha256: 'x'.repeat(64), shaOk: true };
  assert.equal(N.classifyBackup(o, ck, loc, null), 'legado');
  assert.equal(N.classifyBackup(o, ck, loc, { configured: true, signed: false, valid: false }), 'legado', 'nem a resposta do servidor torna um legado autêntico');
  // backup do esquema antigo (assinatura por versão, ftr-painel-backup-v1): não é mais conferido
  assert.equal(N.classifyBackup({ ...o, auth: { alg: 'HMAC-SHA256', scheme: 'ftr-painel-backup-v1' } }, ck, loc, null), 'esquema_antigo');
  // backups antigos sem os campos novos (via, sha256) continuam válidos na estrutura
  const antigo = plain(o); antigo.versions.forEach((v) => { delete v.via; }); eq(N.checkServerBackup(antigo).P, []);
  eq(['autentico', 'legado', 'esquema_antigo', 'pendente', 'invalida', 'assinatura_ausente', 'chave_desconhecida', 'integridade'].map(N.sbkCanRepublish),
    ['sim', 'confirmar', 'confirmar', 'nao', 'nao', 'nao', 'nao', 'nao']);
});

test('JSON canônico (RFC 8785): vetores da norma, ordem das propriedades e entradas inválidas', () => {
  // vetor de exemplo da RFC 8785 (seção 3.2.2): números, textos com escapes e literais
  const entrada = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}');
  assert.equal(N.jcs(entrada), '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  // ordenação de propriedades por unidades UTF-16 (RFC 8785, seção 3.2.3)
  const chaves = JSON.parse('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}');
  assert.deepEqual(JSON.parse('[' + N.jcs(chaves).slice(1, -1).split(/,(?=")/).map((kv) => JSON.stringify(JSON.parse('{' + kv + '}')[Object.keys(JSON.parse('{' + kv + '}'))[0]])).join(',') + ']'),
    ['Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis', 'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh']);
  // mesma informação com propriedades em outra ordem = mesmo texto; arrays mantêm a ordem
  assert.equal(N.jcs({ b: 1, a: { d: [3, 1, 2], c: 'ção' } }), N.jcs({ a: { c: 'ção', d: [3, 1, 2] }, b: 1 }));
  assert.notEqual(N.jcs({ a: [1, 2] }), N.jcs({ a: [2, 1] }));
  assert.equal(N.jcs({ t: 'Fermentação ✓ 😀', z: -0, n: 1.5e-7 }), '{"n":1.5e-7,"t":"Fermentação ✓ 😀","z":0}');
  for (const ruim of [NaN, Infinity, undefined, () => 1, new Date(0), { a: '\ud800' }, { [String.fromCharCode(0xdc00)]: 1 }])
    assert.throws(() => N.jcs(ruim), /JCS/, 'recusa ' + String(ruim));
});

test('classificação de autenticidade: estados distintos e "autêntico" só com HMAC válido', () => {
  const o = { version: 2, auth: { alg: N.SBK_ALG, scheme: N.SBK_SCHEME, keyId: 'k1', contentSha256: 'a'.repeat(64), sig: 'b'.repeat(64) } };
  const ok = { P: [], W: [], V: [] }, loc = { contentSha256: 'a'.repeat(64), shaOk: true };
  const C = (ob, ck, l, s) => N.classifyBackup(ob, ck, l, s);
  assert.equal(C(o, { P: ['x'], W: [], V: [] }, loc, null), 'integridade');
  assert.equal(C(o, ok, { ...loc, shaOk: false }, null), 'integridade');
  assert.equal(C(o, ok, { ...loc, contentSha256: 'c'.repeat(64) }, null), 'integridade', 'resumo do conteúdo diferente do registrado');
  assert.equal(C({ version: 2 }, ok, loc, null), 'assinatura_ausente', 'formato 2 sem assinatura = assinatura removida');
  assert.equal(C({ ...o, auth: { ...o.auth, alg: 'HMAC-SHA1' } }, ok, loc, null), 'esquema_invalido');
  assert.equal(C({ ...o, auth: { ...o.auth, scheme: 'ftr-painel-backup-v1' } }, ok, loc, null), 'esquema_invalido');
  assert.equal(C(o, ok, null, null), 'sem_calculo');
  assert.equal(C(o, ok, loc, null), 'pendente', 'assinado, mas ainda não conferido: não é "autêntico"');
  assert.equal(C(o, ok, loc, { configured: false, signed: true, schemeOk: true, keyKnown: false }), 'nao_configurado');
  assert.equal(C(o, ok, loc, { configured: true, signed: true, schemeOk: true, keyKnown: false }), 'chave_desconhecida');
  assert.equal(C(o, ok, loc, { configured: true, signed: true, schemeOk: false, valid: false }), 'esquema_invalido');
  assert.equal(C(o, ok, loc, { configured: true, signed: true, schemeOk: true, keyKnown: true, valid: false }), 'invalida');
  assert.equal(C(o, ok, loc, { configured: true, signed: true, schemeOk: true, keyKnown: true, valid: true }), 'autentico');
  assert.ok(N.SBK_ST.autentico[1].startsWith('Autêntico') && !Object.entries(N.SBK_ST).some(([k, v]) => k !== 'autentico' && /Autêntico/.test(v[1])), 'só o estado autêntico usa a palavra');
});

