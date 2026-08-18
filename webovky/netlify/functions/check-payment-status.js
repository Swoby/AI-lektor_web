// Netlify Function: check-payment-status.js
// Záchranná pojistka (WP-8, viz architektura sekce 7): pokud Comgate webhook z nějakého
// důvodu nedorazí (výpadek sítě apod.), tato funkce se zavolá z `objednat-nevyrizena.html`
// (1x, po ~5s) a dotáže se Comgate na skutečný stav platby podle `vs` uloženého u objednávky.
// Pokud je platba PAID a účet ještě nebyl aktivován, aktivuje ho stejnou (bezpečnou) cestou
// jako `payment-webhook.js`.
//
// BEZPEČNOST (stejná pravidla jako u webhooku, architektura sekce 5): `vs` poslaný z frontendu
// se používá JEN k dohledání řádku v Supabase — NIKDY není sám o sobě důkazem platby. Skutečný
// stav se vždy ověří server-to-server přes Comgate `payment/transId` s Merchant ID + Secret,
// které nikdy neopouští server.
//
// Env proměnné: SUPABASE_URL, SUPABASE_KEY, COMGATE_MERCHANT_ID, COMGATE_SECRET.
//
// Poznámka k duplicitě s payment-webhook.js: logika ověření stavu + aktivace je záměrně
// implementována zde samostatně (ne sdílena přes _lib), protože vrací JSON odpověď frontendu
// (na rozdíl od webhooku, který vrací prostý text "OK" Comgate) a má jiný vstupní kontrakt
// (GET ?vs=... vs. POST transId od Comgate) — sdílet by šlo jen se zavedením další abstrakce
// nad oběma soubory, což by znamenalo zasahovat do už otestovaného payment-webhook.js. Sdílená
// je aspoň nejcitlivější část: `activateAccount` z `_lib/activate-account.js`.

const { activateAccount } = require('./_lib/activate-account');

const COMGATE_STATUS_URL_BASE = 'https://payments.comgate.cz/v2.0/payment/transId/';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // vs přichází z query stringu (GET, volané z objednat-nevyrizena.html) nebo z JSON těla (POST).
  let vs = null;
  if (event.httpMethod === 'GET') {
    vs = event.queryStringParameters?.vs || null;
  } else {
    try {
      const body = JSON.parse(event.body || '{}');
      vs = body.vs || null;
    } catch {
      vs = null;
    }
  }

  if (!vs) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Chybí povinný parametr vs.' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const COMGATE_MERCHANT_ID = process.env.COMGATE_MERCHANT_ID;
  const COMGATE_SECRET = process.env.COMGATE_SECRET;

  if (!SUPABASE_URL || !SUPABASE_KEY || !COMGATE_MERCHANT_ID || !COMGATE_SECRET) {
    console.log('ERROR: check-payment-status - chybí konfigurace serveru (Supabase/Comgate env).');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chyba konfigurace serveru.' }) };
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1) Dohledej řádek v payment_tokens podle vs.
  let row = null;
  try {
    const resByVs = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_tokens?vs=eq.${encodeURIComponent(vs)}&select=token,email,vs,plan,price,stav,pouzit,comgate_trans_id`,
      { headers: sbHeaders }
    );
    const rowsByVs = await resByVs.json();
    if (rowsByVs && rowsByVs.length > 0) {
      row = rowsByVs[0];
    }
  } catch (e) {
    console.log('ERROR: check-payment-status - Supabase select podle vs selhal:', e.message, 'vs=', vs);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Nepodařilo se ověřit objednávku, zkuste to prosím znovu.' }) };
  }

  if (!row) {
    console.log('WARN: check-payment-status - nenalezen payment_tokens řádek pro vs=', vs);
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Objednávka nenalezena.' }) };
  }

  // 2) Pokud už je řádek paid, není co dělat — informuj frontend.
  if (row.stav === 'paid') {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'paid', activated: true }) };
  }

  // Bez comgate_trans_id nemáme co ověřovat u Comgate (objednávka např. nedoběhla create-payment.js).
  if (!row.comgate_trans_id) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', activated: false }) };
  }

  // 3) Server-to-server ověření skutečného stavu platby u Comgate — jediný zdroj pravdy.
  const basicAuth = Buffer.from(`${COMGATE_MERCHANT_ID}:${COMGATE_SECRET}`).toString('base64');
  let cgResult;
  try {
    const cgResponse = await fetch(`${COMGATE_STATUS_URL_BASE}${encodeURIComponent(row.comgate_trans_id)}.json`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` },
    });
    const cgText = await cgResponse.text();
    try {
      cgResult = JSON.parse(cgText);
    } catch {
      console.log('ERROR: check-payment-status - Comgate status odpověď není validní JSON:', cgResponse.status, cgText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Nepodařilo se ověřit stav platby, zkuste to prosím znovu.' }) };
    }
  } catch (e) {
    console.log('ERROR: check-payment-status - Comgate status exception:', e.message, 'transId=', row.comgate_trans_id);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Nepodařilo se ověřit stav platby, zkuste to prosím znovu.' }) };
  }

  if (!cgResult || cgResult.code !== 0) {
    console.log('WARN: check-payment-status - Comgate status code != 0:', cgResult && cgResult.code, cgResult && cgResult.message, 'transId=', row.comgate_trans_id);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', activated: false }) };
  }

  const { status, price: cgPrice, refId } = cgResult;

  if (status !== 'PAID') {
    const normalized = status === 'CANCELLED' ? 'cancelled' : 'pending';
    return { statusCode: 200, headers, body: JSON.stringify({ status: normalized, activated: false }) };
  }

  // Ověření shody refId/vs (stejná kontrola jako v payment-webhook.js).
  if (refId && row.vs && String(refId) !== String(row.vs)) {
    console.log('ERROR: check-payment-status - refId neodpovídá vs uloženému u řádku:', 'refId=', refId, 'row.vs=', row.vs);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', activated: false }) };
  }

  // Kontrola shody částky (cgPrice v haléřích, row.price v Kč).
  if (row.price != null && cgPrice != null) {
    const expectedHaleru = Math.round(Number(row.price) * 100);
    if (expectedHaleru !== Number(cgPrice)) {
      console.log('ERROR: check-payment-status - částka neodpovídá objednávce:', 'ocekavano(haleru)=', expectedHaleru, 'comgate(haleru)=', cgPrice, 'vs=', row.vs);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', activated: false }) };
    }
  }

  const activationEmail = row.email;
  if (!activationEmail) {
    console.log('ERROR: check-payment-status - chybí email pro aktivaci účtu. vs=', row.vs);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', activated: false }) };
  }

  // 4) Aktivuj účet (sdílená logika s payment-webhook.js / confirm-payment.js).
  try {
    await activateAccount(activationEmail, row.plan, row.vs);
  } catch (e) {
    console.log('ERROR: check-payment-status - activateAccount selhal:', e.message, 'vs=', row.vs);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Platba je zaplacená, ale aktivace účtu se nezdařila. Napište nám prosím na e-mail.' }) };
  }

  // 5) Označ payment_tokens řádek jako paid (idempotentně, stejně jako webhook).
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${row.token}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ stav: 'paid', pouzit: true }),
    });
  } catch (e) {
    console.log('WARN: check-payment-status - nepodařilo se označit řádek jako paid (účet už je aktivní):', e.message, 'vs=', row.vs);
  }

  console.log('INFO: check-payment-status - účet úspěšně aktivován přes záchrannou pojistku. vs=', row.vs, 'email=', activationEmail);
  return { statusCode: 200, headers, body: JSON.stringify({ status: 'paid', activated: true }) };
};
