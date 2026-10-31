// HSP Agentic Payment client: the hackathon's HSP QA surface is an MCP server (streamable HTTP)
// with eight tools. Live input schemas are only visible once our egress IP is allowlisted, so
// argument names are resolved against each tool's advertised inputSchema, falling back to the
// names in the setup guide (https://dorahacks.io/hackathon/hskchainindia/agentic-payment-guide).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const HSP_AGENTIC_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
type ToolName = (typeof HSP_AGENTIC_TOOLS)[number];

/** Terminal statuses from the guide; everything else keeps polling. */
export const AGENTIC_DONE = ["payment-safe", "payment-finalized"];

export interface AgenticToken {
  network: string;
  chainId: number;
  symbol: string;
  address: string;
  decimals: number;
  protocol: string;
}

export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface Prepared {
  eip712: Eip712Payload;
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at?: string;
  pay_to?: string;
  payer?: string;
  payment_request_id?: string;
  payment_payload: unknown;
  payment_mandate_contents: unknown;
  gas_fee_advanced?: boolean;
  [k: string]: unknown;
}

export interface AgenticPayment {
  status: string;
  status_reason?: string;
  tx_signature?: string;
  to_pay_address?: string;
  payer_address?: string;
  network?: string;
  [k: string]: unknown;
}

/** Parse a tool result: JSON text or structuredContent, unwrapping a {code, data} envelope. */
function parseResult(name: string, r: { content?: unknown; structuredContent?: unknown; isError?: unknown }) {
  const text = Array.isArray(r.content) ? r.content.filter((c: { type?: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") : "";
  if (r.isError) throw new Error(`HSP ${name}: ${text || "tool error"}`);
  let v: unknown = r.structuredContent;
  if (v === undefined) {
    try {
      v = JSON.parse(text);
    } catch {
      v = text;
    }
  }
  if (v && typeof v === "object" && "code" in v && "data" in v) {
    const env = v as { code: unknown; msg?: string; data: unknown };
    if (env.code !== 0 && env.code !== "0" && env.code !== 200) throw new Error(`HSP ${name}: ${env.code} ${env.msg ?? ""}`);
    v = env.data;
  }
  return v as Record<string, unknown>;
}

/** Walk get_chain_config output for every (network, token) pair, whatever the nesting. */
export function tokensFromConfig(cfg: unknown): AgenticToken[] {
  const out: AgenticToken[] = [];
  // HSP QA returns flat {networks: [{chain_id, name}], tokens: [{chain_id, address, ...}]}
  const names = new Map<number, string>();
  const nets = (cfg as { networks?: unknown })?.networks;
  if (Array.isArray(nets)) for (const n of nets as Record<string, unknown>[]) names.set(Number(n.chain_id ?? n.chainId), String(n.name ?? n.network ?? n.chain_id));
  const visit = (node: unknown, net?: { network: string; chainId: number }) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, net));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const chainId = Number(o.chain_id ?? o.chainId ?? NaN);
    const here = Number.isFinite(chainId) ? { network: String(o.network ?? names.get(chainId) ?? o.name ?? o.chain ?? chainId), chainId } : net;
    if (Array.isArray(o.tokens)) {
      for (const t of o.tokens as Record<string, unknown>[]) {
        const tid = Number(t.chain_id ?? t.chainId ?? NaN);
        const tnet = Number.isFinite(tid) ? { network: String(t.network ?? names.get(tid) ?? tid), chainId: tid } : here;
        if (!tnet) continue;
        out.push({
          ...tnet,
          symbol: String(t.symbol ?? t.coin ?? t.name ?? ""),
          address: String(t.address ?? t.contract_address ?? ""),
          decimals: Number(t.decimals ?? 6),
          protocol: String(t.payment_protocol ?? t.protocol ?? "eip3009").toLowerCase(),
        });
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && typeof v === "object") visit(v, here);
  };
  visit(cfg);
  return out;
}

export class HspAgentic {
  private client?: Client;
  private schemas = new Map<string, Set<string>>();

  constructor(private url: string) {}

  async connect() {
    if (this.client) return this.client;
    const client = new Client({ name: "allscale-agent-id", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    const { tools } = await client.listTools();
    for (const t of tools) this.schemas.set(t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})));
    const missing = HSP_AGENTIC_TOOLS.filter((n) => !this.schemas.has(n));
    if (missing.length) {
      await client.close();
      throw new Error(`HSP MCP is missing tools: ${missing.join(", ")}`);
    }
    this.client = client;
    return client;
  }

  async tools() {
    const client = await this.connect();
    return (await client.listTools()).tools;
  }

  /** First candidate name the tool's schema declares; the guide's name if the schema is silent. */
  private key(tool: ToolName, ...candidates: string[]) {
    const props = this.schemas.get(tool);
    return candidates.find((c) => props?.has(c)) ?? candidates[0];
  }

  private async call(name: ToolName, args: Record<string, unknown>) {
    const client = await this.connect();
    try {
      return parseResult(name, (await client.callTool({ name, arguments: args })) as never);
    } catch (e) {
      // one reconnect for dropped sessions; tool errors are rethrown as-is
      if (/HSP /.test((e as Error).message)) throw e;
      this.client = undefined;
      return parseResult(name, (await (await this.connect()).callTool({ name, arguments: args })) as never);
    }
  }

  async chainConfig() {
    const raw = await this.call("get_chain_config", {});
    return { raw, tokens: tokensFromConfig(raw) };
  }

  async createOrder(merchantName: string, payTo: string, cartMandate: unknown) {
    const r = await this.call("create_order", { merchant_name: merchantName, pay_to: payTo, cart_mandate: cartMandate });
    const flow_id = String(r.flow_id ?? "");
    const payment_request_id = String(r.payment_request_id ?? "");
    if (!flow_id || !payment_request_id) throw new Error(`HSP create_order returned no flow_id / payment_request_id: ${JSON.stringify(r).slice(0, 200)}`);
    return { flow_id, payment_request_id, payment_url: r.payment_url as string | undefined };
  }

  getOrder(flowId: string) {
    return this.call("get_order", { flow_id: flowId });
  }

  async prepare(flowId: string, payer: string, protocol: string) {
    return (await this.call("prepare_payment", {
      flow_id: flowId,
      [this.key("prepare_payment", "payer", "payer_address", "from")]: payer,
      [this.key("prepare_payment", "protocol", "payment_protocol")]: protocol,
    })) as unknown as Prepared;
  }

  async finalize(signature: string, p: Prepared) {
    const r = await this.call("finalize_payment", {
      signature,
      payment_payload: p.payment_payload,
      payment_mandate_contents: p.payment_mandate_contents,
      cart_hash: p.cart_hash,
    });
    const json = r.payment_mandate_json ?? r;
    return json as unknown;
  }

  submit(paymentMandateJson: unknown) {
    return this.call("submit_payment", { [this.key("submit_payment", "payment_mandate_json", "payment_mandate")]: paymentMandateJson });
  }

  async query(ids: { flowId?: string; paymentRequestId?: string }, merchantName: string) {
    const r = await this.call("query_payment", {
      ...(ids.flowId ? { flow_id: ids.flowId } : {}),
      ...(ids.paymentRequestId ? { payment_request_id: ids.paymentRequestId } : {}),
      expected_merchant_name: merchantName,
    });
    const payment = (r.payment ?? r) as AgenticPayment;
    return { payment, attributionVerified: r.attribution_verified as boolean | undefined };
  }
}
