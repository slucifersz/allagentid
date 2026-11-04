// The pay agent: hires another agent over A2A, checks the quote and both passports
// against the owner's policy, pays through the active HSP rail, records the settlement on the
// PassportRegistry and collects the work. When the rail can't take an agent payment by API
// (HashKey Merchant without pay-by-API), the owner pays at HSP's hosted checkout instead.
import crypto from "node:crypto";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Registry, paymentNet, registryNet } from "../chain.js";
import { emit } from "../events.js";
import type { Quote, Rail, Report } from "../rails.js";
import { PAYMENT_KEY, QUOTE_KEY } from "./seller.js";
import type { Deliverable } from "./work.js";

export type JobStatus = "running" | "awaiting_approval" | "awaiting_checkout" | "rejected" | "completed" | "failed";

export interface Job {
  id: string;
  payer: string;
  seller: string;
  task: string;
  status: JobStatus;
  rail?: string;
  amount?: string;
  reason?: string;
  proofId?: string;
  hspUrl?: string;
  checkoutUrl?: string;
  paymentTx?: string;
  paymentTxUrl?: string;
  settlementTx?: string;
  settlementTxUrl?: string;
  deliverable?: Deliverable;
  createdAt: string;
  // internal
  quote?: Quote;
  taskId?: string;
  a2aUrl?: string;
}

export interface PayerDeps {
  registry: Registry;
  rail: Rail;
  agentKey: (handle: string) => Hex;
  sellerA2aUrl: (handle: string) => string;
}

async function a2aSend(url: string, parts: unknown[], extra: Record<string, unknown> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send", params: { message: { role: "user", messageId: crypto.randomUUID(), parts, ...extra } } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`A2A: ${json.error.message}`);
  return json.result;
}

export class PayAgent {
  jobs = new Map<string, Job>();
  constructor(private d: PayerDeps) {}

  publicJob(j: Job) {
    const { quote, taskId, a2aUrl, ...rest } = j;
    return rest;
  }

  /** Hire `seller` for `task` on behalf of the buyer agent `payer`. Resolves once the job finishes or needs the owner. */
  async hire(payer: string, seller: string, task: string): Promise<Job> {
    const job: Job = { id: crypto.randomUUID().slice(0, 8), payer, seller, task, status: "running", rail: this.d.rail.label, createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    const ev = (e: Parameters<typeof emit>[0]) => emit({ ...e, jobId: job.id });
    const payerWallet = privateKeyToAccount(this.d.agentKey(payer)).address;

    try {
      // 1. Ask for a quote over A2A
      job.a2aUrl = this.d.sellerA2aUrl(seller);
      ev({ kind: "a2a", title: `${payer} → ${seller}: "${task}"`, detail: `A2A message/send` });
      const quoted = await a2aSend(job.a2aUrl, [{ kind: "text", text: task }], { metadata: { "agentid.handle": payer, "agentid.wallet": payerWallet } });
      const part = quoted.status?.message?.parts?.find((p: { kind: string; data?: Record<string, unknown> }) => p.kind === "data" && p.data?.[QUOTE_KEY]);
      if (!part) throw new Error("seller did not return a quote");
      const q = part.data[QUOTE_KEY] as Quote;
      job.taskId = quoted.id;
      job.quote = q;
      job.amount = q.amountUsd;

      // 2. Is the quote authentic and payable, and does it pay the seller's passport wallet?
      const sellerWallet = await this.d.registry.resolve(seller);
      if (/^0x0+$/.test(sellerWallet)) return this.reject(job, `${seller} has no All Agent ID`);
      if (q.rail !== this.d.rail.name) return this.reject(job, `quote uses ${q.rail}, we pay with ${this.d.rail.name}`);
      const bad = await this.d.rail.verifyQuote(q, sellerWallet);
      if (bad) return this.reject(job, bad);
      ev({ kind: "mandate", title: `Quote verified: ${q.amountUsd} USDC to @${seller}`, detail: q.rail === "hsp-merchant" ? "HSP Cart Mandate: ES256K merchant signature ✓ · cart_hash ✓ · pay_to = seller passport ✓" : "signed by the seller's passport wallet ✓" });

      // 3. Read both passports on-chain and apply the owner's policy
      const [mine, theirs] = await Promise.all([this.d.registry.passport(payerWallet), this.d.registry.passport(sellerWallet)]);
      if (!mine) return this.reject(job, `${payer} has no passport`);
      const check = await this.d.registry.checkPayment(payerWallet, sellerWallet, BigInt(q.amount));
      ev({
        kind: "check",
        title: check.ok ? `Passport check passed` : `Passport check: ${check.reasonText}`,
        detail: `@${seller}: ${theirs?.tierName} · policy: ≤${mine.policy.perTxLimit}/payment, ≤${mine.policy.dailyLimit}/day (spent ${mine.spentToday}), payee tier ≥ ${mine.policy.minCounterpartyTier}`,
      });
      if (!check.ok) {
        if (check.reason === 4 || check.reason === 5) {
          job.status = "awaiting_approval";
          job.reason = `${check.reasonText}; waiting for the owner to approve`;
          ev({ kind: "approval", title: `Owner approval needed: ${q.amountUsd} USDC to ${seller}`, detail: check.reasonText, data: { jobId: job.id } });
          return job;
        }
        return this.reject(job, check.reasonText);
      }
      return await this.payAndCollect(job);
    } catch (e) {
      return this.fail(job, (e as Error).message);
    }
  }

  async approve(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "awaiting_approval") throw new Error("no approval pending for this job");
    job.status = "running";
    job.reason = "approved by the owner";
    emit({ kind: "approval", jobId, title: `Owner approved ${job.amount} USDC to ${job.seller}` });
    try {
      return await this.payAndCollect(job);
    } catch (e) {
      return this.fail(job, (e as Error).message);
    }
  }

  decline(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "awaiting_approval") throw new Error("no approval pending for this job");
    return this.reject(job, "owner declined");
  }

  private reporter(job: Job): Report {
    return (kind, title, detail, txHash) => emit({ kind, jobId: job.id, title, detail, txHash });
  }

  private async payAndCollect(job: Job): Promise<Job> {
    const q = job.quote!;
    const report = this.reporter(job);
    const out = await this.d.rail.pay(q, this.d.agentKey(job.payer), report);
    job.proofId = out.proofId;
    job.hspUrl = this.d.rail.proofUrl(out.proofId);

    if (out.kind === "checkout") {
      job.status = "awaiting_checkout";
      job.checkoutUrl = out.checkoutUrl;
      job.reason = "pay at HSP checkout with the owner's wallet";
      emit({ kind: "approval", jobId: job.id, title: `Owner: pay ${q.amountUsd} USDC to ${job.seller} at HSP checkout`, detail: out.checkoutUrl });
      // finish in the background once HSP reports the checkout payment
      void this.d.rail
        .awaitCheckout(q, out.proofId, report)
        .then((p) => this.recordAndCollect(job, p.payer, p.txHash))
        .catch((e) => this.fail(job, (e as Error).message));
      return job;
    }
    return this.recordAndCollect(job, out.payer, out.txHash);
  }

  private async recordAndCollect(job: Job, payer: Address, txHash: Hex): Promise<Job> {
    const q = job.quote!;
    job.status = "running";
    job.paymentTx = txHash;
    job.paymentTxUrl = paymentNet.txUrl(txHash);

    // Ledger on the passports (the buyer agent's passport, even when the owner paid at checkout)
    const agentWallet = privateKeyToAccount(this.d.agentKey(job.payer)).address;
    job.settlementTx = await this.d.registry.recordSettlement(this.d.rail.ledgerId(job.proofId!), agentWallet, q.recipient, BigInt(q.amount), txHash);
    job.settlementTxUrl = registryNet.txUrl(job.settlementTx);
    emit({ kind: "passport", jobId: job.id, title: `Settlement recorded on both passports`, detail: `${registryNet.config.label}${payer.toLowerCase() !== agentWallet.toLowerCase() ? " · paid by the owner's wallet" : ""}`, txHash: job.settlementTx });

    // Hand the payment id to the seller and collect the work
    const done = await a2aSend(job.a2aUrl!, [{ kind: "data", data: { [PAYMENT_KEY]: { proofId: job.proofId } } }], { taskId: job.taskId });
    job.deliverable = done.artifacts?.[0]?.parts?.[0]?.data?.deliverable;
    job.status = "completed";
    if (job.reason?.startsWith("pay at HSP checkout")) job.reason = "paid by the owner at HSP checkout";
    return job;
  }

  private reject(job: Job, reason: string) {
    job.status = "rejected";
    job.reason = reason;
    emit({ kind: "reject", jobId: job.id, title: `${job.payer} refused to pay ${job.seller}`, detail: reason });
    return job;
  }

  private fail(job: Job, reason: string) {
    job.status = "failed";
    job.reason = reason;
    emit({ kind: "reject", jobId: job.id, title: `Job failed`, detail: reason });
    return job;
  }
}
