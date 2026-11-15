import { URNETWORK_BEST_AVAILABLE } from "./types.ts";
import type { JsonObject, UrnetworkApi, UrnetworkCountry, UrnetworkLocation, UrnetworkUpstream } from "./types.ts";

export const URNETWORK_API_URL = "https://api.bringyour.com";
const COUNTRIES_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Operator API client: https://ur.io/docs/api, hosted proxies: https://ur.io/docs/hosted-proxies. */
export class HttpUrnetworkClient implements UrnetworkApi {
  private countries?: { value: UrnetworkCountry[]; expiresAt: number };

  constructor(
    private readonly baseUrl = URNETWORK_API_URL,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async listCountries(): Promise<UrnetworkCountry[]> {
    if (this.countries && this.countries.expiresAt > Date.now()) {
      return this.countries.value;
    }
    const body = await this.request("GET", "/network/provider-locations");
    const locations = Array.isArray(body.locations) ? body.locations as JsonObject[] : [];
    const value = locations
      .filter((location) => location.location_type === "country" && typeof location.country_code === "string")
      .map((location) => ({
        code: String(location.country_code).toLowerCase(),
        name: String(location.name ?? location.country ?? location.country_code),
        providerCount: Number(location.provider_count ?? 0),
      }))
      .sort((a, b) => b.providerCount - a.providerCount || a.name.localeCompare(b.name));
    this.countries = { value, expiresAt: Date.now() + COUNTRIES_TTL_MS };
    return value;
  }

  async createApiKey(authCode: string, name: string): Promise<string> {
    const login = await this.request("POST", "/auth/code-login", { body: { auth_code: authCode } });
    assertNoError(login, "URnetwork auth code login");
    if (typeof login.by_jwt !== "string" || !login.by_jwt) {
      throw new Error("URnetwork auth code login returned no JWT");
    }
    const created = await this.request("POST", "/account/api-key", { token: login.by_jwt, body: { name } });
    assertNoError(created, "URnetwork API key creation");
    if (typeof created.api_key !== "string" || !created.api_key.startsWith("urn_")) {
      throw new Error("URnetwork API key creation returned no urn_ key");
    }
    return created.api_key;
  }

  async verifyApiKey(apiKey: string): Promise<void> {
    await this.request("GET", "/network/proxies", { token: apiKey });
  }

  async createProxy(
    apiKey: string,
    options: { location: UrnetworkLocation; uniqueExit: boolean },
    description: string,
  ): Promise<UrnetworkUpstream> {
    const initialDeviceState = options.location === URNETWORK_BEST_AVAILABLE
      ? { location: { connect_location_id: { best_available: true } } }
      : { country_code: options.location };
    const body = await this.request("POST", "/network/auth-client", {
      token: apiKey,
      body: {
        description,
        device_spec: "vless-countries-bot",
        proxy_config: {
          initial_device_state: initialDeviceState,
          ...(options.uniqueExit ? { unique_exit: true } : {}),
        },
      },
    });
    assertNoError(body, "URnetwork proxy creation");
    const result = body.proxy_config_result as JsonObject | undefined;
    const clientId = String(result?.client_id ?? body.client_id ?? "");
    const authToken = String(result?.auth_token ?? "");
    const proxyHost = String(result?.proxy_host ?? "");
    const httpsProxyPort = Number(result?.https_proxy_port);
    const socksProxyPort = Number(result?.socks_proxy_port);
    if (!clientId || !authToken || !proxyHost || !validPort(httpsProxyPort)) {
      throw new Error("URnetwork proxy creation returned incomplete proxy credentials");
    }
    const exit = result?.exit as JsonObject | undefined;
    const exitLocation = [exit?.city, exit?.region, typeof exit?.country_code === "string" ? exit.country_code.toUpperCase() : undefined]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(", ");
    return {
      clientId,
      authToken,
      proxyHost,
      httpsProxyPort,
      socksProxyPort: validPort(socksProxyPort) ? socksProxyPort : 0,
      ...(exitLocation ? { exitLocation } : {}),
    };
  }

  async removeProxy(apiKey: string, clientId: string): Promise<void> {
    const body = await this.request("POST", "/network/remove-client", { token: apiKey, body: { client_id: clientId } });
    assertNoError(body, "URnetwork proxy removal");
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { token?: string; body?: JsonObject } = {},
  ): Promise<JsonObject> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    if (options.body) {
      headers["content-type"] = "application/json";
    }
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 401) {
      throw new Error("URnetwork rejected the API key (HTTP 401)");
    }
    if (!response.ok) {
      // Refusals have a plain-text body that says why; keep it short and single-line.
      const reason = text.trim().replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`URnetwork ${path} failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}`);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as JsonObject;
    } catch {
      throw new Error(`URnetwork ${path} returned a non-JSON response`);
    }
  }
}

function assertNoError(body: JsonObject, action: string): void {
  const error = body.error as JsonObject | undefined;
  if (error) {
    throw new Error(`${action} refused: ${String(error.message ?? "unknown reason")}`);
  }
}

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= 65535;
}
