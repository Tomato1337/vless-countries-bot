const COUNTRY_ALIASES: Record<string, string> = {
  argentina: "AR",
  australia: "AU",
  austria: "AT",
  belgium: "BE",
  brazil: "BR",
  bulgaria: "BG",
  canada: "CA",
  croatia: "HR",
  czechia: "CZ",
  england: "GB",
  finland: "FI",
  france: "FR",
  germany: "DE",
  holland: "NL",
  hongkong: "HK",
  hungary: "HU",
  iceland: "IS",
  india: "IN",
  ireland: "IE",
  israel: "IL",
  italy: "IT",
  japan: "JP",
  korea: "KR",
  mexico: "MX",
  netherlands: "NL",
  norway: "NO",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  serbia: "RS",
  singapore: "SG",
  spain: "ES",
  sweden: "SE",
  switzerland: "CH",
  taiwan: "TW",
  turkey: "TR",
  uae: "AE",
  uk: "GB",
  usa: "US",
};

export function countryCodeFromSlug(slug: string): string {
  const prefix = slug.split("-", 1)[0]!;
  const code = COUNTRY_ALIASES[prefix] ?? (/^[a-z]{2}$/.test(prefix) ? prefix.toUpperCase() : "");
  if (!code) {
    throw new Error(
      `Cannot infer a country flag from ${JSON.stringify(slug)}. Use an ISO-2 prefix such as us, de or nl-free.`,
    );
  }
  return code;
}

export function countryFlagFromSlug(slug: string): string {
  return [...countryCodeFromSlug(slug)]
    .map((letter) => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65))
    .join("");
}

export function managedClientEmail(subscriptionSlug: string, countrySlug: string): string {
  return `${countryFlagFromSlug(countrySlug)} ${subscriptionSlug}-${countrySlug}`;
}
