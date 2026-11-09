// Invite links: "Play with me on POVCheck" - a link that is sent by
// WhatsApp, Instagram etc. Whoever opens it plays the person who sent it.
//
// The host keeps the invite screen open while the friend opens the link (the
// invite lives as long as the host is connected, at most INVITE_TTL_MS).
// Only rules and the landing page live here; the wiring is in index.js.

import crypto from "crypto";

export const INVITE_TTL_MS = 30 * 60 * 1000;

// No 0/O, 1/I/L - the code may be typed in by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function inviteCode(length = 6) {
    const bytes = crypto.randomBytes(length);
    let code = "";
    for (let i = 0; i < length; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    return code;
}

export function normalizeInviteCode(value) {
    if (typeof value !== "string") return null;
    const code = value.trim().toUpperCase();
    return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : null;
}

export function inviteExpired(invite, now = Date.now()) {
    return !invite || now - invite.createdAt > INVITE_TTL_MS;
}

const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The page behind the link. It opens the app (povcheck://invite/CODE) and,
// for people without the app, links to the download.
export function invitePage({ code, hostName, timeControl, open, downloadUrl, webUrl }) {
    const name = hostName ? escapeHtml(hostName) : "Ein Freund";
    const appLink = `povcheck://invite/${code}`;
    const title = open ? `${name} fordert dich heraus` : "Einladung abgelaufen";
    const text = open
        ? `Partie ${escapeHtml(timeControl)} auf POVCheck. Öffne die Einladung in der App.`
        : "Diese Einladung ist nicht mehr offen. Bitte deinen Freund um einen neuen Link.";

    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · POVCheck</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="Schach auf POVCheck – tippe, um mitzuspielen.">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #f5f5f7;
         font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: min(420px, calc(100% - 32px)); text-align: center; }
  .logo { font-size: 44px; }
  h1 { font-size: 24px; margin: 12px 0 6px; letter-spacing: -0.3px; }
  p { color: #a1a1aa; margin: 0 0 24px; }
  .code { font: 700 28px/1 ui-monospace, monospace; letter-spacing: 6px; background: #1c1f26; border-radius: 14px; padding: 16px; margin-bottom: 22px; }
  a.btn { display: block; padding: 15px; border-radius: 14px; text-decoration: none; font-weight: 700; margin-bottom: 10px; }
  .primary { background: #f5f5f7; color: #0f1115; }
  .secondary { background: #1c1f26; color: #f5f5f7; }
  small { color: #71717a; display: block; margin-top: 14px; }
</style>
</head>
<body>
<main>
  <div class="logo">♞</div>
  <h1>${title}</h1>
  <p>${text}</p>
  ${open ? `<div class="code">${code}</div>
  <a class="btn primary" href="${appLink}">In der App öffnen</a>` : ""}
  ${webUrl ? `<a class="btn secondary" href="${escapeHtml(webUrl)}${open ? `/invite/${code}` : ""}">Im Browser spielen</a>` : ""}
  <a class="btn secondary" href="${escapeHtml(downloadUrl)}">POVCheck herunterladen</a>
  ${open ? "<small>Kein Link? In der App unter Spielen → Freund einladen → Code eingeben.</small>" : ""}
</main>
</body>
</html>`;
}
