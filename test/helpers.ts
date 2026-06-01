import type { ManagedClient, OutboundTestResult, XrayOutbound, XrayTemplate, XuiApi, XuiClient } from "../src/types.ts";

export const REALITY_URI =
  "vless://74b0b096-5d02-11f1-a319-52cf4084cd34@usa12.vpnjantit.com:443?type=tcp&security=reality&sni=cloudflare.com&fp=chrome&pbk=g03nwLrMnwsZs7posvVRTelixQToNkNV2-QQCZa1Mjo&sid=ea81553e93920d38&flow=xtls-rprx-vision#usa";
export const NORD_PRIVATE_KEY = Buffer.alloc(32, 1).toString("base64");

export function baseTemplate(): XrayTemplate {
  return {
    outbounds: [
      { tag: "germany", protocol: "vless", settings: {} },
      { tag: "direct", protocol: "freedom", settings: {} },
    ],
    routing: {
      rules: [{ type: "field", network: "tcp,udp", outboundTag: "germany" }],
    },
  };
}

export class MockXui implements XuiApi {
  template = baseTemplate();
  clients: XuiClient[] = [
    { email: "ilya-phone", subId: "Ilya", inboundIds: [1] },
    { email: "ilya-pc", subId: "Ilya", inboundIds: [1] },
    { email: "denis-phone", subId: "Denis", inboundIds: [1] },
  ];
  created: ManagedClient[] = [];
  deleted: string[] = [];
  renamed: Array<{ from: string; to: string }> = [];
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
    const settings = outbound.settings as { peers?: Array<{ endpoint?: string }> } | undefined;
    const endpoint = settings?.peers?.[0]?.endpoint ?? "";
    if ([...this.failTestHostnames].some((hostname) => endpoint.startsWith(hostname))) {
      throw new Error("outbound test failed");
    }
    return { success: true };
  }

  async listClients(): Promise<XuiClient[]> {
    return structuredClone(this.clients);
  }

  async createClient(client: ManagedClient, inboundId: number): Promise<void> {
    if (client.email === this.failCreateEmail) {
      throw new Error("create failed");
    }
    this.created.push(structuredClone(client));
    this.clients.push({ email: client.email, subId: client.subId, inboundIds: [inboundId] });
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
