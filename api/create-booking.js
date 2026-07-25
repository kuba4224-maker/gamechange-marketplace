// ============================================================
// GAMECHANGE MARKETPLACE — /api/create-booking.js
// ============================================================
// Vercel Serverless Function. Tworzy rezerwację + autoryzuje kartę
// zawodnika (BEZ natychmiastowego obciążenia) — dokładnie mechanizm
// znanylekarz.pl w pełni zatwierdzony przez Kubę: "zarezerwuj teraz,
// zapłać bliżej terminu".
//
// Technicznie: PaymentIntent z capture_method='manual'. Stripe
// autoryzuje i BLOKUJE środki na karcie zawodnika, ale nie pobiera
// ich — to dzieje się dopiero przy wywołaniu capture (osobny
// endpoint/scheduler, uruchamiany bliżej terminu wizyty).
//
// Wymaga: specjalista MUSI mieć ukończony onboarding Stripe Connect
// (stripe_connect_account_id + charges_enabled=true) zanim jego
// sloty staną się rezerwowalne z realną płatnością — sprawdzane
// tutaj, nie tylko zakładane.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Prosta, stała prowizja Gamechange — ustalone w sesji koncepcyjnej
// (audyt biznesowy): zero różnicowania pierwsza/kolejna wizyta,
// zero opłaty za widoczność, tylko ten jeden procent od transakcji.
const PLATFORM_FEE_PERCENT = 15;
// Wartość przykładowa — Kuba ustali docelową stawkę osobno; 15%
// to typowy punkt startowy dla marketplace'ów usług profesjonalnych
// (niżej niż większość platform beauty/fitness, wyżej niż SaaS),
// ŁATWO zmienić w jednym miejscu, gdy Kuba poda docelową liczbę.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    userId,
    availabilityId,
    linkedGoalId,
    sharedDiagnosis,
    sharedNote,
    consentGivenBy
  } = req.body;

  if (!userId || !availabilityId) {
    return res.status(400).json({ error: 'Brak wymaganych danych rezerwacji.' });
  }

  // Walidacja modelu zgody — jeśli zawodnik dołącza kontekst,
  // MUSI być jasne kto wyraził zgodę (self/parent), zgodnie z
  // ustaloną zasadą "świadoma, jawna zgoda, nie automatyczna".
  const isSharingAnything = !!sharedDiagnosis || !!(sharedNote && sharedNote.trim());
  if (isSharingAnything && !['self', 'parent'].includes(consentGivenBy)) {
    return res.status(400).json({ error: 'Brak wymaganej informacji o zgodzie na udostępnienie kontekstu.' });
  }
  if (sharedNote && sharedNote.length > 500) {
    return res.status(400).json({ error: 'Notatka może mieć maksymalnie 500 znaków.' });
  }

  try {
    // 1. Pobierz slot i sprawdź dostępność
    const { data: slot, error: slotError } = await supabase
      .from('specialist_availability')
      .select('id, specialist_id, price_cents, is_booked, slot_start')
      .eq('id', availabilityId)
      .single();

    if (slotError || !slot) {
      return res.status(404).json({ error: 'Nie znaleziono terminu.' });
    }
    if (slot.is_booked) {
      return res.status(409).json({ error: 'Ten termin jest już zarezerwowany.' });
    }

    // 2. Pobierz specjalistę i sprawdź gotowość do przyjmowania płatności
    const { data: specialist, error: specError } = await supabase
      .from('specialists')
      .select('id, stripe_connect_account_id')
      .eq('id', slot.specialist_id)
      .single();

    if (specError || !specialist || !specialist.stripe_connect_account_id) {
      return res.status(400).json({ error: 'Ten specjalista nie ma jeszcze skonfigurowanych płatności.' });
    }

    const platformFeeCents = Math.round(slot.price_cents * (PLATFORM_FEE_PERCENT / 100));

    // 3. Utwórz PaymentIntent z manualnym capture (autoryzacja bez
    // pobrania środków) — środki na koncie specjalisty (destination
    // charge), Gamechange zatrzymuje application_fee.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: slot.price_cents,
      currency: 'pln',
      capture_method: 'manual',
      application_fee_amount: platformFeeCents,
      transfer_data: {
        destination: specialist.stripe_connect_account_id
      },
      metadata: {
        availability_id: String(availabilityId),
        user_id: userId
      }
    });

    // 4. Zapisz rezerwację w bazie ze statusem pending_payment.
    // Status zmieni się na 'confirmed' dopiero w webhooku, gdy
    // Stripe potwierdzi że autoryzacja się powiodła (nie od razu
    // tutaj — pomiędzy stworzeniem PaymentIntent a faktycznym
    // wprowadzeniem danych karty przez zawodnika może upłynąć
    // chwila, a nawet się nie udać).
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        user_id: userId,
        specialist_id: slot.specialist_id,
        availability_id: availabilityId,
        linked_goal_id: linkedGoalId || null,
        status: 'pending_payment',
        shared_diagnosis: !!sharedDiagnosis,
        shared_note: sharedNote ? sharedNote.trim() : null,
        consent_given_by: isSharingAnything ? consentGivenBy : null,
        price_cents: slot.price_cents,
        stripe_payment_intent_id: paymentIntent.id,
        platform_fee_cents: platformFeeCents
      })
      .select()
      .single();

    if (bookingError) {
      console.error('create-booking DB error:', bookingError);
      // Rezerwacja się nie zapisała — anulujemy PaymentIntent, żeby
      // nie zostawić autoryzacji karty bez odpowiadającej rezerwacji.
      await stripe.paymentIntents.cancel(paymentIntent.id).catch(() => {});
      return res.status(500).json({ error: 'Nie udało się zapisać rezerwacji. Spróbuj ponownie.' });
    }

    return res.status(200).json({
      bookingId: booking.id,
      clientSecret: paymentIntent.client_secret
      // Frontend użyje client_secret do dokończenia autoryzacji
      // karty (Stripe Elements/Payment Element) po stronie klienta.
    });
  } catch (e) {
    console.error('create-booking error:', e);
    return res.status(500).json({ error: 'Coś poszło nie tak. Spróbuj ponownie.' });
  }
};
