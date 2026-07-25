// ============================================================
// GAMECHANGE MARKETPLACE — /api/specialist-onboarding.js
// ============================================================
// Vercel Serverless Function. Tworzy konto Stripe Connect dla
// specjalisty i zwraca link onboardingowy (Stripe hostuje cały
// formularz weryfikacji tożsamości/konta bankowego — Gamechange
// nie przechowuje żadnych danych finansowych specjalisty).
//
// Wywoływane z panelu specjalisty (do zbudowania), gdy specjalista
// zakłada konto logowania i chce zacząć przyjmować płatne rezerwacje.
// Profil w tabeli `specialists` może istnieć PRZED tym krokiem
// (Kuba tworzy go ręcznie) — stripe_connect_account_id zostaje
// NULL dopóki ten endpoint się nie wykona.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
  // UWAGA: service_role, NIE publishable key — ten endpoint
  // działa po stronie serwera i musi móc zapisać
  // stripe_connect_account_id niezależnie od RLS specjalisty
  // (RLS pozwala specjaliście update'ować TYLKO własny profil,
  // ale to zapisujemy z zaufanego backendu, nie z przeglądarki).
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { specialistId } = req.body;
  if (!specialistId) {
    return res.status(400).json({ error: 'Brak specialistId.' });
  }

  try {
    // 1. Pobierz profil specjalisty
    const { data: specialist, error: fetchError } = await supabase
      .from('specialists')
      .select('id, display_name, stripe_connect_account_id')
      .eq('id', specialistId)
      .single();

    if (fetchError || !specialist) {
      return res.status(404).json({ error: 'Nie znaleziono specjalisty.' });
    }

    let accountId = specialist.stripe_connect_account_id;

    // 2. Jeśli specjalista nie ma jeszcze konta Connect, utwórz je
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        // 'express' — Stripe hostuje UI onboardingu i dashboard
        // wypłat, Gamechange nie musi budować własnego panelu
        // finansowego. Najlżejsza opcja integracyjna, odpowiednia
        // dla modelu kuratorowanego na start.
        country: 'PL',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });
      accountId = account.id;

      const { error: updateError } = await supabase
        .from('specialists')
        .update({ stripe_connect_account_id: accountId })
        .eq('id', specialistId);

      if (updateError) {
        console.error('Nie udało się zapisać stripe_connect_account_id:', updateError);
        return res.status(500).json({ error: 'Błąd zapisu konta Stripe.' });
      }
    }

    // 3. Wygeneruj link onboardingowy (zawsze świeży, jednorazowy)
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.MARKETPLACE_URL}/onboarding-refresh?specialistId=${specialistId}`,
      return_url: `${process.env.MARKETPLACE_URL}/onboarding-complete?specialistId=${specialistId}`,
      type: 'account_onboarding'
    });

    return res.status(200).json({ onboardingUrl: accountLink.url });
  } catch (e) {
    console.error('specialist-onboarding error:', e);
    return res.status(500).json({ error: 'Coś poszło nie tak. Spróbuj ponownie.' });
  }
};
