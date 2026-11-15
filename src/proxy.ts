import { countryFlagFromSlug } from "./country-flag.ts";
import type { JsonObject, UrnetworkProxyKind, UrnetworkUpstream, XrayOutbound, XrayRoutingRule, XrayTemplate } from "./types.ts";

// Proxy profile emails end with this suffix. Exit slugs may not end with it, so the `regexp:.*-<exit>$` exit rules
// never match a proxy profile.
export const PROXY_EMAIL_SUFFIX = "-proxy";
const PROXY_TAG_PREFIX = "proxies-";
const PROXY_RULE_PREFIX = "proxies-route-";
const GLOBE = "🌐";

export function assertProxyName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 24) {
    throw new Error("Имя прокси: латиница в нижнем регистре, цифры и одиночные дефисы, до 24 символов");
  }
}

/** `ur-de`, `ur-best-socks`, `ur-nl-uniq`: one name per location, type and exit mode. */
export function urnetworkProxyName(location: string, kind: UrnetworkProxyKind, uniqueExit: boolean): string {
  return `ur-${location.toLowerCase()}${kind === "socks" ? "-socks" : ""}${uniqueExit ? "-uniq" : ""}`;
}

/** Country flag for names that start with a country code (`de-home`, `ur-de`), otherwise a globe. */
export function proxyFlag(name: string): string {
  const countryPart = name.startsWith("ur-") ? name.slice(3) : name;
  try {
    return countryFlagFromSlug(countryPart);
  } catch {
    return GLOBE;
  }
}

export function proxyClientEmail(subscriptionSlug: string, name: string): string {
  return `${proxyFlag(name)}-${subscriptionSlug}-${name}${PROXY_EMAIL_SUFFIX}`;
}

// Subscription slugs and proxy names never contain `--`, so the separator keeps every pair distinct.
export function proxyOutboundTag(subscriptionSlug: string, name: string): string {
  return `${PROXY_TAG_PREFIX}${subscriptionSlug}--${name}`;
}

// 3x-ui's outbound test (testOutbounds, TCP mode) reads http/socks endpoints only from `settings.servers[]`, so
// these outbounds use the servers form; Xray accepts it alongside the flat form.
function proxyServerSettings(address: string, port: number, credentials?: { user: string; pass: string }): JsonObject {
  return { servers: [{ address, port, ...(credentials ? { users: [credentials] } : {}) }] };
}

/** Address and port of a proxy outbound built by this module. */
export function proxyServerEndpoint(outbound: XrayOutbound): { address: string; port: number } | undefined {
  const settings = outbound.settings;
  if (!settings || typeof settings !== "object" || !("servers" in settings) || !Array.isArray(settings.servers)) {
    return undefined;
  }
  const server: unknown = settings.servers[0];
  if (!server || typeof server !== "object" || !("address" in server) || !("port" in server)) {
    return undefined;
  }
  return { address: String(server.address), port: Number(server.port) };
}

export function buildUrnetworkOutbound(
  tag: string,
  upstream: UrnetworkUpstream,
  kind: UrnetworkProxyKind,
  geOutboundTag: string,
): XrayOutbound {
  if (kind === "socks") {
    if (!upstream.socksProxyPort) {
      throw new Error("URnetwork did not issue a SOCKS5 port for this proxy (SOCKS5 needs UR Pro)");
    }
    // The SOCKS5 proxy takes the token as the username and never checks the password.
    return {
      tag,
      protocol: "socks",
      settings: proxyServerSettings(upstream.proxyHost, upstream.socksProxyPort, { user: upstream.authToken, pass: "x" }),
      streamSettings: { sockopt: { dialerProxy: geOutboundTag } },
    };
  }
  // The HTTPS proxy authenticates by the token as the first host-name label; TLS is mandatory for that form.
  const host = `${upstream.authToken}.${upstream.proxyHost}`;
  return {
    tag,
    protocol: "http",
    settings: proxyServerSettings(host, upstream.httpsProxyPort),
    streamSettings: {
      network: "tcp",
      security: "tls",
      tlsSettings: { serverName: host, alpn: ["http/1.1"] },
      sockopt: { dialerProxy: geOutboundTag },
    },
  };
}

/** Accepts `socks5://`, `socks5h://`, `socks://`, `http://` and `https://` URLs with optional `user:pass@`. */
export function buildCustomProxyOutbound(tag: string, rawUrl: string, geOutboundTag: string): XrayOutbound {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Не удалось разобрать URL прокси. Пример: socks5://user:pass@1.2.3.4:1080");
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const protocol = ["socks", "socks5", "socks5h"].includes(scheme) ? "socks" : ["http", "https"].includes(scheme) ? "http" : "";
  if (!protocol) {
    throw new Error(`Неподдерживаемая схема прокси: ${scheme}. Используйте socks5, http или https`);
  }
  const address = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (scheme === "https" ? 443 : scheme === "http" ? 80 : 1080));
  if (!address || !Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("URL прокси должен содержать хост и корректный порт");
  }
  const settings = proxyServerSettings(
    address,
    port,
    url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
  );
  const streamSettings: JsonObject = { sockopt: { dialerProxy: geOutboundTag } };
  if (scheme === "https") {
    Object.assign(streamSettings, { network: "tcp", security: "tls", tlsSettings: { serverName: address } });
  }
  return { tag, protocol, settings, streamSettings };
}

/** Adds or replaces proxy outbounds; each one routes exactly its own profile email. */
export function upsertProxies(
  template: XrayTemplate,
  entries: Array<{ outbound: XrayOutbound; email: string }>,
): XrayTemplate {
  const tags = new Set(entries.map(({ outbound }) => outbound.tag));
  const next = removeProxies(template, [...tags]);
  for (const { outbound, email } of entries) {
    next.outbounds.push(outbound);
    const rule: XrayRoutingRule = {
      type: "field",
      ruleTag: `${PROXY_RULE_PREFIX}${outbound.tag.slice(PROXY_TAG_PREFIX.length)}`,
      user: [email],
      outboundTag: outbound.tag,
    };
    next.routing.rules.unshift(rule);
  }
  return next;
}

export function removeProxies(template: XrayTemplate, outboundTags: string[]): XrayTemplate {
  const tags = new Set(outboundTags);
  const next = structuredClone(template);
  next.outbounds = next.outbounds.filter((item) => !tags.has(item.tag));
  next.routing.rules = next.routing.rules.filter((rule) =>
    !(rule.ruleTag?.startsWith(PROXY_RULE_PREFIX) && rule.outboundTag && tags.has(rule.outboundTag))
  );
  return next;
}
