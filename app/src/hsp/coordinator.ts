// Client for the HSP Coordinator (the hackathon sandbox, or the local emulator).
// Payer flow: POST /payments (signed mandate) -> wallet transfer -> POST /payments/:id/observe
// -> poll GET /payments/:id until SETTLED. Reads are public; writes need the team API key.
import type { Address, Hex } from "viem";
import type { SignedMandate } from "./wire.js";

export interface HspChainInfo {
  name: string;
  chainId: number;
  stablecoin: { address: Address; symbol: string; decimals: number };
  confirmations: number;
  verifyingContract: Address;
  adapterAddress: Address;
  adapterOperatorUrl?: string | null;
}

export type HspStatus = "REGISTERED" | "OBSERVING" | "SETTLED" | "FAILED" | "DISPUTED" | "EXPIRED" | string;
export const TERMINAL = new Set(["SETTLED", "FAILED", "DISPUTED", "EXPIRED"]);

export interface HspPayment {
  paymentId: Hex;
  status: HspStatus;
  mandate?: SignedMandate;
  receipt?: unknown;
  decision?: { ok?: boolean; outcomeClass?: string; reason?: string };
  txHash?: Hex;
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Coordinator {
  constructor(public readonly url: string, private apiKey: string) {}

  private get base() {
    return this.url.replace(/\/$/, "");
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(method === "POST" ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as T;
    return { status: res.status, json };
  }

  async chainInfo(chainId: number): Promise<HspChainInfo> {
    const { status, json } = await this.req<HspChainInfo[] | { chains: HspChainInfo[] }>("GET", "/chains");
    if (status !== 200) throw new Error(`GET /chains: HTTP ${status}`);
    const list = Array.isArray(json) ? json : json.chains;
    const c = list.find((x) => Number(x.chainId) === chainId);
    if (!c) throw new Error(`HSP Coordinator does not serve chain ${chainId}`);
    return c;
  }

  async register(chain: string, mandate: SignedMandate, attestations: unknown[] = []): Promise<Hex> {
    const { status, json } = await this.req<{ paymentId?: Hex; error?: string }>("POST", "/payments", { chain, mandate, attestations });
    if (status >= 300 || !json?.paymentId) throw new Error(`HSP register: HTTP ${status} ${JSON.stringify(json)}`);
    return json.paymentId;
  }

  /** Ask the adapter to observe the settlement tx; 202 means still confirming. */
  async observe(info: HspChainInfo, paymentId: Hex, txHash: Hex) {
    for (let i = 0; i < 40; i++) {
      const op = info.adapterOperatorUrl?.replace(/\/$/, "");
      const res = op
        ? await fetch(`${op}/observe/evm-transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coordinatorUrl: this.base, paymentId, txHash }) })
        : await fetch(`${this.base}/payments/${paymentId}/observe`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ txHash }),
          });
      if (res.status === 202) {
        await sleep(2000);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`HSP observe: HTTP ${res.status} ${JSON.stringify(json)}`);
      return json as { status?: string };
    }
    throw new Error("HSP observe timed out");
  }

  async get(paymentId: Hex): Promise<HspPayment> {
    const { status, json } = await this.req<HspPayment>("GET", `/payments/${paymentId}`);
    if (status !== 200) throw new Error(`HSP get: HTTP ${status}`);
    return json;
  }

  async awaitTerminal(paymentId: Hex, onStatus?: (s: string) => void, timeoutMs = 180_000): Promise<HspPayment> {
    const start = Date.now();
    let last = "";
    for (;;) {
      const p = await this.get(paymentId).catch(() => null);
      if (p?.status && p.status !== last) onStatus?.((last = p.status));
      if (p?.status && TERMINAL.has(p.status)) return p;
      if (Date.now() - start > timeoutMs) throw new Error(`HSP settlement timed out (last status ${last || "unknown"})`);
      await sleep(1500);
    }
  }

  paymentUrl(paymentId: Hex) {
    return `${this.base}/payments/${paymentId}/explain`;
  }
}
