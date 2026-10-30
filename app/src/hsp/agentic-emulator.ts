// Local stand-in for the HSP Agentic Payment MCP server (HSP QA), built to the hackathon setup
// guide: the same eight tools, the same prepare → sign → finalize → submit → query flow. It
// returns real EIP-3009 typed data, checks the payer's signature, relays the transfer on-chain
// and walks the HSP status machine, so the agentic rail runs end to end before allowlisting.
import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import { EIP3009_TYPES, paymentNet, relayTransferWithAuthorization, tokenDomain, toUnits } from "../chain.js";
import { canonicalJSON } from "./merchant-crypto.js";

interface Order {
  flow_id: string;
  payment_request_id: string;
  merchant_name: string;
  pay_to: Address;
  amountUsd: string;
  contents: Record<string, unknown>;
  quote?: { payer: Address; raw: string; auth: Record<string, string>; expires: number };
  payment?: Record<string, unknown>;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const err = (msg: string) => ({ ...text({ error: msg }), isError: true });

export function createAgenticEmulator(o: { token: Address; relayerKey: Hex; publicUrl: string }) {
  const orders = new Map<string, Order>();
  const byRequest = new Map<string, Order>();
  const network = paymentNet.config.hspName;
  const chainId = paymentNet.config.chainId;

  function build() {
    const s = new McpServer({ name: "hsp-agentic-payment (local)", version: "0.1.0" });

    s.registerTool("get_chain_config", { description: "Supported networks and tokens", inputSchema: {} }, async () =>
      text({ networks: [{ network, chain_id: chainId, tokens: [{ symbol: "USDC", address: o.token, decimals: 6, payment_protocol: "eip3009" }] }] }),
    );

    s.registerTool(
      "create_order",
      { description: "Create an HSP order from a cart mandate", inputSchema: { merchant_name: z.string(), pay_to: z.string(), cart_mandate: z.any() } },
      async ({ merchant_name, pay_to, cart_mandate }) => {
        const c = (cart_mandate?.contents ?? cart_mandate) as Record<string, any>;
        const pr = c?.payment_request;
        const md = pr?.method_data?.[0];
        if (!c?.id || !c.cart_expiry || !pr?.details) return err("cart_mandate.contents needs id, cart_expiry, payment_request");
        if (md?.supported_methods !== "https://www.x402.org/" || md?.data?.x402Version !== 2) return err("method_data must be x402 v2");
        if (pr.details.total?.amount?.currency !== "USD") return err("amount.currency must be USD");
        if (!/^0x[0-9a-fA-F]{40}$/.test(pay_to)) return err("pay_to must be an EVM address");
        const ord: Order = {
          flow_id: crypto.randomUUID(),
          payment_request_id: String(pr.details.id ?? `PR-${crypto.randomUUID()}`),
          merchant_name,
          pay_to: pay_to as Address,
          amountUsd: String(pr.details.total.amount.value),
          contents: c,
        };
        orders.set(ord.flow_id, ord);
        byRequest.set(ord.payment_request_id, ord);
        return text({ flow_id: ord.flow_id, payment_request_id: ord.payment_request_id, payment_url: `${o.publicUrl}/orders/${ord.flow_id}` });
      },
    );

    s.registerTool("get_order", { description: "Read an order", inputSchema: { flow_id: z.string() } }, async ({ flow_id }) => {
      const ord = orders.get(flow_id);
      if (!ord) return err("order not found");
      return text({ flow_id, payment_request_id: ord.payment_request_id, merchant_name: ord.merchant_name, pay_to: ord.pay_to, amount: { currency: "USD", value: ord.amountUsd }, network, chain_id: chainId, gas_fee_advanced: true });
    });

    s.registerTool("estimate_fee", { description: "Estimate the network fee", inputSchema: { flow_id: z.string().optional() } }, async () =>
      text({ gas_fee: "0", gas_fee_advanced: true }),
    );

    s.registerTool(
      "prepare_payment",
      { description: "Lock a quote and return EIP-712 data to sign", inputSchema: { flow_id: z.string(), payer: z.string(), protocol: z.enum(["eip3009", "permit2"]) } },
      async ({ flow_id, payer, protocol }) => {
        const ord = orders.get(flow_id);
        if (!ord) return err("order not found");
        if (protocol !== "eip3009") return err("this token uses eip3009");
        const raw = toUnits(ord.amountUsd).toString();
        const expires = Math.floor(Date.now() / 1000) + 300;
        const auth = { from: payer, to: ord.pay_to, value: raw, validAfter: "0", validBefore: String(expires), nonce: `0x${crypto.randomBytes(32).toString("hex")}` };
        ord.quote = { payer: payer as Address, raw, auth, expires };
        const domain = await tokenDomain(o.token);
        const cart_hash = crypto.createHash("sha256").update(canonicalJSON(ord.contents)).digest("hex");
        return text({
          eip712: {
            domain: { ...domain, chainId: String(domain.chainId) },
            types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...EIP3009_TYPES },
            primaryType: "TransferWithAuthorization",
            message: auth,
          },
          cart_hash,
          token_total_raw: raw,
          quote_expires_at: new Date(expires * 1000).toISOString(),
          pay_to: ord.pay_to,
          payer,
          payment_request_id: ord.payment_request_id,
          gas_fee_advanced: true,
          payment_payload: { x402Version: 2, scheme: "exact", network, payload: { signature: "", authorization: auth } },
          payment_mandate_contents: { payment_mandate_id: ord.payment_request_id, payment_details_id: ord.payment_request_id, merchant_agent: ord.merchant_name },
        });
      },
    );

    s.registerTool(
      "finalize_payment",
      { description: "Insert the wallet signature and build the payment mandate", inputSchema: { signature: z.string(), payment_payload: z.any(), payment_mandate_contents: z.any(), cart_hash: z.string() } },
      async ({ signature, payment_payload, payment_mandate_contents, cart_hash }) => {
        const ord = byRequest.get(String(payment_mandate_contents?.payment_mandate_id));
        if (!ord?.quote) return err("no prepared quote for this payment");
        const q = ord.quote;
        const ok = await verifyTypedData({
          address: q.payer,
          domain: await tokenDomain(o.token),
          types: EIP3009_TYPES,
          primaryType: "TransferWithAuthorization",
          message: { ...q.auth, value: BigInt(q.auth.value), validAfter: 0n, validBefore: BigInt(q.auth.validBefore) } as never,
          signature: signature as Hex,
        });
        if (!ok) return err("signature does not match the prepared EIP-712 data and payer");
        const payload = { ...payment_payload, payload: { ...payment_payload.payload, signature } };
        const payment_hash = crypto.createHash("sha256").update(canonicalJSON(payload)).digest("hex");
        const jwt = `local.${Buffer.from(JSON.stringify({ cart_hash, payment_hash })).toString("base64url")}.sig`;
        return text({ payment_mandate_json: JSON.stringify({ payment_mandate_contents: { ...payment_mandate_contents, payment_response: { method_name: "https://www.x402.org/", details: payload } }, user_authorization: jwt }) });
      },
    );

    s.registerTool("submit_payment", { description: "Submit the payment mandate to the Gateway", inputSchema: { payment_mandate_json: z.string() } }, async ({ payment_mandate_json }) => {
      const pm = JSON.parse(payment_mandate_json);
      const ord = byRequest.get(String(pm.payment_mandate_contents?.payment_mandate_id));
      if (!ord?.quote) return err("unknown payment");
      if (ord.payment && ord.payment.status !== "payment-failed") return err("payment already submitted");
      if (ord.quote.expires < Date.now() / 1000) return { ...text({ code: 30043, error: "quote expired" }), isError: true };
      const x = pm.payment_mandate_contents.payment_response.details.payload;
      const p: Record<string, unknown> = { status: "payment-submitted", payer_address: ord.quote.payer, to_pay_address: ord.pay_to, network, tx_signature: "" };
      ord.payment = p;
      const set = (status: string, extra: Record<string, unknown> = {}) => Object.assign(p, { status, ...extra });
      (async () => {
        try {
          set("payment-verified");
          set("payment-processing");
          const hash = await relayTransferWithAuthorization(o.relayerKey, o.token, x.authorization, x.signature);
          const r = await paymentNet.client.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error("transfer reverted");
          set("payment-included", { tx_signature: hash });
          setTimeout(() => set("payment-safe"), 1000);
          setTimeout(() => set("payment-finalized"), 2500);
        } catch (e) {
          set("payment-failed", { status_reason: (e as Error).message.split("\n")[0] });
        }
      })();
      return text({ status: "payment-submitted", flow_id: ord.flow_id, payment_request_id: ord.payment_request_id });
    });

    s.registerTool(
      "query_payment",
      { description: "Query payment status", inputSchema: { flow_id: z.string().optional(), payment_request_id: z.string().optional(), expected_merchant_name: z.string() } },
      async ({ flow_id, payment_request_id, expected_merchant_name }) => {
        const ord = (flow_id && orders.get(flow_id)) || (payment_request_id && byRequest.get(payment_request_id));
        if (!ord) return err("payment not found");
        return text({ payment: ord.payment ?? { status: "payment-required" }, attribution_verified: ord.merchant_name === expected_merchant_name });
      },
    );
    return s;
  }

  const router = express.Router();
  router.post("/", async (req, res) => {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.get("/health", (_req, res) => res.json({ status: "ok" }));
  router.get("/orders/:id", (req, res) => {
    const ord = orders.get(req.params.id);
    if (!ord) return res.status(404).send("Not found");
    res.json({ flow_id: ord.flow_id, payment_request_id: ord.payment_request_id, merchant_name: ord.merchant_name, pay_to: ord.pay_to, amount_usd: ord.amountUsd, payment: ord.payment ?? { status: "payment-required" } });
  });
  return router;
}
