'use strict';

/**
 * Render laporan KPI MTEL (gaya dashboard) → PNG → kirim ke Telegram.
 *
 * Dipicu oleh repository_dispatch (event: kpi-report) dari Apps Script bot.
 * Data diambil dari endpoint dashboard: <WEBAPP_URL>?op=kpiMtEl&token=...
 *
 * Env:
 *   KPI_JSON_URL        URL endpoint JSON KPI (secret repo)
 *   TELEGRAM_BOT_TOKEN  token bot Telegram (secret repo)
 *   KPI_PAYLOAD         JSON client_payload dari repository_dispatch
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PAYLOAD = (() => {
  try { return JSON.parse(process.env.KPI_PAYLOAD || '{}') || {}; } catch (e) { return {}; }
})();
const JSON_URL = String(process.env.KPI_JSON_URL || '').trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

const COVERAGE = {
  BANDUNG: 'Witel Bandung & Cianjur',
  CIREBON: 'Witel pesisir utara Pulau Jawa',
  SOREANG: 'Witel Kab. Bandung',
  TASIKMALAYA: 'Witel Priangan Timur'
};

const KINDS = [
  { key: 'FIBERISASI', label: 'KPI MTEL — FIBERISASI' },
  { key: 'TIS', label: 'KPI MTEL — TIS' }
];

// ---------- KPI LINTAS ARTA (SLA per branch) ----------
function laPct(frac) {
  if (frac == null || isNaN(Number(frac))) return '-';
  return (Number(frac) * 100).toFixed(2).replace('.', ',') + '%';
}
function laJam(v) {
  if (v == null || isNaN(Number(v))) return '-';
  return Number(v).toFixed(2).replace('.', ',') + ' Jam';
}
function laSub(score) {
  if (score == null || isNaN(Number(score))) return '';
  let v = Number(score);
  if (v > 1) v = 1;
  if (v < 0) v = 0;
  return '<div style="font-size:.68rem;color:var(--text-muted);margin-top:1px;">Prestasi ' +
    (v * 100).toFixed(2).replace('.', ',') + '%</div>';
}
function laPerfect(sc) { return sc != null && !isNaN(Number(sc)) && Number(sc) >= 0.999999; }
function laPmHit(sc) { return Number(sc) >= 0.9; }
function laStatus(finalFrac) {
  const v = Number(finalFrac);
  if (!isFinite(v)) return { cls: 'badge-danger', txt: '💀 Perlu Tindakan' };
  const p = v * 100;
  if (p >= 98) return { cls: 'badge-success', txt: '👍 Excellent' };
  if (p >= 95) return { cls: 'badge-success', txt: '💪 Perlu ditingkatkan' };
  if (p >= 85) return { cls: 'badge-warning', txt: '⚠ Perlu Perhatian' };
  return { cls: 'badge-danger', txt: '💀 Perlu Tindakan' };
}
function laFinalCell(frac) {
  const v = Number(frac);
  const txt = (frac == null || isNaN(v)) ? '-' : (v * 100).toFixed(2).replace('.', ',') + '%';
  const p = v * 100;
  return kpiCell(txt, isFinite(v) && p >= 95, isFinite(v) && p >= 85 && p < 95);
}
function laBranch(b) {
  const k = String(b || '').toUpperCase();
  return k === 'BOGOR' ? 'SUKABUMI' : String(b || '');
}
function laRows(branches) {
  const rows = (branches || []).slice().map(function (r) {
    return Object.assign({}, r, { final: Number(r.final) || 0 });
  });
  rows.sort(function (a, b) { return b.final - a.final; });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  return rows;
}


function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function f2(v) {
  if (v == null || isNaN(Number(v))) return '-';
  return Number(v).toFixed(2).replace('.', ',');
}
function pct(v) {
  if (v == null || isNaN(Number(v))) return '-';
  return Number(v).toFixed(2).replace('.', ',') + '%';
}
function cap100(v) { return Math.min(Number(v) || 0, 100); }

// Pencapaian = aktual/target (MTTR = 4 jam/aktual), dibatasi 100%.
function pencMttr(m) {
  if (m == null || isNaN(Number(m)) || Number(m) <= 0) return 100;
  return Math.min(4 / Number(m) * 100, 100);
}
function pencComp(p) { return cap100((Number(p) || 0) / 90 * 100); }
function pencAvail(p) { return cap100((Number(p) || 0) / 99.5 * 100); }
function pencPm(p) { return cap100((Number(p) || 0) / 90 * 100); }

function overallRatio(compPct, availPct, pmPct, mttr) {
  return pencMttr(mttr) * .30 + pencComp(compPct) * .30 +
         pencAvail(availPct) * .20 + pencPm(pmPct) * .20;
}

function subNilai(text, pencapaian, bobot) {
  return text +
    '<div style="font-size:.68rem;color:var(--text-muted);margin-top:2px;font-weight:600;">' +
    'Nilai Akhir ' + pct(pencapaian * bobot) + '</div>';
}

function branchLabel(b) {
  const s = String(b || '');
  return 'Branch ' + s.charAt(0) + s.slice(1).toLowerCase();
}
function kpiCell(text, ok, warn) {
  const isEmpty = (text === '-' || text === '' || text == null);
  const cls = isEmpty ? 'pct-empty' : (ok ? 'pct-good' : (warn ? 'pct-warn' : 'pct-bad'));
  const icon = isEmpty ? '' : (cls === 'pct-good' ? '★ ' : (cls === 'pct-warn' ? '⚠ ' : '💀 '));
  return '<span class="pct-label ' + cls + '">' + icon + esc(text) + '</span>';
}
function statusFromOverall(v) {
  const n = Number(v);
  if (!isFinite(n)) return { cls: 'badge-danger', txt: '— Belum ada data' };
  if (n >= 97) return { cls: 'badge-success', txt: '👍 Excellent' };
  if (n >= 90) return { cls: 'badge-warning', txt: '⚠ Perlu Perhatian' };
  return { cls: 'badge-danger', txt: '💀 Perlu Tindakan' };
}
function statusNilai(overall) {
  return cap100((Number(overall) || 0) / 97 * 100);
}
function stars(hits) {
  const c = (hits || []).filter(Boolean).length;
  if (!c) return '';
  return '<div style="font-size:1.05rem;letter-spacing:.12em;color:#facc15;text-shadow:0 0 8px rgba(250,204,21,.4);">' +
    '★'.repeat(c) + '</div>';
}
function availOf(js) {
  if (js && js.availPct != null && isFinite(Number(js.availPct))) return Number(js.availPct);
  const sum = Number(js && js.availSum), cnt = Number(js && js.availCount);
  if (isFinite(sum) && isFinite(cnt) && cnt > 0) return Math.max(0, Math.min(100, sum / cnt * 100));
  return null;
}

function buildRows(branches, kind) {
  const rows = (branches || []).map(function (b) {
    const js = (b.jenis && b.jenis[kind]) ? b.jenis[kind] : {};
    const tot = Number(js.total) || 0;
    const comp = Number(js.compliance) || 0;
    const compPct = tot ? comp / tot * 100 : 0;
    const mttr = (js.mttr == null || isNaN(Number(js.mttr))) ? null : Number(js.mttr);
    const avail = availOf(js);
    const pmPct = Number(b.pmPct) || 0;
    const overall = overallRatio(compPct, avail, pmPct, mttr);
    return {
      branch: String(b.branch || '').toUpperCase(),
      prevRank: Number(b.prevRank) || 0,
      total: tot, compPct: compPct, mttr: mttr,
      ttrCount: Number(js.ttrCount) || 0,
      availPct: avail, pmPct: pmPct, overall: overall,
      availSum: Number(js.availSum) || 0,
      availCount: Number(js.availCount) || 0
    };
  });
  rows.sort(function (a, b) { return (b.overall || 0) - (a.overall || 0); });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  return rows;
}

function buildTotal(rows, meta) {
  const m = meta || {};
  let tot = 0, comp = 0, ttrC = 0, ttrS = 0, pmW = 0, availSum = 0, availCount = 0;
  rows.forEach(function (r) {
    tot += r.total;
    comp += r.total ? (r.compPct / 100) * r.total : 0;
    ttrC += r.ttrCount;
    ttrS += (r.mttr || 0) * r.ttrCount;
    pmW += (r.pmPct || 0) * (r.total || 0);
    availSum += r.availSum;
    availCount += r.availCount;
  });
  const mttr = ttrC ? ttrS / ttrC : null;
  let availPct = availCount > 0 ? Math.max(0, Math.min(100, availSum / availCount * 100)) : null;
  if (m.availPct != null && isFinite(Number(m.availPct))) availPct = Number(m.availPct);
  const compPct = tot ? comp / tot * 100 : 0;
  let pmPct = tot ? pmW / tot : 0;
  // GRAND TOTAL memakai PM patroli global (45%), bukan bobot TOTAL TT.
  if (m.pmPct != null && isFinite(Number(m.pmPct))) pmPct = Number(m.pmPct);
  const overall = overallRatio(compPct, availPct, pmPct, mttr);
  return { total: tot, mttr: mttr, compPct: compPct, availPct: availPct, pmPct: pmPct, overall: overall };
}

function headerCell(text, bobot) {
  return '<th>' + text + '<div style="font-size:.68rem;color:var(--text-muted);font-weight:600;">Bobot ' + bobot + '</div></th>';
}

function tableHtml(kindKey, label, rows, gt, monthLabel) {
  let html = '<div style="display:flex;align-items:baseline;gap:8px;margin:4px 0 8px;">' +
    '<span style="font-weight:800;letter-spacing:.04em;color:#38bdf8;">' + esc(label) + '</span>' +
    '<span style="font-size:.75rem;color:var(--text-muted);">' + esc(monthLabel) + '</span>' +
    '</div>' +
    '<div class="ticket-month-table-wrap"><table class="ticket-month-table"><thead><tr>' +
    '<th>BRANCH</th><th>TOTAL TT</th>' +
    headerCell('MTTR (≤4.0h) Nilai Akhir', '30%') +
    headerCell('TTR COMP (≥90%)', '30%') +
    headerCell('AVAIL (≥99.5%)', '20%') +
    headerCell('PM (≥90%)', '20%') +
    '<th>OVERALL KPI (&ge; 97%)<div style="font-size:.68rem;color:var(--text-muted);font-weight:600;">100%</div></th>' +
    '<th>STATUS</th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (r) {
    const st = statusFromOverall(r.overall);
    const status = stars([r.mttr != null && r.mttr <= 4, r.compPct >= 90,
      r.availPct != null && r.availPct >= 99.5, r.pmPct >= 90]) +
      '<span class="badge ' + st.cls + '">' + st.txt + '</span>' +
      '<div style="font-size:.68rem;color:var(--text-muted);margin-top:2px;font-weight:600;">' +
      'Nilai Akhir ' + pct(statusNilai(r.overall)) + '</div>';

    html += '<tr>' +
      '<td><div style="font-weight:700;">' + esc(branchLabel(r.branch)) + '</div></td>' +
      '<td class="text-right" style="font-weight:700;">' + r.total + '</td>' +
      '<td class="text-right font-mono">' + subNilai(
        (r.mttr == null ? '-' : f2(r.mttr) + 'h'), pencMttr(r.mttr), .30) + '</td>' +
      '<td class="text-right font-mono">' + subNilai(pct(r.compPct), pencComp(r.compPct), .30) + '</td>' +
      '<td class="text-right font-mono">' + subNilai(
        (r.availPct == null ? '-' : pct(r.availPct)), pencAvail(r.availPct), .20) + '</td>' +
      '<td class="text-right font-mono" style="font-weight:700;">' + subNilai(pct(r.pmPct), pencPm(r.pmPct), .20) + '</td>' +
      '<td class="text-right font-mono" style="font-weight:700;">' + kpiCell(pct(r.overall), r.overall >= 97, r.overall >= 90 && r.overall < 97) + '</td>' +
      '<td class="text-center">' + status + '</td>' +
      '</tr>';
  });

  const gtSt = statusFromOverall(gt.overall);
  const gtStatus = stars([gt.mttr != null && gt.mttr <= 4, gt.compPct >= 90,
    gt.availPct != null && gt.availPct >= 99.5, gt.pmPct >= 90]) +
    '<span class="badge ' + gtSt.cls + '">' + gtSt.txt + '</span>' +
    '<div style="font-size:.68rem;color:var(--text-muted);margin-top:2px;font-weight:600;">' +
    'Nilai Akhir ' + pct(statusNilai(gt.overall)) + '</div>';

  html += '</tbody><tfoot><tr>' +
    '<td class="text-left" style="font-weight:800;letter-spacing:.05em;">GRAND TOTAL</td>' +
    '<td class="text-right" style="font-weight:800;">' + gt.total + '</td>' +
    '<td class="text-right font-mono">' + subNilai(
      (gt.mttr == null ? '-' : f2(gt.mttr) + 'h'), pencMttr(gt.mttr), .30) + '</td>' +
    '<td class="text-right font-mono">' + subNilai(pct(gt.compPct), pencComp(gt.compPct), .30) + '</td>' +
    '<td class="text-right font-mono">' + subNilai(
      (gt.availPct == null ? '-' : pct(gt.availPct)), pencAvail(gt.availPct), .20) + '</td>' +
    '<td class="text-right font-mono" style="font-weight:800;">' + subNilai(pct(gt.pmPct), pencPm(gt.pmPct), .20) + '</td>' +
    '<td class="text-right font-mono" style="font-weight:800;">' + kpiCell(pct(gt.overall), gt.overall >= 97, gt.overall >= 90 && gt.overall < 97) + '</td>' +
    '<td class="text-center">' + gtStatus + '</td>' +
    '</tr></tfoot></table></div>';
  return html;
}

function actionHtml(kindKey, rows) {
  return '<div style="background:rgba(15,23,42,.6);border:1px solid #334155;border-radius:10px;padding:12px 14px;margin-top:10px;">' +
    '<div style="font-size:.72rem;color:#38bdf8;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Action Item per Branch — ' + esc(kindKey) + '</div>' +
    rows.map(function (r) {
      const names = ['MTTR', 'TTR COMP', 'AVAIL', 'PM'];
      const hits = [r.mttr != null && r.mttr <= 4, r.compPct >= 90, r.availPct != null && r.availPct >= 99.5, r.pmPct >= 90];
      const failed = [];
      for (let i = 0; i < names.length; i++) { if (!hits[i]) failed.push(names[i]); }
      const tip = failed.length === 0
        ? '<span style="color:#34d399;font-weight:800;">Semua tercapai ★</span>'
        : '<span style="color:#fb7185;font-weight:700;">Perbaiki: ' + esc(failed.join(', ')) + '</span>';
      return '<div style="padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.18);display:flex;gap:10px;align-items:center;">' +
        '<b style="min-width:160px;color:#e2e8f0;">' + esc(branchLabel(r.branch)) + '</b>' +
        '<span style="font-variant-numeric:tabular-nums;color:#94a3b8;min-width:90px;">OVERALL ' + esc(pct(r.overall)) + '</span>' +
        tip +
        '</div>';
    }).join('') +
    '</div>';
}

function laTableHtml(rows, gt, monthLabel) {
  function mom(r) {
    if (!r.prevRank) return '<span style="color:var(--text-muted);">-</span>';
    if (r.rank < Number(r.prevRank)) return '<span style="color:#34d399;font-weight:800;text-shadow:0 0 6px rgba(52,211,153,.4);">▲ Naik</span>';
    if (r.rank > Number(r.prevRank)) return '<span style="color:#fb7185;font-weight:800;text-shadow:0 0 6px rgba(251,113,133,.4);">▼ Turun</span>';
    return '<span style="color:#fbbf24;font-weight:800;">— Masih sama</span>';
  }
  function hits(r) {
    return [laPerfect(r.scoreRT), laPerfect(r.scoreOST), laPerfect(r.scoreTTR), laPerfect(r.scoreTTP), laPmHit(r.scorePM)];
  }
  function cells(r) {
    return '<td class="text-right font-mono">' + kpiCell(r.meanRT == null ? (laPerfect(r.scoreRT) ? '0,00 Jam' : '-') : laJam(r.meanRT), laPerfect(r.scoreRT), r.meanRT != null && Number(r.meanRT) > 0.25 && Number(r.meanRT) <= 0.3125) + laSub(r.scoreRT) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(r.meanOST == null ? (laPerfect(r.scoreOST) ? '0,00 Jam' : '-') : laJam(r.meanOST), laPerfect(r.scoreOST), r.meanOST != null && Number(r.meanOST) > 1 && Number(r.meanOST) <= 1.25) + laSub(r.scoreOST) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(r.meanTTR == null ? (laPerfect(r.scoreTTR) ? '0,00 Jam' : '-') : laJam(r.meanTTR), laPerfect(r.scoreTTR), r.meanTTR != null && Number(r.meanTTR) > 4 && Number(r.meanTTR) <= 5) + laSub(r.scoreTTR) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(r.meanTTP == null ? (laPerfect(r.scoreTTP) ? '0,00 Jam' : '-') : laJam(r.meanTTP), laPerfect(r.scoreTTP), r.meanTTP != null && Number(r.meanTTP) > 24 && Number(r.meanTTP) <= 30) + laSub(r.scoreTTP) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell((Number(r.pmReal) || 0) + '/' + (Number(r.routeCount) || 0), laPmHit(r.scorePM), Number(r.scorePM) >= 0.8 && !laPmHit(r.scorePM)) + laSub(r.scorePM) + '</td>';
  }

  let html = '<div class="ticket-month-table-wrap" style="margin-top:6px;">' +
    '<div style="font-weight:600;margin:0 0 6px;">KPI Lintas Arta bulan ' + esc(monthLabel) + '</div>' +
    '<table class="ticket-month-table"><thead><tr>' +
    '<th>RANK</th><th>MOM</th><th class="branch-col">BRANCH</th><th>AREA</th>' +
    '<th class="num">TOTAL TIKET</th><th class="num">RT (≤ 0,25 Jam)</th><th class="num">OST (≤ 1 Jam)</th>' +
    '<th class="num">TTR (≤ 4 Jam)</th><th class="num">TTP (≤ 24 Jam)</th><th class="num">PM (≥ 90%)</th>' +
    '<th class="num">FINAL (100%)</th><th>STATUS</th><th>ACTION</th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (r) {
    const st = laStatus(r.final);
    html += '<tr>' +
      '<td class="text-center" style="font-weight:700;">#' + r.rank + '</td>' +
      '<td class="text-center">' + mom(r) + '</td>' +
      '<td class="branch-col"><div style="font-weight:700;">Branch ' + esc(laBranch(r.branch)) + '</div></td>' +
      '<td><span class="badge badge-info" style="font-size:.68rem;">JAWA BARAT</span></td>' +
      '<td class="text-right font-mono" style="font-weight:700;">' + (Number(r.gangguan) || 0) + '</td>' +
      cells(r) +
      '<td class="text-right font-mono" style="font-weight:800;">' + laFinalCell(r.final) + '</td>' +
      '<td class="text-center">' + stars(hits(r)) + '<span class="badge ' + st.cls + '">' + st.txt + '</span></td>' +
      '<td class="text-center"><span class="kpi-detail-btn" style="display:inline-block;font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;">Detail</span></td>' +
      '</tr>';
  });

  const g = gt || {};
  const gHits = [laPerfect(g.scoreRT), laPerfect(g.scoreOST), laPerfect(g.scoreTTR), laPerfect(g.scoreTTP),
    Number(g.routeCount) > 0 && (Number(g.pmReal) || 0) / Number(g.routeCount) >= 0.9];
  const gst = laStatus(g.final);
  html += '</tbody><tfoot><tr><td colspan="4" class="text-left" style="font-weight:800;letter-spacing:.05em;">GRAND TOTAL</td>' +
    '<td class="text-right font-mono" style="font-weight:800;">' + (Number(g.gangguan) || 0) + '</td>' +
    cells(g) +
    '<td class="text-right font-mono" style="font-weight:800;">' + laFinalCell(g.final) + '</td>' +
    '<td class="text-center">' + stars(gHits) + '<span class="badge ' + gst.cls + '">' + gst.txt + '</span></td>' +
    '<td class="text-center"></td></tr></tfoot></table></div>' +
    '<div style="color:#e2e8f0;font-size:.78rem;margin-top:8px;">FINAL = 10% Respon + 10% On Site + 40% To Repair + 10% Temp→+Perm + 30% PM.</div>';
  return html;
}

function laActionHtml(rows) {
  return '<div style="background:rgba(15,23,42,.6);border:1px solid #334155;border-radius:10px;padding:12px 14px;margin-top:10px;">' +
    '<div style="font-size:.72rem;color:#38bdf8;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Action Item per Branch</div>' +
    (rows || []).map(function (r) {
      const names = ['RT', 'OST', 'TTR', 'TTP', 'PM'];
      const hit = [laPerfect(r.scoreRT), laPerfect(r.scoreOST), laPerfect(r.scoreTTR), laPerfect(r.scoreTTP), laPmHit(r.scorePM)];
      const failed = [];
      for (let i = 0; i < names.length; i++) { if (!hit[i]) failed.push(names[i]); }
      const tip = failed.length === 0
        ? '<span style="color:#34d399;font-weight:800;">Semua tercapai ★</span>'
        : '<span style="color:#fb7185;font-weight:700;">Perbaiki: ' + esc(failed.join(', ')) + '</span>';
      return '<div style="padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.18);display:flex;gap:10px;align-items:center;">' +
        '<b style="min-width:160px;color:#e2e8f0;">' + esc(laBranch(r.branch)) + '</b>' +
        '<span style="font-variant-numeric:tabular-nums;color:#94a3b8;min-width:90px;">FINAL ' + esc(laPct(r.final)) + '</span>' +
        tip +
        '</div>';
    }).join('') +
    '</div>';
}

function buildLaPage(data) {
  const css = fs.readFileSync(path.join(__dirname, 'kpi-style.css'), 'utf8');
  const monthLabel = data.monthLabel || data.bulan || '';
  const rows = laRows(data.branches);
  const block = '<div class="panel panel-photo panel-overall kpi-shot" id="shot-LA">' +
    '<div class="panel-title"><span>KPI LINTAS ARTA BULAN ' + esc(String(monthLabel).toUpperCase()) + '</span></div>' +
    '<div style="padding:2px 0 4px;">' +
      laTableHtml(rows, data.total || {}, monthLabel) +
      laActionHtml(rows) +
    '</div>' +
    '</div>';

  return '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<title>KPI LINTAS ARTA — ' + esc(monthLabel) + '</title>' +
    '<style>' + css + '</style>' +
    '<style>' +
    'html,body{background:#0b1220 !important;margin:0;padding:18px;}' +
    '.kpi-shot{width:max-content;max-width:none;}' +
    '.kpi-shot .ticket-month-table-wrap{overflow:visible !important;}' +
    '.kpi-shot .ticket-month-table{white-space:nowrap;}' +
    '</style></head><body class="app-mode theme-aura theme-dark">' +
    block +
    '</body></html>';
}

function buildPage(data) {
  const css = fs.readFileSync(path.join(__dirname, 'kpi-style.css'), 'utf8');
  const monthLabel = data.monthLabel || data.bulan || '';
  const gtMeta = data.total || {};
  const blocks = KINDS.map(function (kd) {
    const rows = buildRows(data.branches, kd.key);
    const gt = buildTotal(rows, gtMeta);
    return '<div class="panel panel-photo panel-overall kpi-shot" id="shot-' + kd.key + '">' +
      '<div class="panel-title"><span>KPI TIKET MTEL BULAN ' + esc(monthLabel) + ' — ' + kd.key + '</span></div>' +
      '<div style="padding:2px 0 4px;">' +
        tableHtml(kd.key, kd.label, rows, gt, monthLabel) +
        actionHtml(kd.key, rows) +
      '</div>' +
      '</div>';
  }).join('');

  return '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<title>KPI MTEL — ' + esc(monthLabel) + '</title>' +
    '<style>' + css + '</style>' +
    '<style>' +
    'html,body{background:#0b1220 !important;margin:0;padding:18px;}' +
    '.kpi-shot{width:max-content;max-width:none;margin-bottom:18px;}' +
    '.kpi-shot .ticket-month-table-wrap{overflow:visible !important;}' +
    '.kpi-shot .ticket-month-table{white-space:nowrap;}' +
    '.kpi-shot .kpi-detail-btn{pointer-events:none;}' +
    '</style></head><body class="app-mode theme-aura theme-dark">' +
    blocks +
    '</body></html>';
}

// URL endpoint LA: pakai KPI_LA_JSON_URL bila diisi, kalau tidak turunkan
// dari KPI_JSON_URL (op=kpiMtEl -> op=kpiLa) supaya cukup 1 secret.
function laJsonUrl() {
  const direct = String(process.env.KPI_LA_JSON_URL || '').trim();
  if (direct) return direct;
  if (JSON_URL.indexOf('op=kpiMtEl') !== -1) return JSON_URL.replace('op=kpiMtEl', 'op=kpiLa');
  if (JSON_URL.indexOf('op=') !== -1) return JSON_URL.replace(/op=[^&]+/, 'op=kpiLa');
  return JSON_URL + (JSON_URL.indexOf('?') !== -1 ? '&' : '?') + 'op=kpiLa';
}

async function fetchData(url) {
  const target = url || JSON_URL;
  if (!target) throw new Error('KPI_JSON_URL belum diisi (secret repo).');
  const res = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'kpi-report-bot/1.0' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Endpoint bukan JSON (HTTP ' + res.status + '): ' + text.slice(0, 200).replace(/\s+/g, ' '));
  }
  if (!data || data.ok !== true) throw new Error('Endpoint KPI error: ' + String((data && data.error) || 'unknown'));
  if (!data.branches || !data.branches.length) throw new Error('Data KPI kosong (branches=0).');
  return data;
}

async function sendPhoto(chatId, buffer, filename, caption, replyTo) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (replyTo) fd.append('reply_to_message_id', String(replyTo));
  if (caption) fd.append('caption', String(caption).slice(0, 1024));
  fd.append('photo', new Blob([buffer], { type: 'image/png' }), filename);

  const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto', {
    method: 'POST',
    body: fd
  });
  const body = await res.text();
  let ok = false;
  try { ok = JSON.parse(body).ok === true; } catch (e) {}
  if (!ok) console.error('sendPhoto gagal (' + chatId + '): ' + body.slice(0, 300));
  return ok;
}

(async function main() {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN belum diisi (secret repo).');

  const chatIds = (PAYLOAD.chat_ids && PAYLOAD.chat_ids.length)
    ? PAYLOAD.chat_ids.map(String)
    : (PAYLOAD.chat_id ? [String(PAYLOAD.chat_id)] : []);
  if (!chatIds.length) throw new Error('chat_ids kosong di payload.');
  const replyTo = Number(PAYLOAD.reply_to_message_id || 0);

  const KIND = String(PAYLOAD.kind || 'mtel').toLowerCase() === 'la' ? 'la' : 'mtel';

  const data = await fetchData(KIND === 'la' ? laJsonUrl() : JSON_URL);
  console.log('Data OK (' + KIND + '): ' + (data.monthLabel || data.bulan) + ' | branches=' + ((data.branches || []).length));

  const html = KIND === 'la' ? buildLaPage(data) : buildPage(data);
  fs.writeFileSync(path.join(__dirname, 'kpi-report-preview.html'), html);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });

  const shotIds = KIND === 'la' ? ['LA'] : KINDS.map(function (kd) { return kd.key; });
  const shots = {};
  for (const id of shotIds) {
    const el = page.locator('#shot-' + id);
    await el.waitFor({ state: 'visible', timeout: 30000 });
    shots[id] = await el.screenshot({ type: 'png', animations: 'disabled' });
    console.log('Screenshot ' + id + ': ' + shots[id].length + ' bytes');
  }
  await browser.close();

  for (const chatId of chatIds) {
    if (KIND === 'la') {
      await sendPhoto(chatId, shots.LA, 'KPI_LINTAS_ARTA.png', PAYLOAD.la_caption || '', replyTo);
    } else {
      await sendPhoto(chatId, shots.FIBERISASI, 'KPI_FIBERISASI.png', PAYLOAD.fib_caption || '', replyTo);
      await new Promise(function (r) { setTimeout(r, 700); });
      await sendPhoto(chatId, shots.TIS, 'KPI_TIS.png', PAYLOAD.tis_caption || '', replyTo);
    }
    console.log('Terkirim ke ' + chatId);
  }
})().catch(function (err) {
  console.error('GAGAL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
