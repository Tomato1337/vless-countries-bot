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
  countrySlug: string;
  email: string;
  subId: string;
  uuid: string;
}

export interface Country {
  slug: string;
  uri: string;
  outbound: XrayOutbound;
  createdAt: string;
  updatedAt: string;
}

export interface XuiApi {
  checkCompatibility(geOutboundTag: string, inboundId: number): Promise<void>;
  getTemplate(): Promise<XrayTemplate>;
  updateTemplate(template: XrayTemplate): Promise<void>;
  testOutbound(outbound: XrayOutbound, allOutbounds: XrayOutbound[]): Promise<void>;
  listClients(): Promise<XuiClient[]>;
  createClient(client: ManagedClient, inboundId: number): Promise<void>;
  renameClient(client: ManagedClient, nextEmail: string, inboundId: number): Promise<void>;
  deleteClient(client: Pick<ManagedClient, "email" | "uuid">): Promise<void>;
}
