import type {
  ManagedClient,
  OutboundTestResult,
  UrnetworkApi,
  UrnetworkCountry,
  UrnetworkUpstream,
  XrayOutbound,
  XrayTemplate,
  XuiApi,
  XuiClient,
} from "../src/types.ts";

type BaseClient = Pick<ManagedClient, "email" | "subId" | "uuid">;

export const REALITY_URI =
  "vless://00000000-0000-4000-8000-000000000001@usa.vless.example.com:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=ExampleRealityPublicKeyForUnitTests00000000&sid=0123456789abcdef&flow=xtls-rprx-vision#usa";
export const NORD_PRIVATE_KEY = Buffer.alloc(32, 1).toString("base64");

export function baseTemplate(): XrayTemplate {
  return {
    outbounds: [
      { tag: "germany", protocol: "vless", settings: {} },
      { tag: "direct", protocol: "freedom", settings: {} },
    ],
    routing: {
      rules: [
        { type: "field", user: ["regexp:.*-russia$"], outboundTag: "direct" },
        { type: "field", network: "tcp,udp", outboundTag: "germany" },
      ],
    },
  };
}

export class MockXui implements XuiApi {
  template = baseTemplate();
  clients: XuiClient[] = [
    { email: "ilya-phone", subId: "Ilya", inboundIds: [1] },
    { email: "ilya-pc", subId: "Ilya", inboundIds: [1] },
    { email: "ilya-russia", subId: "Ilya", inboundIds: [1] },
    { email: "denis-phone", subId: "Denis", inboundIds: [1] },
    { email: "denis-russia", subId: "Denis", inboundIds: [1] },
  ];
  created: BaseClient[] = [];
  subscriptionBaseUrl: string | undefined = "https://sub.test:2096/sub/";
  deleted: string[] = [];
  renamed: Array<{ from: string; to: string }> = [];
  attached: string[] = [];
  tested: XrayOutbound[] = [];
  failTestHostnames = new Set<string>();
  failUpdateOnCall?: number;
  failCreateEmail?: string;
  private updateCalls = 0;

  async checkCompatibility(geOutboundTag: string, inboundId: number): Promise<void> {
    if (!this.template.outbounds.some((outbound) => outbound.tag === geOutboundTag)) {
      throw new Error("missing GE outbound");
    }
    if (inboundId !== 1) {
      throw new Error("missing inbound");
    }
  }

  async getTemplate(): Promise<XrayTemplate> {
    return structuredClone(this.template);
  }

  async updateTemplate(template: XrayTemplate): Promise<void> {
    this.updateCalls += 1;
    if (this.failUpdateOnCall === this.updateCalls) {
      throw new Error("update failed");
    }
    this.template = structuredClone(template);
  }

  async testOutbound(outbound: XrayOutbound): Promise<OutboundTestResult> {
    this.tested.push(structuredClone(outbound));
    const settings = outbound.settings as {
      peers?: Array<{ endpoint?: string }>;
      servers?: Array<{ address?: string }>;
      address?: string;
    } | undefined;
    // Mirrors 3x-ui extractOutboundEndpoints: http/socks endpoints come only from settings.servers[].
    const endpoint = ["http", "socks"].includes(outbound.protocol)
      ? settings?.servers?.[0]?.address ?? ""
      : settings?.peers?.[0]?.endpoint ?? settings?.address ?? "";
    if (!endpoint) {
      throw new Error("No testable endpoint");
    }
    if ([...this.failTestHostnames].some((hostname) => endpoint.startsWith(hostname))) {
      throw new Error("outbound test failed");
    }
    return { success: true };
  }

  async listClients(): Promise<XuiClient[]> {
    return structuredClone(this.clients);
  }

  async createClient(client: BaseClient, inboundId: number): Promise<void> {
    if (client.email === this.failCreateEmail) {
      throw new Error("create failed");
    }
    this.created.push(structuredClone(client));
    this.clients.push({ email: client.email, subId: client.subId, inboundIds: [inboundId] });
  }

  async attachClient(email: string, inboundId: number): Promise<void> {
    this.attached.push(email);
    const existing = this.clients.find((item) => item.email === email);
    if (!existing) {
      throw new Error("attach failed");
    }
    existing.inboundIds.push(inboundId);
  }

  async getSubscriptionBaseUrl(): Promise<string | undefined> {
    return this.subscriptionBaseUrl;
  }

  async deleteClient(client: Pick<ManagedClient, "email" | "uuid">): Promise<void> {
    this.deleted.push(client.email);
    this.clients = this.clients.filter((item) => item.email !== client.email);
  }

  async renameClient(client: ManagedClient, nextEmail: string): Promise<void> {
    this.renamed.push({ from: client.email, to: nextEmail });
    const existing = this.clients.find((item) => item.email === client.email);
    if (!existing) {
      throw new Error("rename failed");
    }
    existing.email = nextEmail;
  }
}

export class MockUrnetwork implements UrnetworkApi {
  countries: UrnetworkCountry[] = [
    { code: "de", name: "Germany", providerCount: 100 },
    { code: "nl", name: "Netherlands", providerCount: 50 },
  ];
  created: Array<{ apiKey: string; location: string; uniqueExit: boolean; clientId: string }> = [];
  removed: string[] = [];
  exchangedCodes: string[] = [];
  invalidKeys = new Set<string>();
  private nextClient = 1;

  async listCountries(): Promise<UrnetworkCountry[]> {
    return structuredClone(this.countries);
  }

  async createApiKey(authCode: string): Promise<string> {
    this.exchangedCodes.push(authCode);
    return `urn_from_${authCode}`;
  }

  async verifyApiKey(apiKey: string): Promise<void> {
    if (this.invalidKeys.has(apiKey)) {
      throw new Error("URnetwork rejected the API key (HTTP 401)");
    }
  }

  async createProxy(apiKey: string, options: { location: string; uniqueExit: boolean }): Promise<UrnetworkUpstream> {
    const clientId = `client-${this.nextClient++}`;
    this.created.push({ apiKey, ...options, clientId });
    return {
      clientId,
      authToken: `token${clientId.replace("-", "")}`,
      proxyHost: "proxy.ur.test",
      httpsProxyPort: 8443,
      socksProxyPort: 8080,
      ...(options.uniqueExit ? { exitLocation: "Berlin, DE" } : {}),
    };
  }

  async removeProxy(_apiKey: string, clientId: string): Promise<void> {
    this.removed.push(clientId);
  }
}
