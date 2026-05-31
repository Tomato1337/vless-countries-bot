import type { JsonObject, XrayOutbound } from "./types.ts";

export type VlessTransport = "tcp" | "ws" | "xhttp" | "grpc";
export type VlessSecurity = "none" | "tls" | "reality";

export interface ParsedVlessUri {
  address: string;
  port: number;
  uuid: string;
  encryption: string;
  flow?: string;
  transport: VlessTransport;
  security: VlessSecurity;
  host?: string;
  path?: string;
  serviceName?: string;
  authority?: string;
  mode?: string;
  serverName?: string;
  fingerprint?: string;
  alpn?: string[];
  allowInsecure?: boolean;
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
}

export interface ParsedVlessRealityTcp extends ParsedVlessUri {
  transport: "tcp";
  security: "reality";
  serverName: string;
  fingerprint: string;
  publicKey: string;
  shortId: string;
}

export function parseVlessUri(uri: string): ParsedVlessUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("Invalid VLESS URI");
  }

  if (url.protocol !== "vless:") {
    throw new Error("Only vless:// links are supported");
  }
  if (!url.username || !url.hostname || !url.port) {
    throw new Error("VLESS URI must contain UUID, host and port");
  }

  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("VLESS URI contains an invalid port");
  }

  const params = url.searchParams;
  const transport = parseTransport(params.get("type"));
  const security = parseSecurity(params.get("security"));
  const serverName = params.get("sni")?.trim() || (security === "tls" ? url.hostname : undefined);
  const fingerprint = params.get("fp")?.trim() || (security === "reality" ? "chrome" : undefined);

  if (security === "reality") {
    required(params, "sni");
    required(params, "pbk");
    required(params, "sid");
  }

  return {
    address: url.hostname,
    port,
    uuid: decodeURIComponent(url.username),
    encryption: params.get("encryption")?.trim() || "none",
    flow: params.get("flow")?.trim() || undefined,
    transport,
    security,
    host: params.get("host")?.trim() || undefined,
    path: params.get("path")?.trim() || undefined,
    serviceName: params.get("serviceName")?.trim() || params.get("path")?.trim() || undefined,
    authority: params.get("authority")?.trim() || undefined,
    mode: params.get("mode")?.trim() || undefined,
    serverName,
    fingerprint,
    alpn: splitCommaList(params.get("alpn")),
    allowInsecure: parseOptionalBoolean(params.get("allowInsecure")),
    publicKey: params.get("pbk")?.trim() || undefined,
    shortId: params.get("sid")?.trim() || undefined,
    spiderX: params.get("spx")?.trim() || undefined,
  };
}

export function parseVlessRealityTcp(uri: string): ParsedVlessRealityTcp {
  const parsed = parseVlessUri(uri);
  if (parsed.transport !== "tcp" || parsed.security !== "reality") {
    throw new Error("Only VLESS Reality TCP links are supported by this parser");
  }
  return parsed as ParsedVlessRealityTcp;
}

export function buildCountryOutbound(
  slug: string,
  uri: string,
  geOutboundTag: string,
): XrayOutbound {
  const parsed = parseVlessUri(uri);
  return {
    tag: countryOutboundTag(slug),
    protocol: "vless",
    settings: {
      address: parsed.address,
      port: parsed.port,
      id: parsed.uuid,
      encryption: parsed.encryption,
      ...(parsed.flow ? { flow: parsed.flow } : {}),
    },
    streamSettings: buildStreamSettings(parsed),
    proxySettings: {
      tag: geOutboundTag,
      transportLayer: true,
    },
  };
}

export function countryOutboundTag(slug: string): string {
  return `countries-exit-${slug}`;
}

function buildStreamSettings(parsed: ParsedVlessUri): JsonObject {
  return {
    network: parsed.transport,
    security: parsed.security,
    ...buildTransportSettings(parsed),
    ...buildSecuritySettings(parsed),
  };
}

function buildTransportSettings(parsed: ParsedVlessUri): JsonObject {
  switch (parsed.transport) {
    case "tcp":
      return {};
    case "ws":
      return {
        wsSettings: {
          path: parsed.path || "/",
          ...(parsed.host ? { host: parsed.host } : {}),
        },
      };
    case "xhttp":
      return {
        xhttpSettings: {
          path: parsed.path || "/",
          ...(parsed.host ? { host: parsed.host } : {}),
          ...(parsed.mode ? { mode: parsed.mode } : {}),
        },
      };
    case "grpc":
      return {
        grpcSettings: {
          serviceName: parsed.serviceName || "",
          ...(parsed.authority ? { authority: parsed.authority } : {}),
          ...(parsed.mode === "multi" ? { multiMode: true } : {}),
        },
      };
  }
}

function buildSecuritySettings(parsed: ParsedVlessUri): JsonObject {
  switch (parsed.security) {
    case "none":
      return {};
    case "tls":
      return {
        tlsSettings: {
          ...(parsed.serverName ? { serverName: parsed.serverName } : {}),
          ...(parsed.fingerprint ? { fingerprint: parsed.fingerprint } : {}),
          ...(parsed.alpn?.length ? { alpn: parsed.alpn } : {}),
          ...(parsed.allowInsecure !== undefined ? { allowInsecure: parsed.allowInsecure } : {}),
        },
      };
    case "reality":
      return {
        realitySettings: {
          serverName: parsed.serverName,
          fingerprint: parsed.fingerprint,
          publicKey: parsed.publicKey,
          shortId: parsed.shortId,
          ...(parsed.spiderX ? { spiderX: parsed.spiderX } : {}),
        },
      };
  }
}

function parseTransport(value: string | null): VlessTransport {
  switch (value?.trim().toLowerCase() || "tcp") {
    case "tcp":
    case "raw":
      return "tcp";
    case "ws":
    case "websocket":
      return "ws";
    case "xhttp":
    case "grpc":
      return value!.trim().toLowerCase() as VlessTransport;
    default:
      throw new Error(`Unsupported VLESS transport: ${value}`);
  }
}

function parseSecurity(value: string | null): VlessSecurity {
  switch (value?.trim().toLowerCase() || "none") {
    case "none":
    case "tls":
    case "reality":
      return (value?.trim().toLowerCase() || "none") as VlessSecurity;
    default:
      throw new Error(`Unsupported VLESS security: ${value}`);
  }
}

function required(params: URLSearchParams, key: string): string {
  const value = params.get(key)?.trim();
  if (!value) {
    throw new Error(`VLESS URI is missing required parameter: ${key}`);
  }
  return value;
}

function splitCommaList(value: string | null): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new Error(`Invalid boolean value in VLESS URI: ${value}`);
}
