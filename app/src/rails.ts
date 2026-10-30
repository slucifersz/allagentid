// Payment rails. Seller agents quote and verify payment through a rail; the pay agent checks
// quotes and pays through it. Two HSP rails, picked by HSP_MODE:
//   coordinator — HSP Settlement Protocol: signed EIP-712 mandate, transfer from the agent's own
//                 wallet, Coordinator observes + verifies (hosted sandbox, or built in)
//   merchant    — HashKey Merchant gateway: seller's Cart Mandate is an HSP order; the payer signs
//                 an x402 / EIP-3009 Payment Mandate by API if enabled, otherwise the owner pays
//                 at the hosted checkout
import crypto from "node:crypto";
import { decodeEventLog, keccak256, parseAbi, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SellerSpec } from "./agents/catalog.js";
import { paymentNet, signTransferAuthorization, stable, toUnits } from "./chain.js";
import type { Coordinator, HspChainInfo } from "./hsp/coordinator.js";
import { flowIdFromUrl, MERCHANT_SETTLED, type CartContents, type CartMandate, type MerchantClient, type MerchantPayment, type PaymentMandate } from "./hsp/merchant.js";
import { signMerchantAuthorization, verifyMerchantAuthorization } from "./hsp/merchant-crypto.js";
import { buildMandate, decodeAddress, mandateHash, MANDATE_TYPES, type HspDomain, type SignedMandate } from "./hsp/wire.js";

export interface Quote {
  rail: "hsp-coordinator" | "hsp-merchant";
  quoteId: string;
  seller: string;
  recipient: Address;
  token: Address;
  chainId: number;
  amount: string; // base units
  amountUsd: string;
  description: string;
  expiresAt: number;
  payload: Record<string, unknown>;
}

export type PayOutcome =
  | { kind: "settled"; proofId: string; payer: Address; txHash: Hex; hspUrl?: string }
  | { kind: "checkout"; proofId: string; checkoutUrl: string };

export type Report = (kind: "sign" | "hsp" | "chain", title: string, detail?: string, txHash?: string) => void;

export interface Rail {
  name: "hsp-coordinator" | "hsp-merchant";
  label: string;
  token: Address;
  chainId: number;
  createQuote(s: SellerSpec, sellerKey: Hex): Promise<Quote>;
  /** Returns an error message, or null if the quote is authentic and payable here. */
  verifyQuote(q: Quote, sellerWallet: Address): Promise<string | null>;
  pay(q: Quote, agentKey: Hex, report: Report): Promise<PayOutcome>;
  /** Merchant rail: wait for the owner to pay at the hosted checkout. */
  awaitCheckout(q: Quote, proofId: string, report: Report): Promise<{ payer: Address; txHash: Hex }>;
  /** Seller side: throws unless the payment really settled to the seller. */
  verifyPaid(q: Quote, proofId: string): Promise<{ payer: Address; txHash?: Hex }>;
  /** bytes32 id for the passport ledger */
  ledgerId(proofId: string): Hex;
  proofUrl(proofId: string): string | undefined;
}

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function transferSeen(txHash: Hex, token: Address, to: Address, min: bigint) {
  const rcpt = await paymentNet.client.getTransactionReceipt({ hash: txHash });
  return rcpt.logs.some((l) => {
    try {
      const a = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics }).args;
      return l.address.toLowerCase() === token.toLowerCase() && a.to.toLowerCase() === to.toLowerCase() && a.value >= min;
    } catch {
      return false;
    }
  });
}

const baseQuote = (rail: Quote["rail"], s: SellerSpec, recipient: Address, token: Address, ttlSec: number) => ({
  rail,
  quoteId: crypto.randomUUID(),
  seller: s.handle,
  recipient,
  token,
  chainId: paymentNet.config.chainId,
  amount: toUnits(s.priceUsd).toString(),
  amountUsd: Number(s.priceUsd).toFixed(2),
  description: s.skill.name,
  expiresAt: Math.floor(Date.now() / 1000) + ttlSec,
});

// ---------------------------------------------------------------- HSP Settlement Protocol

/** Canonical bytes the seller signs (EIP-191), so the buyer can check it came from the passport wallet. */
const quoteMessage = (q: Omit<Quote, "payload">) => JSON.stringify(q, Object.keys(q).sort());

export class CoordinatorRail implements Rail {
  name = "hsp-coordinator" as const;
  token: Address;
  chainId: number;
  constructor(private coordinator: Coordinator, private info: HspChainInfo, public label: string, private publicUrl: (id: string) => string) {
    this.token = info.stablecoin.address;
    this.chainId = info.chainId;
  }

  private get domain(): HspDomain {
    return { name: "HSP", version: "1", chainId: this.info.chainId, verifyingContract: this.info.verifyingContract };
  }

  async createQuote(s: SellerSpec, sellerKey: Hex): Promise<Quote> {
    const seller = privateKeyToAccount(sellerKey);
    const q = baseQuote(this.name, s, seller.address, this.token, 900);
    return { ...q, payload: { chain: this.info.name, requiredCapabilities: [], signature: await seller.signMessage({ message: quoteMessage(q) }) } };
  }

  async verifyQuote(q: Quote, sellerWallet: Address) {
    const { payload, ...body } = q;
    const signer = await recoverMessageAddress({ message: quoteMessage(body), signature: payload.signature as Hex });
    if (signer.toLowerCase() !== sellerWallet.toLowerCase()) return "quote was not signed by the seller's passport wallet";
    if (q.recipient.toLowerCase() !== sellerWallet.toLowerCase()) return "quote asks to pay a wallet that isn't the seller's passport";
    if (q.chainId !== this.chainId || q.token.toLowerCase() !== this.token.toLowerCase()) return "quote is not payable in the HSP stablecoin on this chain";
    if (q.expiresAt < Date.now() / 1000) return "quote expired";
    return null;
  }

  async pay(q: Quote, agentKey: Hex, report: Report): Promise<PayOutcome> {
    const account = privateKeyToAccount(agentKey);
    const caps = (q.payload.requiredCapabilities as Hex[]) ?? [];
    const body = buildMandate({ signer: account.address, to: q.recipient, token: q.token, amount: BigInt(q.amount), chainId: this.chainId, caps });
    const signerProof = await account.signTypedData({
      domain: this.domain,
      types: MANDATE_TYPES,
      primaryType: "Mandate",
      message: { ...body, amount: BigInt(body.amount), chainId: BigInt(body.chainId), deadline: BigInt(body.deadline) },
    } as never);
    const mandate: SignedMandate = { body, signerProof, requiredCapabilities: caps };
    const paymentId = await this.coordinator.register(this.info.name, mandate);
    if (paymentId.toLowerCase() !== mandateHash(this.domain, body).toLowerCase()) throw new Error("Coordinator returned a paymentId that doesn't match our mandate");
    report("sign", `Signed the HSP mandate`, `${q.amountUsd} USDC → ${q.recipient} · paymentId ${paymentId.slice(0, 18)}…`);

    const txHash = await stable.transfer(agentKey, q.token, q.recipient, BigInt(q.amount));
    report("chain", `USDC transferred from the agent wallet on ${paymentNet.config.label}`, undefined, txHash);

    await this.coordinator.observe(this.info, paymentId, txHash);
    const final = await this.coordinator.awaitTerminal(paymentId, (s) => report("hsp", `HSP: ${s}`));
    if (final.status !== "SETTLED") throw new Error(`HSP payment ended ${final.status}: ${final.decision?.reason ?? ""}`);
    return { kind: "settled", proofId: paymentId, payer: account.address, txHash, hspUrl: this.publicUrl(paymentId) };
  }

  awaitCheckout(): Promise<{ payer: Address; txHash: Hex }> {
    throw new Error("the coordinator rail has no hosted checkout");
  }

  async verifyPaid(q: Quote, proofId: string) {
    const p = await this.coordinator.get(proofId as Hex);
    if (p.status !== "SETTLED") throw new Error(`HSP says ${p.status}, not SETTLED`);
    const b = p.mandate!.body;
    if (mandateHash(this.domain, b).toLowerCase() !== proofId.toLowerCase()) throw new Error("paymentId does not match the mandate");
    if (decodeAddress(b.recipient.payload).toLowerCase() !== q.recipient.toLowerCase()) throw new Error("payment went to another wallet");
    if (BigInt(b.amount) < BigInt(q.amount)) throw new Error("paid less than quoted");
    const txHash = (p.txHash ?? (p.receipt as { txHash?: Hex } | undefined)?.txHash) as Hex | undefined;
    if (txHash && !(await transferSeen(txHash, q.token, q.recipient, BigInt(q.amount)))) throw new Error("settlement transfer not found on-chain");
    return { payer: decodeAddress(b.signer.payload), txHash };
  }

  ledgerId(proofId: string) {
    return proofId as Hex;
  }
  proofUrl(proofId: string) {
    return this.publicUrl(proofId);
  }
}

// ---------------------------------------------------------------- HashKey Merchant gateway

export class MerchantRail implements Rail {
  name = "hsp-merchant" as const;
  chainId = paymentNet.config.chainId;
  constructor(
    private merchant: MerchantClient,
    private keys: { privateKeyPem: string; publicKeyPem: string },
    private merchantName: string,
    public token: Address,
    public label: string,
  ) {}

  async createQuote(s: SellerSpec, sellerKey: Hex): Promise<Quote> {
    const payTo = privateKeyToAccount(sellerKey).address;
    const q = baseQuote(this.name, s, payTo, this.token, 2 * 3600);
    const id = `${s.handle}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const contents: CartContents = {
      id: `CART-${id}`,
      user_cart_confirmation_required: false,
      payment_request: {
        method_data: [
          {
            supported_methods: "https://www.x402.org/",
            data: { x402Version: 2, network: paymentNet.config.hspName, chain_id: this.chainId, contract_address: this.token, pay_to: payTo, coin: "USDC" },
          },
        ],
        details: {
          id: `PAY-${id}`,
          display_items: [{ label: s.skill.name, amount: { currency: "USD", value: q.amountUsd } }],
          total: { label: "Total", amount: { currency: "USD", value: q.amountUsd } },
        },
      },
      cart_expiry: new Date(q.expiresAt * 1000).toISOString(),
      merchant_name: `${this.merchantName} · ${s.handle}`,
    };
    const cart_mandate: CartMandate = { contents, merchant_authorization: signMerchantAuthorization(this.keys.privateKeyPem, this.merchantName, contents) };
    const order = await this.merchant.createOrder(cart_mandate);
    return { ...q, quoteId: contents.payment_request.details.id, payload: { cart_mandate, payment_url: order.payment_url } };
  }

  async verifyQuote(q: Quote, sellerWallet: Address) {
    const cart = q.payload.cart_mandate as CartMandate;
    const v = verifyMerchantAuthorization(cart.merchant_authorization, this.keys.publicKeyPem, cart.contents);
    if (!v.ok) return `cart mandate failed verification: ${v.error}`;
    const m = cart.contents.payment_request.method_data.find((x) => x.data.chain_id === this.chainId && x.data.contract_address.toLowerCase() === this.token.toLowerCase());
    if (!m) return "no USDC payment option on this chain";
    if (m.data.pay_to.toLowerCase() !== sellerWallet.toLowerCase()) return "cart mandate pays a wallet that isn't the seller's passport";
    if (toUnits(cart.contents.payment_request.details.total.amount.value) !== BigInt(q.amount)) return "cart total doesn't match the quote";
    if (new Date(cart.contents.cart_expiry) < new Date()) return "cart mandate expired";
    return null;
  }

  async pay(q: Quote, agentKey: Hex, report: Report): Promise<PayOutcome> {
    const cart = q.payload.cart_mandate as CartMandate;
    const c = cart.contents;
    const proofId = c.payment_request.details.id;
    if (!this.merchant.canPayByApi) {
      report("hsp", `HSP order ready: owner pays at checkout`, "agent pay-by-API not enabled for this HSP gateway");
      return { kind: "checkout", proofId, checkoutUrl: q.payload.payment_url as string };
    }
    const { authorization, signature } = await signTransferAuthorization(agentKey, q.token, q.recipient, BigInt(q.amount));
    const pm: PaymentMandate = {
      payment_mandate_contents: {
        payment_mandate_id: proofId,
        payment_details_id: proofId,
        payment_details_total: { label: "Total", amount: { currency: "USD", value: q.amountUsd } },
        payment_response: { request_id: `REQ-${crypto.randomUUID()}`, method_name: "https://www.x402.org/", details: { x402Version: 2, scheme: "exact", network: `eip155:${this.chainId}`, payload: { signature, authorization } } },
        merchant_agent: c.merchant_name,
        timestamp: new Date().toISOString(),
      },
      user_authorization: signature,
    };
    report("sign", `Signed the HSP payment mandate`, `x402 / EIP-3009 · ${q.amountUsd} USDC from ${authorization.from}`);
    await this.merchant.submitPaymentMandate(flowIdFromUrl(q.payload.payment_url as string), pm);
    const p = await this.waitSettled(proofId, report);
    report("chain", `Settled by HSP on ${paymentNet.config.label}`, undefined, p.tx_signature);
    return { kind: "settled", proofId, payer: authorization.from, txHash: p.tx_signature as Hex };
  }

  async awaitCheckout(_q: Quote, proofId: string, report: Report) {
    const p = await this.waitSettled(proofId, report, 30 * 60_000);
    report("chain", `Owner paid at HSP checkout: settled on ${paymentNet.config.label}`, undefined, p.tx_signature);
    return { payer: p.payer_address as Address, txHash: p.tx_signature as Hex };
  }

  private async waitSettled(proofId: string, report: Report, timeoutMs = 180_000): Promise<MerchantPayment> {
    const start = Date.now();
    let last = "";
    for (;;) {
      const p = await this.merchant.getPayment(proofId).catch(() => null);
      if (p && p.status !== last) report("hsp", `HSP: ${(last = p.status)}`);
      if (p && MERCHANT_SETTLED.includes(p.status) && p.tx_signature) return p;
      if (p?.status === "payment-failed") throw new Error(`HSP payment failed: ${p.status_reason ?? "unknown"}`);
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for HSP (last status ${last || "unknown"})`);
      await sleep(1500);
    }
  }

  async verifyPaid(q: Quote, proofId: string) {
    const p = await this.merchant.getPayment(proofId);
    if (!MERCHANT_SETTLED.includes(p.status)) throw new Error(`HSP says ${p.status}`);
    if (p.to_pay_address?.toLowerCase() !== q.recipient.toLowerCase()) throw new Error("payment went to another wallet");
    if (p.tx_signature && !(await transferSeen(p.tx_signature as Hex, q.token, q.recipient, BigInt(q.amount)))) throw new Error("settlement transfer not found on-chain");
    return { payer: p.payer_address as Address, txHash: p.tx_signature as Hex | undefined };
  }

  ledgerId(proofId: string) {
    return keccak256(toHex(proofId));
  }
  proofUrl() {
    return undefined;
  }
}
