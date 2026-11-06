// Planilha SINTÉTICA (valores fictícios) com a mesma estrutura das abas oficiais do Excel do FTR.
// Matrizes no mesmo formato que o SheetJS entrega ao painel (sheet_to_json com header:1).
export function planilha({ mesConsol = '2026-10-01T00:00:00.000Z', invalidos = true } = {}) {
  const grade = (r, c) => Array.from({ length: r }, () => Array(c).fill(null));
  const bh = (sala) => { const R = grade(40, 12); R[2][0] = 'MOSTO HEINEKEN'; R[3][0] = 'Nº Batch';
    ['Extrato final de fervura (°P)', 'Tempo total de fabricação (min)', 'Aeração (mg/L)'].forEach((h, i) => { R[3][2 + i] = h; R[4][2 + i] = [15, 120, 9][i]; R[5][2 + i] = [14.5, 100, 8][i]; R[6][2 + i] = [15.5, 140, 10][i]; });
    R[3][5] = 'SENTENÇAS';
    const lotes = [['L1', 15, 110, 9, 'GOOD', 'GOOD', 'GOOD'], ['L2', 16, 130, 9.5, 'WRONG', 'GOOD', 'GOOD'], ['L3', 15.2, invalidos ? 'abc' : 125, '#REF!', 'GOOD', 'GOOD', ''], ['L4', 'n.a.', 150, 8.5, '', 'WRONG', 'GOOD'], ['L1', 15, 110, 9, 'GOOD', 'GOOD', 'GOOD']];
    lotes.forEach((l, i) => { R[11 + i][1] = l[0] + sala; R[11 + i][2] = l[1]; R[11 + i][3] = l[2]; R[11 + i][4] = l[3]; R[11 + i][5] = l[4]; R[11 + i][6] = l[5]; R[11 + i][7] = l[6]; });
    return R; };
  const etapa = (nome, params) => { const R = grade(30, 20), c = 1; // índices 1-based na lógica de parseStage (g(r,c) = R[r-1][c-1])
    const set = (r, cc, v) => { R[r - 1][cc - 1] = v; };
    set(3, c, nome + ' BLOCO'); set(4, c, 'Nº Batch'); set(4, c + 1, 'Parâmetro');
    params.forEach((p, i) => set(4, c + 2 + i, p)); const s = c + 2 + params.length, ftr = s + params.length;
    set(4, s, 'SENTENÇAS'); set(4, ftr, 'FTR BATCH');
    set(5, c + 1, 'Target'); set(6, c + 1, 'Mín'); set(7, c + 1, 'Máx');
    params.forEach((_, i) => { set(5, c + 2 + i, 10); set(6, c + 2 + i, 8); set(7, c + 2 + i, 12); });
    set(8, c, 'Nº Batch');
    [['F1', 9, 11], ['F2', 13, invalidos ? 'x' : 10], ['F3', 'n.a.', 10]].forEach((l, i) => { set(9 + i, c + 1, l[0]); params.forEach((_, k) => set(9 + i, c + 2 + k, l[1 + k])); });
    return R; };
  const C = grade(52, 16); C[0][5] = mesConsol; C[1][5] = 0.91; C[1][6] = 'Meta 92%';
  C[3][1] = 'Brewhouse';
  [['Original extract Sala', 'Original extract', 10, 1, 0.9], ['FTR Brewhouse (%)', '>92%', 20, 2, 0.9], ['Fermentation', null, null, null, null], ['FTR Fermentation (%)', '>90%', 10, 1, 0.9], ['Bright Beer', null, null, null, null], ['FTR Bright Beer (%)', '>95%', 10, 0, 1]]
    .forEach((r, i) => { C[4 + i][1] = r[0]; if (r[1] != null) { C[4 + i][2] = r[1]; C[4 + i][3] = r[2]; C[4 + i][4] = r[3]; C[4 + i][5] = r[4]; } });
  return { 'CONSOL.': C, 'BREWHOUSE 1': bh('-S1'), 'BREWHOUSE 3': bh('-S3'), FERMENTHP: etapa('HP', ['Enchimento', 'Dosagem']), FERMENTAMSTELPRAY: etapa('AMSTEL', ['Velocidade']), 'BRIGHT BEER': etapa('BB', ['Extrato', 'Turbidez']) };
}
