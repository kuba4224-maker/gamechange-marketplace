// ============================================================
// test-session-bridge-codes.js — testy jednostkowe
// lib/session-bridge-codes.js
// ============================================================
// Uruchom: node tests/test-session-bridge-codes.js
// ============================================================
const assert = require('assert');
const { isBridgeCodeUsable, buildBridgeCodeInsert } = require('../lib/session-bridge-codes');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${label}`);
  } catch (e) {
    console.error(`  FAIL — ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const NOW = '2026-08-03T12:00:00.000Z';
const IN_1_MIN = '2026-08-03T12:01:00.000Z';
const AGO_1_MIN = '2026-08-03T11:59:00.000Z';

console.log('1. isBridgeCodeUsable — reguła jednorazowości + wygaśnięcia');

check('nieużyty, nie wygasł -> usable', () => {
  assert.strictEqual(isBridgeCodeUsable({ usedAt: null, expiresAt: IN_1_MIN, nowIso: NOW }), true);
});
check('już użyty (used_at ustawiony) -> NIE usable, nawet jeśli w oknie ważności', () => {
  assert.strictEqual(
    isBridgeCodeUsable({ usedAt: '2026-08-03T11:50:00.000Z', expiresAt: IN_1_MIN, nowIso: NOW }),
    false
  );
});
check('wygasł (expires_at w przeszłości) -> NIE usable', () => {
  assert.strictEqual(isBridgeCodeUsable({ usedAt: null, expiresAt: AGO_1_MIN, nowIso: NOW }), false);
});
check('brak expiresAt (np. błąd danych) -> NIE usable, nie zakładamy nieskończonej ważności', () => {
  assert.strictEqual(isBridgeCodeUsable({ usedAt: null, expiresAt: null, nowIso: NOW }), false);
});
check('dokładnie w momencie wygaśnięcia -> NIE usable (< nie <=)', () => {
  assert.strictEqual(isBridgeCodeUsable({ usedAt: null, expiresAt: NOW, nowIso: NOW }), false);
});

console.log('2. buildBridgeCodeInsert — payload POST (Asystent -> session_bridge_codes)');

check('poprawne dane -> poprawny payload, DOKŁADNIE 2 klucze', () => {
  const p = buildBridgeCodeInsert({ code: 'abc123', userId: 'user-1' });
  assert.deepStrictEqual(p, { code: 'abc123', user_id: 'user-1' });
});
check('brak code -> rzuca błąd', () => {
  assert.throws(() => buildBridgeCodeInsert({ userId: 'user-1' }));
});
check('brak userId -> rzuca błąd', () => {
  assert.throws(() => buildBridgeCodeInsert({ code: 'abc123' }));
});

if (process.exitCode) {
  console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
} else {
  console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
}
