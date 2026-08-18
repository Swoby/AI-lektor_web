// Sdílená knihovna: activate-account.js
// Vytáhnuto z confirm-payment.js (WP-3) — společná logika aktivace účtu, kterou používá
// jak confirm-payment.js (ruční potvrzení převodu), tak payment-webhook.js (automatická
// aktivace po platbě kartou/GPay přes Comgate).
//
// Env proměnné (musí být nastavené v prostředí volajícího): SUPABASE_URL, SUPABASE_KEY,
// RESEND_API_KEY, RESEND_FROM.

const RESEND_API = 'https://api.resend.com/emails';

// appLink opraven na aktuální produkční URL (viz architektura, sekce "Otevřené otázky", bod 3) —
// stará hodnota `azqkj8fjpkhqhlvzeqtcyj.streamlit.app` byl bug, produkce běží na Next.js.
const APP_LINK = 'https://app.ai-lektor.cz/';

/**
 * Aktivuje účet zákazníka na 30 dní od teď a odešle e-mail s přihlašovacím odkazem.
 *
 * @param {string} email - e-mail zákazníka (bude uložen/aktualizován v Supabase `accounts`)
 * @param {string} [plan] - plán, který se má uložit do `accounts.plan` (fallback 'rodiny', viz WP-6)
 * @param {string} [vs] - variabilní symbol objednávky (zatím jen pro logování/budoucí potřebu)
 * @returns {Promise<{ok: boolean, email: string, datumExpirace: string}>}
 */
async function activateAccount(email, plan, vs) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || 'AI Lektor <noreply@ai-lektor.cz>';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Chyba konfigurace serveru (Supabase URL/KEY chybí).');
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1. Vypočítej datum expirace (+30 dní od teď)
  const expirace = new Date();
  expirace.setDate(expirace.getDate() + 30);
  const datumExpirace = expirace.toISOString().split('T')[0];

  // Plán s fallbackem na 'rodiny' pro staré řádky bez uloženého plánu (viz WP-6).
  const resolvedPlan = plan || 'rodiny';

  // 2. Ulož do accounts (nebo aktualizuj pokud existuje)
  const resAccount = await fetch(`${SUPABASE_URL}/rest/v1/accounts`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ email, datum_expirace: datumExpirace, plan: resolvedPlan }),
  });

  if (!resAccount.ok) {
    const errText = await resAccount.text();
    console.log('ERROR: activateAccount - upsert accounts selhal:', resAccount.status, errText, 'vs=', vs);
    throw new Error('Nepodařilo se aktivovat účet (Supabase accounts).');
  }

  // 3. Pošli zákazníkovi email s přihlašovacím odkazem
  if (RESEND_API_KEY) {
    try {
      await fetch(RESEND_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject: '🎉 Váš přístup do AI Lektoru je aktivní!',
          html: `
<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(30,58,110,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a6e,#2a5298);padding:28px 32px;">
      <div style="font-size:1.2rem;font-weight:900;color:#fff;">🧠 AI Lektor exaktních věd</div>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#1a2535;margin:0 0 12px;">Platba přijata, přístup aktivní! 🎉</h2>
      <p style="color:#5a6a7d;font-size:0.95rem;">Váš přístup je aktivní do <b>${datumExpirace}</b>.</p>
      <a href="${APP_LINK}" style="display:inline-block;margin:20px 0;background:linear-gradient(135deg,#1e3a6e,#2a5298);color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:1rem;">
        Spustit AI Lektor →
      </a>
      <p style="font-size:0.85rem;color:#888;">Dotazy? <a href="mailto:ailektor.info@gmail.com" style="color:#1e3a6e;">ailektor.info@gmail.com</a></p>
    </div>
    <div style="padding:16px 32px;background:#f5f2ec;text-align:center;font-size:0.78rem;color:#888;">
      © 2026 AI Lektor exaktních věd · IČO: 88282759
    </div>
  </div>
</body></html>`,
        }),
      });
    } catch (e) {
      // Nefatální — účet je aktivovaný i bez e-mailu, jen zalogujeme.
      console.log('WARN: activateAccount - odeslání emailu selhalo:', e.message, 'email=', email);
    }
  }

  return { ok: true, email, datumExpirace };
}

module.exports = { activateAccount, APP_LINK };
