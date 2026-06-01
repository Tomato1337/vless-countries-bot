import { describe, expect, test } from "bun:test";
import { collectSubscriptions, CountryService, normalizeSubscriptionSlug } from "../src/country-service.ts";
import { NordVpnCatalog } from "../src/nordvpn.ts";
import type { NordVpnCity, NordVpnCountry, NordVpnServer } from "../src/nordvpn.ts";
import { Store } from "../src/store.ts";
import { MockXui, NORD_PRIVATE_KEY, REALITY_URI } from "./helpers.ts";

function setup() {
  const store = new Store();
  const xui = new MockXui();
  const service = new CountryService(store, xui, { geOutboundTag: "germany", inboundId: 1 });
  return { store, xui, service };
}

function setupNord() {
  const store = new Store();
  const xui = new MockXui();
  const catalog = new MockNordCatalog();
  const service = new CountryService(
    store,
    xui,
    { geOutboundTag: "germany", inboundId: 1, nordVpnPrivateKey: NORD_PRIVATE_KEY },
    catalog,
  );
  return { store, xui, catalog, service };
}

describe("subscription normalization", () => {
  test("normalizes ASCII names", () => {
    expect(normalizeSubscriptionSlug("  Ilya Home ")).toBe("ilya-home");
  });

  test("detects normalized slug collisions", () => {
    expect(() => collectSubscriptions([
      { email: "one", subId: "Ilya Home", inboundIds: [1] },
      { email: "two", subId: "ilya-home", inboundIds: [1] },
    ], 1)).toThrow("Subscription slug collision");
  });
});

describe("CountryService", () => {
  test("creates one country profile per subscription and leaves device profiles intact", async () => {
    const { store, xui, service } = setup();
    const result = await service.setCountry(1, "usa", REALITY_URI);

    expect(result.created).toEqual(["🇺🇸-ilya-usa", "🇺🇸-denis-usa"]);
    expect(xui.clients.map((client) => client.email)).toContain("ilya-phone");
    expect(xui.clients.map((client) => client.email)).toContain("ilya-pc");
    expect(store.listManagedClients("usa")).toHaveLength(2);
    expect(xui.template.routing.rules[0]?.ruleTag).toBe("countries-route-usa");
  });

  test("replaces only the outbound for an existing country", async () => {
    const { store, xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    const uuids = store.listManagedClients("usa").map((client) => client.uuid);

    const result = await service.setCountry(1, "usa", REALITY_URI.replace("usa12", "usa13"));

    expect(result.createdCountry).toBeFalse();
    expect(result.created).toEqual([]);
    expect(store.listManagedClients("usa").map((client) => client.uuid)).toEqual(uuids);
  });

  test("sync is idempotent and creates profiles for a new subscription", async () => {
    const { xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    expect((await service.sync(1)).created).toEqual([]);
    xui.clients.push({ email: "maria-phone", subId: "Maria", inboundIds: [1] });
    expect((await service.sync(1)).created).toEqual(["🇺🇸-maria-usa"]);
  });

  test("rolls back a new country when a profile cannot be created", async () => {
    const { store, xui, service } = setup();
    xui.failCreateEmail = "🇺🇸-denis-usa";

    await expect(service.setCountry(1, "usa", REALITY_URI)).rejects.toThrow("create failed");

    expect(store.getCountry("usa")).toBeUndefined();
    expect(store.listManagedClients()).toEqual([]);
    expect(xui.clients.map((client) => client.email)).not.toContain("🇺🇸-ilya-usa");
    expect(xui.template.outbounds.some((outbound) => outbound.tag === "countries-exit-usa")).toBeFalse();
  });

  test("removes managed profiles without touching device profiles", async () => {
    const { store, xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    expect(await service.removeCountry(1, "usa")).toBe(2);

    expect(store.getCountry("usa")).toBeUndefined();
    expect(xui.clients.map((client) => client.email)).toEqual([
      "ilya-phone",
      "ilya-pc",
      "denis-phone",
    ]);
  });

  test("restores deleted profiles when removing a country fails", async () => {
    const { store, xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    xui.failUpdateOnCall = 2;

    await expect(service.removeCountry(1, "usa")).rejects.toThrow("update failed");

    expect(store.getCountry("usa")).toBeDefined();
    expect(xui.clients.map((client) => client.email)).toContain("🇺🇸-ilya-usa");
    expect(xui.clients.map((client) => client.email)).toContain("🇺🇸-denis-usa");
    expect(xui.template.outbounds.some((outbound) => outbound.tag === "countries-exit-usa")).toBeTrue();
  });

  test("sync migrates old managed profile names without changing UUIDs", async () => {
    const { store, xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    const previous = store.listManagedClients("usa");
    for (const client of previous) {
      const oldEmail = client.email.replace("🇺🇸-", "");
      store.renameManagedClient(client.email, oldEmail);
      xui.clients.find((item) => item.email === client.email)!.email = oldEmail;
    }

    const result = await service.sync(1);

    expect(result.renamed).toEqual(["🇺🇸-ilya-usa", "🇺🇸-denis-usa"]);
    expect(store.listManagedClients("usa").map((client) => client.uuid)).toEqual(
      previous.map((client) => client.uuid),
    );
    expect(xui.renamed).toEqual([
      { from: "ilya-usa", to: "🇺🇸-ilya-usa" },
      { from: "denis-usa", to: "🇺🇸-denis-usa" },
    ]);
  });

  test("rejects a country slug without an inferable flag before updating xray", async () => {
    const { store, xui, service } = setup();
    const template = structuredClone(xui.template);

    await expect(service.setCountry(1, "moon", REALITY_URI)).rejects.toThrow("Cannot infer a country flag");

    expect(store.getCountry("moon")).toBeUndefined();
    expect(xui.template).toEqual(template);
  });

  test("rolls back migrated names when a later sync create fails", async () => {
    const { store, xui, service } = setup();
    await service.setCountry(1, "usa", REALITY_URI);
    for (const client of store.listManagedClients("usa")) {
      const oldEmail = client.email.replace("🇺🇸-", "");
      store.renameManagedClient(client.email, oldEmail);
      xui.clients.find((item) => item.email === client.email)!.email = oldEmail;
    }
    xui.clients.push({ email: "maria-phone", subId: "Maria", inboundIds: [1] });
    xui.failCreateEmail = "🇺🇸-maria-usa";

    await expect(service.sync(1)).rejects.toThrow("create failed");

    expect(store.listManagedClients("usa").map((client) => client.email)).toEqual([
      "denis-usa",
      "ilya-usa",
    ]);
    expect(xui.clients.map((client) => client.email)).toContain("ilya-usa");
    expect(xui.clients.map((client) => client.email)).not.toContain("🇺🇸-ilya-usa");
  });
});

describe("CountryService NordVPN", () => {
  test("adds multiple regions in one country and protects them from manual overwrite", async () => {
    const { store, xui, service } = setupNord();

    await service.addNordVpnRegion(1, 1, 100);
    await service.addNordVpnRegion(1, 1, 101);

    expect(store.listExits("nordvpn").map((vpnExit) => vpnExit.slug)).toEqual([
      "us-chicago",
      "us-new-york",
    ]);
    expect(store.listManagedClients("us-chicago").map((client) => client.email)).toEqual([
      "🇺🇸-denis-us-chicago",
      "🇺🇸-ilya-us-chicago",
    ]);
    const outbound = xui.template.outbounds.find((item) => item.tag === "countries-nord-exit-us-chicago");
    expect(outbound?.proxySettings).toEqual({ tag: "germany", transportLayer: true });
    await expect(service.setCountry(1, "us-chicago", REALITY_URI)).rejects.toThrow("managed by NordVPN");
  });

  test("tries the next least-loaded hostname and repairs without changing UUIDs", async () => {
    const { store, xui, catalog, service } = setupNord();
    xui.failTestHostnames.add("198.51.100.1");

    const added = await service.addNordVpnRegion(1, 1, 100);
    expect(added.attemptedHostnames).toEqual(["us-low.nordvpn.com", "us-backup.nordvpn.com"]);
    expect(added.source.hostname).toBe("us-backup.nordvpn.com");
    const uuids = store.listManagedClients("us-chicago").map((client) => client.uuid);

    catalog.mockServers = [
      nordServer(4, "us-repaired.nordvpn.com", "198.51.100.4", 1, 100, "Chicago"),
      ...catalog.mockServers,
    ];
    const repaired = await service.repairNordVpnRegion(1, "us-chicago");

    expect(repaired.source.hostname).toBe("us-repaired.nordvpn.com");
    expect(store.listManagedClients("us-chicago").map((client) => client.uuid)).toEqual(uuids);
  });

  test("does not apply a NordVPN region when every candidate fails its outbound test", async () => {
    const { store, xui, service } = setupNord();
    const template = structuredClone(xui.template);
    xui.failTestHostnames.add("198.51.100.1");
    xui.failTestHostnames.add("198.51.100.2");

    await expect(service.addNordVpnRegion(1, 1, 100)).rejects.toThrow(
      "NordVPN outbound test failed",
    );

    expect(store.getExit("us-chicago")).toBeUndefined();
    expect(store.listManagedClients()).toEqual([]);
    expect(xui.template).toEqual(template);
  });
});

class MockNordCatalog extends NordVpnCatalog {
  mockCountries: NordVpnCountry[] = [{ id: 1, code: "US", name: "United States" }];
  mockServers: NordVpnServer[] = [
    nordServer(1, "us-low.nordvpn.com", "198.51.100.1", 1, 100, "Chicago"),
    nordServer(2, "us-backup.nordvpn.com", "198.51.100.2", 2, 100, "Chicago"),
    nordServer(3, "us-new-york.nordvpn.com", "198.51.100.3", 3, 101, "New York"),
  ];

  override async listCountries(): Promise<NordVpnCountry[]> {
    return structuredClone(this.mockCountries);
  }

  override async listServers(): Promise<NordVpnServer[]> {
    return structuredClone(this.mockServers).sort((a, b) => a.load - b.load);
  }

  override async listCities(): Promise<NordVpnCity[]> {
    const cities = new Map(this.mockServers.map((server) => [
      server.cityId,
      { id: server.cityId, name: server.cityName },
    ]));
    return [...cities.values()];
  }
}

function nordServer(
  id: number,
  hostname: string,
  station: string,
  load: number,
  cityId: number,
  cityName: string,
): NordVpnServer {
  return { id, name: hostname, hostname, station, load, publicKey: `public-${id}`, cityId, cityName };
}
