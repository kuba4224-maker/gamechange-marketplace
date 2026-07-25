// ============================================================
// GAMECHANGE MARKETPLACE — /api/create-availability-slot.js
// ============================================================
// Tworzy nowy, pojedynczy slot terminu dla specjalisty. RLS w
// bazie już pilnuje że specjalista tworzy TYLKO własne sloty
// (marketplace_02_bookings.sql, polityka "Specialists insert
// own availability") — ten endpoint dodaje tylko czytelniejszą
// walidację przed wysłaniem żądania do bazy.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { specialistId, slotStart, slotEnd, sessionType, priceCents, accessToken } = req.body;

  if (!specialistId || !slotStart || !slotEnd || priceCents == null) {
    return res.status(400).json({ error: 'Brak wymaganych danych slotu.' });
  }
  if (new Date(slotEnd) <= new Date(slotStart)) {
    return res.status(400).json({ error: 'Koniec terminu musi być po jego początku.' });
  }
  if (!['in_person', 'online'].includes(sessionType)) {
    return res.status(400).json({ error: 'Nieprawidłowy typ sesji.' });
  }
  if (priceCents <= 0) {
    return res.status(400).json({ error: 'Cena musi być większa od zera.' });
  }

  // WAŻNE: używamy klucza anon + accessToken specjalisty (nie
  // service_role) — dzięki temu RLS faktycznie weryfikuje że to
  // ten konkretny, zalogowany specjalista tworzy slot dla SIEBIE,
  // zgodnie z polityką w bazie. Gdybyśmy użyli service_role tutaj,
  // ominęlibyśmy tę ochronę i musielibyśmy ręcznie sprawdzać
  // uprawnienia w kodzie zamiast polegać na już istniejącym RLS.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  try {
    const { data, error } = await supabase
      .from('specialist_availability')
      .insert({
        specialist_id: specialistId,
        slot_start: slotStart,
        slot_end: slotEnd,
        session_type: sessionType,
        price_cents: priceCents
      })
      .select()
      .single();

    if (error) {
      console.error('create-availability-slot error:', error);
      return res.status(400).json({ error: 'Nie udało się utworzyć terminu. Sprawdź czy masz uprawnienia do tego profilu.' });
    }

    return res.status(200).json({ slot: data });
  } catch (e) {
    console.error('create-availability-slot exception:', e);
    return res.status(500).json({ error: 'Coś poszło nie tak. Spróbuj ponownie.' });
  }
};
