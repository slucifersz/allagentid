// AgentCard (DEMO). A US bank card for the agent: one long-term card plus single-use virtual
// cards issued per order, spendable at any card-accepting merchant. Not live: this is a
// simulation of how cards would be issued through an issuing partner, so it never touches card
// rails. The passport's spending rules are applied before a card is issued.
import crypto from "node:crypto";
import type { Hex } from "viem";
import type { Registry } from "./chain.js";
import { emit } from "./events.js";

export interface AgentCard {
  id: string;
  agent: string;
  kind: "long-term" | "one-time";
  network: "Visa";
  last4: string;
  label: string;
  limitUsd?: string;
  merchant?: string;
  singleUse: boolean;
  expires: string;
  status: "demo";
  createdAt: string;
}

const last4 = () => String(crypto.randomInt(0, 10000)).padStart(4, "0");

export class Cards {
  private cards = new Map<string, AgentCard[]>();
  private spentToday = new Map<string, number>(); // card spend per agent today (demo, off-chain)

  constructor(private registry: Registry) {}

  list(agent: string) {
    if (!this.cards.has(agent)) {
      const exp = new Date();
      exp.setFullYear(exp.getFullYear() + 3);
      this.cards.set(agent, [
        { id: crypto.randomUUID(), agent, kind: "long-term", network: "Visa", last4: last4(), label: "AgentCard", singleUse: false, expires: `${String(exp.getMonth() + 1).padStart(2, "0")}/${String(exp.getFullYear()).slice(2)}`, status: "demo", createdAt: new Date().toISOString() },
      ]);
    }
    return this.cards.get(agent)!;
  }

  cardSpentToday(agent: string) {
    return this.spentToday.get(agent) ?? 0;
  }

  /** Issue a single-use card for one merchant order, within the passport's spending rules. */
  async issueOneTime(agent: string, wallet: Hex, merchant: string, amountUsd: string) {
    const amount = Number(amountUsd);
    if (!(amount > 0)) throw new Error("amount must be positive");
    const p = await this.registry.passport(wallet);
    if (!p) throw new Error(`${agent} has no passport`);
    const { perTxLimit, dailyLimit, active } = p.policy;
    const spent = Number(p.spentToday) + this.cardSpentToday(agent);
    if (active && Number(perTxLimit) > 0 && amount > Number(perTxLimit)) {
      emit({ kind: "reject", title: `Card refused: $${amount.toFixed(2)} at ${merchant}`, detail: `over the passport's per-payment limit (${perTxLimit})` });
      return { ok: false as const, reason: `over the per-payment limit of ${perTxLimit}` };
    }
    if (active && Number(dailyLimit) > 0 && spent + amount > Number(dailyLimit)) {
      emit({ kind: "reject", title: `Card refused: $${amount.toFixed(2)} at ${merchant}`, detail: `over the passport's daily limit (${dailyLimit}, spent ${spent.toFixed(2)} incl. HSP)` });
      return { ok: false as const, reason: `over the daily limit of ${dailyLimit}` };
    }
    const card: AgentCard = {
      id: crypto.randomUUID(),
      agent,
      kind: "one-time",
      network: "Visa",
      last4: last4(),
      label: "One-time card",
      limitUsd: amount.toFixed(2),
      merchant,
      singleUse: true,
      expires: new Date(Date.now() + 15 * 60_000).toISOString(),
      status: "demo",
      createdAt: new Date().toISOString(),
    };
    this.list(agent).push(card);
    this.spentToday.set(agent, this.cardSpentToday(agent) + amount);
    emit({ kind: "card", title: `One-time card issued: $${card.limitUsd} at ${merchant}`, detail: `Visa •••• ${card.last4} · single use · within @${agent}'s passport limits · DEMO (coming soon via issuing partner)` });
    return { ok: true as const, card };
  }
}
