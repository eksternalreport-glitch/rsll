'use strict';

// ============================================================
// Screenshot halaman RSL (DataPilot) lalu kirim ke Telegram.
//
// Alur:
//   1. buka halaman RSL,
//   2. login CAS (#username / #password / #loginButton) bila diminta,
//   3. isi query (tiket / hostname) dan submit,
//   4. tunggu tabel hasil muncul,
//   5. screenshot elemen hasil (fallback: full page),
//   6. kirim ke Telegram lewat sendPhoto (fallback: sendDocument).
//
// Env wajib:
//   RSL_USER, RSL_PASS, RSL_QUERY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Env opsional:
//   RSL_URL   (default halaman RSL Query tenant 1057)
//   RSL_QUERY_TYPE = ticket | hostname | order
//   CAPTURE_MODE   = page (default) | full | sides | slices | both
//   CAPTURE_SLICE_PX = tinggi potongan gambar saat mode slices (default 1300)
//   REPLY_TO_MESSAGE_ID = ID pesan induk; foto dikirim sebagai reply (opsional)
// ============================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const RSL_URL = process.env.RSL_URL || (
  'https://1057-sg.teleows.com/adc-static/static/procodeComp/1057/' +
  'rslquery/rslquery/rsl_query/latest/dist/index.html'
);

const QUERY = String(process.env.RSL_QUERY || '').trim();
const QUERY_TYPE = String(process.env.RSL_QUERY_TYPE || '').trim().toLowerCase();
const CAPTURE_MODE = String(process.env.CAPTURE_MODE || 'page').trim().toLowerCase();
const SLICE_PX = Math.max(600, Number(process.env.CAPTURE_SLICE_PX || 1300) || 1300);
const REPLY_TO = Math.max(0, Number(process.env.REPLY_TO_MESSAGE_ID || 0) || 0);
const ART = path.join(process.cwd(), 'artifacts');

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log('[' + new Date().toISOString() + ']', args.join(' '));
}

function env(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error('Env ' + name + ' belum diisi.');
  return v;
}

function ensureArt() {
  fs.mkdirSync(ART, { recursive: true });
}

async function saveDebug(page, tag) {
  if (!page) return;
  ensureArt();
  try {
    fs.writeFileSync(path.join(ART, tag + '.html'), await page.content());
  } catch (e) {}
  try {
    await page.screenshot({ path: path.join(ART, tag + '-full.png'), fullPage: true });
  } catch (e) {}
  try {
    const info = await page.evaluate(function () {
      function vis(el) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      }
      const inputs = Array.prototype.slice.call(document.querySelectorAll('input'))
        .filter(vis).map(function (el) {
          return { id: el.id, name: el.name, type: el.type, placeholder: el.placeholder };
        });
      const buttons = Array.prototype.slice.call(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
        .filter(vis).map(function (el) {
          return { tag: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 80) };
        });
      const selects = Array.prototype.slice.call(document.querySelectorAll('select'))
        .filter(vis).map(function (el) {
          return {
            id: el.id,
            options: Array.prototype.slice.call(el.options).map(function (o) { return o.text; })
          };
        });
      return { url: location.href, title: document.title, inputs: inputs, buttons: buttons, selects: selects };
    });
    fs.writeFileSync(path.join(ART, tag + '-fields.json'), JSON.stringify(info, null, 2));
  } catch (e) {}
  log('Debug disimpan di artifacts/' + tag + '.*');
}

async function loginIfNeeded(page, user, pass) {
  const userInput = page.locator('#username, input[name="username"]').first();
  if (!(await userInput.count())) return false;
  if (!(await userInput.isVisible().catch(function () { return false; }))) return false;

  log('Halaman login CAS terdeteksi.');
  await userInput.fill(user);
  await page.locator('#password, input[name="password"]').first().fill(pass);

  const btn = page.locator('#loginButton, input[type="submit"], button[type="submit"]').first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(function () { return null; }),
    btn.click()
  ]);
  await page.waitForLoadState('domcontentloaded').catch(function () {});
  log('Setelah login, URL:', page.url());

  const still = page.locator('#username, input[name="username"]').first();
  const stillCount = await still.count();
  const stillVisible = stillCount ? await still.isVisible().catch(function () { return false; }) : false;
  if (stillVisible) {
    await saveDebug(page, 'login-gagal');
    throw new Error(
      'Login gagal. Cek RSL_USER / RSL_PASS. Bila akun memakai OTP SMS atau captcha, ' +
      'login otomatis dari cloud tidak bisa dipakai.'
    );
  }
  return true;
}

// Pilih tipe query (Ticket / Hostname / Order ID).
// Halaman asli memakai tombol tab: HOSTNAME | TROUBLETICKET | ORDER ID.
async function pickQueryType(page, isTicket) {
  const wanted = QUERY_TYPE === 'hostname' ? /^HOSTNAME$/i
    : QUERY_TYPE === 'order' ? /^ORDER\s*ID$/i
      : isTicket ? /^TROUBLE\s*TICKET$/i : /^HOSTNAME$/i;

  const btns = page.locator('button, [role="button"]');
  const bn = await btns.count();
  for (let i = 0; i < bn; i++) {
    const el = btns.nth(i);
    if (!(await el.isVisible().catch(function () { return false; }))) continue;
    const t = ((await el.innerText().catch(function () { return ''; })) || '').trim();
    if (wanted.test(t)) {
      await el.click().catch(function () {});
      log('Tipe query via tombol:', t);
      await page.waitForTimeout(600);
      return true;
    }
  }

  const want = isTicket ? /ticket/i : /host/i;
  const selects = page.locator('select');
  const sn = await selects.count();
  for (let i = 0; i < sn; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible().catch(function () { return false; }))) continue;
    const options = await sel.locator('option').allTextContents().catch(function () { return []; });
    const idx = options.findIndex(function (t) { return want.test(t); });
    if (idx >= 0) {
      await sel.selectOption({ index: idx }).catch(function () {});
      log('Tipe query via select:', options[idx]);
      return true;
    }
  }

  const labels = page.locator('label, .el-radio, .ant-radio-wrapper, [role="radio"], .el-radio-button');
  const ln = await labels.count();
  for (let i = 0; i < ln; i++) {
    const el = labels.nth(i);
    if (!(await el.isVisible().catch(function () { return false; }))) continue;
    const t = (await el.innerText().catch(function () { return ''; })) || '';
    if (want.test(t)) {
      await el.click().catch(function () {});
      log('Tipe query via label:', t.trim().slice(0, 60));
      return true;
    }
  }
  return false;
}

async function findQueryInput(page) {
  const all = page.locator('input[type="text"], input:not([type])');
  const n = await all.count();
  let fallback = null;

  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(function () { return false; }))) continue;

    const id = (await el.getAttribute('id').catch(function () { return ''; })) || '';
    if (/username|password|captcha|sms|otp/i.test(id)) continue;

    const ph = ((await el.getAttribute('placeholder').catch(function () { return ''; })) || '').toLowerCase();
    const aria = ((await el.getAttribute('aria-label').catch(function () { return ''; })) || '').toLowerCase();
    const hay = ph + ' ' + aria + ' ' + id.toLowerCase();

    if (/ticket|host|input|enter|please|search|query|nomor|kode/.test(hay)) return el;
    if (!fallback) fallback = el;
  }
  return fallback;
}

// Halaman RSL memakai tab HOSTNAME | TROUBLETICKET | ORDER ID lalu tombol GO.
async function submitQuery(page, input) {
  const go = page.getByRole('button', { name: /^GO$/i }).first();
  const hasGo = await go.count().catch(function () { return 0; });
  if (hasGo && await go.isVisible().catch(function () { return false; })) {
    await go.click().catch(function () {});
    log('Tombol GO diklik.');
    return;
  }
  await input.press('Enter').catch(function () {});
  log('Enter ditekan (tombol GO tidak ditemukan).');
}

// ============================================================
// HOSTNAME PAIR â€” UI BARU: NEAR END / FAR END (vue-multiselect)
// ============================================================
async function multiselectPick(page, inputId, value) {
  const safe = String(value || '').trim();
  if (!safe) throw new Error('Hostname kosong untuk ' + inputId);

  const input = page.locator('#' + inputId).first();
  const wrap = page.locator('.multiselect').filter({ has: page.locator('#' + inputId) }).first();

  // Klik wrapper untuk membuka dropdown (atau fokus ke input).
  try { await wrap.click({ force: true }); }
  catch (eOpen) { await input.click({ force: true }); }
  await page.waitForTimeout(400);

  await input.waitFor({ state: 'attached', timeout: 10000 });
  await input.evaluate(function (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await input.fill(safe);
  await page.waitForTimeout(1200);

  const esc = safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const optionExact = page.locator('.multiselect__option').filter({ hasText: new RegExp(esc, 'i') }).first();
  const firstOption = page.locator('.multiselect__option').first();
  const optCount = await optionExact.count().catch(function () { return 0; });
  const opt = optCount > 0 ? optionExact : firstOption;
  await opt.waitFor({ state: 'visible', timeout: 15000 });
  await opt.click();
  const label = await opt.innerText().catch(function () { return safe; });
  log('Dipilih ' + inputId + ':', String(label || safe).trim());
  await page.waitForTimeout(500);
}

async function queryHostnamePair(page, query) {
  const parts = String(query || '').trim().split(/[\s,;\/]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Query hostname kosong.');
  const near = parts[0];
  const far = parts.length > 1 ? parts[1] : parts[0];
  log('NEAR END:', near, '| FAR END:', far);

  await multiselectPick(page, 'single-near-end', near);
  await page.waitForTimeout(1500);
  await multiselectPick(page, 'single-far-end', far);

  const go = page.getByRole('button', { name: /^GO$/i }).first();
  const hasGo = await go.count().catch(function () { return 0; });
  if (hasGo > 0) {
    await go.click();
    log('Tombol GO diklik.');
  } else {
    await page.locator('button:has-text("GO")').first().click();
    log('Tombol GO (fallback) diklik.');
  }
}

async function waitForResult(page) {
  const started = Date.now();

  // Query RSL bisa lama (Attempt n/30). Tunggu sampai judul laporan muncul.
  while (Date.now() - started < 300000) {
    const h1 = page.locator('h1', { hasText: /Link Hygiene Report/i }).first();
    if (await h1.count().catch(function () { return 0; })) {
      if (await h1.isVisible().catch(function () { return false; })) {
        // Beri waktu animasi/komponen selesai render.
        await page.waitForTimeout(2000);
        log('Laporan RSL muncul setelah', Math.round((Date.now() - started) / 1000), 'detik.');
        return true;
      }
    }

    const body = await page.locator('body').innerText().catch(function () { return ''; });
    const attempt = /Attempt\s+(\d+)\s*\/\s*(\d+)/i.exec(body);
    if (attempt) log('Masih memuat, attempt', attempt[1] + '/' + attempt[2]);

    if (/ticket\s+not\s+found|no\s+data|data\s+tidak\s+ditemukan|invalid/i.test(body)) {
      throw new Error('Query tidak menemukan data: ' + QUERY);
    }

    await page.waitForTimeout(1500);
  }
  return false;
}

// Halaman RSL memuat beberapa bagian (RSL Information Lane) secara lazy.
// Scroll ke bawah lalu ke atas supaya intersection observer terpicu.
async function triggerLazyLoad(page) {
  try {
    // Paksa semua konten lazy (content-visibility, contain) agar ter-render.
    await page.addStyleTag({ content: '* { content-visibility: visible !important; contain: none !important; } img, iframe { loading: eager !important; }' });
    await page.evaluate(function () {
      document.querySelectorAll('*').forEach(function (el) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none') el.style.display = '';
        if (s.visibility === 'hidden') el.style.visibility = 'visible';
        if (s.opacity === '0') el.style.opacity = '1';
      });
    });
    await page.waitForTimeout(2000);

    const height = await page.evaluate(function () { return document.documentElement.scrollHeight; });
    const step = 150;
    for (let y = 0; y < height; y += step) {
      await page.evaluate(function (yy) {
        window.scrollTo(0, yy);
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      }, y);
      await page.waitForTimeout(300);
    }
    // Pastikan sampai paling bawah
    await page.evaluate(function () { window.scrollTo(0, document.documentElement.scrollHeight); window.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(8000);
    // Kembali ke atas
    await page.evaluate(function () { window.scrollTo(0, 0); window.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(1500);
    const newHeight = await page.evaluate(function () { return document.documentElement.scrollHeight; });
    // Cek posisi teks Lane
    const laneInfo = await page.evaluate(function () {
      const t = document.body.innerText;
      const idx = t.toLowerCase().indexOf('lane');
      let pos = 'not found';
      if (idx >= 0) {
        const el = document.elementFromPoint(100, Math.min(window.innerHeight - 10, 500));
        pos = 'found at char ' + idx;
      }
      return { hasLane: idx >= 0, pos: pos, scrollH: document.documentElement.scrollHeight };
    });
    log('Lazy-load dipicu (tinggi ' + height + ' -> ' + newHeight + ' px). Lane: ' + JSON.stringify(laneInfo));
  } catch (e) {
    log('Gagal memicu lazy-load:', e && e.message ? e.message : e);
  }
}

// Setelah judul muncul, detail per lane (RSL Information Lane) masih bisa
// menyusul. Tunggu sampai bagian itu benar-benar ter-render.
async function waitForDetail(page) {
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(function () {});
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const txt = await page.locator('body').innerText().catch(function () { return ''; });
    const hasLane = /Lane/i.test(txt);
    const hasAlarm = /Active Alarms/i.test(txt);
    const hasCrc = /CRC/i.test(txt);
    const loading = /Loading RSL Query Result/i.test(txt);
    if (hasLane && hasAlarm && hasCrc && !loading) {
      log('Detail lane siap (' + Math.round((Date.now() - started) / 1000) + ' detik).');
      await page.waitForTimeout(1500);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  log('Peringatan: detail lane belum lengkap, capture tetap dilanjutkan.');
  return false;
}

// ---------- Pengambilan gambar ----------

async function findResultRoot(page) {
  const h1 = page.locator('h1', { hasText: /Link Hygiene Report/i }).first();
  if (!(await h1.count().catch(function () { return 0; }))) return null;
  const root = h1.locator('xpath=../..').first();
  if (await root.count().catch(function () { return 0; })) return root;
  return null;
}

// Kartu Near End / Far End pada halaman asli.
async function findPanels(page) {
  const cards = page.locator('div.rounded-2xl.border.border-cyan-500');
  const n = await cards.count().catch(function () { return 0; });
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = cards.nth(i);
    if (!(await el.isVisible().catch(function () { return false; }))) continue;
    const box = await el.boundingBox().catch(function () { return null; });
    if (!box || box.height < 100) continue;
    const txt = await el.innerText().catch(function () { return ''; });
    if (/^\s*Near End/i.test(txt)) out.push({ el: el, label: 'Near End' });
    else if (/^\s*Far End/i.test(txt)) out.push({ el: el, label: 'Far End' });
  }
  if (out.length === 2) {
    // Pastikan urutan: Near dulu, lalu Far.
    out.sort(function (a, b) { return a.label === 'Near End' ? -1 : 1; });
  }
  return out;
}

async function shotElement(el, file) {
  await el.scrollIntoViewIfNeeded().catch(function () {});
  await el.screenshot({ path: file });
  return file;
}

// Potong elemen tinggi jadi beberapa gambar agar teks tetap terbaca di Telegram.
async function shotSlices(page, el, prefix, slicePx) {
  const doc = await el.evaluate(function (e) {
    const r = e.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height
    };
  });

  const files = [];
  const total = Math.ceil(doc.height / slicePx);
  for (let i = 0; i < total; i++) {
    const off = i * slicePx;
    const height = Math.min(slicePx, doc.height - off);
    if (height < 40) continue;
    const file = path.join(ART, prefix + '-' + (i + 1) + '.png');
    await page.screenshot({
      clip: { x: doc.x, y: doc.y + off, width: doc.width, height: height }
    }).catch(function () {});
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

// Hasil: array of { file, label }.
async function captureResult(page, query) {
  ensureArt();
  await page.waitForTimeout(800);

  const shots = [];
  const root = await findResultRoot(page);
  const panels = await findPanels(page);
  const mode = CAPTURE_MODE;

  const label = function (suffix) {
    return 'RSL ' + query + (suffix ? ' Â· ' + suffix : '');
  };

  if (mode === 'slices') {
    const target = root || page.locator('body');
    const files = await shotSlices(page, target, 'rsl-slice', SLICE_PX);
    files.forEach(function (f, i) {
      shots.push({ file: f, label: label('bagian ' + (i + 1) + '/' + files.length) });
    });
  } else if (mode === 'page') {
    // Paksa semua konten lazy ter-render
    await page.addStyleTag({ content: '* { content-visibility: visible !important; contain: none !important; } img, iframe { loading: eager !important; } [hidden] { display: block !important; }' }).catch(function () {});
    await page.evaluate(function () {
      document.querySelectorAll('*').forEach(function (el) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none') el.style.display = '';
        if (s.visibility === 'hidden') el.style.visibility = 'visible';
        if (s.opacity === '0') el.style.opacity = '1';
        el.style.contentVisibility = 'visible';
        el.style.contain = 'none';
        el.style.height = 'auto';
        el.style.maxHeight = 'none';
        el.style.overflow = 'visible';
        el.style.transform = 'none';
      });
    }).catch(function () {});
    await page.waitForTimeout(2000);

    // Scroll ke bawah perlahan untuk memicu lazy-load
    const totalH = await page.evaluate(function () { return document.documentElement.scrollHeight; });
    const step = 150;
    for (let y = 0; y < totalH; y += step) {
      await page.evaluate(function (yy) {
        window.scrollTo(0, yy);
        window.dispatchEvent(new Event('scroll'));
      }, y);
      await page.waitForTimeout(300);
    }
    await page.evaluate(function () { window.scrollTo(0, document.documentElement.scrollHeight); window.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(10000);
    // Tetap di bawah agar lazy content tidak hilang
    // (jangan scroll ke atas sebelum screenshot)


    // Cari elemen yang mengandung 'Lane', paksa visible + semua ancestor
    const laneEl = await page.evaluate(function () {
      const all = Array.from(document.querySelectorAll('*'));
      const hits = all.filter(function (el) { return /Lane/i.test(el.textContent || ''); });
      if (!hits.length) return { found: false };
      let target = hits[0];
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].children.length === 0 && (hits[i].innerText || '').trim().length > 0) { target = hits[i]; break; }
      }
      if (target.children.length > 0) {
        let best = hits[0];
        for (let i = 1; i < hits.length; i++) {
          const t = (hits[i].innerText || '').trim();
          if (t.length > 0 && t.length < (best.innerText || '').trim().length) best = hits[i];
        }
        target = best;
      }
      let el = target;
      while (el && el !== document.documentElement) {
        el.style.display = '';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
        el.style.contentVisibility = 'visible';
        el.style.contain = 'none';
        el.style.height = 'auto';
        el.style.maxHeight = 'none';
        el.style.overflow = 'visible';
        el.style.transform = 'none';
        el = el.parentElement;
      }
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
      const r = target.getBoundingClientRect();
      return { found: true, tag: target.tagName, text: String(target.textContent || '').slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, totalHeight: document.documentElement.scrollHeight };
    }).catch(function (e) { return { error: String(e && e.message || e) }; });
    log('Lane element: ' + JSON.stringify(laneEl));

    // Ambil screenshot full page
    // Scroll ke posisi lane dan tunggu data render
    await page.evaluate(function () { window.scrollTo(0, 480); });
    await page.waitForTimeout(15000);
    // Ambil screenshot full page (semua konten termasuk header, lane, alarm)
    await page.evaluate(function () { window.scrollTo(0, 0); });
    await page.waitForTimeout(2000);
    const out = path.join(ART, 'rsl-page.png');
    log('Screenshot full page (termasuk header, lane, alarm).');
    await page.screenshot({ path: out, fullPage: true }).catch(function () {});
    if (!fs.existsSync(out)) {
      await page.screenshot({ path: out, fullPage: true }).catch(function () {});
    }
    const txt = await page.locator('body').innerText().catch(function () { return ''; });
    const hasLane = /Lane/i.test(txt);
    const hasCrc = /CRC/i.test(txt);
    const hasAlarm = /Active Alarms/i.test(txt);
    const hasRx = /RX/i.test(txt);
    const hasDbm = /dBm/i.test(txt);
    const hasSfp = /SFP/i.test(txt);
    const hasOptical = /Optical/i.test(txt);
    log('Teks terdeteksi: Lane=' + hasLane + ' CRC=' + hasCrc + ' Alarm=' + hasAlarm + ' RX=' + hasRx + ' dBm=' + hasDbm + ' SFP=' + hasSfp + ' Optical=' + hasOptical);
    const diag = 'lane=' + hasLane + ' crc=' + hasCrc + ' alarm=' + hasAlarm + ' ' + JSON.stringify(laneEl);
    shots.push({ file: out, label: label(hasLane ? '' : ' (lane tidak terdeteksi: ' + diag + ')') });
  } else if (mode === 'full') {
    const out = path.join(ART, 'rsl-full.png');
    if (root) await shotElement(root, out).catch(function () {});
    if (!fs.existsSync(out)) {
      await page.screenshot({ path: out, fullPage: true }).catch(function () {});
    }
    shots.push({ file: out, label: label('') });
  } else if (mode === 'both') {
    const out = path.join(ART, 'rsl-full.png');
    if (root) await shotElement(root, out).catch(function () {});
    if (fs.existsSync(out)) shots.push({ file: out, label: label('') });
  } else {
    // default: sides
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      const out = path.join(ART, 'rsl-' + (p.label === 'Near End' ? 'near' : 'far') + '.png');
      await shotElement(p.el, out).catch(function () {});
      if (fs.existsSync(out)) shots.push({ file: out, label: label(p.label) });
    }
  }

  if (!shots.length) {
    // Fallback terakhir: seluruh halaman hasil.
    const out = path.join(ART, 'rsl-full.png');
    if (root) await shotElement(root, out).catch(function () {});
    if (!fs.existsSync(out)) await page.screenshot({ path: out, fullPage: true }).catch(function () {});
    shots.push({ file: out, label: label('') });
  }

  // Simpan juga full page untuk debug.
  await page.screenshot({ path: path.join(ART, 'page-full.png'), fullPage: true }).catch(function () {});
  log('Gambar diambil:', shots.map(function (s) { return path.basename(s.file); }).join(', '));
  return shots;
}

async function telegramSend(token, method, chatId, file, caption) {
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  if (REPLY_TO > 0) {
    fd.append('reply_parameters', JSON.stringify({
      message_id: REPLY_TO,
      allow_sending_without_reply: true
    }));
  }
  const field = method === 'sendPhoto' ? 'photo' : 'document';
  fd.append(field, new Blob([buf], { type: 'image/png' }), 'rsl-result.png');

  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    body: fd
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Telegram ' + method + ' HTTP ' + res.status + ': ' + text.slice(0, 300));
  log('Terkirim via ' + method + '.');
}

async function sendToTelegram(token, chatId, file, caption) {
  try {
    await telegramSend(token, 'sendPhoto', chatId, file, caption);
  } catch (e) {
    log('sendPhoto gagal, coba sendDocument:', e.message);
    await telegramSend(token, 'sendDocument', chatId, file, caption);
  }
}

async function main() {
  const user = env('RSL_USER');
  const pass = env('RSL_PASS');
  const botToken = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_CHAT_ID');
  if (!QUERY) throw new Error('RSL_QUERY kosong. Isi tiket (INC-...) atau hostname.');

  log('Query:', QUERY);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('requestfailed', function (req) {
    const f = req.failure();
    log('REQUEST GAGAL:', req.url().slice(0, 160), f && f.errorText);
  });

  try {
    log('Buka halaman RSL...');
    await page.goto(RSL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    await loginIfNeeded(page, user, pass);

    // Pastikan benar-benar di aplikasi RSL, bukan portal perantara.
    if (!/rsl_query|rslquery/i.test(page.url())) {
      log('Kembali ke URL RSL:', RSL_URL);
      await page.goto(RSL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    }

    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(function () {});
    await page.waitForTimeout(2000);

    const isTicket = QUERY_TYPE
      ? QUERY_TYPE === 'ticket'
      : /^INC[-_ ]?/i.test(QUERY);

    await pickQueryType(page, isTicket).catch(function () {});

    const isHostnameMode = (QUERY_TYPE === 'hostname') || ((!QUERY_TYPE) && !isTicket);
    const hasPairUI = await page.locator('#single-near-end').count().catch(function () { return 0; });

    if (isHostnameMode && hasPairUI) {
      try {
        await queryHostnamePair(page, QUERY);
      } catch (ePair) {
        log('Hostname pair gagal:', ePair && ePair.message ? ePair.message : ePair);
        await saveDebug(page, 'hostname-pair-gagal');
        throw ePair;
      }
    } else {
      let input = await findQueryInput(page);
      if (!input) {
        await saveDebug(page, 'input-tidak-ditemukan');
        throw new Error('Kolom input query tidak ditemukan. Lihat artifacts/input-tidak-ditemukan.*');
      }

      log('Isi query ke kolom input...');
      await input.click().catch(function () {});
      await input.fill('');
      await input.fill(QUERY);
      await submitQuery(page, input);
    }

    log('Menunggu hasil query (mode capture: ' + CAPTURE_MODE + ')...');
    const ok = await waitForResult(page);
    if (!ok) {
      await saveDebug(page, 'hasil-tidak-muncul');
      throw new Error('Hasil query tidak muncul dalam batas waktu. Lihat artifacts/hasil-tidak-muncul.*');
    }

    await triggerLazyLoad(page);
    await waitForDetail(page);

    const shots = await captureResult(page, QUERY);
    for (let i = 0; i < shots.length; i++) {
      await sendToTelegram(botToken, chatId, shots[i].file, shots[i].label);
      if (i < shots.length - 1) await page.waitForTimeout(1200);
    }
    log('SELESAI. ' + shots.length + ' gambar terkirim.');
  } catch (err) {
    const msgErr = err && err.message ? err.message : String(err || 'Gagal tanpa pesan');
    log('GAGAL:', msgErr);
    await saveDebug(page, 'gagal');
    try {
      const tgRes = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'RSL gagal: ' + msgErr.slice(0, 350),
          reply_parameters: REPLY_TO > 0 ? { message_id: REPLY_TO, allow_sending_without_reply: true } : undefined
        })
      });
      const tgBody = await tgRes.text();
      log('Notifikasi Telegram terkirim:', tgRes.status, tgBody.slice(0, 300));
    } catch (eNotify) {
      log('Notifikasi Telegram gagal:', eNotify && eNotify.message ? eNotify.message : eNotify);
    }
    process.exitCode = 1;
  } finally {
    await browser.close().catch(function () {});
  }
}

main();
