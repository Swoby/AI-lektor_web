// Netlify Function: confirm-payment.js
// Mira klikne na odkaz v emailu → zákazník dostane přístup na 30 dní
// Env proměnné: SUPABASE_URL, SUPABASE_KEY, RESEND_API_KEY, RESEND_FROM

const RESEND_API = 'https://api.resend.com/emails';

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
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || 'AI Lektor <noreply@ai-lektor.cz>';

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
    `${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${token}&pouzit=eq.false&select=email,vs`,
    { headers: sbHeaders }
  );
  const tokens = await resToken.json();

  if (!tokens || tokens.length === 0) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html' }, body: htmlErr('Token nenalezen nebo již byl použit.') };
  }

  const { email, vs } = tokens[0];

  // 2. Vypočítej datum expirace (+30 dní)
  const expirace = new Date();
  expirace.setDate(expirace.getDate() + 30);
  const datumExpirace = expirace.toISOString().split('T')[0];

  // 3. Ulož do accounts (nebo aktualizuj pokud existuje)
  await fetch(`${SUPABASE_URL}/rest/v1/accounts`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ email, datum_expirace: datumExpirace, plan: 'rodiny' }),
  });

  // 4. Označ token jako použitý
  await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${token}`, {
    method: 'PATCH',
    headers: sbHeaders,
    body: JSON.stringify({ pouzit: true }),
  });

  // 5. Pošli zákazníkovi email s přihlašovacím odkazem
  const appLink = `https://azqkj8fjpkhqhlvzeqtcyj.streamlit.app/`;
  if (RESEND_API_KEY) {
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
      <a href="${appLink}" style="display:inline-block;margin:20px 0;background:linear-gradient(135deg,#1e3a6e,#2a5298);color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:800;font-size:1rem;">
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
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: htmlOk(email),
  };
};
