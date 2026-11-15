import type { GeIpv6Slot, JsonObject, XrayOutbound, XrayRoutingRule, XrayTemplate } from "./types.ts";

// One GE IPv6 slot = one VLESS client on the GE inbound + one GE freedom outbound bound to its own IPv6 address.
// RU chains every URnetwork proxy of a subscription through that client, so ur.io sees one stable address per account.
const SLOT_EMAIL_PREFIX = "ipv6-slot-";
const RU_SLOT_TAG_PREFIX = "ge-";

export function geSlotEmail(slot: number): string {
  return `${SLOT_EMAIL_PREFIX}${String(slot).padStart(2, "0")}`;
}

/** RU outbound that reaches GE as the slot's client. */
export function ruSlotOutboundTag(slot: GeIpv6Slot): string {
  return `${RU_SLOT_TAG_PREFIX}${slot.email}`;
}

/** Random addresses spread over random /64s of a /48, so the slots share no /64 with each other or the host. */
export function generateGeIpv6Slots(prefix48: string, count: number): GeIpv6Slot[] {
  const head = parsePrefix48(prefix48);
  const addresses = new Set<string>();
  const slots: GeIpv6Slot[] = [];
  while (slots.length < count) {
    const words = new Uint16Array(5);
    crypto.getRandomValues(words);
    if (words[0] === 0) {
      continue; // subnet 0 holds the host's own address
    }
    const address = [...head, ...words].map((word) => word.toString(16)).join(":");
    if (addresses.has(address)) {
      continue;
    }
    addresses.add(address);
    const slot = slots.length + 1;
    slots.push({ slot, email: geSlotEmail(slot), uuid: crypto.randomUUID(), address });
  }
  return slots;
}

function parsePrefix48(prefix: string): number[] {
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/48$/i.exec(prefix.trim());
  if (!match) {
    throw new Error(`Expected an IPv6 /48 like 2001:db8:1234::/48, got ${prefix}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 16));
}

export function parseGeIpv6Slots(value: unknown): GeIpv6Slot[] {
  const slots = value && typeof value === "object" && "slots" in value ? value.slots : undefined;
  if (!Array.isArray(slots) || !slots.length) {
    throw new Error("GE IPv6 slots file has no slots");
  }
  const seen = new Set<string>();
  return slots.map((item: unknown) => {
    const slot = item as Partial<GeIpv6Slot>;
    if (
      !Number.isSafeInteger(slot.slot) || slot.slot! <= 0
      || slot.email !== geSlotEmail(slot.slot!)
      || typeof slot.uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(slot.uuid)
      || typeof slot.address !== "string" || !slot.address.includes(":")
    ) {
      throw new Error(`Invalid GE IPv6 slot: ${JSON.stringify(item)}`);
    }
    for (const key of [`n${slot.slot}`, `u${slot.uuid}`, `a${slot.address}`]) {
      if (seen.has(key)) {
        throw new Error(`Duplicate GE IPv6 slot value: ${key.slice(1)}`);
      }
      seen.add(key);
    }
    return { slot: slot.slot!, email: slot.email, uuid: slot.uuid, address: slot.address };
  });
}

/** `undefined` when the file does not exist: URnetwork proxies then dial ur.io through the plain GE outbound. */
export async function loadGeIpv6Slots(path: string): Promise<GeIpv6Slot[] | undefined> {
  const file = Bun.file(path);
  if (!await file.exists()) {
    return undefined;
  }
  return parseGeIpv6Slots(await file.json());
}

/** GE side: a freedom outbound per slot bound to its address, and a rule routing the slot's client to it. */
export function applyGeSlotRouting(template: XrayTemplate, slots: GeIpv6Slot[]): XrayTemplate {
  const next = structuredClone(template);
  next.outbounds = next.outbounds.filter((outbound) => !outbound.tag.startsWith(SLOT_EMAIL_PREFIX));
  next.routing.rules = next.routing.rules.filter((rule) => !rule.ruleTag?.startsWith(SLOT_EMAIL_PREFIX));
  next.outbounds.push(...slots.map((slot): XrayOutbound => ({
    tag: slot.email,
    protocol: "freedom",
    sendThrough: slot.address,
    // The source is IPv6, so the destination must be resolved to IPv6 too.
    targetStrategy: "UseIPv6",
  })));
  // Before every other rule except the panel API one: domain/IP rules (warp, IPv4) must not catch slot traffic.
  const apiIndex = next.routing.rules.findIndex((rule) => rule.outboundTag === "api");
  next.routing.rules.splice(apiIndex + 1, 0, ...slots.map((slot): XrayRoutingRule => ({
    type: "field",
    ruleTag: slot.email,
    user: [slot.email],
    outboundTag: slot.email,
  })));
  return next;
}

/**
 * RU side: one copy of the GE outbound per used slot, authenticated as the slot's client, and each listed proxy
 * outbound dialed through its slot. Slot outbounds no longer used are dropped.
 */
export function applyRuSlotChains(
  template: XrayTemplate,
  geOutboundTag: string,
  bindings: Array<{ proxyTag: string; slot: GeIpv6Slot }>,
): XrayTemplate {
  const next = structuredClone(template);
  next.outbounds = next.outbounds.filter((outbound) => !outbound.tag.startsWith(`${RU_SLOT_TAG_PREFIX}${SLOT_EMAIL_PREFIX}`));
  const geIndex = next.outbounds.findIndex((outbound) => outbound.tag === geOutboundTag);
  if (geIndex < 0) {
    throw new Error(`Germany outbound tag was not found: ${geOutboundTag}`);
  }
  const ge = next.outbounds[geIndex]!;
  const geUuid = vlessUserId(ge);
  const slots = new Map(bindings.map(({ slot }) => [slot.slot, slot]));
  const copies = [...slots.values()]
    .sort((a, b) => a.slot - b.slot)
    .map((slot) => ({ ...replaceString(ge, geUuid, slot.uuid) as XrayOutbound, tag: ruSlotOutboundTag(slot) }));
  next.outbounds.splice(geIndex + 1, 0, ...copies);
  for (const { proxyTag, slot } of bindings) {
    const outbound = next.outbounds.find((item) => item.tag === proxyTag);
    if (!outbound) {
      throw new Error(`Proxy outbound was not found: ${proxyTag}`);
    }
    const streamSettings = (outbound.streamSettings ?? {}) as JsonObject;
    outbound.streamSettings = {
      ...streamSettings,
      sockopt: { ...(streamSettings.sockopt as JsonObject | undefined), dialerProxy: ruSlotOutboundTag(slot) },
    };
  }
  return next;
}

// 3x-ui 3.x writes the VLESS user both flat (`settings.id`) and as `settings.vnext[0].users[0].id`.
function vlessUserId(outbound: XrayOutbound): string {
  if (outbound.protocol !== "vless") {
    throw new Error(`GE outbound ${outbound.tag} must be VLESS to chain IPv6 slots, got ${outbound.protocol}`);
  }
  const settings = (outbound.settings ?? {}) as JsonObject;
  const vnext = Array.isArray(settings.vnext) ? settings.vnext[0] as JsonObject | undefined : undefined;
  const user = Array.isArray(vnext?.users) ? vnext.users[0] as JsonObject | undefined : undefined;
  const id = user?.id ?? settings.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`GE outbound ${outbound.tag} has no VLESS user id`);
  }
  return id;
}

function replaceString(value: unknown, from: string, to: string): unknown {
  if (value === from) {
    return to;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceString(item, from, to));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceString(item, from, to)]));
  }
  return value;
}
