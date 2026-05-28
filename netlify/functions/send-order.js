// Netlify Function: send-order.js
// Odesílá potvrzovací email zákazníkovi + notifikaci provozovateli
// Env proměnné (nastavit v Netlify → Site config → Environment variables):
//   RESEND_API_KEY   = re_euysR5kQ_...
//   RESEND_FROM      = noreply@ai-lektor.cz
//   NOTIFY_EMAIL     = ailektor.info@gmail.com
//   SUPABASE_URL     = https://xxx.supabase.co
//   SUPABASE_KEY     = service_role klíč

const RESEND_API = 'https://api.resend.com/emails';

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

exports.handler = async (event) => {
  // Pouze POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS hlavičky (pro volání z HTML stránky)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    email_login,
    email_notif,
    plan_name,
    plan_typ,
    price,
    vs,
    payment_method,
  } = data;

  const RESEND_API_KEY  = process.env.RESEND_API_KEY;
  const FROM            = process.env.RESEND_FROM || 'AI Lektor <noreply@ai-lektor.cz>';
  const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL || 'ailektor.info@gmail.com';
  const SUPABASE_URL    = process.env.SUPABASE_URL;
  const SUPABASE_KEY    = process.env.SUPABASE_KEY;

  // Generuj potvrzovací token a ulož do Supabase
  const confirmToken = generateToken();
  const confirmLink  = `https://ai-lektor.cz/.netlify/functions/confirm-payment?token=${confirmToken}`;

  if (SUPABASE_URL && SUPABASE_KEY && isPrevod) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: confirmToken, email: email_login, vs }),
      });
    } catch(e) { console.log('Supabase token save error:', e.message); }
  }

  console.log('DEBUG: RESEND_API_KEY set?', !!RESEND_API_KEY);
  console.log('DEBUG: FROM =', FROM);
  console.log('DEBUG: NOTIFY_EMAIL =', NOTIFY_EMAIL);
  console.log('DEBUG: data =', JSON.stringify(data));

  if (!RESEND_API_KEY) {
    console.log('ERROR: RESEND_API_KEY chybi!');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY not set' }) };
  }

  const isPrevod = payment_method === 'prevod';
  const formattedPrice = Number(price).toLocaleString('cs-CZ') + ' Kč';

  // ── EMAIL ZÁKAZNÍKOVI ─────────────────────────────────────────────────────
  const subjectCustomer = isPrevod
    ? `Potvrzení objednávky — AI Lektor ${plan_name}`
    : `Objednávka evidována — AI Lektor ${plan_name}`;

  const bodyCustomer = isPrevod ? `
<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(30,58,110,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a6e,#2a5298);padding:32px 36px;">
      <div style="font-size:1.3rem;font-weight:900;color:#fff;letter-spacing:-0.02em;">🧠 AI Lektor exaktních věd</div>
      <div style="font-size:0.85rem;color:rgba(255,255,255,0.7);margin-top:4px;">Potvrzení objednávky</div>
    </div>
    <div style="padding:32px 36px;">
      <h2 style="font-size:1.3rem;font-weight:900;color:#1a2535;margin:0 0 8px;">Vaše objednávka byla přijata ✅</h2>
      <p style="color:#5a6a7d;font-size:0.95rem;margin:0 0 28px;">Dokončete ji platbou na níže uvedený účet. Přístup aktivujeme do 24 hodin od připsání.</p>

      <div style="background:#f5f2ec;border-radius:14px;padding:20px 22px;margin-bottom:24px;">
        <div style="font-size:0.78rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1e3a6e;margin-bottom:14px;">Váš plán</div>
        <div style="font-size:1.1rem;font-weight:900;color:#1a2535;">${plan_name} — ${plan_typ}</div>
        <div style="font-size:1.5rem;font-weight:900;color:#1e3a6e;margin-top:4px;">${formattedPrice} / měsíc</div>
      </div>

      <div style="border:1.5px solid rgba(30,58,110,0.15);border-radius:14px;padding:20px 22px;margin-bottom:24px;">
        <div style="font-size:0.85rem;font-weight:800;color:#1a2535;margin-bottom:14px;">Platební instrukce</div>
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Číslo účtu</td>
            <td style="padding:9px 0;font-weight:800;color:#1a2535;text-align:right;">bude doplněno</td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Částka</td>
            <td style="padding:9px 0;font-weight:800;color:#1e3a6e;text-align:right;">${formattedPrice}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Variabilní symbol</td>
            <td style="padding:9px 0;font-weight:800;color:#1e3a6e;font-size:1.05rem;text-align:right;">${vs}</td>
          </tr>
          <tr>
            <td style="padding:9px 0;color:#5a6a7d;font-weight:600;">Zpráva pro příjemce</td>
            <td style="padding:9px 0;font-weight:700;color:#1a2535;text-align:right;">AI Lektor ${plan_name} - ${vs}</td>
          </tr>
        </table>
      </div>

      <p style="font-size:0.88rem;color:#5a6a7d;line-height:1.6;">
        Po připsání platby vám na tento e-mail přijde přihlašovací link do aplikace.<br>
        Dotazy? Napište na <a href="mailto:ailektor.info@gmail.com" style="color:#1e3a6e;">ailektor.info@gmail.com</a>
      </p>
    </div>
    <div style="padding:18px 36px;background:#f5f2ec;text-align:center;font-size:0.78rem;color:#5a6a7d;">
      © 2026 AI Lektor exaktních věd · Miroslav Svoboda · IČO: 88282759
    </div>
  </div>
</body>
</html>
` : `
<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(30,58,110,0.1);">
    <div style="background:linear-gradient(135deg,#1e3a6e,#2a5298);padding:32px 36px;">
      <div style="font-size:1.3rem;font-weight:900;color:#fff;">🧠 AI Lektor exaktních věd</div>
      <div style="font-size:0.85rem;color:rgba(255,255,255,0.7);margin-top:4px;">Objednávka přijata</div>
    </div>
    <div style="padding:32px 36px;">
      <h2 style="font-size:1.3rem;font-weight:900;color:#1a2535;margin:0 0 8px;">Objednávka evidována 📋</h2>
      <p style="color:#5a6a7d;font-size:0.95rem;margin:0 0 20px;">
        Platební brána se připravuje. Jakmile bude aktivní, pošleme vám přímý odkaz k dokončení platby.
      </p>
      <div style="background:#f5f2ec;border-radius:14px;padding:20px 22px;margin-bottom:24px;">
        <div style="font-size:1.1rem;font-weight:900;color:#1a2535;">${plan_name} — ${plan_typ}</div>
        <div style="font-size:1.5rem;font-weight:900;color:#1e3a6e;margin-top:4px;">${formattedPrice} / měsíc</div>
      </div>
      <p style="font-size:0.88rem;color:#5a6a7d;">
        Nechcete čekat? Napište nám a zařídíme platbu převodem:<br>
        <a href="mailto:ailektor.info@gmail.com" style="color:#1e3a6e;">ailektor.info@gmail.com</a>
      </p>
    </div>
    <div style="padding:18px 36px;background:#f5f2ec;text-align:center;font-size:0.78rem;color:#5a6a7d;">
      © 2026 AI Lektor exaktních věd · IČO: 88282759
    </div>
  </div>
</body>
</html>
`;

  // ── EMAIL PROVOZOVATELI (notifikace) ──────────────────────────────────────
  const bodyNotify = `
<div style="font-family:'Segoe UI',sans-serif;background:#f0f0f0;padding:20px;border-radius:10px;max-width:500px;">
  <b style="font-size:1.1rem;">🛒 NOVÁ OBJEDNÁVKA</b><br><br>
  Plán: <b>${plan_name} — ${plan_typ}</b><br>
  Cena: <b>${formattedPrice}/měs.</b><br>
  Platba: <b>${payment_method}</b><br>
  VS: <b>${vs}</b><br><br>
  Login email: ${email_login}<br>
  Notif email: ${email_notif || email_login}<br><br>
  ${isPrevod ? `
  <div style="margin-top:16px;">
    <a href="${confirmLink}" style="display:inline-block;background:#1e3a6e;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:800;font-size:1rem;">
      ✅ Potvrdit přijetí platby
    </a>
    <p style="font-size:0.8rem;color:#888;margin-top:8px;">Kliknutím aktivuješ přístup zákazníkovi na 30 dní.</p>
  </div>
  ` : ''}
</div>
`;

  try {
    // Odeslat email zákazníkovi
    const r1 = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email_login],
        subject: subjectCustomer,
        html: bodyCustomer,
      }),
    });

    // Odeslat notifikaci provozovateli
    const r2 = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [NOTIFY_EMAIL],
        subject: `🛒 Nová objednávka: ${plan_name} (${formattedPrice}) — VS ${vs}`,
        html: bodyNotify,
      }),
    });

    const ok = r1.ok && r2.ok;
    return {
      statusCode: ok ? 200 : 502,
      headers,
      body: JSON.stringify({ ok, r1: r1.status, r2: r2.status }),
    };
  } catch (err) {
    console.log('ERROR catch:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
