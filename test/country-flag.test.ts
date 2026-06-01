import { describe, expect, test } from "bun:test";
import { countryCodeFromSlug, countryFlagFromSlug, managedClientEmail } from "../src/country-flag.ts";

describe("country flags", () => {
  test("uses common aliases and ISO-2 prefixes", () => {
    expect(countryCodeFromSlug("usa")).toBe("US");
    expect(countryFlagFromSlug("germany")).toBe("🇩🇪");
    expect(managedClientEmail("ilya", "nl-free")).toBe("🇳🇱-ilya-nl-free");
    expect(managedClientEmail("ilya", "nl-free")).not.toContain(" ");
  });

  test("rejects slugs without a country prefix", () => {
    expect(() => countryFlagFromSlug("moon")).toThrow("Cannot infer a country flag");
  });
});
