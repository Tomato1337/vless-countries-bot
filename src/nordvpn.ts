import type { JsonObject, NordVpnSource, XrayOutbound } from "./types.ts";

const COUNTRIES_URL = "https://api.nordvpn.com/v1/countries";
const SERVERS_URL = "https://api.nordvpn.com/v2/servers";
const NORDLYNX_TECHNOLOGY_ID = 35;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_SIZE = 10 << 20;

export interface NordVpnCountry {
  id: number;
  code: string;
  name: string;
}

export interface NordVpnCity {
  id: number;
  name: string;
}

export interface NordVpnServer {
  id: number;
  name: string;
  hostname: string;
  station: string;
  load: number;
  publicKey: string;
  cityId: number;
  cityName: string;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class NordVpnCatalog {
  private countries?: CacheEntry<NordVpnCountry[]>;
  private readonly servers = new Map<number, CacheEntry<NordVpnServer[]>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  async listCountries(force = false): Promise<NordVpnCountry[]> {
    if (!force && this.countries && this.countries.expiresAt > Date.now()) {
      return structuredClone(this.countries.value);
    }
    const value = parseCountries(await this.fetchJson(COUNTRIES_URL));
    this.countries = { expiresAt: Date.now() + this.cacheTtlMs, value };
    return structuredClone(value);
  }

  async listServers(countryId: number, force = false): Promise<NordVpnServer[]> {
    const cached = this.servers.get(countryId);
    if (!force && cached && cached.expiresAt > Date.now()) {
      return structuredClone(cached.value);
    }
    const url = new URL(SERVERS_URL);
    url.searchParams.set("limit", "0");
    url.searchParams.set("filters[servers_technologies][id]", String(NORDLYNX_TECHNOLOGY_ID));
    url.searchParams.set("filters[country_id]", String(countryId));
    const value = parseServers(await this.fetchJson(url.toString()));
    this.servers.set(countryId, { expiresAt: Date.now() + this.cacheTtlMs, value });
    return structuredClone(value);
  }

  async listCities(countryId: number, force = false): Promise<NordVpnCity[]> {
    const servers = await this.listServers(countryId, force);
    const cities = new Map<number, NordVpnCity>();
    for (const server of servers) {
      cities.set(server.cityId, { id: server.cityId, name: server.cityName });
    }
    return [...cities.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`NordVPN API returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      throw new Error("NordVPN API response is too large");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("NordVPN API returned invalid JSON");
    }
  }
}

export function assertNordVpnPrivateKey(value: string | undefined): string {
  if (!value) {
    throw new Error("NORDVPN_PRIVATE_KEY is not configured");
  }
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    throw new Error("NORDVPN_PRIVATE_KEY must be a base64 WireGuard private key");
  }
  if (decoded.length !== 32 || Buffer.from(decoded).toString("base64") !== value) {
    throw new Error("NORDVPN_PRIVATE_KEY must decode to exactly 32 bytes");
  }
  return value;
}

export function buildNordVpnSource(
  country: NordVpnCountry,
  city: NordVpnCity,
  server: NordVpnServer,
): NordVpnSource {
  return {
    countryId: country.id,
    countryCode: country.code.toUpperCase(),
    countryName: country.name,
    cityId: city.id,
    cityName: city.name,
    serverId: server.id,
    serverName: server.name,
    hostname: server.hostname,
    station: server.station,
    load: server.load,
    publicKey: server.publicKey,
  };
}

export function buildNordVpnOutbound(
  slug: string,
  source: NordVpnSource,
  privateKey: string,
  geOutboundTag: string,
): XrayOutbound {
  return {
    tag: nordVpnOutboundTag(slug),
    protocol: "wireguard",
    settings: {
      secretKey: assertNordVpnPrivateKey(privateKey),
      address: ["10.5.0.2/32"],
      peers: [{
        publicKey: source.publicKey,
        endpoint: `${source.station}:51820`,
      }],
      mtu: 1280,
      noKernelTun: true,
    },
    proxySettings: {
      tag: geOutboundTag,
      transportLayer: true,
    },
  };
}

export function nordVpnOutboundTag(slug: string): string {
  return `countries-nord-exit-${slug}`;
}

export function nordVpnRegionSlug(countryCode: string, cityName: string, cityId?: number): string {
  const country = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) {
    throw new Error(`Invalid NordVPN country code: ${countryCode}`);
  }
  const city = cityName.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!city) {
    throw new Error(`NordVPN city cannot be normalized to a slug: ${JSON.stringify(cityName)}`);
  }
  return `${country}-${city}${cityId === undefined ? "" : `-${cityId}`}`;
}

function parseCountries(value: unknown): NordVpnCountry[] {
  if (!Array.isArray(value)) {
    throw new Error("NordVPN countries response is invalid");
  }
  return value.map((item) => {
    const country = asObject(item);
    const id = asPositiveInteger(country.id, "country.id");
    const code = asString(country.code, "country.code").toUpperCase();
    const name = asString(country.name, "country.name");
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error(`NordVPN country code is invalid: ${code}`);
    }
    return { id, code, name };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function parseServers(value: unknown): NordVpnServer[] {
  const root = asObject(value);
  if (!Array.isArray(root.locations) || !Array.isArray(root.servers)) {
    throw new Error("NordVPN servers response is invalid");
  }
  const cities = new Map<number, NordVpnCity>();
  for (const item of root.locations) {
    try {
      const location = asObject(item);
      const locationId = asPositiveInteger(location.id, "location.id");
      const country = asObject(location.country);
      const city = asObject(country.city);
      cities.set(locationId, {
        id: asPositiveInteger(city.id, "city.id"),
        name: asString(city.name, "city.name"),
      });
    } catch {
      // One malformed location must not hide otherwise usable NordVPN servers.
    }
  }

  const servers: NordVpnServer[] = [];
  for (const item of root.servers) {
    const server = asObject(item);
    const city = findServerCity(server.location_ids, cities);
    const publicKey = findNordLynxPublicKey(server.technologies);
    const station = typeof server.station === "string" ? server.station.trim() : "";
    if (!city || !publicKey || !station) {
      continue;
    }
    servers.push({
      id: asPositiveInteger(server.id, "server.id"),
      name: asString(server.name, "server.name"),
      hostname: asString(server.hostname, "server.hostname"),
      station,
      load: asNonNegativeNumber(server.load, "server.load"),
      publicKey,
      cityId: city.id,
      cityName: city.name,
    });
  }
  return servers.sort((a, b) => a.load - b.load || a.hostname.localeCompare(b.hostname));
}

function findServerCity(value: unknown, cities: Map<number, NordVpnCity>): NordVpnCity | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const city = cities.get(Number(item));
    if (city) {
      return city;
    }
  }
  return undefined;
}

function findNordLynxPublicKey(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const technology = asObject(item);
    if (Number(technology.id) !== NORDLYNX_TECHNOLOGY_ID || !Array.isArray(technology.metadata)) {
      continue;
    }
    for (const metadataValue of technology.metadata) {
      const metadata = asObject(metadataValue);
      if (metadata.name === "public_key" && typeof metadata.value === "string" && metadata.value.trim()) {
        return metadata.value.trim();
      }
    }
  }
  return undefined;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NordVPN API response contains an invalid object");
  }
  return value as JsonObject;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`NordVPN API response is missing ${field}`);
  }
  return value.trim();
}

function asPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`NordVPN API response contains invalid ${field}`);
  }
  return parsed;
}

function asNonNegativeNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`NordVPN API response contains invalid ${field}`);
  }
  return parsed;
}
