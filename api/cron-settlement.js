// ============================================================
// GAMECHANGE MARKETPLACE — /api/cron-settlement.js
// ============================================================
// Ten endpoint jest SCHEDULEREM — jedynym miejscem, które faktycznie
// wywołuje captureBookingPayment / finalizeCompletedBookings.
// Wcześniej te funkcje istniały (api_process_booking_settlement.js),
// ale nic ich automatycznie nie uruchamiało. Ten plik to naprawia.
//
// Wywoływane przez Vercel Cron raz dziennie (limit planu Hobby —
// wystarczający, bo rozliczenia nie wymagają wysokiej częstotliwości:
// "bliżej terminu wizyty" i "48h po" to okna rzędu godzin, nie minut).
//
// Zabezpieczone przez CRON_SECRET — Vercel automatycznie dołącza go
// jako nagłówek Authorization przy wywołaniach z crona, więc nikt
// z zewnątrz nie może wywołać tego endpointu i wymusić rozliczeń.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { captureBookingPayment, finalizeCompletedBookings } = require('./process-booking-settlement');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Ile godzin przed terminem wizyty pobieramy płatność. 24h to
// rozsądny margines — wystarczająco blisko, żeby cena była
// aktualna, wystarczająco wcześnie, żeby zdążyć zareagować na
// nieudaną płatność (np. karta bez środków) przed samą wizytą.
const CAPTURE_WINDOW_HOURS = 24;

module.exports = async (req, res) => {
  // Weryfikacja że wywołanie faktycznie pochodzi od Vercel Cron,
  // nie od kogoś kto zgadł adres endpointu.
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {
    captured: 0,
    captureFailed: 0,
    autoCompleted: 0
  };

  try {
    // ------------------------------------------------------------
    // Krok 1 — pobierz płatności za rezerwacje, których termin
    // zaczyna się w ciągu najbliższych 24h i które są wciąż
    // 'confirmed' (czyli nie anulowane, nie już rozliczone).
    // ------------------------------------------------------------
    const captureWindowEnd = new Date(Date.now() + CAPTURE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: dueBookings, error: fetchError } = await supabase
      .from('bookings')
      .select('id, specialist_availability!inner(slot_start)')
      .eq('status', 'confirmed')
      .lt('specialist_availability.slot_start', captureWindowEnd);

    if (fetchError) {
      console.error('cron-settlement: błąd pobierania rezerwacji do capture:', fetchError);
    } else {
      for (const booking of dueBookings || []) {
        const result = await captureBookingPayment(booking.id);
        if (result.ok) {
          results.captured++;
        } else {
          results.captureFailed++;
          console.error(`cron-settlement: capture nieudany dla booking ${booking.id}:`, result.error);
        }
      }
    }

    // ------------------------------------------------------------
    // Krok 2 — automatycznie domknij rezerwacje, których termin
    // minął ponad 48h temu, a specjalista nie potwierdził wizyty.
    // ------------------------------------------------------------
    const finalizeResult = await finalizeCompletedBookings();
    results.autoCompleted = finalizeResult.processedCount || 0;

    console.log('cron-settlement zakończony:', results);
    return res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('cron-settlement error:', e);
    return res.status(500).json({ ok: false, error: 'Błąd wykonania schedulera.', results });
  }
};
