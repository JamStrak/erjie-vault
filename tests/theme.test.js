import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, THEME_STORAGE_KEY, normalizeTheme, readTheme, saveTheme } from '../theme.js';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('new and unknown skin settings use the auspicious jade default', () => {
  assert.equal(DEFAULT_THEME, 'jade');
  assert.equal(readTheme(fakeStorage()), 'jade');
  assert.equal(readTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'unknown' })), 'jade');
  assert.equal(normalizeTheme(null), 'jade');
});

test('berry remains selectable and the choice persists on this device', () => {
  const storage = fakeStorage();
  assert.equal(saveTheme(storage, 'berry'), 'berry');
  assert.equal(readTheme(storage), 'berry');
  assert.equal(saveTheme(storage, 'jade'), 'jade');
  assert.equal(readTheme(storage), 'jade');
});

test('skin read failure cannot stop the ledger from opening', () => {
  assert.equal(readTheme({ getItem() { throw new Error('storage unavailable'); } }), 'jade');
  assert.throws(() => saveTheme({ setItem() { throw new Error('storage unavailable'); } }, 'berry'), /storage unavailable/);
});
