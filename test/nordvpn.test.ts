import { describe, expect, test } from "bun:test";
import {
  assertNordVpnPrivateKey,
  buildNordVpnOutbound,
  buildNordVpnSource,
  NordVpnCatalog,
  nordVpnRegionSlug,
} from "../src/nordvpn.ts";
import { NORD_PRIVATE_KEY } from "./helpers.ts";

export function nordApiResponse() {
  return {
    locations: [
      { id: 10, country: { city: { id: 100, name: "Chicago" } } },
      { id: 11, country: { city: { id: 101, name: "New York" } } },
      { id: 12, country: null },
    ],
    servers: [
      nordServer(1, "us-one.nordvpn.com", "198.51.100.1", 15, 10),
      nordServer(2, "us-two.nordvpn.com", "198.51.100.2", 5, 10),
      nordServer(3, "us-new-york.nordvpn.com", "198.51.100.3", 9, 11),
      { id: 4, hostname: "missing-key.nordvpn.com", station: "198.51.100.4", location_ids: [10], technologies: [] },
    ],
  };
}

export function nordServer(id: number, hostname: string, station: string, load: number, locationId: number) {
  return {
    id,
    name: hostname,
    hostname,
    station,
    load,
    location_ids: [locationId],
    technologies: [{ id: 35, metadata: [{ name: "public_key", value: `public-key-${id}` }] }],
  };
}

describe("NordVPN", () => {
  test("validates WireGuard keys and builds a GE-chained outbound", () => {
    expect(assertNordVpnPrivateKey(NORD_PRIVATE_KEY)).toBe(NORD_PRIVATE_KEY);
    expect(() => assertNordVpnPrivateKey("broken")).toThrow("exactly 32 bytes");
    const source = buildNordVpnSource(
      { id: 1, code: "US", name: "United States" },
      { id: 100, name: "Chicago" },
      {
        id: 2,
        name: "US two",
        hostname: "us-two.nordvpn.com",
        station: "198.51.100.2",
        load: 5,
        publicKey: "public-key-2",
        cityId: 100,
        cityName: "Chicago",
      },
    );
    const outbound = buildNordVpnOutbound("us-chicago", source, NORD_PRIVATE_KEY, "germany");

    expect(outbound.tag).toBe("countries-nord-exit-us-chicago");
    expect(outbound.protocol).toBe("wireguard");
    expect(outbound.proxySettings).toEqual({ tag: "germany", transportLayer: true });
    expect((outbound.settings as { peers: unknown[] }).peers).toEqual([
      { publicKey: "public-key-2", endpoint: "198.51.100.2:51820" },
    ]);
    expect(outbound.settings).toMatchObject({
      mtu: 1280,
      noKernelTun: true,
    });
  });

  test("parses, sorts and caches public NordVPN servers", async () => {
    let calls = 0;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      calls += 1;
      const url = String(input);
      if (url.includes("/v1/countries")) {
        return Response.json([{ id: 1, code: "US", name: "United States" }]);
      }
      return Response.json(nordApiResponse());
    };
    const catalog = new NordVpnCatalog(fetchImpl as typeof fetch);

    expect(await catalog.listCountries()).toEqual([{ id: 1, code: "US", name: "United States" }]);
    expect((await catalog.listServers(1)).map((server) => server.hostname)).toEqual([
      "us-two.nordvpn.com",
      "us-new-york.nordvpn.com",
      "us-one.nordvpn.com",
    ]);
    expect(await catalog.listCities(1)).toEqual([
      { id: 100, name: "Chicago" },
      { id: 101, name: "New York" },
    ]);
    expect(calls).toBe(2);
  });

  test("generates readable region slugs with an optional collision suffix", () => {
    expect(nordVpnRegionSlug("US", "New York")).toBe("us-new-york");
    expect(nordVpnRegionSlug("US", "New York", 101)).toBe("us-new-york-101");
  });
});
