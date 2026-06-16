// Netlify Function: qr-objednat.js
// QR kód objednávka od školy — uloží do leads, pošle notifikaci Mirovi
// Env: RESEND_API_KEY, RESEND_FROM, NOTIFY_EMAIL, SUPABASE_URL, SUPABASE_KEY

const RESEND_API = 'https://api.resend.com/emails';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let data;
  try { data = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { skola, ucitel, email, vs } = data;

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM          = process.env.RESEND_FROM || 'AI Lektor <noreply@ai-lektor.cz>';
  const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL || 'ailektor.info@gmail.com';
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_KEY;

  if (!RESEND_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY not set' }) };
  }

  // Ulož do leads
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ email, session_id: 'qr-objednavka-' + vs }),
      });
    } catch(e) { console.log('Leads save error:', e.message); }
  }

  // Email zákazníkovi (potvrzení objednávky)
  const bodyCustomer = `
<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(30,58,110,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a6e,#2a5298);padding:28px 32px;">
      <div style="font-size:1.2rem;font-weight:900;color:#fff;">🧠 AI Lektor exaktních věd</div>
      <div style="font-size:0.85rem;color:rgba(255,255,255,0.7);margin-top:4px;">Potvrzení objednávky QR kódu</div>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#1a2535;margin:0 0 8px;">Objednávka přijata ✅</h2>
      <p style="color:#5a6a7d;font-size:0.95rem;margin:0 0 24px;">
        Dobrý den, ${ucitel},<br>
        vaši objednávku QR kódu pro <strong>${skola}</strong> jsme přijali.
        Zašlete prosím platbu a QR kód vám doručíme do 24 hodin.
      </p>
      <div style="background:#f5f2ec;border-radius:14px;padding:20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Číslo účtu</td>
            <td style="padding:9px 0;font-weight:800;text-align:right;">1029728622/5500</td>
          </tr>
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Částka</td>
            <td style="padding:9px 0;font-weight:800;color:#1e3a6e;text-align:right;">299 Kč</td>
          </tr>
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Variabilní symbol</td>
            <td style="padding:9px 0;font-weight:800;color:#1e3a6e;font-size:1.05rem;text-align:right;">${vs}</td>
          </tr>
          <tr>
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Zpráva</td>
            <td style="padding:9px 0;font-weight:700;text-align:right;">QR AI Lektor - ${vs}</td>
          </tr>
        </table>
      </div>
      <p style="font-size:0.85rem;color:#5a6a7d;">
        Dotazy? Napište na <a href="mailto:ailektor.info@gmail.com" style="color:#1e3a6e;">ailektor.info@gmail.com</a>
      </p>
    </div>
    <div style="padding:16px 32px;background:#f5f2ec;text-align:center;font-size:0.78rem;color:#888;">
      © 2026 AI Lektor exaktních věd · IČO: 88282759
    </div>
  </div>
</body></html>`;

  // Notifikační email Mirovi
  const bodyNotify = `
<div style="font-family:'Segoe UI',sans-serif;background:#f0f0f0;padding:20px;border-radius:10px;max-width:500px;">
  <b style="font-size:1.1rem;">📱 NOVÁ OBJEDNÁVKA QR KÓDU</b><br><br>
  Škola: <b>${skola}</b><br>
  Učitel: <b>${ucitel}</b><br>
  Email: <b>${email}</b><br>
  VS: <b>${vs}</b><br>
  Cena: <b>299 Kč</b><br><br>
  <div style="background:#fff3cd;border-radius:8px;padding:12px;margin-top:8px;">
    ⏰ <b>Do 24h po přijetí platby vygeneruj QR kód a pošli na ${email}</b><br>
    <small>Použij: py -3.12 test/vytvor_skolu.py</small>
  </div>
</div>`;

  try {
    await Promise.all([
      fetch(RESEND_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [email], subject: `Potvrzení objednávky QR kódu — VS ${vs}`, html: bodyCustomer }),
      }),
      fetch(RESEND_API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [NOTIFY_EMAIL], subject: `📱 QR objednávka: ${skola} — VS ${vs}`, html: bodyNotify }),
      }),
    ]);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
