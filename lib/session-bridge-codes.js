// ============================================================
// GAMECHANGE MARKETPLACE — lib/session-bridge-codes.js
// ============================================================
// Zbudowane 03.08.2026 — most sesji Asystent -> Marketplace
// (KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcja 1.1).
//
// Czyste funkcje decyzyjne, bez sieci/Supabase — wywoływane z
// api/exchange-bridge-code.js, testowane niezależnie od bazy.
// ============================================================

const BRIDGE_CODE_TTL_MINUTES = 2;

// Czy kod jest jeszcze możliwy do wymiany: nie użyty wcześniej I nie
// wygasł. Osobna funkcja (nie inline w endpointzie), żeby dokładnie ta
// reguła bezpieczeństwa miała test jednostkowy, niezależny od tego, czy
// zapytanie do bazy poszło dobrze.
function isBridgeCodeUsable({ usedAt, expiresAt, nowIso }) {
  if (usedAt) return false;
  if (!expiresAt) return false;
  return new Date(nowIso).getTime() < new Date(expiresAt).getTime();
}

// Payload dla POST .../session_bridge_codes wykonywanego przez
// gamechange-app (JWT zawodnika, RLS: user_id = auth.uid()). Trzymane
// tu też (nie tylko w asystent_app.html) wyłącznie jako udokumentowany,
// testowalny wzorzec — asystent_app.html i tak musi mieć własną kopię
// w czystym JS przeglądarki (brak kroku budowania), dokładnie ten sam
// zaakceptowany wzorzec co reszta duplikacji w tym projekcie.
function buildBridgeCodeInsert({ code, userId }) {
  if (!code) throw new Error('code jest wymagany.');
  if (!userId) throw new Error('userId jest wymagany.');
  return { code, user_id: userId };
}

module.exports = {
  BRIDGE_CODE_TTL_MINUTES,
  isBridgeCodeUsable,
  buildBridgeCodeInsert,
};
