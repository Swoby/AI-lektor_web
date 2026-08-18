// Netlify Function: confirm-payment.js
// Mira klikne na odkaz v emailu → zákazník dostane přístup na 30 dní
// Env proměnné: SUPABASE_URL, SUPABASE_KEY, RESEND_API_KEY, RESEND_FROM
//
// Aktivační logika (upsert accounts + email) je od WP-3 vytažena do sdíleného modulu
// _lib/activate-account.js, který používá i payment-webhook.js (Comgate karta/GPay).

const { activateAccount } = require('./_lib/activate-account');

exports.handler = async (event) => {
  const token = event.queryStringParameters?.token;

  const htmlOk = (email) => `
<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Platba potvrzena</title></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="background:#fff;border-radius:20px;padding:40px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(30,58,110,0.1);">
    <div style="font-size:3rem;">✅</div>
    <h1 style="color:#1e3a6e;font-size:1.4rem;margin:16px 0 8px;">Platba potvrzena!</h1>
    <p style="color:#5a6a7d;font-size:0.95rem;">Přístup pro <b>${email}</b> byl aktivován na 30 dní.<br>Zákazníkovi byl odeslán přihlašovací link.</p>
  </div>
</body></html>`;

  const htmlErr = (msg) => `
<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>Chyba</title></head>
<body style="margin:0;padding:40px;background:#f5f2ec;font-family:'Segoe UI',sans-serif;text-align:center;">
  <h1 style="color:#c00;">Chyba</h1><p>${msg}</p>
</body></html>`;

  if (!token) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: htmlErr('Chybí token.') };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: htmlErr('Chyba konfigurace serveru.') };
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1. Najdi token v payment_tokens
  const resToken = await fetch(
    `${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${token}&pouzit=eq.false&select=email,vs,plan`,
    { headers: sbHeaders }
  );
  const tokens = await resToken.json();

  if (!tokens || tokens.length === 0) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: htmlErr('Token nenalezen nebo již byl použit.') };
  }

  const { email, vs, plan } = tokens[0];

  // 2-3-5. Aktivace účtu (upsert accounts + odeslání emailu) — sdílená logika, viz _lib/activate-account.js.
  // plan bere se z uloženého řádku (WP-6 oprava natvrdo zadrátovaného 'rodiny'), s fallbackem uvnitř activateAccount.
  try {
    await activateAccount(email, plan, vs);
  } catch (e) {
    console.log('ERROR: confirm-payment - activateAccount selhal:', e.message, 'vs=', vs);
    return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: htmlErr('Nepodařilo se aktivovat účet, zkuste to prosím znovu.') };
  }

  // 4. Označ token jako použitý
  await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${token}`, {
    method: 'PATCH',
    headers: sbHeaders,
    body: JSON.stringify({ pouzit: true }),
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: htmlOk(email),
  };
};
