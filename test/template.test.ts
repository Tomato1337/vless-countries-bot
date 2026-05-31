import { describe, expect, test } from "bun:test";
import { createCountryRule, removeCountry, upsertCountry } from "../src/template.ts";
import { buildCountryOutbound } from "../src/vless.ts";
import { baseTemplate, REALITY_URI } from "./helpers.ts";

describe("Xray template merge", () => {
  test("preserves foreign objects and adds a prefixed country rule first", () => {
    const template = baseTemplate();
    const outbound = buildCountryOutbound("usa", REALITY_URI, "germany");
    const next = upsertCountry(template, "usa", outbound);

    expect(next.outbounds[0]).toEqual(template.outbounds[0]);
    expect(next.outbounds.at(-1)).toEqual(outbound);
    expect(next.routing.rules[0]).toEqual(createCountryRule("usa"));
    expect(next.routing.rules[1]).toEqual(template.routing.rules[0]);
    expect(template.outbounds).toHaveLength(2);
  });

  test("removes only matching managed objects", () => {
    const outbound = buildCountryOutbound("usa", REALITY_URI, "germany");
    const next = removeCountry(upsertCountry(baseTemplate(), "usa", outbound), "usa");
    expect(next).toEqual(baseTemplate());
  });
});

