// Netlify Function: create-payment.js
// Vytvoří pending záznam objednávky v Supabase a založí platbu v Comgate (karta/GPay).
// Vrací frontendu jen { redirect } URL na platební bránu — nikdy neposílá Merchant ID/Secret.
//
// Env proměnné (Netlify → Site config → Environment variables):
//   SUPABASE_URL         = https://xxx.supabase.co
//   SUPABASE_KEY         = service_role klíč
//   COMGATE_MERCHANT_ID  = Merchant ID (viz hesla.txt, NIKDY nekomitovat)
//   COMGATE_SECRET       = Secret (viz hesla.txt, NIKDY nekomitovat)
//   COMGATE_TEST_MODE    = 'true' / 'false' (string) — dokud CEO neschválí ostrý provoz, má být 'true'
//
// Pole a formát requestu ověřeny podle oficiální Comgate REST API v2.0 dokumentace
// (https://apidoc.comgate.cz/api/rest/, staženo 2026-08-18):
//   - Autentizace: HTTP Basic (Authorization: Basic base64(merchant:secret)) — NE pole v těle.
//   - Content-Type: application/json (NE form-urlencoded).
//   - Endpoint: POST https://payments.comgate.cz/v2.0/payment.json
//   - Odpověď je JSON: { code, message, transId, redirect }, code === 0 = OK.
//   - `label` má hard limit 1-16 znaků.
//   - `fullName` je podle dokumentace povinné pole — TODO: objednat.html aktuálně nesbírá
//     jméno zákazníka, jako dočasný fallback se posílá email (viz níže).

const COMGATE_CREATE_URL = 'https://payments.comgate.cz/v2.0/payment.json';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS hlavičky (stejný styl jako send-order.js / confirm-payment.js)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

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
    payment_method, // 'karta' nebo 'gpay' (přichází z objednat.html radio hodnoty)
  } = data;

  // Základní validace vstupu
  if (!email_login || !plan_name || !price || !vs) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Chybí povinná pole (email_login, plan_name, price, vs).' }),
    };
  }

  // payment_method omezíme na 'karta' / 'gpay' (default 'karta', pokud přijde něco jiného)
  const normalizedMethod = payment_method === 'gpay' ? 'gpay' : 'karta';

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const COMGATE_MERCHANT_ID = process.env.COMGATE_MERCHANT_ID;
  const COMGATE_SECRET = process.env.COMGATE_SECRET;
  const COMGATE_TEST_MODE = (process.env.COMGATE_TEST_MODE || 'true') === 'true';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('ERROR: SUPABASE_URL/SUPABASE_KEY chybi!');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chyba konfigurace serveru (Supabase).' }) };
  }

  if (!COMGATE_MERCHANT_ID || !COMGATE_SECRET) {
    console.log('ERROR: COMGATE_MERCHANT_ID/COMGATE_SECRET chybi!');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chyba konfigurace serveru (Comgate).' }) };
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1) Ulož pending řádek do payment_tokens (podobný styl zápisu jako send-order.js).
  //    token zde slouží jen jako interní identifikátor řádku (na rozdíl od 'prevod' flow ho
  //    zákazník nikdy neuvidí v odkazu — aktivaci u karet/GPay řeší payment-webhook.js přes vs/transId).
  const internalToken = 'cg_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  try {
    const resInsert = await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        token: internalToken,
        email: email_login,
        vs,
        pouzit: false,
        payment_method: normalizedMethod,
        stav: 'pending',
        plan: plan_name,
        price,
      }),
    });

    if (!resInsert.ok) {
      const errText = await resInsert.text();
      console.log('ERROR: Supabase insert payment_tokens selhal:', resInsert.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Nepodařilo se uložit objednávku, zkuste to prosím znovu.' }),
      };
    }
  } catch (e) {
    console.log('ERROR: Supabase insert exception:', e.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Nepodařilo se uložit objednávku, zkuste to prosím znovu.' }),
    };
  }

  // 2) Zavolej Comgate payment.json (server-to-server, JSON, HTTP Basic auth).
  //    price se posílá v haléřích jako celé číslo (Comgate standard), viz architektura bod 0.
  const priceHaleru = Math.round(Number(price) * 100);
  const baseUrl = 'https://ai-lektor.cz';

  // label má hard limit 1-16 znaků podle Comgate REST API v2.0 dokumentace — ořízneme.
  const rawLabel = `AI Lektor ${plan_name || ''}`.trim() || 'AI Lektor';
  const label = rawLabel.slice(0, 16);

  // TODO: objednat.html aktuálně nesbírá jméno zákazníka (jen email a plán) — fullName je
  // ale podle Comgate dokumentace povinné pole. Dokud formulář nezíská pole na jméno,
  // používáme jako dočasný fallback email.
  const fullName = data.full_name || email_login;

  const requestBody = {
    test: COMGATE_TEST_MODE,
    price: priceHaleru,
    curr: 'CZK',
    label,
    refId: String(vs),
    method: 'ALL', // 'ALL' = zákazník si vybere kartu/bankovní tlačítko/GPay na Comgate stránce
    email: email_login,
    fullName,
    lang: 'cs',
    // Redirect URL po dokončení platby na straně Comgate (jen zobrazení výsledku,
    // aktivaci účtu dělá vždy payment-webhook.js — viz architektura bod 5).
    url_paid: `${baseUrl}/objednat-ok.html?vs=${encodeURIComponent(vs)}`,
    url_cancelled: `${baseUrl}/objednat-zrusena.html?vs=${encodeURIComponent(vs)}`,
    url_pending: `${baseUrl}/objednat-nevyrizena.html?vs=${encodeURIComponent(vs)}`,
  };

  const basicAuth = Buffer.from(`${COMGATE_MERCHANT_ID}:${COMGATE_SECRET}`).toString('base64');

  try {
    const cgResponse = await fetch(COMGATE_CREATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: JSON.stringify(requestBody),
    });

    const cgText = await cgResponse.text();
    let cgResult;
    try {
      cgResult = JSON.parse(cgText);
    } catch {
      console.log('ERROR: Comgate create - odpověď není validní JSON:', cgResponse.status, cgText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Platební bránu se nepodařilo spustit, zkuste to prosím znovu.' }),
      };
    }

    if (!cgResponse.ok || cgResult.code !== 0 || !cgResult.redirect) {
      console.log('ERROR: Comgate create selhal:', cgResponse.status, cgResult.code, cgResult.message);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Platební bránu se nepodařilo spustit, zkuste to prosím znovu.' }),
      };
    }

    // Ulož transId k pending řádku, ať ho payment-webhook.js dohledá (podle vs, i podle transId).
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payment_tokens?token=eq.${internalToken}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ comgate_trans_id: cgResult.transId }),
      });
    } catch (e) {
      console.log('WARN: Nepodařilo se dopsat comgate_trans_id:', e.message);
      // Nefatální — webhook může transakci dohledat i podle refId/vs, pokračujeme dál.
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ redirect: cgResult.redirect }),
    };
  } catch (err) {
    console.log('ERROR: Comgate create exception:', err.message, err.stack);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Platební bránu se nepodařilo spustit, zkuste to prosím znovu.' }),
    };
  }
};
