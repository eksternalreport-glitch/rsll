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
  { key: 'FIBERISASI', label: 'KPI MTEL \u2014 FIBERISASI' },
  { key: 'TIS', label: 'KPI MTEL \u2014 TIS' }
];

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
function mttrScore(m) {
  if (m == null || isNaN(Number(m)) || Number(m) <= 0) return 100;
  return Math.min(4 / Number(m) * 100, 100);
}
function branchLabel(b) {
  const s = String(b || '');
  return 'Branch ' + s.charAt(0) + s.slice(1).toLowerCase();
}
function kpiCell(text, ok, warn) {
  const isEmpty = (text === '-' || text === '' || text == null);
  const cls = isEmpty ? 'pct-empty' : (ok ? 'pct-good' : (warn ? 'pct-warn' : 'pct-bad'));
  const icon = isEmpty ? '' : (cls === 'pct-good' ? '\u2605 ' : (cls === 'pct-warn' ? '\u26A0 ' : '\u{1F480} '));
  return '<span class="pct-label ' + cls + '">' + icon + esc(text) + '</span>';
}
function statusFromOverall(v) {
  const n = Number(v);
  if (!isFinite(n)) return { cls: 'badge-danger', txt: '\u2014 Belum ada data' };
  if (n >= 97) return { cls: 'badge-success', txt: '\u{1F44D} Excellent' };
  if (n >= 90) return { cls: 'badge-warning', txt: '\u26A0 Perlu Perhatian' };
  return { cls: 'badge-danger', txt: '\u{1F480} Perlu Tindakan' };
}
function stars(hits) {
  const c = (hits || []).filter(Boolean).length;
  if (!c) return '';
  return '<div style="font-size:1.05rem;letter-spacing:.12em;color:#facc15;text-shadow:0 0 8px rgba(250,204,21,.4);">' +
    '\u2605'.repeat(c) + '</div>';
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
    const overall = compPct * 0.30 + (avail != null ? avail : 0) * 0.20 + pmPct * 0.20 + mttrScore(mttr) * 0.30;
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

function buildTotal(rows) {
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
  const availPct = availCount > 0 ? Math.max(0, Math.min(100, availSum / availCount * 100)) : null;
  const compPct = tot ? comp / tot * 100 : 0;
  const pmPct = tot ? pmW / tot : 0;
  const overall = compPct * 0.30 + (availPct != null ? availPct : 0) * 0.20 + pmPct * 0.20 + mttrScore(mttr) * 0.30;
  return { total: tot, mttr: mttr, compPct: compPct, availPct: availPct, pmPct: pmPct, overall: overall };
}

function tableHtml(kindKey, label, rows, gt, monthLabel) {
  let html = '<div style="display:flex;align-items:baseline;gap:8px;margin:4px 0 8px;">' +
    '<span style="font-weight:800;letter-spacing:.04em;color:#38bdf8;">' + esc(label) + '</span>' +
    '<span style="font-size:.75rem;color:var(--text-muted);">' + esc(monthLabel) + '</span>' +
    '</div>' +
    '<div class="ticket-month-table-wrap"><table class="ticket-month-table"><thead><tr>' +
    '<th>RANK</th><th>MOM</th><th>BRANCH &amp; WITEL COVERAGE</th><th>AREA</th>' +
    '<th>TOTAL TT</th><th>MTTR (\u22644.0h)</th><th>TTR COMP (\u226590%)</th>' +
    '<th>AVAIL (\u226599.5%)</th><th>PM (\u226590%)</th><th>OVERALL KPI (&ge; 97%)</th><th>STATUS</th><th>ACTION</th>' +
    '</tr></thead><tbody>';

  rows.forEach(function (r) {
    let mom = '<span style="color:var(--text-muted);">-</span>';
    if (r.prevRank) {
      if (r.rank < r.prevRank) mom = '<span style="color:#34d399;font-weight:800;text-shadow:0 0 6px rgba(52,211,153,.4);">\u25B2 Naik</span>';
      else if (r.rank > r.prevRank) mom = '<span style="color:#fb7185;font-weight:800;text-shadow:0 0 6px rgba(251,113,133,.4);">\u25BC Turun</span>';
      else mom = '<span style="color:#fbbf24;font-weight:800;">\u2014 Masih sama</span>';
    }
    const st = statusFromOverall(r.overall);
    const status = stars([r.mttr != null && r.mttr <= 4, r.compPct >= 90, r.availPct != null && r.availPct >= 99.5, r.pmPct >= 90]) +
      '<span class="badge ' + st.cls + '">' + st.txt + '</span>';

    html += '<tr>' +
      '<td class="text-center" style="font-weight:700;">#' + r.rank + '</td>' +
      '<td class="text-center">' + mom + '</td>' +
      '<td><div style="font-weight:700;">' + esc(branchLabel(r.branch)) + '</div>' +
      '<div style="font-size:.75rem;color:var(--text-muted);">' + esc(COVERAGE[r.branch] || '') + '</div></td>' +
      '<td><span class="badge badge-info" style="font-size:.68rem;">JAWA BARAT</span></td>' +
      '<td class="text-right" style="font-weight:700;">' + r.total + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(r.mttr == null ? '-' : f2(r.mttr) + 'h', r.mttr != null && r.mttr <= 4, r.mttr != null && r.mttr > 4 && r.mttr <= 6) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(pct(r.compPct), r.compPct >= 90, r.compPct >= 80 && r.compPct < 90) + '</td>' +
      '<td class="text-right font-mono">' + kpiCell(r.availPct == null ? '-' : pct(r.availPct), r.availPct != null && r.availPct >= 99.5, r.availPct != null && r.availPct >= 99 && r.availPct < 99.5) + '</td>' +
      '<td class="text-right font-mono" style="font-weight:700;">' + kpiCell(pct(r.pmPct), r.pmPct >= 90, r.pmPct >= 80 && r.pmPct < 90) + '</td>' +
      '<td class="text-right font-mono" style="font-weight:700;">' + kpiCell(pct(r.overall), r.overall >= 97, r.overall >= 90 && r.overall < 97) + '</td>' +
      '<td class="text-center">' + status + '</td>' +
      '<td class="text-center"><span class="kpi-detail-btn" style="display:inline-block;font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;">Detail</span></td>' +
      '</tr>';
  });

  const gtSt = statusFromOverall(gt.overall);
  html += '</tbody><tfoot><tr>' +
    '<td colspan="4" class="text-left" style="font-weight:800;letter-spacing:.05em;">GRAND TOTAL</td>' +
    '<td class="text-right" style="font-weight:800;">' + gt.total + '</td>' +
    '<td class="text-right font-mono">' + kpiCell(gt.mttr == null ? '-' : f2(gt.mttr) + 'h', gt.mttr != null && gt.mttr <= 4, gt.mttr != null && gt.mttr > 4 && gt.mttr <= 6) + '</td>' +
    '<td class="text-right font-mono">' + kpiCell(pct(gt.compPct), gt.compPct >= 90, gt.compPct >= 80 && gt.compPct < 90) + '</td>' +
    '<td class="text-right font-mono">' + kpiCell(gt.availPct == null ? '-' : pct(gt.availPct), gt.availPct != null && gt.availPct >= 99.5, gt.availPct != null && gt.availPct >= 99 && gt.availPct < 99.5) + '</td>' +
    '<td class="text-right font-mono" style="font-weight:800;">' + kpiCell(pct(gt.pmPct), gt.pmPct >= 90, gt.pmPct >= 80 && gt.pmPct < 90) + '</td>' +
    '<td class="text-right font-mono" style="font-weight:800;">' + kpiCell(pct(gt.overall), gt.overall >= 97, gt.overall >= 90 && gt.overall < 97) + '</td>' +
    '<td class="text-center">' + stars([gt.mttr != null && gt.mttr <= 4, gt.compPct >= 90, gt.availPct != null && gt.availPct >= 99.5, gt.pmPct >= 90]) + '<span class="badge ' + gtSt.cls + '">' + gtSt.txt + '</span></td>' +
    '<td class="text-center"></td>' +
    '</tr></tfoot></table></div>';
  return html;
}

function actionHtml(kindKey, rows) {
  return '<div style="background:rgba(15,23,42,.6);border:1px solid #334155;border-radius:10px;padding:12px 14px;margin-top:10px;">' +
    '<div style="font-size:.72rem;color:#38bdf8;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Action Item per Branch \u2014 ' + esc(kindKey) + '</div>' +
    rows.map(function (r) {
      const names = ['MTTR', 'TTR COMP', 'AVAIL', 'PM'];
      const hits = [r.mttr != null && r.mttr <= 4, r.compPct >= 90, r.availPct != null && r.availPct >= 99.5, r.pmPct >= 90];
      const failed = [];
      for (let i = 0; i < names.length; i++) { if (!hits[i]) failed.push(names[i]); }
      const tip = failed.length === 0
        ? '<span style="color:#34d399;font-weight:800;">Semua tercapai \u2605</span>'
        : '<span style="color:#fb7185;font-weight:700;">Perbaiki: ' + esc(failed.join(', ')) + '</span>';
      return '<div style="padding:5px 0;border-bottom:1px dashed rgba(148,163,184,.18);display:flex;gap:10px;align-items:center;">' +
        '<b style="min-width:160px;color:#e2e8f0;">' + esc(branchLabel(r.branch)) + '</b>' +
        '<span style="font-variant-numeric:tabular-nums;color:#94a3b8;min-width:90px;">OVERALL ' + esc(pct(r.overall)) + '</span>' +
        tip +
        '</div>';
    }).join('') +
    '</div>';
}

function buildPage(data) {
  const css = fs.readFileSync(path.join(__dirname, 'kpi-style.css'), 'utf8');
  const monthLabel = data.monthLabel || data.bulan || '';
  const blocks = KINDS.map(function (kd) {
    const rows = buildRows(data.branches, kd.key);
    const gt = buildTotal(rows);
    return '<div class="panel panel-photo panel-overall kpi-shot" id="shot-' + kd.key + '">' +
      '<div class="panel-title"><span>KPI TIKET MTEL BULAN ' + esc(monthLabel) + ' \u2014 ' + kd.key + '</span></div>' +
      '<div style="padding:2px 0 4px;">' +
        tableHtml(kd.key, kd.label, rows, gt, monthLabel) +
        actionHtml(kd.key, rows) +
      '</div>' +
      '</div>';
  }).join('');

  return '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<title>KPI MTEL \u2014 ' + esc(monthLabel) + '</title>' +
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

async function fetchData() {
  if (!JSON_URL) throw new Error('KPI_JSON_URL belum diisi (secret repo).');
  const res = await fetch(JSON_URL, { redirect: 'follow', headers: { 'User-Agent': 'kpi-report-bot/1.0' } });
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

  const data = await fetchData();
  console.log('Data OK: ' + (data.monthLabel || data.bulan) + ' | branches=' + data.branches.length);

  const html = buildPage(data);
  fs.writeFileSync(path.join(__dirname, 'kpi-report-preview.html'), html);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });

  const shots = {};
  for (const kd of KINDS) {
    const el = page.locator('#shot-' + kd.key);
    await el.waitFor({ state: 'visible', timeout: 30000 });
    shots[kd.key] = await el.screenshot({ type: 'png', animations: 'disabled' });
    console.log('Screenshot ' + kd.key + ': ' + shots[kd.key].length + ' bytes');
  }
  await browser.close();

  for (const chatId of chatIds) {
    await sendPhoto(chatId, shots.FIBERISASI, 'KPI_FIBERISASI.png', PAYLOAD.fib_caption || '', replyTo);
    await new Promise(function (r) { setTimeout(r, 700); });
    await sendPhoto(chatId, shots.TIS, 'KPI_TIS.png', PAYLOAD.tis_caption || '', replyTo);
    console.log('Terkirim ke ' + chatId);
  }
})().catch(function (err) {
  console.error('GAGAL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
