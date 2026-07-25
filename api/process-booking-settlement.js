// ============================================================
// GAMECHANGE MARKETPLACE — /api/process-booking-settlement.js
// ============================================================
// Vercel Serverless Function, wywoływana przez SCHEDULER (osobny,
// jeszcze niezbudowany proces — analogicznie do brakującego
// schedulera dla followups/goal_checkin w Asystencie Codziennym;
// ten sam, znany, wcześniej zidentyfikowany brakujący element).
//
// Dwie odpowiedzialności, obsługiwane osobnymi funkcjami eksportu,
// żeby scheduler mógł je wywoływać niezależnie w różnych momentach:
//
// 1. captureBookingPayment — wywoływane bliżej terminu wizyty
//    (np. 24h przed), faktycznie POBIERA autoryzowane wcześniej
//    środki z karty zawodnika (Stripe capture).
// 2. finalizeCompletedBookings — wywoływane okresowo (np. co
//    godzinę), sprawdza rezerwacje ze statusem 'confirmed' których
//    slot_end minął o więcej niż 48h i nikt ich nie oznaczył jako
//    'completed' — automatycznie przechodzą w 'auto_completed',
//    co odblokowuje wypłatę dla specjalisty (transfer_data w
//    PaymentIntent już to załatwia automatycznie przy capture,
//    więc to praktycznie zamyka cykl rezerwacji).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AUTO_COMPLETE_HOURS = 48;

// ------------------------------------------------------------
// 1. Pobranie płatności (capture) — bliżej terminu wizyty
// ------------------------------------------------------------
async function captureBookingPayment(bookingId) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, status, stripe_payment_intent_id')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    return { ok: false, error: 'Nie znaleziono rezerwacji.' };
  }
  if (booking.status !== 'confirmed') {
    // Rezerwacja mogła zostać anulowana zanim doszło do capture —
    // NIE próbujemy pobrać płatności za coś, co już nie jest aktywne.
    return { ok: false, error: `Rezerwacja ma status '${booking.status}', nie 'confirmed' — pomijam capture.` };
  }

  try {
    await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);
    return { ok: true };
  } catch (e) {
    console.error('captureBookingPayment error:', e);
    return { ok: false, error: 'Nie udało się pobrać płatności.' };
  }
}

// ------------------------------------------------------------
// 2. Ręczne potwierdzenie przez specjalistę — wywoływane z panelu
// specjalisty (endpoint do zbudowania), nie przez scheduler.
// ------------------------------------------------------------
async function markBookingCompleted(bookingId, specialistUserId) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, status, specialist_id, specialists!inner(user_id)')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    return { ok: false, error: 'Nie znaleziono rezerwacji.' };
  }
  if (booking.specialists.user_id !== specialistUserId) {
    // Zabezpieczenie na poziomie logiki aplikacji, DODATKOWE do RLS
    // (RLS już to pilnuje na poziomie bazy, ale sprawdzenie tutaj
    // daje czytelniejszy komunikat błędu niż surowe odrzucenie z bazy).
    return { ok: false, error: 'Brak uprawnień do tej rezerwacji.' };
  }
  if (booking.status !== 'confirmed') {
    return { ok: false, error: `Nie można potwierdzić rezerwacji ze statusem '${booking.status}'.` };
  }

  const { error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', bookingId);

  if (updateError) {
    return { ok: false, error: 'Nie udało się zaktualizować rezerwacji.' };
  }
  return { ok: true };
}

// ------------------------------------------------------------
// 3. Automatyczne domknięcie po 48h bez potwierdzenia
// ------------------------------------------------------------
async function finalizeCompletedBookings() {
  const cutoff = new Date(Date.now() - AUTO_COMPLETE_HOURS * 60 * 60 * 1000).toISOString();

  // Rezerwacje 'confirmed', gdzie termin (slot_end) minął ponad
  // 48h temu — dołączamy do specialist_availability, żeby dostać
  // slot_end (bookings samo w sobie go nie ma, tylko availability_id).
  const { data: staleBookings, error } = await supabase
    .from('bookings')
    .select('id, specialist_availability!inner(slot_end)')
    .eq('status', 'confirmed')
    .lt('specialist_availability.slot_end', cutoff);

  if (error) {
    console.error('finalizeCompletedBookings fetch error:', error);
    return { ok: false, processedCount: 0 };
  }

  let processedCount = 0;
  for (const booking of staleBookings || []) {
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'auto_completed', completed_at: new Date().toISOString() })
      .eq('id', booking.id)
      .eq('status', 'confirmed');
      // Warunek .eq('status', 'confirmed') chroni przed race
      // condition — gdyby specjalista właśnie w tej samej chwili
      // ręcznie potwierdził wizytę (markBookingCompleted), ten
      // update nic by nie nadpisał.

    if (!updateError) processedCount++;
  }

  return { ok: true, processedCount };
}

module.exports = {
  captureBookingPayment,
  markBookingCompleted,
  finalizeCompletedBookings,
  AUTO_COMPLETE_HOURS
};
