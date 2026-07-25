// ============================================================
// GAMECHANGE MARKETPLACE — /api/stripe-webhook.js
// ============================================================
// Vercel Serverless Function. Odbiera zdarzenia od Stripe i
// aktualizuje status rezerwacji w bazie. To jest JEDYNE miejsce,
// które powinno przesuwać booking ze statusu 'pending_payment' na
// 'confirmed' — nigdy nie robimy tego bezpośrednio z frontendu,
// bo frontend nie ma pewności czy autoryzacja karty faktycznie
// się powiodła (to wie tylko Stripe).
//
// WAŻNE: Vercel wymaga wyłączenia domyślnego bodyParser dla tego
// route'a, żeby móc zweryfikować podpis webhooka na surowym body
// (Stripe wymaga dokładnie oryginalnych bajtów requestu, nie
// sparsowanego JSON-a — inaczej weryfikacja podpisu zawsze zawiedzie).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const getRawBody = require('raw-body');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const config = {
  api: {
    bodyParser: false
  }
};

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).json({ error: 'Nieprawidłowy podpis webhooka.' });
  }

  try {
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': {
        // Karta autoryzowana pomyślnie (środki zablokowane, jeszcze
        // nie pobrane) — to jest sygnał że rezerwacja może przejść
        // w status 'confirmed'.
        const pi = event.data.object;
        await supabase
          .from('bookings')
          .update({ status: 'confirmed' })
          .eq('stripe_payment_intent_id', pi.id)
          .eq('status', 'pending_payment');
        // Warunek .eq('status', 'pending_payment') chroni przed
        // przypadkowym cofnięciem stanu, gdyby ten sam event
        // dotarł więcej niż raz (Stripe może wysyłać duplikaty —
        // webhooki MUSZĄ być idempotentne).
        break;
      }

      case 'payment_intent.payment_failed': {
        // Autoryzacja się nie powiodła (np. karta odrzucona) —
        // rezerwacja wraca do stanu, w którym zawodnik może
        // spróbować ponownie albo wybrać inny termin. Slot NIE
        // jest oznaczany jako zajęty (trigger mark_slot_booked
        // reaguje tylko na status='confirmed', więc pending_payment
        // nigdy go nie zablokował).
        const pi = event.data.object;
        await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .eq('stripe_payment_intent_id', pi.id)
          .eq('status', 'pending_payment');
        break;
      }

      case 'payment_intent.canceled': {
        // Autoryzacja anulowana (np. przez nas w create-booking.js
        // jeśli zapis do bazy się nie udał, albo przez zawodnika).
        const pi = event.data.object;
        await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .eq('stripe_payment_intent_id', pi.id)
          .in('status', ['pending_payment', 'confirmed']);
        break;
      }

      default:
        // Inne typy zdarzeń (np. dotyczące samego onboardingu Connect)
        // świadomie ignorowane na tym etapie — nie każdy webhook
        // Stripe wymaga akcji po naszej stronie.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe-webhook processing error:', e);
    // Zwracamy 500, żeby Stripe spróbował dostarczyć webhook
    // ponownie (Stripe automatycznie ponawia nieudane dostawy).
    return res.status(500).json({ error: 'Błąd przetwarzania webhooka.' });
  }
};

module.exports = handler;
module.exports.config = config;
