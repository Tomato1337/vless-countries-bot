export type JsonObject = Record<string, unknown>;

export interface XrayOutbound extends JsonObject {
  tag: string;
  protocol: string;
}

export interface XrayRoutingRule extends JsonObject {
  ruleTag?: string;
  outboundTag?: string;
}

export interface XrayTemplate extends JsonObject {
  outbounds: XrayOutbound[];
  routing: JsonObject & {
    rules: XrayRoutingRule[];
  };
}

export interface XuiClient {
  email: string;
  subId: string;
  inboundIds: number[];
}

export interface ManagedClient {
  exitSlug: string;
  email: string;
  subId: string;
  uuid: string;
}

export type ExitProvider = "manual-vless" | "nordvpn";

export interface ManualVlessSource extends JsonObject {
  uri: string;
}

export interface NordVpnSource extends JsonObject {
  countryId: number;
  countryCode: string;
  countryName: string;
  cityId: number;
  cityName: string;
  serverId: number;
  serverName: string;
  hostname: string;
  station: string;
  load: number;
  publicKey: string;
}

export interface VpnExit {
  id: number;
  slug: string;
  provider: ExitProvider;
  source: ManualVlessSource | NordVpnSource;
  outbound: XrayOutbound;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundTestResult {
  success: boolean;
  delay?: number;
  error?: string;
  mode?: string;
}

export interface WizardSession {
  chatId: number;
  userId: number;
  flow: string;
  step: string;
  payload: JsonObject;
  expiresAt: string;
}

export type ProxyProvider = "urnetwork" | "custom";

/** HTTPS works on every URnetwork plan; SOCKS5 needs UR Pro. */
export type UrnetworkProxyKind = "https" | "socks";

/** Where a URnetwork proxy exits: one country, or `best` for any provider on the network. */
export type UrnetworkLocation = string;
export const URNETWORK_BEST_AVAILABLE = "best";

export interface UrnetworkProxySource extends JsonObject {
  /** ISO-2 code in lower case, or `best`. */
  countryCode: UrnetworkLocation;
  countryName: string;
  kind: UrnetworkProxyKind;
  /** UR Pro: the proxy gets an exit IP that none of the account's other unique-exit proxies use. */
  uniqueExit?: boolean;
}

export interface CustomProxySource extends JsonObject {
  url: string;
}

/** A hosted proxy created on the subscription owner's URnetwork account. */
export interface UrnetworkUpstream extends JsonObject {
  clientId: string;
  authToken: string;
  proxyHost: string;
  httpsProxyPort: number;
  socksProxyPort: number;
  /** Unique-exit proxies only: where URnetwork placed the exit, e.g. "Berlin, DE". */
  exitLocation?: string;
}

export interface ProxyRecord {
  id: number;
  subId: string;
  name: string;
  provider: ProxyProvider;
  source: UrnetworkProxySource | CustomProxySource;
  upstream?: UrnetworkUpstream;
  outbound: XrayOutbound;
  email: string;
  uuid: string;
  createdBy: number;
  createdAt: string;
}

/** One GE IPv6 slot: the GE inbound client RU authenticates as, and the address GE sends from for it. */
export interface GeIpv6Slot {
  slot: number;
  /** GE client email, also the GE outbound and rule tag: `ipv6-slot-07`. */
  email: string;
  uuid: string;
  address: string;
}

export interface TelegramUserInfo {
  telegramId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  profileSubId?: string;
}

export interface UrnetworkCountry {
  code: string;
  name: string;
  providerCount: number;
}

export interface UrnetworkApi {
  listCountries(): Promise<UrnetworkCountry[]>;
  /** Exchanges a one-time ur.io auth code for a long-lived `urn_` API key. */
  createApiKey(authCode: string, name: string): Promise<string>;
  verifyApiKey(apiKey: string): Promise<void>;
  createProxy(
    apiKey: string,
    options: { location: UrnetworkLocation; uniqueExit: boolean },
    description: string,
  ): Promise<UrnetworkUpstream>;
  removeProxy(apiKey: string, clientId: string): Promise<void>;
}

export interface XuiApi {
  checkCompatibility(geOutboundTag: string, inboundId: number): Promise<void>;
  getTemplate(): Promise<XrayTemplate>;
  updateTemplate(template: XrayTemplate): Promise<void>;
  testOutbound(outbound: XrayOutbound, allOutbounds: XrayOutbound[]): Promise<OutboundTestResult>;
  listClients(): Promise<XuiClient[]>;
  createClient(client: Pick<ManagedClient, "email" | "subId" | "uuid">, inboundId: number): Promise<void>;
  attachClient(email: string, inboundId: number): Promise<void>;
  getSubscriptionBaseUrl(): Promise<string | undefined>;
  renameClient(client: ManagedClient, nextEmail: string, inboundId: number): Promise<void>;
  deleteClient(client: Pick<ManagedClient, "email" | "uuid">): Promise<void>;
}
