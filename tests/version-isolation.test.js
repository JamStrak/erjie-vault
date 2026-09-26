import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { THEME_STORAGE_KEY, readTheme, saveTheme } from '../theme.js';

test('activating the multi-partner worker removes only its outdated caches and preserves the stable app', async () => {
  const stableCache = 'erjie-vault-static-v12';
  const oldMultiCache = 'erjie-vault-multi-static-old';
  const unrelatedCache = 'another-app-static-v1';
  const cacheNames = new Set([stableCache, oldMultiCache, unrelatedCache]);
  const deleted = [];
  const opened = [];
  const listeners = new Map();
  let claimed = false;
  const context = {
    self: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      skipWaiting() {},
      clients: { claim() { claimed = true; } },
    },
    caches: {
      async open(name) {
        opened.push(name);
        cacheNames.add(name);
        return { async addAll() {} };
      },
      async keys() { return [...cacheNames]; },
      async delete(name) {
        deleted.push(name);
        return cacheNames.delete(name);
      },
    },
  };
  runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), context);
  const dispatch = async name => {
    const pending = [];
    assert.equal(typeof listeners.get(name), 'function');
    listeners.get(name)({ waitUntil(promise) { pending.push(promise); } });
    assert.ok(pending.length > 0, `${name} should await its cache work`);
    await Promise.all(pending);
  };

  await dispatch('install');
  assert.equal(opened.length, 1);
  const currentMultiCache = opened[0];
  assert.match(currentMultiCache, /^erjie-vault-multi-static-/);
  assert.notEqual(currentMultiCache, oldMultiCache);

  await dispatch('activate');
  assert.deepEqual(deleted, [oldMultiCache]);
  assert.deepEqual([...cacheNames].sort(), [stableCache, unrelatedCache, currentMultiCache].sort());
  assert.equal(claimed, true);
});

test('multi-partner theme starts independently and never reads or overwrites the stable theme', () => {
  const stableThemeKey = 'erjie-vault-theme-v1';
  const values = new Map([[stableThemeKey, 'berry']]);
  const reads = [];
  const writes = [];
  const storage = {
    getItem(key) {
      reads.push(key);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push(key);
      values.set(key, value);
    },
  };

  assert.notEqual(THEME_STORAGE_KEY, stableThemeKey);
  assert.equal(readTheme(storage), 'jade');
  saveTheme(storage, 'berry');
  assert.equal(readTheme(storage), 'berry');
  saveTheme(storage, 'jade');
  assert.equal(readTheme(storage), 'jade');
  assert.deepEqual(reads, [THEME_STORAGE_KEY, THEME_STORAGE_KEY, THEME_STORAGE_KEY]);
  assert.deepEqual(writes, [THEME_STORAGE_KEY, THEME_STORAGE_KEY]);
  assert.equal(values.get(stableThemeKey), 'berry');
  assert.equal(values.get(THEME_STORAGE_KEY), 'jade');
});
