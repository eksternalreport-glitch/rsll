// ============================================================
// HELPER APPS SCRIPT — perintah /rslfoto
// Tempel di project BOT_TELEGRAM_FULL.gs.
//
// Script Properties yang harus diisi:
//   GITHUB_TOKEN = Personal Access Token (classic: scope "repo";
//                  fine-grained: Contents = Read and write)
//   GITHUB_REPO  = "username/nama-repo", contoh: "wahyu/rsl-screenshot-bot"
// ============================================================

function isRslFotoCommand_(text) {
  return /^\/(?:rslfoto|rsl-foto|rslshot)(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim());
}

// Picu workflow GitHub Actions (event: repository_dispatch / rsl-shot).
function rslFotoTrigger_(chatId, query) {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('GITHUB_TOKEN');
  const repo = p.getProperty('GITHUB_REPO');
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPO belum diisi di Script Properties.');
  }

  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({
      event_type: 'rsl-shot',
      client_payload: {
        query: String(query || '').trim(),
        chat_id: String(chatId)
      }
    }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 204) {
    throw new Error('GitHub HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
  }
}

function handleRslFoto_(chatId, query) {
  const q = String(query == null ? '' : query).trim().replace(/\s+/g, ' ');
  if (!q) {
    sendMessage(
      chatId,
      '📸 *Screenshot RSL*\n\n' +
      'Contoh:\n' +
      '`/rslfoto INC-20261022-00022727`\n' +
      '`/rslfoto BDG-PSKJ-EN1-C512Z`',
      'Markdown'
    );
    return;
  }

  try {
    rslFotoTrigger_(chatId, q);
    sendMessage(
      chatId,
      '📸 Screenshot RSL untuk *' + q + '* sedang diproses.\n' +
      'Hasil dikirim ke chat ini dalam ±1–3 menit.',
      'Markdown'
    );
  } catch (e) {
    sendMessage(chatId, '⚠️ Gagal memicu screenshot:\n' + e.message, 'Markdown');
  }
}

// ============================================================
// CARA MENYAMBUNG KE ROUTER PESAN
// ============================================================
// 1) Di handler GROUP, dekat pengecekan isRslCommand_, tambahkan:
//
//    } else if (isRslFotoCommand_(text)) {
//      handleRslFoto_(chatId, text.trim().replace(/^\/(?:rslfoto|rsl-foto|rslshot)(?:@\w+)?/i, '').trim());
//
// 2) Di handler PRIVATE, dekat pengecekan isRslCommand_, tambahkan:
//
//    if (isRslFotoCommand_(text)) {
//      removeOldReplyKeyboard(chatId);
//      clearUserState(chatId);
//      handleRslFoto_(chatId, text.trim().replace(/^\/(?:rslfoto|rsl-foto|rslshot)(?:@\w+)?/i, '').trim());
//      return;
//    }
//
// 3) Tambahkan baris bantuan di menu:
//    `• *\/rslfoto* <tiket|hostname> — screenshot halaman RSL (via GitHub Actions)\n` +
