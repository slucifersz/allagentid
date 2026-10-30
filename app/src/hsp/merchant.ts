// HashKey Merchant (HSP gateway) types and client. The same client talks to the real gateway
// (QA / staging / prod hosts) or to the local merchant emulator.
import { signRequest } from "./merchant-crypto.js";

export interface Item {
  label: string;
  amount: { currency: "USD"; value: string };
}

export interface X402MethodData {
  supported_methods: "https://www.x402.org/";
  data: { x402Version: 2; network: string; chain_id: number; contract_address: string; pay_to: string; coin: string };
}

export interface CartContents {
  id: string; // cart_mandate_id
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: X402MethodData[];
    details: { id: string; display_items?: Item[]; total: Item; modifiers?: { supported_methods: string; additional_display_items: Item[]; total?: Item; data?: { method_data_indexes?: number[] } }[] };
  };
  cart_expiry: string;
  merchant_name: string;
}

export interface CartMandate {
  contents: CartContents;
  merchant_authorization: string;
}

export type MerchantStatus =
  | "payment-required"
  | "payment-submitted"
  | "payment-verified"
  | "payment-processing"
  | "payment-included"
  | "payment-safe"
  | "payment-finalized"
  | "payment-failed";
export const MERCHANT_SETTLED: MerchantStatus[] = ["payment-included", "payment-safe", "payment-finalized"];

export interface MerchantPayment {
  payment_request_id: string;
  request_id?: string;
  flow_id: string;
  status: MerchantStatus;
  status_reason?: string;
  payer_address?: string;
  to_pay_address?: string;
  pay_amount?: string;
  token?: string;
  token_address?: string;
  tx_signature?: string;
  [k: string]: unknown;
}

/** x402 v2 "exact" payload carrying an EIP-3009 authorization (what the checkout submits). */
export interface X402Payload {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: { signature: `0x${string}`; authorization: { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
}

/** AP2 Payment Mandate as the HSP checkout builds it. */
export interface PaymentMandate {
  payment_mandate_contents: {
    payment_mandate_id: string;
    payment_details_id: string;
    payment_details_total: Item;
    payment_response: { request_id: string; method_name: "https://www.x402.org/"; details: X402Payload };
    merchant_agent: string;
    timestamp: string;
  };
  user_authorization: string;
}

export class MerchantClient {
  constructor(private o: { baseUrl: string; appKey: string; appSecret: string; payMandateUrl?: string }) {}

  private async call<T>(method: "GET" | "POST", path: string, query = "", body?: unknown): Promise<T> {
    const fullPath = `/api/v1${path}`;
    const basePath = new URL(this.o.baseUrl).pathname.replace(/\/$/, "");
    const headers = signRequest(this.o.appKey, this.o.appSecret, method, basePath + fullPath, query, body);
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}${fullPath}${query ? `?${query}` : ""}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return unwrap<T>(res);
  }

  createOrder(cart_mandate: CartMandate, redirect_url?: string) {
    return this.call<{ payment_request_id: string; payment_url: string; multi_pay: boolean }>("POST", "/merchant/orders", "", { cart_mandate, ...(redirect_url ? { redirect_url } : {}) });
  }

  getPayment(payment_request_id: string) {
    return this.call<MerchantPayment>("GET", "/merchant/payments", new URLSearchParams({ payment_request_id }).toString());
  }

  /** True when we know where an agent can submit a Payment Mandate without the hosted checkout. */
  get canPayByApi() {
    return !!this.o.payMandateUrl;
  }

  /**
   * Payer side, without the hosted checkout. HSP's architecture shows the checkout posting to
   * /api/v1/payment/pay-mandate; it isn't in the public docs, so it's only used when
   * HSP_PAY_MANDATE_URL is configured (after HSP confirms it).
   */
  async submitPaymentMandate(flow_id: string, payment_mandate: PaymentMandate) {
    const res = await fetch(this.o.payMandateUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flow_id, payment_mandate }) });
    return unwrap<{ flow_id: string; request_id: string; status: string }>(res);
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: { code?: number; msg?: string; data?: T };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HSP merchant: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.code !== 0) throw new Error(`HSP merchant ${json.code}: ${json.msg}`);
  return json.data as T;
}

/** flow_id is the last path segment of payment_url (…/flow/<flow_id>). */
export const flowIdFromUrl = (paymentUrl: string) => new URL(paymentUrl).pathname.split("/").filter(Boolean).pop()!;
