// ============================================================
// GAMECHANGE MARKETPLACE — /api/mark-booking-completed.js
// ============================================================
// Cienki wrapper HTTP wokół markBookingCompleted z
// api_process_booking_settlement.js. Ta funkcja tam żyje jako
// eksport modułu (myślana pod scheduler), ale panel specjalisty
// w przeglądarce potrzebuje zwykłego endpointu POST do wywołania
// jej po kliknięciu przycisku "Potwierdź odbytą wizytę".
// ============================================================

const { markBookingCompleted } = require('./process-booking-settlement');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { bookingId, specialistUserId } = req.body;
  if (!bookingId || !specialistUserId) {
    return res.status(400).json({ error: 'Brak wymaganych danych.' });
  }

  const result = await markBookingCompleted(bookingId, specialistUserId);

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  return res.status(200).json({ ok: true });
};
