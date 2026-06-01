import { countryOutboundTag } from "./vless.ts";
import type { JsonObject, XrayOutbound, XrayRoutingRule, XrayTemplate } from "./types.ts";

const MANAGED_RULE_PREFIX = "countries-route-";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertTemplate(value: unknown): asserts value is XrayTemplate {
  if (!value || typeof value !== "object") {
    throw new Error("3x-ui returned an invalid Xray template");
  }
  const template = value as Partial<XrayTemplate>;
  if (!Array.isArray(template.outbounds)) {
    throw new Error("Xray template is missing outbounds");
  }
  if (!template.routing || typeof template.routing !== "object") {
    throw new Error("Xray template is missing routing");
  }
  if (!Array.isArray(template.routing.rules)) {
    throw new Error("Xray template is missing routing.rules");
  }
}

export function assertGeOutbound(template: XrayTemplate, geOutboundTag: string): void {
  if (!template.outbounds.some((outbound) => outbound.tag === geOutboundTag)) {
    throw new Error(`Germany outbound tag was not found: ${geOutboundTag}`);
  }
}

export function countryRuleTag(slug: string): string {
  return `${MANAGED_RULE_PREFIX}${slug}`;
}

export function createCountryRule(slug: string): XrayRoutingRule {
  return createExitRule(slug, countryOutboundTag(slug));
}

export function createExitRule(slug: string, outboundTag: string): XrayRoutingRule {
  return {
    type: "field",
    ruleTag: countryRuleTag(slug),
    user: [`regexp:.*-${slug}$`],
    outboundTag,
  };
}

export function upsertCountry(
  template: XrayTemplate,
  slug: string,
  outbound: XrayOutbound,
): XrayTemplate {
  return upsertExit(template, slug, outbound);
}

export function upsertExit(
  template: XrayTemplate,
  slug: string,
  outbound: XrayOutbound,
): XrayTemplate {
  const next = clone(template);
  next.outbounds = next.outbounds.filter((item) => item.tag !== outbound.tag);
  next.outbounds.push(outbound);

  next.routing.rules = next.routing.rules.filter(
    (rule) => rule.ruleTag !== countryRuleTag(slug),
  );
  // Country rules must run before broader existing rules.
  next.routing.rules.unshift(createExitRule(slug, outbound.tag));
  return next;
}

export function removeCountry(template: XrayTemplate, slug: string): XrayTemplate {
  return removeExit(template, slug, countryOutboundTag(slug));
}

export function removeExit(template: XrayTemplate, slug: string, outboundTag: string): XrayTemplate {
  const next = clone(template);
  next.outbounds = next.outbounds.filter((item) => item.tag !== outboundTag);
  next.routing.rules = next.routing.rules.filter(
    (rule) => rule.ruleTag !== countryRuleTag(slug),
  );
  return next;
}

export function findCountryOutbound(
  template: XrayTemplate,
  slug: string,
): XrayOutbound | undefined {
  return template.outbounds.find((item) => item.tag === countryOutboundTag(slug));
}

export function asTemplate(value: unknown): XrayTemplate {
  assertTemplate(value);
  return value;
}

export function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as JsonObject;
}
