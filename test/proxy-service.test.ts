import { describe, expect, test } from "bun:test";
import { assertCountrySlug, CountryService } from "../src/country-service.ts";
import { buildCustomProxyOutbound } from "../src/proxy.ts";
import { ProxyService } from "../src/proxy-service.ts";
import { Store } from "../src/store.ts";
import { MockUrnetwork, MockXui } from "./helpers.ts";

function setup() {
  const store = new Store();
  const xui = new MockXui();
  const urnetwork = new MockUrnetwork();
  const countries = new CountryService(store, xui, { geOutboundTag: "germany", inboundId: 1 });
  const proxies = new ProxyService(store, xui, urnetwork, { geOutboundTag: "germany", inboundId: 1 }, countries.mutex);
  return { store, xui, urnetwork, proxies };
}

describe("ProxyService", () => {
  test("creates URnetwork proxies on each profile's own account and skips profiles without a key", async () => {
    const { store, xui, urnetwork, proxies } = setup();
    store.setUrnetworkKey("Ilya", "urn_ilya");

    const result = await proxies.addUrnetworkProxies(1, await proxies.listSubscriptions(), "DE", "https");

    expect(result.failed).toEqual([{ slug: "denis", reason: "нет ключа URnetwork" }]);
    expect(result.added.map((proxy) => proxy.email)).toEqual(["🇩🇪-ilya-ur-de-proxy"]);
    expect(urnetwork.created).toEqual([{ apiKey: "urn_ilya", location: "de", uniqueExit: false, clientId: "client-1" }]);
    expect(xui.created).toContainEqual(expect.objectContaining({ email: "🇩🇪-ilya-ur-de-proxy", subId: "Ilya" }));
    const outbound = xui.template.outbounds.find((item) => item.tag === "proxies-ilya--ur-de");
    expect(outbound).toMatchObject({
      protocol: "http",
      settings: { servers: [{ address: "tokenclient1.proxy.ur.test", port: 8443 }] },
      streamSettings: { security: "tls", tlsSettings: { serverName: "tokenclient1.proxy.ur.test" }, sockopt: { dialerProxy: "germany" } },
    });
    expect(xui.template.routing.rules[0]).toMatchObject({ user: ["🇩🇪-ilya-ur-de-proxy"], outboundTag: "proxies-ilya--ur-de" });
  });

  test("creates best-available and unique-exit proxies under distinct names", async () => {
    const { store, urnetwork, proxies } = setup();
    store.setUrnetworkKey("Ilya", "urn_ilya");
    const ilya = [await proxies.requireSubscription("ilya")];

    const best = await proxies.addUrnetworkProxies(1, ilya, "best", "https");
    const unique = await proxies.addUrnetworkProxies(1, ilya, "de", "socks", true);

    expect(best.added.map((proxy) => proxy.email)).toEqual(["🌐-ilya-ur-best-proxy"]);
    expect(unique.added.map((proxy) => proxy.email)).toEqual(["🇩🇪-ilya-ur-de-socks-uniq-proxy"]);
    expect(urnetwork.created.map(({ location, uniqueExit }) => ({ location, uniqueExit }))).toEqual([
      { location: "best", uniqueExit: false },
      { location: "de", uniqueExit: true },
    ]);
    expect(unique.added[0]!.upstream?.exitLocation).toBe("Berlin, DE");
  });

  test("removes the hosted proxy when its outbound test fails and leaves the template untouched", async () => {
    const { store, xui, urnetwork, proxies } = setup();
    store.setUrnetworkKey("Ilya", "urn_ilya");
    xui.failTestHostnames.add("tokenclient1");
    const before = structuredClone(xui.template);

    const result = await proxies.addUrnetworkProxies(1, [await proxies.requireSubscription("ilya")], "de", "https");

    expect(result.added).toEqual([]);
    expect(result.failed[0]?.reason).toBe("outbound test failed");
    expect(urnetwork.removed).toEqual(["client-1"]);
    expect(xui.template).toEqual(before);
    expect(store.listProxies()).toEqual([]);
  });

  test("rolls back panel clients, template and hosted proxies when applying fails", async () => {
    const { store, xui, urnetwork, proxies } = setup();
    store.setUrnetworkKey("Ilya", "urn_ilya");
    store.setUrnetworkKey("Denis", "urn_denis");
    xui.failCreateEmail = "🇩🇪-ilya-ur-de-proxy";
    const before = structuredClone(xui.template);

    await expect(proxies.addUrnetworkProxies(1, await proxies.listSubscriptions(), "de", "https")).rejects.toThrow("create failed");

    expect(xui.deleted).toEqual(["🇩🇪-denis-ur-de-proxy"]);
    expect(xui.template).toEqual(before);
    expect(urnetwork.removed.sort()).toEqual(["client-1", "client-2"]);
    expect(store.listProxies()).toEqual([]);
  });

  test("adds a custom proxy to selected profiles and removes it with its routing", async () => {
    const { store, xui, proxies } = setup();
    const ilya = await proxies.requireSubscription("ilya");

    const result = await proxies.addCustomProxies(1, [ilya], "nl-home", "socks5://user%40x:p%3Ass@203.0.113.5:1080");

    expect(result.added.map((proxy) => proxy.email)).toEqual(["🇳🇱-ilya-nl-home-proxy"]);
    expect(xui.template.outbounds.at(-1)).toMatchObject({
      tag: "proxies-ilya--nl-home",
      protocol: "socks",
      settings: { servers: [{ address: "203.0.113.5", port: 1080, users: [{ user: "user@x", pass: "p:ss" }] }] },
    });

    const removed = await proxies.removeProxies(1, [result.added[0]!.id]);

    expect(removed).toEqual({ removed: 1, upstreamLeftovers: [] });
    expect(xui.deleted).toEqual(["🇳🇱-ilya-nl-home-proxy"]);
    expect(xui.template.outbounds.some((item) => item.tag === "proxies-ilya--nl-home")).toBe(false);
    expect(xui.template.routing.rules.some((rule) => rule.outboundTag === "proxies-ilya--nl-home")).toBe(false);
    expect(store.listProxies()).toEqual([]);
  });

  test("removing a URnetwork proxy also deletes it on the profile's account", async () => {
    const { store, urnetwork, proxies } = setup();
    store.setUrnetworkKey("Ilya", "urn_ilya");
    const { added } = await proxies.addUrnetworkProxies(1, [await proxies.requireSubscription("ilya")], "de", "socks");

    await proxies.removeProxies(1, added.map((proxy) => proxy.id));

    expect(added[0]!.outbound).toMatchObject({
      protocol: "socks",
      settings: { servers: [{ address: "proxy.ur.test", port: 8080, users: [{ user: "tokenclient1", pass: "x" }] }] },
    });
    expect(urnetwork.removed).toEqual(["client-1"]);
  });

  test("exchanges a ur.io auth code for an API key and rejects keys URnetwork refuses", async () => {
    const { store, urnetwork, proxies } = setup();
    const ilya = await proxies.requireSubscription("ilya");

    await proxies.setUrnetworkKey(1, ilya, "one-time-code");
    expect(urnetwork.exchangedCodes).toEqual(["one-time-code"]);
    expect(store.getUrnetworkKey("Ilya")).toBe("urn_from_one-time-code");

    urnetwork.invalidKeys.add("urn_bad");
    await expect(proxies.setUrnetworkKey(1, ilya, "urn_bad")).rejects.toThrow("HTTP 401");
    expect(store.getUrnetworkKey("Ilya")).toBe("urn_from_one-time-code");
  });
});

describe("proxy naming and URLs", () => {
  test("exit slugs cannot take the proxy suffix, so exit rules never capture proxy profiles", () => {
    expect(() => assertCountrySlug("de-proxy")).toThrow("-proxy");
  });

  test("https custom proxies use TLS to the proxy; unsupported schemes are rejected", () => {
    expect(buildCustomProxyOutbound("t", "https://proxy.example:8443", "germany")).toMatchObject({
      protocol: "http",
      settings: { servers: [{ address: "proxy.example", port: 8443 }] },
      streamSettings: { security: "tls", tlsSettings: { serverName: "proxy.example" } },
    });
    expect(() => buildCustomProxyOutbound("t", "ftp://proxy.example:21", "germany")).toThrow("ftp");
  });
});
