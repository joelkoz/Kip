// Signal K `symbols` resource provider for KIP.
//
// Exposes KIP's curated AIS-radar icon set (vessels + Aids to Navigation) as a
// read-only `symbols` resource so a compatible chart plotter — Freeboard-SK is
// the reference consumer — can render them in place of its own built-in icons.
//
// A symbol carries an `fsk:<built-in-id>` alias; Freeboard adopts its own vendor
// namespace, so a symbol aliased `fsk:ais_cargo` overrides Freeboard's built-in
// `ais_cargo` icon globally. See the Symbols API and Freeboard's symbol-support
// docs for the alias/override contract.
//
// KIP is a single package that is BOTH the webapp and this server plugin, so the
// icon files already ship in `public/assets/svg/**` and are served publicly by
// the Signal K server at `/<package-name>/assets/svg/**` (outside the admin-gated
// `/plugins` path). The provider therefore only references those URLs — it copies
// nothing and serves no assets of its own.

import { createHash } from 'node:crypto';

/** Freeboard's vendor namespace: an `fsk:<id>` alias overrides that built-in. */
const FSK_NAMESPACE = 'fsk';

/** Plugin id used as the resource `$source`. */
const PROVIDER_SOURCE = 'kip';

/**
 * A Signal K `symbols` resource entry (the subset KIP emits). Matches the
 * host-agnostic Symbols API shape consumed by Freeboard-SK.
 */
export interface SymbolResource {
  uuid: string;
  alias: string[];
  name: string;
  mediaType: 'image/svg+xml';
  url: string;
  roles: string[];
  scale: number;
  anchor: [number, number];
  $source: string;
  timestamp: string;
}

/** Resolved KIP symbol-provider settings (see the plugin config schema). */
export interface SymbolProviderConfig {
  /** Provide the unambiguous 1:1 AIS vessel overrides (cargo, tanker, …). */
  aisSymbols: boolean;
  /** Stand-in for Freeboard's coarse `ais_active` bucket (AIS types 10–39). */
  aisActiveSource: string;
  /** Stand-in for Freeboard's coarse `ais_special` bucket (AIS types 50–59). */
  aisSpecialSource: string;
  /** Stand-in for Freeboard's `ais_inactive` (lost/stale target) marker. */
  aisInactiveSource: string;
  /** AtoN visual form: `none` | `floating` (buoys) | `fixed` (beacons). */
  atonStyle: string;
  /** User size multiplier for AIS vessel symbols (1.0 = default size). */
  vesselScale: number;
  /** User size multiplier for AtoN symbols (1.0 = default size). */
  atonScale: number;
}

/** The `ResourceProviderMethods` subset a symbols provider implements. */
export interface SymbolProviderMethods {
  listResources: (query: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getResource: (id: string, property?: string) => Promise<object>;
  setResource: (id: string, value: Record<string, unknown>) => Promise<void>;
  deleteResource: (id: string) => Promise<void>;
}

interface Candidate {
  /** The Freeboard built-in id this symbol overrides (the `fsk:` alias id). */
  id: string;
  name: string;
  /** Path under `assets/svg/`, e.g. `vessel/cargo.svg`. */
  file: string;
  kind: 'vessel' | 'aton';
}

// --- Clean 1:1 AIS overrides -------------------------------------------------
// Each maps one KIP icon to exactly one Freeboard AIS id. Enabled together by
// the `aisSymbols` master toggle. `vessel-self` is the OWN vessel (not the
// focused AIS target `ais_self`, which KIP has no distinct icon for).
const AIS_CORE: Candidate[] = [
  { id: 'ais_cargo', name: 'Cargo Vessel', file: 'vessel/cargo.svg', kind: 'vessel' },
  { id: 'ais_tanker', name: 'Tanker', file: 'vessel/tanker.svg', kind: 'vessel' },
  { id: 'ais_passenger', name: 'Passenger Vessel', file: 'vessel/passenger.svg', kind: 'vessel' },
  { id: 'ais_highspeed', name: 'High-Speed Craft', file: 'vessel/highspeed.svg', kind: 'vessel' },
  { id: 'ais_other', name: 'Other Vessel', file: 'vessel/other.svg', kind: 'vessel' },
  { id: 'ais_buddy', name: 'Buddy Vessel', file: 'vessel/buddy.svg', kind: 'vessel' },
  { id: 'vessel-self', name: 'Own Vessel', file: 'vessel/self.svg', kind: 'vessel' }
];

// --- Coarse AIS buckets (user-selectable stand-ins) --------------------------
// Freeboard collapses whole ranges of AIS ship types into a single icon
// (`ais_active` = types 10–39, `ais_special` = 50–59). KIP has finer icons than
// Freeboard can distinguish, so the user picks which one represents each bucket.
// Key = config enum value.
const AIS_ACTIVE_SOURCES: Record<string, Candidate> = {
  sailing: { id: 'ais_active', name: 'Sailing (active vessel)', file: 'vessel/sailing.svg', kind: 'vessel' },
  pleasurecraft: { id: 'ais_active', name: 'Pleasure Craft (active vessel)', file: 'vessel/pleasurecraft.svg', kind: 'vessel' },
  fishing: { id: 'ais_active', name: 'Fishing (active vessel)', file: 'vessel/fishing.svg', kind: 'vessel' },
  tug: { id: 'ais_active', name: 'Tug / Towing (active vessel)', file: 'vessel/tug.svg', kind: 'vessel' },
  military: { id: 'ais_active', name: 'Military (active vessel)', file: 'vessel/military-ops.svg', kind: 'vessel' },
  diving: { id: 'ais_active', name: 'Diving (active vessel)', file: 'vessel/diving-ops.svg', kind: 'vessel' }
};
const AIS_SPECIAL_SOURCES: Record<string, Candidate> = {
  pilot: { id: 'ais_special', name: 'Pilot Vessel', file: 'vessel/pilot.svg', kind: 'vessel' },
  tug: { id: 'ais_special', name: 'Tug', file: 'vessel/tug.svg', kind: 'vessel' },
  sar: { id: 'ais_special', name: 'Search & Rescue Vessel', file: 'vessel/sar.svg', kind: 'vessel' },
  law: { id: 'ais_special', name: 'Law Enforcement', file: 'vessel/law-enforcement.svg', kind: 'vessel' }
};
const AIS_INACTIVE_SOURCES: Record<string, Candidate> = {
  stationary: { id: 'ais_inactive', name: 'Stationary (inactive vessel)', file: 'vessel/stationary.svg', kind: 'vessel' },
  unknown: { id: 'ais_inactive', name: 'Unknown (inactive vessel)', file: 'vessel/unknown.svg', kind: 'vessel' }
};

// --- Aids to Navigation ------------------------------------------------------
// Freeboard's `real-*` vs `virtual-*` axis is physical-vs-AIS-synthetic. KIP's
// `mark` vs `beacon` axis is floating-buoy-vs-fixed-structure — BOTH are real.
// So KIP only ever fills `real-*` ids; `virtual-*` is left to Freeboard (KIP has
// no synthetic-AtoN artwork). Freeboard collapses floating (AIS codes 20–25) and
// fixed (codes 9–14) into the same `real-*` id, so the two KIP forms compete for
// one slot — the `atonStyle` setting picks which.
interface AtoNVariant {
  id: string;
  name: string;
  floating: string;
  fixed: string;
}
const ATON_VARIANTS: AtoNVariant[] = [
  { id: 'real-north', name: 'North Cardinal', floating: 'AtoN/cardinal/north_mark.svg', fixed: 'AtoN/cardinal/north_beacon.svg' },
  { id: 'real-east', name: 'East Cardinal', floating: 'AtoN/cardinal/east_mark.svg', fixed: 'AtoN/cardinal/east_beacon.svg' },
  { id: 'real-south', name: 'South Cardinal', floating: 'AtoN/cardinal/south_mark.svg', fixed: 'AtoN/cardinal/south_beacon.svg' },
  { id: 'real-west', name: 'West Cardinal', floating: 'AtoN/cardinal/west_mark.svg', fixed: 'AtoN/cardinal/west_beacon.svg' },
  { id: 'real-port', name: 'Port-hand Mark', floating: 'AtoN/lateral/port_mark.svg', fixed: 'AtoN/lateral/port_beacon.svg' },
  { id: 'real-starboard', name: 'Starboard-hand Mark', floating: 'AtoN/lateral/starboard_mark.svg', fixed: 'AtoN/lateral/starboard_beacon.svg' },
  { id: 'real-danger', name: 'Isolated Danger', floating: 'AtoN/dangerSafe/isolateddanger_mark.svg', fixed: 'AtoN/dangerSafe/isolateddanger_beacon.svg' },
  { id: 'real-safe', name: 'Safe Water', floating: 'AtoN/dangerSafe/safewater_mark.svg', fixed: 'AtoN/dangerSafe/safewater_beacon_.svg' },
  { id: 'real-special', name: 'Special Mark', floating: 'AtoN/special/special_mark.svg', fixed: 'AtoN/special/special_beacon.svg' }
];
// AtoN types with a single form — included whenever `atonStyle` is not `none`.
const ATON_SINGLE: Candidate[] = [
  { id: 'real-basestation', name: 'AIS Base Station', file: 'AtoN/other/basestation.svg', kind: 'aton' },
  { id: 'real-aton', name: 'Generic AtoN', file: 'AtoN/other/aton.svg', kind: 'aton' }
];

// Allowed config enum values (also the source of the schema `enum` lists).
export const AIS_ACTIVE_VALUES = ['none', ...Object.keys(AIS_ACTIVE_SOURCES)];
export const AIS_SPECIAL_VALUES = ['none', ...Object.keys(AIS_SPECIAL_SOURCES)];
export const AIS_INACTIVE_VALUES = ['none', ...Object.keys(AIS_INACTIVE_SOURCES)];
export const ATON_STYLE_VALUES = ['none', 'floating', 'fixed'];

// Placement defaults. KIP icons are 24×24; vessels point north and rotate to
// orientation about their centre, AtoNs sit at their base on the charted point.
// scale/anchor are advisory (the Symbols API lets a consumer ignore them); tune
// against a live plotter if needed.
const VESSEL_ANCHOR: [number, number] = [12, 12];
const ATON_ANCHOR: [number, number] = [12, 22];
// Base scales tuned so the default (user multiplier 1.0) reads well on-screen.
// Vessels ~32px match Freeboard's own AIS icons (24pt at scale 1.0 → 32/24 ≈
// 1.35). AtoNs are set larger than raw Freeboard parity — the thin marks read
// small otherwise — at 1.68 (Freeboard-parity 1.2, sized up ~40%). The user
// size multipliers (`vesselScale`/`atonScale`, default 1.0) are applied on top.
const BASE_VESSEL_SCALE = 1.35;
const BASE_ATON_SCALE = 1.68;

/**
 * Derive the public asset URL for an icon file. The webapp static mount serves
 * `public/assets/svg/**` at `<assetBase>` (`/<package-name>/assets/svg`).
 */
function svgUrl(assetBase: string, file: string): string {
  return `${assetBase.replace(/\/$/, '')}/${file}`;
}

/**
 * Stable, deterministic uuid derived from the Freeboard id, so consumer
 * references stay valid across restarts and versions.
 */
function uuidFor(id: string): string {
  const h = createHash('sha1').update(`kip-symbol:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function toResource(candidate: Candidate, assetBase: string, timestamp: string, scale: number): SymbolResource {
  return {
    uuid: uuidFor(candidate.id),
    alias: [`${FSK_NAMESPACE}:${candidate.id}`],
    name: candidate.name,
    mediaType: 'image/svg+xml',
    url: svgUrl(assetBase, candidate.file),
    roles: ['map-marker'],
    scale,
    anchor: candidate.kind === 'vessel' ? VESSEL_ANCHOR : ATON_ANCHOR,
    $source: PROVIDER_SOURCE,
    timestamp
  };
}

/**
 * Read the plugin settings into a validated `SymbolProviderConfig`. Unknown or
 * malformed values fall back to the safe default (`none` / off).
 */
export function resolveSymbolProviderConfig(settings: unknown): SymbolProviderConfig {
  const root = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const sp = (root.symbolProvider && typeof root.symbolProvider === 'object'
    ? root.symbolProvider
    : {}) as Record<string, unknown>;

  const oneOf = (value: unknown, allowed: string[]): string =>
    typeof value === 'string' && allowed.includes(value) ? value : 'none';
  const positive = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1.0;

  return {
    aisSymbols: sp.aisSymbols === true,
    aisActiveSource: oneOf(sp.aisActiveSource, AIS_ACTIVE_VALUES),
    aisSpecialSource: oneOf(sp.aisSpecialSource, AIS_SPECIAL_VALUES),
    aisInactiveSource: oneOf(sp.aisInactiveSource, AIS_INACTIVE_VALUES),
    atonStyle: oneOf(sp.atonStyle, ATON_STYLE_VALUES),
    vesselScale: positive(sp.vesselScale),
    atonScale: positive(sp.atonScale)
  };
}

/** True when at least one symbol category is enabled. */
export function symbolProviderEnabled(config: SymbolProviderConfig): boolean {
  return (
    config.aisSymbols ||
    config.aisActiveSource !== 'none' ||
    config.aisSpecialSource !== 'none' ||
    config.aisInactiveSource !== 'none' ||
    config.atonStyle !== 'none'
  );
}

/**
 * Build the `symbols` collection (keyed by uuid) for the given config, selecting
 * only the categories the user enabled.
 */
export function buildSymbolCollection(
  config: SymbolProviderConfig,
  assetBase: string,
  timestamp: string
): Record<string, SymbolResource> {
  const collection: Record<string, SymbolResource> = {};
  const vesselScale = BASE_VESSEL_SCALE * config.vesselScale;
  const atonScale = BASE_ATON_SCALE * config.atonScale;
  const add = (candidate: Candidate): void => {
    const scale = candidate.kind === 'vessel' ? vesselScale : atonScale;
    const resource = toResource(candidate, assetBase, timestamp, scale);
    collection[resource.uuid] = resource;
  };

  if (config.aisSymbols) {
    AIS_CORE.forEach(add);
  }
  const active = AIS_ACTIVE_SOURCES[config.aisActiveSource];
  if (active) {
    add(active);
  }
  const special = AIS_SPECIAL_SOURCES[config.aisSpecialSource];
  if (special) {
    add(special);
  }
  const inactive = AIS_INACTIVE_SOURCES[config.aisInactiveSource];
  if (inactive) {
    add(inactive);
  }
  if (config.atonStyle === 'floating' || config.atonStyle === 'fixed') {
    const useFixed = config.atonStyle === 'fixed';
    ATON_VARIANTS.forEach((variant) =>
      add({
        id: variant.id,
        name: variant.name,
        file: useFixed ? variant.fixed : variant.floating,
        kind: 'aton'
      })
    );
    ATON_SINGLE.forEach(add);
  }

  return collection;
}

/**
 * Build the read-only `ResourceProviderMethods` for the symbols provider. The
 * collection is resolved lazily on every call so live config changes are
 * reflected without re-registering. Writes are rejected.
 */
export function createSymbolProviderMethods(
  getCollection: () => Record<string, SymbolResource>
): SymbolProviderMethods {
  const readOnly = (): Promise<never> =>
    Promise.reject(new Error('KIP symbols are read-only'));

  return {
    listResources: async () => getCollection(),
    getResource: async (id: string) => {
      const collection = getCollection();
      if (collection[id]) {
        return collection[id];
      }
      // Match a qualified alias (`fsk:ais_cargo`) or a bare local id (`ais_cargo`).
      const matches = Object.values(collection).filter(
        (symbol) =>
          symbol.alias.includes(id) ||
          symbol.alias.some((alias) => alias.slice(alias.indexOf(':') + 1) === id)
      );
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        return Promise.reject(new Error(`Ambiguous symbol reference: ${id}`));
      }
      return Promise.reject(new Error(`Symbol not found: ${id}`));
    },
    setResource: readOnly,
    deleteResource: readOnly
  };
}
