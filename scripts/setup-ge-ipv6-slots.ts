// One-time, idempotent GE setup for per-account IPv6 exits to ur.io.
//
//   GE_XUI_BASE_URL=https://ge-panel.example.com:8080/secret-panel-path GE_XUI_INBOUND_ID=4 \
//   GE_IPV6_PREFIX=2001:db8:1234::/48 bun scripts/setup-ge-ipv6-slots.ts
//
// Creates (or reuses) the slots file, adds one GE inbound client per slot and rewrites the GE Xray template with the
// slot outbounds and rules. The addresses themselves are put on the GE interface by deploy/ge-ipv6-slots.service.
// GE_XUI_USERNAME / GE_XUI_PASSWORD default to XUI_USERNAME / XUI_PASSWORD.
import { applyGeSlotRouting, generateGeIpv6Slots, loadGeIpv6Slots } from "../src/ge-slots.ts";
import { HttpXuiClient } from "../src/xui-client.ts";

const SLOT_COUNT = 32;

function env(key: string, fallback?: string): string {
  const value = Bun.env[key]?.trim() || fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

const slotsPath = env("GE_IPV6_SLOTS_PATH", "./data/ge-ipv6-slots.json");
const inboundId = Number(env("GE_XUI_INBOUND_ID"));
const ge = new HttpXuiClient({
  baseUrl: env("GE_XUI_BASE_URL"),
  username: env("GE_XUI_USERNAME", Bun.env.XUI_USERNAME),
  password: env("GE_XUI_PASSWORD", Bun.env.XUI_PASSWORD),
});

let slots = await loadGeIpv6Slots(slotsPath);
if (!slots) {
  slots = generateGeIpv6Slots(env("GE_IPV6_PREFIX"), SLOT_COUNT);
  await Bun.write(slotsPath, `${JSON.stringify({ slots }, null, 2)}\n`);
  console.log(`Generated ${slots.length} slots into ${slotsPath}`);
}

// Any existing outbound works for the compatibility probe; it also selects the panel's client API flavour.
await ge.checkCompatibility("direct", inboundId);
const existing = new Set((await ge.listClients()).map((client) => client.email));
for (const slot of slots) {
  if (existing.has(slot.email)) {
    continue;
  }
  const subId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  await ge.createClient({ email: slot.email, subId, uuid: slot.uuid }, inboundId);
  console.log(`Added GE client ${slot.email}`);
}

const template = await ge.getTemplate();
const next = applyGeSlotRouting(template, slots);
if (JSON.stringify(next) === JSON.stringify(template)) {
  console.log("GE template already up to date");
} else {
  await ge.updateTemplate(next);
  console.log(`GE template updated: ${slots.length} slot outbounds and rules`);
}
