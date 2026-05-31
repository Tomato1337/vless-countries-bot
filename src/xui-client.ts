import { asJsonObject, asTemplate, assertGeOutbound } from "./template.ts";
import type { JsonObject, ManagedClient, XrayOutbound, XrayTemplate, XuiApi, XuiClient } from "./types.ts";

interface HttpXuiClientConfig {
  baseUrl: string;
  username: string;
  password: string;
}

interface XuiEnvelope {
  success?: boolean;
  msg?: string;
  obj?: unknown;
}

export class HttpXuiClient implements XuiApi {
  private readonly baseUrl: string;
  private cookie = "";
  private csrfToken = "";
  private csrfSupported?: boolean;
  private clientApiMode?: "modern" | "legacy";
  private inboundId?: number;
  private loginPromise?: Promise<void>;

  constructor(
    private readonly config: HttpXuiClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async checkCompatibility(geOutboundTag: string, inboundId: number): Promise<void> {
    const template = await this.getTemplate();
    assertGeOutbound(template, geOutboundTag);
    const inbound = await this.getInbound(inboundId);
    if (String(inbound.protocol).toLowerCase() !== "vless") {
      throw new Error(`Configured inbound ${inboundId} is not VLESS`);
    }
    this.inboundId = inboundId;
    const modernClients = await this.tryGet("/panel/api/clients/list");
    this.clientApiMode = Array.isArray(modernClients) ? "modern" : "legacy";
  }

  async getTemplate(): Promise<XrayTemplate> {
    const obj = await this.postForm("/panel/xray/", {});
    const response = parseMaybeJson(obj);
    let wrapper: JsonObject;
    try {
      wrapper = asJsonObject(response);
    } catch {
      throw new Error(
        `3x-ui /panel/xray/ returned an unsupported response shape: ${describeShape(response)}`,
      );
    }
    return asTemplate(parseMaybeJson(wrapper.xraySetting));
  }

  async updateTemplate(template: XrayTemplate): Promise<void> {
    await this.postForm("/panel/xray/update", {
      xraySetting: JSON.stringify(template),
    });
  }

  async testOutbound(outbound: XrayOutbound, allOutbounds: XrayOutbound[]): Promise<void> {
    await this.postForm("/panel/xray/testOutbound", {
      outbound: JSON.stringify(outbound),
      allOutbounds: JSON.stringify(allOutbounds),
    });
  }

  async listClients(): Promise<XuiClient[]> {
    if (this.clientApiMode === "legacy") {
      return this.listLegacyClients();
    }
    const obj = await this.get("/panel/api/clients/list");
    if (!Array.isArray(obj)) {
      throw new Error("3x-ui returned an invalid client list");
    }
    return obj.map((value) => {
      const client = asJsonObject(value);
      return {
        email: String(client.email ?? ""),
        subId: String(client.subId ?? ""),
        inboundIds: Array.isArray(client.inboundIds)
          ? client.inboundIds.map(Number).filter(Number.isSafeInteger)
          : [],
      };
    });
  }

  async createClient(client: ManagedClient, inboundId: number): Promise<void> {
    if (this.clientApiMode === "legacy") {
      await this.postJson("/panel/api/inbounds/addClient", {
        id: inboundId,
        settings: JSON.stringify({
          clients: [
            {
              id: client.uuid,
              flow: "",
              email: client.email,
              limitIp: 0,
              totalGB: 0,
              expiryTime: 0,
              enable: true,
              tgId: "",
              subId: client.subId,
              reset: 0,
            },
          ],
        }),
      });
      return;
    }
    await this.postJson("/panel/api/clients/add", {
      client: {
        id: client.uuid,
        email: client.email,
        subId: client.subId,
        enable: true,
        totalGB: 0,
        expiryTime: 0,
        limitIp: 0,
      },
      inboundIds: [inboundId],
    });
  }

  async renameClient(client: ManagedClient, nextEmail: string, inboundId: number): Promise<void> {
    if (this.clientApiMode === "legacy") {
      await this.deleteClient(client);
      try {
        await this.createClient({ ...client, email: nextEmail }, inboundId);
      } catch (error) {
        try {
          await this.createClient(client, inboundId);
        } catch {
          // Preserve the rename error. The later /sync can expose an incomplete restoration.
        }
        throw error;
      }
      return;
    }
    await this.postJson(`/panel/api/clients/update/${encodeURIComponent(client.email)}`, {
      id: client.uuid,
      email: nextEmail,
      subId: client.subId,
      enable: true,
      totalGB: 0,
      expiryTime: 0,
      limitIp: 0,
    });
  }

  async deleteClient(client: Pick<ManagedClient, "email" | "uuid">): Promise<void> {
    if (this.clientApiMode === "legacy") {
      const inboundId = this.requireInboundId();
      await this.postJson(
        `/panel/api/inbounds/${inboundId}/delClient/${encodeURIComponent(client.uuid)}`,
        {},
      );
      return;
    }
    await this.postJson(`/panel/api/clients/del/${encodeURIComponent(client.email)}`, {});
  }

  private async login(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin().finally(() => {
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }

  private async performLogin(): Promise<void> {
    this.cookie = "";
    await this.refreshCsrf(true);
    const values: Record<string, string> = {
      username: this.config.username,
      password: this.config.password,
    };
    if (this.csrfToken) {
      values.csrfToken = this.csrfToken;
    }
    const body = new URLSearchParams(values);
    const response = await this.rawFetch("/login", {
      method: "POST",
      headers: this.csrfHeaders({
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      }),
      body,
    });
    const envelope = await readEnvelope(response, "/login");
    if (!response.ok || envelope.success === false) {
      throw new Error(envelope.msg || `3x-ui login failed with HTTP ${response.status}`);
    }
    await this.refreshCsrf(true);
  }

  private async refreshCsrf(allowUnsupported = false): Promise<void> {
    if (this.csrfSupported === false) {
      return;
    }
    const response = await this.rawFetch("/csrf-token", {
      headers: this.headers(),
    });
    if (allowUnsupported && response.status === 404) {
      this.csrfSupported = false;
      this.csrfToken = "";
      return;
    }
    const envelope = await readEnvelope(response, "/csrf-token");
    if (!response.ok || envelope.success === false || typeof envelope.obj !== "string") {
      throw new Error(envelope.msg || "Could not obtain 3x-ui CSRF token");
    }
    this.csrfSupported = true;
    this.csrfToken = envelope.obj;
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  private async postForm(path: string, values: Record<string, string>): Promise<unknown> {
    await this.ensureAuthenticated();
    await this.refreshCsrf();
    const body = new URLSearchParams(this.csrfToken ? { ...values, csrfToken: this.csrfToken } : values);
    return this.request(path, {
      method: "POST",
      headers: this.csrfHeaders({
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      }),
      body,
    });
  }

  private async postJson(path: string, value: JsonObject): Promise<unknown> {
    await this.ensureAuthenticated();
    await this.refreshCsrf();
    return this.request(path, {
      method: "POST",
      headers: this.csrfHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(value),
    });
  }

  private async request(path: string, init: RequestInit, retry = true): Promise<unknown> {
    await this.ensureAuthenticated();
    const response = await this.rawFetch(path, {
      ...init,
      headers: this.headers(init.headers),
    });
    if (retry && (response.status === 401 || response.status === 404)) {
      this.cookie = "";
      await this.login();
      return this.request(path, init, false);
    }
    const envelope = await readEnvelope(response, path);
    if (!response.ok || envelope.success === false) {
      throw new Error(envelope.msg || `3x-ui request failed with HTTP ${response.status}`);
    }
    return envelope.obj;
  }

  private async tryGet(path: string): Promise<unknown | undefined> {
    await this.ensureAuthenticated();
    const response = await this.rawFetch(path, {
      method: "GET",
      headers: this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    const envelope = await readEnvelope(response, path);
    if (!response.ok || envelope.success === false) {
      throw new Error(envelope.msg || `3x-ui request failed with HTTP ${response.status}`);
    }
    return envelope.obj;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.cookie) {
      await this.login();
    }
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Accept", "application/json");
    headers.set("X-Requested-With", "XMLHttpRequest");
    if (this.cookie) {
      headers.set("Cookie", this.cookie);
    }
    return headers;
  }

  private csrfHeaders(extra?: HeadersInit): Headers {
    const headers = this.headers(extra);
    if (this.csrfToken) {
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    return headers;
  }

  private async getInbound(inboundId: number): Promise<JsonObject> {
    return asJsonObject(await this.get(`/panel/api/inbounds/get/${inboundId}`));
  }

  private async listLegacyClients(): Promise<XuiClient[]> {
    const inboundId = this.requireInboundId();
    const inbound = await this.getInbound(inboundId);
    const settings = parseMaybeJson(inbound.settings);
    const wrapper = asJsonObject(settings);
    if (!Array.isArray(wrapper.clients)) {
      throw new Error("Legacy 3x-ui inbound settings are missing clients");
    }
    return wrapper.clients.map((value) => {
      const client = asJsonObject(value);
      return {
        email: String(client.email ?? ""),
        subId: String(client.subId ?? ""),
        inboundIds: [inboundId],
      };
    });
  }

  private requireInboundId(): number {
    if (!this.inboundId) {
      throw new Error("3x-ui compatibility check must run before client operations");
    }
    return this.inboundId;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
    });
    this.captureCookies(response.headers);
    return response;
  }

  private captureCookies(headers: Headers): void {
    const cookieHeaders = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
    const incoming = cookieHeaders
      .filter(Boolean)
      .map((header) => header.split(";", 1)[0])
      .filter((value): value is string => Boolean(value));
    if (!incoming.length) {
      return;
    }
    const cookies = new Map(
      this.cookie.split("; ").filter(Boolean).map(splitCookie),
    );
    for (const part of incoming) {
      const [key, value] = splitCookie(part);
      if (key && value) {
        cookies.set(key, value);
      }
    }
    this.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

async function readEnvelope(response: Response, path: string): Promise<XuiEnvelope> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`3x-ui ${path} returned a non-JSON response with HTTP ${response.status}`);
  }
  try {
    return asJsonObject(value) as XuiEnvelope;
  } catch {
    throw new Error(
      `3x-ui ${path} returned an unsupported response shape with HTTP ${response.status}: ${describeShape(value)}`,
    );
  }
}

function splitCookie(part: string): [string, string] {
  const separator = part.indexOf("=");
  return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function describeShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return `object with keys [${Object.keys(value as JsonObject).join(", ")}]`;
  }
  return typeof value;
}
