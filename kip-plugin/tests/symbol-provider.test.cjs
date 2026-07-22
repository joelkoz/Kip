const test = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  resolveSymbolProviderConfig,
  symbolProviderEnabled,
  buildSymbolCollection,
  createSymbolProviderMethods
} = require('../../plugin/symbol-provider.js');

const BASE = '/@mxtommy/kip/assets/svg';
const TS = '2026-01-01T00:00:00.000Z';
const TEST_DATA_DIR = resolve('.tmp-kip-symbol-test-data');

const cfg = (symbolProvider) => resolveSymbolProviderConfig(symbolProvider ? { symbolProvider } : undefined);
const urlOf = (collection, alias) =>
  Object.values(collection).find((s) => s.alias.includes(alias)).url;

// --- config resolution -------------------------------------------------------

test('resolveSymbolProviderConfig defaults to all-off', () => {
  assert.deepEqual(cfg(), {
    aisSymbols: false,
    aisActiveSource: 'none',
    aisSpecialSource: 'none',
    aisInactiveSource: 'none',
    atonStyle: 'none',
    vesselScale: 1.0,
    atonScale: 1.0
  });
});

test('resolveSymbolProviderConfig reads the nested symbolProvider block', () => {
  const c = cfg({ aisSymbols: true, atonStyle: 'fixed', aisActiveSource: 'sailing' });
  assert.equal(c.aisSymbols, true);
  assert.equal(c.atonStyle, 'fixed');
  assert.equal(c.aisActiveSource, 'sailing');
});

test('resolveSymbolProviderConfig rejects invalid enum values (falls back to none)', () => {
  const c = cfg({ atonStyle: 'bogus', aisActiveSource: 'nope', aisSymbols: 'yes' });
  assert.equal(c.atonStyle, 'none');
  assert.equal(c.aisActiveSource, 'none');
  assert.equal(c.aisSymbols, false); // only boolean true enables
});

test('symbolProviderEnabled is true when any category is active', () => {
  assert.equal(symbolProviderEnabled(cfg()), false);
  assert.equal(symbolProviderEnabled(cfg({ aisSymbols: true })), true);
  assert.equal(symbolProviderEnabled(cfg({ atonStyle: 'floating' })), true);
  assert.equal(symbolProviderEnabled(cfg({ aisInactiveSource: 'unknown' })), true);
});

// --- collection building -----------------------------------------------------

test('buildSymbolCollection is empty when nothing is enabled', () => {
  assert.deepEqual(buildSymbolCollection(cfg(), BASE, TS), {});
});

test('aisSymbols yields the 7 clean 1:1 overrides with fsk aliases and public urls', () => {
  const coll = buildSymbolCollection(cfg({ aisSymbols: true }), BASE, TS);
  const aliases = Object.values(coll).flatMap((s) => s.alias).sort();
  assert.deepEqual(aliases, [
    'fsk:ais_buddy',
    'fsk:ais_cargo',
    'fsk:ais_highspeed',
    'fsk:ais_other',
    'fsk:ais_passenger',
    'fsk:ais_tanker',
    'fsk:vessel-self'
  ]);
  const cargo = Object.values(coll).find((s) => s.alias.includes('fsk:ais_cargo'));
  assert.equal(cargo.url, `${BASE}/vessel/cargo.svg`);
  assert.equal(cargo.mediaType, 'image/svg+xml');
  assert.equal(cargo.$source, 'kip');
  assert.equal(cargo.timestamp, TS);
  assert.deepEqual(cargo.roles, ['map-marker']);
  assert.deepEqual(cargo.anchor, [12, 12]); // vessels anchor at centre
  assert.equal(cargo.scale, 1.35); // scaled to match Freeboard's ~32px AIS icons
});

test('the AIS coarse-bucket dropdowns each add exactly one symbol', () => {
  const coll = buildSymbolCollection(
    cfg({ aisActiveSource: 'sailing', aisSpecialSource: 'tug', aisInactiveSource: 'stationary' }),
    BASE,
    TS
  );
  assert.equal(Object.keys(coll).length, 3);
  assert.equal(urlOf(coll, 'fsk:ais_active'), `${BASE}/vessel/sailing.svg`);
  assert.equal(urlOf(coll, 'fsk:ais_special'), `${BASE}/vessel/tug.svg`);
  assert.equal(urlOf(coll, 'fsk:ais_inactive'), `${BASE}/vessel/stationary.svg`);
});

test('atonStyle floating uses mark (buoy) files; fixed uses beacon files', () => {
  const floating = buildSymbolCollection(cfg({ atonStyle: 'floating' }), BASE, TS);
  const fixed = buildSymbolCollection(cfg({ atonStyle: 'fixed' }), BASE, TS);

  // 9 dual-form types (cardinal ×4, lateral ×2, danger/safe/special) + 2 single-form
  assert.equal(Object.keys(floating).length, 11);
  assert.equal(Object.keys(fixed).length, 11);

  assert.equal(urlOf(floating, 'fsk:real-north'), `${BASE}/AtoN/cardinal/north_mark.svg`);
  assert.equal(urlOf(fixed, 'fsk:real-north'), `${BASE}/AtoN/cardinal/north_beacon.svg`);
  // safe-water's fixed form keeps its real (trailing-underscore) filename
  assert.equal(urlOf(fixed, 'fsk:real-safe'), `${BASE}/AtoN/dangerSafe/safewater_beacon_.svg`);
  // single-form types are present regardless of style
  assert.equal(urlOf(floating, 'fsk:real-basestation'), `${BASE}/AtoN/other/basestation.svg`);
  assert.equal(urlOf(floating, 'fsk:real-aton'), `${BASE}/AtoN/other/aton.svg`);
  // no virtual-* ids are ever emitted (KIP has no synthetic-AtoN artwork)
  assert.ok(Object.values(floating).every((s) => s.alias.every((a) => !a.startsWith('fsk:virtual-'))));
  // atons anchor near their base; base scale sized up from Freeboard parity
  assert.deepEqual(Object.values(floating)[0].anchor, [12, 22]);
  assert.equal(Object.values(floating)[0].scale, 1.68);
});

test('user size multipliers scale the base vessel/aton sizes', () => {
  const coll = buildSymbolCollection(
    cfg({ aisSymbols: true, atonStyle: 'floating', vesselScale: 2, atonScale: 0.5 }),
    BASE,
    TS
  );
  const cargo = Object.values(coll).find((s) => s.alias.includes('fsk:ais_cargo'));
  const north = Object.values(coll).find((s) => s.alias.includes('fsk:real-north'));
  assert.equal(cargo.scale, 1.35 * 2); // base 1.35 × user 2
  assert.equal(north.scale, 1.68 * 0.5); // base 1.68 × user 0.5
});

test('invalid or non-positive size multipliers fall back to 1.0', () => {
  const coll = buildSymbolCollection(
    cfg({ aisSymbols: true, vesselScale: -3, atonScale: 'big' }),
    BASE,
    TS
  );
  const cargo = Object.values(coll).find((s) => s.alias.includes('fsk:ais_cargo'));
  assert.equal(cargo.scale, 1.35); // base × 1.0
});

test('symbol uuid is stable and deterministic per fsk id', () => {
  const a = buildSymbolCollection(cfg({ aisSymbols: true }), BASE, TS);
  const b = buildSymbolCollection(cfg({ aisSymbols: true }), 'https://elsewhere', 'different-ts');
  const uuidA = Object.values(a).find((s) => s.alias.includes('fsk:ais_cargo')).uuid;
  const uuidB = Object.values(b).find((s) => s.alias.includes('fsk:ais_cargo')).uuid;
  assert.equal(uuidA, uuidB);
  assert.match(uuidA, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

// --- provider methods --------------------------------------------------------

test('provider methods list, resolve by uuid/alias/bare-id, and reject writes', async () => {
  const config = cfg({ aisSymbols: true });
  const methods = createSymbolProviderMethods(() => buildSymbolCollection(config, BASE, TS));

  const coll = await methods.listResources({});
  assert.equal(Object.keys(coll).length, 7);

  const cargo = Object.values(coll).find((s) => s.alias.includes('fsk:ais_cargo'));
  assert.equal((await methods.getResource(cargo.uuid)).uuid, cargo.uuid);
  assert.equal((await methods.getResource('fsk:ais_cargo')).uuid, cargo.uuid);
  assert.equal((await methods.getResource('ais_cargo')).uuid, cargo.uuid);

  await assert.rejects(() => methods.getResource('does-not-exist'), /not found/i);
  await assert.rejects(() => methods.setResource('x', {}), /read-only/i);
  await assert.rejects(() => methods.deleteResource('x'), /read-only/i);
});

test('provider listResources reflects live config through the getter', async () => {
  let config = cfg();
  const methods = createSymbolProviderMethods(() => buildSymbolCollection(config, BASE, TS));
  assert.equal(Object.keys(await methods.listResources({})).length, 0);
  config = cfg({ aisSymbols: true });
  assert.equal(Object.keys(await methods.listResources({})).length, 7);
});

// --- plugin registration (integration) ---------------------------------------

function createSymbolServerMock(captured) {
  return {
    selfId: 'urn:mrn:signalk:uuid:symbol-test',
    debug() {},
    error() {},
    setPluginStatus() {},
    setPluginError() {},
    getDataDirPath() {
      return TEST_DATA_DIR;
    },
    registerPutHandler() {},
    registerResourceProvider(provider) {
      captured.push(provider);
    }
  };
}

async function withSqliteDisabled(fn) {
  const pluginModule = require('../../plugin/index.js');
  const original = pluginModule.getSqliteModule;
  pluginModule.getSqliteModule = async () => null; // force sqlite-unavailable → light start()
  try {
    await fn(pluginModule);
  } finally {
    pluginModule.getSqliteModule = original;
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

test('plugin registers a read-only symbols provider when a category is enabled', async () => {
  await withSqliteDisabled(async (start) => {
    const captured = [];
    const server = createSymbolServerMock(captured);
    const plugin = start(server);
    await plugin.start({ symbolProvider: { aisSymbols: true } });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'symbols');
    const coll = await captured[0].methods.listResources({});
    assert.ok(Object.values(coll).some((s) => s.alias.includes('fsk:ais_cargo')));
    await assert.rejects(() => captured[0].methods.setResource('x', {}), /read-only/i);

    plugin.stop();
  });
});

test('plugin does not register a symbols provider when all categories are off', async () => {
  await withSqliteDisabled(async (start) => {
    const captured = [];
    const server = createSymbolServerMock(captured);
    const plugin = start(server);
    await plugin.start({});

    assert.equal(captured.length, 0);

    plugin.stop();
  });
});
