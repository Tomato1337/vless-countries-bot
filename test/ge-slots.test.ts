import { describe, expect, test } from "bun:test";
import { CountryService } from "../src/country-service.ts";
import { applyGeSlotRouting, generateGeIpv6Slots } from "../src/ge-slots.ts";
import { ProxyService } from "../src/proxy-service.ts";
import { Store } from "../src/store.ts";
import type { XrayOutbound } from "../src/types.ts";
import { MockUrnetwork, MockXui } from "./helpers.ts";

const GE_UUID = "11111111-2222-3333-4444-555555555555";

function setup(slotCount = 4) {
  const store = new Store();
  const xui = new MockXui();
  xui.template.outbounds[0] = {
    tag: "germany",
    protocol: "vless",
    settings: { address: "ge.test", port: 443, id: GE_UUID, vnext: [{ users: [{ id: GE_UUID }] }] },
    streamSettings: { network: "xhttp", security: "reality" },
  };
  const slots = generateGeIpv6Slots("2001:db8:1234::/48", slotCount);
  const countries = new CountryService(store, xui, { geOutboundTag: "germany", inboundId: 1 });
  const proxies = new ProxyService(
    store,
    xui,
    new MockUrnetwork(),
    { geOutboundTag: "germany", inboundId: 1, geIpv6Slots: slots },
    countries.mutex,
  );
  store.setUrnetworkKey("Ilya", "urn_ilya");
  store.setUrnetworkKey("Denis", "urn_denis");
  return { store, xui, slots, proxies };
}

function outbound(xui: MockXui, tag: string): XrayOutbound | undefined {
  return xui.template.outbounds.find((item) => item.tag === tag);
}

describe("GE IPv6 slots", () => {
  test("chains each subscription's URnetwork proxies through its own GE client and keeps it across re-creation", async () => {
    const { xui, slots, proxies } = setup();
    const subscriptions = await proxies.listSubscriptions();

    await proxies.addUrnetworkProxies(1, subscriptions, "de", "https");
    await proxies.addUrnetworkProxies(1, subscriptions, "nl", "https");

    const ilyaDe = outbound(xui, "proxies-ilya--ur-de")!;
    const ilyaNl = outbound(xui, "proxies-ilya--ur-nl")!;
    const denisDe = outbound(xui, "proxies-denis--ur-de")!;
    const ilyaChain = (ilyaDe.streamSettings as { sockopt: { dialerProxy: string } }).sockopt.dialerProxy;
    const denisChain = (denisDe.streamSettings as { sockopt: { dialerProxy: string } }).sockopt.dialerProxy;
    expect(ilyaNl.streamSettings).toMatchObject({ sockopt: { dialerProxy: ilyaChain } });
    expect(denisChain).not.toBe(ilyaChain);

    const ilyaAddress = proxies.ipv6Address("Ilya")!;
    const ilyaSlot = slots.find((slot) => slot.address === ilyaAddress)!;
    expect(ilyaChain).toBe(`ge-${ilyaSlot.email}`);
    // The chain is the GE outbound authenticated as the slot's GE client; nothing else differs.
    const chain = outbound(xui, ilyaChain)!;
    expect(chain.settings).toEqual({
      address: "ge.test",
      port: 443,
      id: ilyaSlot.uuid,
      vnext: [{ users: [{ id: ilyaSlot.uuid }] }],
    });
    expect(chain.streamSettings).toEqual({ network: "xhttp", security: "reality" });
    expect(xui.template.outbounds.filter((item) => item.tag.startsWith("ge-ipv6-slot-"))).toHaveLength(2);

    await proxies.removeProxies(1, proxies.listProxies("Ilya").map((proxy) => proxy.id));
    expect(outbound(xui, ilyaChain)).toBeUndefined();
    expect(outbound(xui, denisChain)).toBeDefined();

    await proxies.addUrnetworkProxies(1, [await proxies.requireSubscription("ilya")], "de", "https");
    expect(proxies.ipv6Address("Ilya")).toBe(ilyaAddress);
    expect(outbound(xui, "proxies-ilya--ur-de")!.streamSettings).toMatchObject({ sockopt: { dialerProxy: ilyaChain } });
  });

  test("sync re-chains proxies created before slots existed", async () => {
    const { store, xui, proxies } = setup();
    const legacy = new ProxyService(store, xui, new MockUrnetwork(), { geOutboundTag: "germany", inboundId: 1 }, new CountryService(store, xui, { geOutboundTag: "germany", inboundId: 1 }).mutex);
    await legacy.addUrnetworkProxies(1, [await legacy.requireSubscription("ilya")], "de", "https");
    expect(outbound(xui, "proxies-ilya--ur-de")!.streamSettings).toMatchObject({ sockopt: { dialerProxy: "germany" } });

    expect(await proxies.syncIpv6Slots(1)).toBe(1);

    const chain = `ge-ipv6-slot-${String(store.listIpv6SlotBindings().get("Ilya")).padStart(2, "0")}`;
    expect(outbound(xui, "proxies-ilya--ur-de")!.streamSettings).toMatchObject({ sockopt: { dialerProxy: chain } });
    expect(outbound(xui, chain)).toBeDefined();
    expect(store.listProxies("Ilya")[0]!.outbound.streamSettings).toMatchObject({ sockopt: { dialerProxy: chain } });
  });

  test("fails a subscription cleanly when every slot is taken", async () => {
    const { proxies } = setup(1);

    const result = await proxies.addUrnetworkProxies(1, await proxies.listSubscriptions(), "de", "https");

    expect(result.added.map((proxy) => proxy.subId)).toHaveLength(1);
    expect(result.failed).toEqual([{ slug: expect.any(String), reason: expect.stringContaining("закончились IPv6-адреса") }]);
  });

  test("GE routing sends each slot client to its own address before domain rules", () => {
    const slots = generateGeIpv6Slots("2001:db8:1234::/48", 2);
    const template = {
      outbounds: [{ tag: "direct", protocol: "freedom" }, { tag: "warp", protocol: "wireguard" }],
      routing: { rules: [{ inboundTag: ["api"], outboundTag: "api" }, { domain: ["geosite:reddit"], outboundTag: "warp" }] },
    };

    const once = applyGeSlotRouting(template, slots);
    const twice = applyGeSlotRouting(once, slots);

    expect(twice).toEqual(once);
    expect(once.routing.rules.map((rule) => rule.outboundTag)).toEqual(["api", slots[0]!.email, slots[1]!.email, "warp"]);
    expect(once.outbounds[2]).toEqual({
      tag: slots[0]!.email,
      protocol: "freedom",
      sendThrough: slots[0]!.address,
      targetStrategy: "UseIPv6",
    });
    for (const slot of slots) {
      expect(slot.address.startsWith("2001:db8:1234:")).toBe(true);
      expect(slot.address.split(":")).toHaveLength(8);
    }
  });
});
