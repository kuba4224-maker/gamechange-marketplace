// ============================================================
// GAMECHANGE MARKETPLACE — /api/exchange-bridge-code.js
// ============================================================
// Zbudowane 03.08.2026 — most sesji Asystent -> Marketplace
// (KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 1.1, "Opcja (a) —
// jednorazowy kod wymiany sesji", ZDECYDOWANE autonomicznie przez
// Claude'a 01.08.2026, Kuba upoważnił wprost do tej decyzji).
//
// Co robi: dostaje jednorazowy `code` (wstawiony wcześniej przez
// gamechange-app do public.session_bridge_codes, patrz
// INTEGRACJA_MOST_SESJI_MARKETPLACE_SQL.md), sprawdza że jest ważny i
// nieużyty, ATOMOWO oznacza go jako użyty (warunek used_at is null w
// samym UPDATE — zabezpieczenie przed race condition przy dwóch
// równoczesnych wywołaniach tym samym kodem), po czym mintuje realną
// sesję Supabase Auth dla właściciela kodu i zwraca token do
// przeglądarki Marketplace, żeby ta mogła dokończyć logowanie sama
// (supabaseClient.auth.verifyOtp({ token_hash, type: 'email' })) —
// bez wysyłki jakiegokolwiek maila, bez drugiego logowania.
//
// Mechanizm potwierdzony wprost przez społeczność Supabase jako
// standardowy wzorzec "admin loguje w imieniu użytkownika":
// supabase.auth.admin.generateLink({type:'magiclink', email}) zwraca
// properties.hashed_token, NIE wysyłając żadnego maila (generateLink
// tylko generuje dane linku, wysyłka to osobna operacja) — ten token
// przekazany do klienckiego verifyOtp({token_hash, type:'email'})
// ustanawia prawdziwą sesję (access_token + refresh_token) w
// localStorage origin Marketplace.
// ⚠️ DO ZWERYFIKOWANIA JEDNYM ŻYWYM TESTEM PRZED PRODUKCJĄ: dokładne
// zachowanie (czy hashed_token jest jednorazowy, domyślny czas
// wygaśnięcia) zależy od wersji @supabase/supabase-js/GoTrue — nasza
// WŁASNA warstwa (kod jednorazowy + 2 minuty ważności w
// session_bridge_codes) i tak chroni niezależnie od tego, ale warto
// jedno kliknięcie na żywo zamiast wierzyć dokumentacji na słowo.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { isBridgeCodeUsable } = require('../lib/session-bridge-codes');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Brak kodu wymiany.' });
  }

  try {
    const { data: row, error: selectError } = await supabase
      .from('session_bridge_codes')
      .select('id, user_id, used_at, expires_at')
      .eq('code', code)
      .maybeSingle();

    if (selectError) throw selectError;
    if (!row) {
      return res.status(400).json({ error: 'Nieprawidłowy kod wymiany.' });
    }

    const nowIso = new Date().toISOString();
    if (!isBridgeCodeUsable({ usedAt: row.used_at, expiresAt: row.expires_at, nowIso })) {
      return res.status(400).json({ error: 'Kod wymiany wygasł albo już został użyty.' });
    }

    // Atomowe "zajęcie" kodu: warunek used_at is null wprost w UPDATE,
    // nie w osobnym SELECT-cie sprzed chwili — dwa równoczesne żądania
    // tym samym kodem NIE mogą oba przejść (drugie dostanie 0 zmienionych
    // wierszy i skończy z błędem, zamiast obie strony dostać ważną sesję
    // dla tego samego jednorazowego kodu).
    const { data: claimed, error: updateError } = await supabase
      .from('session_bridge_codes')
      .update({ used_at: nowIso })
      .eq('id', row.id)
      .is('used_at', null)
      .select('id')
      .maybeSingle();

    if (updateError) throw updateError;
    if (!claimed) {
      return res.status(400).json({ error: 'Kod wymiany już został użyty (równoczesne żądanie).' });
    }

    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(row.user_id);
    if (userError || !userData || !userData.user || !userData.user.email) {
      throw userError || new Error('Nie znaleziono użytkownika dla tego kodu.');
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: userData.user.email,
    });
    if (linkError) throw linkError;

    const tokenHash = linkData && linkData.properties && linkData.properties.hashed_token;
    if (!tokenHash) {
      throw new Error('Supabase nie zwrócił hashed_token (generateLink).');
    }

    return res.status(200).json({ tokenHash });
  } catch (e) {
    console.log('exchange-bridge-code error:', e);
    return res.status(500).json({ error: 'Nie udało się wymienić kodu sesji.' });
  }
};
