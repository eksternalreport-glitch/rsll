// ============================================================
// HELPER APPS SCRIPT â€” perintah /rslfoto
// Disalin dari BOT_TELEGRAM_FULL.gs; helper aktif ada di sana.
//
// Script Properties yang harus diisi:
//   GITHUB_TOKEN = Personal Access Token (classic: scope "repo")
//   GITHUB_REPO  = "username/nama-repo", contoh: "eksternalreport-glitch/rsll"
// ============================================================

function isRslFotoCommand_(text) {
  return /^\/(?:rslfoto|rsl-foto|rslshot)(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim());
}

// Ambil message_id dari response JSON sendMessage Telegram.
function telegramMessageId_(responseText) {
  try {
    const o = JSON.parse(String(responseText || ''));
    if (o && o.ok === true && o.result && o.result.message_id) {
      return Number(o.result.message_id) || 0;
    }
  } catch (e) {}
  return 0;
}

// Picu workflow GitHub Actions (event: repository_dispatch / rsl-shot).
// replyToMessageId = message_id pesan teks RSL; foto dikirim sebagai reply ke teks itu.
function rslFotoTrigger_(chatId, query, replyToMessageId) {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('GITHUB_TOKEN');
  const repo = p.getProperty('GITHUB_REPO');
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPO belum diisi di Script Properties.');
  }

  const replyMid = Number(replyToMessageId || 0);
  const payload = {
    query: String(query || '').trim(),
    chat_id: String(chatId)
  };
  if (replyMid > 0) payload.reply_to_message_id = replyMid;

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
      client_payload: payload
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
      'ðŸ“¸ *Screenshot RSL*\n\n' +
      'Contoh:\n' +
      '`/rslfoto INC-20261022-00022727`\n' +
      '`/rslfoto BDG-PSKJ-EN1-C512Z`',
      'Markdown'
    );
    return;
  }

  try {
    // Kirim konfirmasi dulu, lalu foto hasil screenshot di-reply ke pesan ini.
    const confirmRes = sendMessage(
      chatId,
      'ðŸ“¸ Screenshot RSL untuk *' + q + '* sedang diproses.\n' +
      'Hasil dikirim ke chat ini dalam Â±1â€“3 menit.',
      'Markdown'
    );
    const confirmId = telegramMessageId_(confirmRes);
    rslFotoTrigger_(chatId, q, confirmId);
  } catch (e) {
    sendMessage(chatId, 'âš ï¸ Gagal memicu screenshot:\n' + e.message, 'Markdown');
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
//    `â€¢ *\/rslfoto* <tiket|hostname> â€” screenshot halaman RSL (via GitHub Actions)\n` +
