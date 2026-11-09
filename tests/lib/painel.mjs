// Carrega as funções PURAS do painel (docs/index.html) num contexto vm, para os testes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
const bloco = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, 'bloco ' + a); return src.slice(i, j); };
const linha = (src, re) => { const m = re.exec(src); assert.ok(m, String(re)); return m[0]; };
// Ambiente com o bloco puro + as definições de que o bloco PURE2 depende (copiadas do próprio painel)
export function ambiente(src) {
  const code = bloco(src, '/*PURE_START*/', '/*PURE_END*/') + '\n' +
    linha(src, /const DBN='ftr-painel',STORE='imports',FMT=2;/) + '\n' + linha(src, /function fnv\(s\)\{[^\n]*/) + '\n' + linha(src, /const jsonOf=[^\n]*/) + '\n' +
    linha(src, /function validateData\(d\)\{[\s\S]*?return null\}/) + '\n' + (src.includes('/*PURE2_START*/') ? bloco(src, '/*PURE2_START*/', '/*PURE2_END*/') : '') +
    '\n;globalThis.__ = {parseWorkbook,summarize,pkeyOf,keyLabel,stageReadings,mkReadingsOf,chk,mkReadings,fnv,jsonOf,validateData,FMT,SLOTS,' +
    (src.includes('reviewImport') ? 'reviewImport,summaryDiff,periodFromName,exportTables,csvCell,toCsv,sheetCells,xlSerial,buildServerBackup,checkServerBackup,' : '') +
    (src.includes('function classifyBackup') ? 'jcs,backupBody,classifyBackup,sbkCanRepublish,SBK_ST,SBK_SCHEME,SBK_ALG' : '') + '}';
  const ctx = vm.createContext({ console, Intl, Date, Math, JSON, Object, Array, String, Number, Set, Map, RegExp, isFinite, isNaN, parseFloat, Error });
  vm.runInContext(code, ctx); return ctx.__;
}
