// Netlify Function: payment-webhook.js
// URL pro předání výsledku platby ("push notifikace") od Comgate — nastaví se do portálu
// Comgate (WP-7, mimo scope tohoto souboru). Comgate ji volá server-to-server po výsledku platby.
//
// BEZPEČNOST (viz architektura sekce 5): z příchozího requestu se použije JEN `transId`.
// Nikdy se nevěří žádnému jinému poli (status, price, refId apod.) z těla requestu — vždy se
// znovu ověří skutečný stav platby přes server-to-server GET na Comgate `payment/transId`.
//
// Env proměnné: SUPABASE_URL, SUPABASE_KEY, COMGATE_MERCHANT_ID, COMGATE_SECRET.
//
// Comgate REST API v2.0 (https://apidoc.comgate.cz/api/rest/):
//   GET https://payments.comgate.cz/v2.0/payment/transId/{transId}.json
//   Header: Authorization: Basic base64(merchant:secret)
//   Odpověď JSON: { code, message, test, price, curr, label, refId, email, transId, status,
//                   payerName, payerAcc, fee, vs, ... }, code === 0 = OK.

const { activateAccount } = require('./_lib/activate-account');

const COMGATE_STATUS_URL_BASE = 'https://payments.comgate.cz/v2.0/payment/transId/';

// Comgate podle dokumentace neočekává JSON, ale prostou odpověď 200 s tělem "OK" — jinak bude
// callback opakovat. Toto je bezpečný default, pokud přesný formát není v CodeBooku jednoznačně
// specifikován jinak.
const OK_RESPONSE = { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'OK' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Comgate posílá notifikaci buď jako POST form-urlencoded/JSON tělo, nebo jako GET query params.
  // Z celého requestu bereme POUZE transId — žádné jiné pole (viz bezpečnost výše).
  let transId = null;
  try {
    if (event.httpMethod === 'GET') {
      transId = event.queryStringParameters?.transId || null;
    } else {
      const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
      if (contentType.includes('application/json')) {
        const body = JSON.parse(event.body || '{}');
        transId = body.transId || null;
      } else {
        // form-urlencoded (Comgate výchozí formát pro notifikace)
        const params = new URLSearchParams(event.body || '');
        transId = params.get('transId');
      }
      // Fallback: pokud transId nepřišel v těle, zkus query string (Comgate ho někdy posílá tam).
      if (!transId) {
        transId = event.queryStringParameters?.transId || null;
      }
    }
  } catch (e) {
    console.log('WARN: payment-webhook - parsování requestu selhalo:', e.message);
  }

  if (!transId) {
    console.log('WARN: payment-webhook - chybí transId v requestu, nic se neaktivuje.');
    return OK_RESPONSE;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const COMGATE_MERCHANT_ID = process.env.COMGATE_MERCHANT_ID;
  const COMGATE_SECRET = process.env.COMGATE_SECRET;

  if (!SUPABASE_URL || !SUPABASE_KEY || !COMGATE_MERCHANT_ID || !COMGATE_SECRET) {
    console.log('ERROR: payment-webhook - chybí konfigurace serveru (Supabase/Comgate env).');
    // I tak vrátíme 200 OK, ať Comgate zbytečně neopakuje callback donekonečna kvůli naší
    // konfigurační chybě — problém je vidět v logu a musí ho vyřešit provoz/CEO.
    return OK_RESPONSE;
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1) Server-to-server ověření skutečného stavu platby u Comgate. Toto je jediný zdroj pravdy.
  const basicAuth = Buffer.from(`${COMGATE_MERCHANT_ID}:${COMGATE_SECRET}`).toString('base64');
  let cgResult;
  try {
    const cgResponse = await fetch(`${COMGATE_STATUS_URL_BASE}${encodeURIComponent(transId)}.json`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${basicAuth}` },
    });
    const cgText = await cgResponse.text();
    try {
      cgResult = JSON.parse(cgText);
    } catch {
      console.log('ERROR: payment-webhook - Comgate status odpověď není validní JSON:', cgResponse.status, cgText);
      return OK_RESPONSE;
    }
  } catch (e) {
    console.log('ERROR: payment-webhook - Comgate status exception:', e.message, 'transId=', transId);
    return OK_RESPONSE;
  }

  if (!cgResult || cgResult.code !== 0) {
    // Neplatný/nenalezený transId (nebo podvržený požadavek) — nic se neaktivuje.
    console.log('WARN: payment-webhook - Comgate status code != 0, transId neplatný nebo neznámý:', cgResult && cgResult.code, cgResult && cgResult.message, 'transId=', transId);
    return OK_RESPONSE;
  }

  const { status, price: cgPrice, refId, email: cgEmail } = cgResult;

  if (status !== 'PAID') {
    // CANCELLED / PENDING / AUTHORIZED apod. — jen zalogujeme, nic neaktivujeme.
    console.log('INFO: payment-webhook - platba zatím není PAID, status=', status, 'transId=', transId, 'refId=', refId);
    return OK_RESPONSE;
  }

  // 2) Dohledej pending řádek v payment_tokens — primárně podle comgate_trans_id (spolehlivější,
  //    zapsal ho create-payment.js), s ověřením shody refId/vs jako doplňkovou kontrolou.
  let row = null;
  try {
    const resByTrans = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_tokens?comgate_trans_id=eq.${encodeURIComponent(transId)}&select=token,email,vs,plan,price,stav,pouzit`,
      { headers: sbHeaders }
    );
    const rowsByTrans = await resByTrans.json();
    if (rowsByTrans && rowsByTrans.length > 0) {
      row = rowsByTrans[0];
    }
  } catch (e) {
    console.log('ERROR: payment-webhook - Supabase select podle comgate_trans_id selhal:', e.message, 'transId=', transId);
  }

  if (!row && refId) {
    try {
      const resByVs = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_tokens?vs=eq.${encodeURIComponent(refId)}&select=token,email,vs,plan,price,stav,pouzit`,
        { headers: sbHeaders }
      );
      const rowsByVs = await resByVs.json();
      if (rowsByVs && rowsByVs.length > 0) {
        row = rowsByVs[0];
      }
    } catch (e) {
      console.log('ERROR: payment-webhook - Supabase select podle vs selhal:', e.message, 'refId=', refId);
    }
  }

  if (!row) {
    console.log('ERROR: payment-webhook - nenalezen odpovídající payment_tokens řádek pro transId=', transId, 'refId=', refId);
    return OK_RESPONSE;
  }

  // Ověření shody refId/vs (doplňková kontrola proti podvodu, viz architektura bod 5.2).
  if (refId && row.vs && String(refId) !== String(row.vs)) {
    console.log('ERROR: payment-webhook - refId neodpovídá vs uloženému u řádku:', 'refId=', refId, 'row.vs=', row.vs, 'transId=', transId);
    return OK_RESPONSE;
  }

  // Kontrola shody částky — chrání proti scénáři, kdy by někdo zaplatil méně a snažil se
  // aktivovat dražší plán (architektura bod 5.2). cgPrice je v haléřích (Comgate standard),
  // row.price je v Kč (stejně jako ho ukládá create-payment.js).
  if (row.price != null && cgPrice != null) {
    const expectedHaleru = Math.round(Number(row.price) * 100);
    if (expectedHaleru !== Number(cgPrice)) {
      console.log('ERROR: payment-webhook - částka neodpovídá objednávce:', 'ocekavano(haleru)=', expectedHaleru, 'comgate(haleru)=', cgPrice, 'transId=', transId, 'vs=', row.vs);
      return OK_RESPONSE;
    }
  }

  // 3) Idempotence — pokud už je řádek 'paid', nic dalšího nedělej (neposílej email 2×).
  if (row.stav === 'paid') {
    console.log('INFO: payment-webhook - řádek už je paid, idempotentní no-op. transId=', transId, 'vs=', row.vs);
    return OK_RESPONSE;
  }

  const activationEmail = row.email || cgEmail;
  if (!activationEmail) {
    console.log('ERROR: payment-webhook - chybí email pro aktivaci účtu. transId=', transId, 'vs=', row.vs);
    return OK_RESPONSE;
  }

  // 4) Aktivuj účet (sdílená logika s confirm-payment.js).
  try {
    await activateAccount(activationEmail, row.plan, row.vs);
  } catch (e) {
    console.log('ERROR: payment-webhook - activateAccount selhal:', e.message, 'transId=', transId, 'vs=', row.vs);
    // Nevracíme chybu Comgate — pokud aktivace selhala kvůli naší chybě, Comgate stejně
    // notifikaci neopakuje donekonečna spolehlivě; problém je vidět v logu. Řádek zůstane
    // 'pending' a lze ho doaktivovat ručně / přes check-payment-status.js (WP-8).
    return OK_RESPONSE;
  }

  // 5) Označ payment_tokens řádek jako paid (+ pouzit=true pro zpětnou kompatibilitu).
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${row.token}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ stav: 'paid', pouzit: true }),
    });
  } catch (e) {
    console.log('WARN: payment-webhook - nepodařilo se označit řádek jako paid (účet už je aktivní):', e.message, 'transId=', transId, 'vs=', row.vs);
  }

  console.log('INFO: payment-webhook - účet úspěšně aktivován. transId=', transId, 'vs=', row.vs, 'email=', activationEmail);
  return OK_RESPONSE;
};
