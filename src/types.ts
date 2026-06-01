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

export interface XuiApi {
  checkCompatibility(geOutboundTag: string, inboundId: number): Promise<void>;
  getTemplate(): Promise<XrayTemplate>;
  updateTemplate(template: XrayTemplate): Promise<void>;
  testOutbound(outbound: XrayOutbound, allOutbounds: XrayOutbound[]): Promise<OutboundTestResult>;
  listClients(): Promise<XuiClient[]>;
  createClient(client: ManagedClient, inboundId: number): Promise<void>;
  renameClient(client: ManagedClient, nextEmail: string, inboundId: number): Promise<void>;
  deleteClient(client: Pick<ManagedClient, "email" | "uuid">): Promise<void>;
}
