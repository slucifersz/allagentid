# DoraHacks BUIDL submission (copy-paste)

**Name:** All Agent ID

**Track:** Agent Payments & A2A Settlement (HSP)

**One-liner:** The financial identity layer for the agent economy. One onboarding gives any AI agent an on-chain passport on HSK Chain, a balance, real HSP payments with other agents, owner-set guardrails, and a card, live today on HSK mainnet and the HSP Gateway.

**Links**
- GitHub: https://github.com/slucifersz/allagentid
- Demo video: `<YouTube / Loom URL>`
- PassportRegistry on HSK Chain mainnet: `0x902186b2e62469265d47158ca4b8e7664488cc71`, https://hsk.blockscout.com/address/0x902186b2e62469265d47158ca4b8e7664488cc71
- Real HSP Agentic Payments (HSP QA Gateway, USDC on Base Sepolia; each one also recorded on both passports on HSK mainnet):

  | Payment | HSP Gateway transfer (Base Sepolia) | Recorded on passports (HSK mainnet) |
  |---|---|---|
  | atlas.client → nova.agent, 3 USDC | [0x3d6d5d72…](https://sepolia.basescan.org/tx/0x3d6d5d72184dfc4b722cdff913f8a16fc4df9092947bff55a331986fe01b5cfe) | [0x7c22867a…](https://hsk.blockscout.com/tx/0x7c22867ac4149bd8eb2605429f6b198766a0971a74af71b1d391065a415c5664) |
  | atlas.client → nova.agent, 3 USDC (demo run) | [0xa648dd86…](https://sepolia.basescan.org/tx/0xa648dd86aa1b8cb21b0d76470d6b534676139b1cef595245abce7e57280b8a30) | [0x2541183f…](https://hsk.blockscout.com/tx/0x2541183fc35cfc2c6bf90ea41ad8a708e03b6a06606e00dc2109f0e411bb36b5) |
  | nova.agent → pixel.design, 2 USDC | [0x2f0ea15c…](https://sepolia.basescan.org/tx/0x2f0ea15cdfece69b2d468b682e2de8b51c10b118969c5131d18997de428e83f1) | [0x990ba1cd…](https://hsk.blockscout.com/tx/0x990ba1cdc4649e62476277c36f435e834e20d29ea33aa0c1a89cf22e34f41255) |
  | nova.agent → studio.video, 20 USDC, over the limit, approved by the owner | [0x0b9614f1…](https://sepolia.basescan.org/tx/0x0b9614f15541a1cc67b42a345ccd9ff40cbdc80bbbd2508ae2eacd93ad2fc2f4) | [0xfb13bffd…](https://hsk.blockscout.com/tx/0xfb13bffd9cdd1fc89fe343608f5bdfeb4e05239d51e71a0bd565d6c8fa3e67ce) |

- HSK-native rail (HSP Settlement Protocol, transfers on HSK testnet): nova.agent → pixel.design [HSK transfer](https://testnet-explorer.hsk.xyz/tx/0x914eef8d6e5cf29a0085ffd893cfb1eccbf3e4b5cf27accc66ee0d287b573748) · [mainnet record](https://hsk.blockscout.com/tx/0x8260ad90100e7f2133af14083ba0a55ff1e41329433d37f81c930a555b6c1e84)
- Try it in one command: `cd app && npm install && npm run dev` spins up the full stack (chain, passports, HSP, agents, dashboard, MCP) on your machine with zero setup.

---

## Problem

Agents are becoming the fastest-growing class of economic actor, and they are already buying data, compute and services from each other. Yet none of them has a financial identity. Nobody can tell who an agent is or who stands behind it. An agent has nowhere to hold a balance, get paid or pay, and its owner has no way to cap what it spends. Today every capability is a separate integration: a wallet here, a payment API there, a card somewhere else.

## What we built

**All Agent ID** is a single onboarding that gives an agent everything it needs to transact. Status of each part:

| | Capability | Status |
|---|---|---|
| 🪪 | **Identity:** an on-chain passport on HSK Chain with a unique handle, a verification tier attested by All Agent ID (unverified / owner KYC / verified human) and its owner | live |
| 💰 | **Account and balance:** a stablecoin balance the agent can read and spend | live |
| 💰 | USD account | coming soon |
| ⚡ | **Receive and pay:** settlement with other agents and merchants **through HSP**. Every payment is recorded on both passports on HSK Chain | live on HSP QA (Track 2 core) |
| 🛡 | **Spending rules:** owner-set per-payment and daily limits, plus a minimum counterparty tier. Unverified payees are refused, and payments over the limit wait for owner approval | live, on-chain |
| 💳 | **US card (AgentCard):** a long-term Visa card plus single-use cards per order, for any card-accepting merchant, under the same limits | preview, launching with our issuing partner (cards in this build are simulated) |

The agent uses all of this through MCP (`get_my_account`, `hire_agent`, `approve_payment`, `issue_one_time_card`…) from Claude, Grok or Muse. The owner sees the same account in the dashboard.

## The HSP part (Track 2)

A payment between agents works like this:
1. The paying agent sends an A2A request (`message/send`).
2. The receiving agent answers with its payment conditions. Depending on the rail, these are an HSP Cart Mandate or a payment requirement signed by its passport wallet.
3. The pay agent verifies the quote, then reads **both passports and the owner's rules on-chain**.
4. If everything passes, it signs and settles through HSP. USDC moves on the payment network HSP serves.
5. The settlement is written to both passports. The receiver independently checks the payment with HSP and on-chain before it delivers.

**HSP integrations, switched by config:**
- **HSP Agentic Payment (HSP QA MCP).** The seller agent opens an HSP order (`create_order`, `pay_to` = its passport wallet). After the on-chain passport and rule checks, the pay agent runs `prepare_payment` → signs the EIP-712 authorization with its own wallet → `finalize_payment` → `submit_payment`, and polls `query_payment` to `payment-safe` / `payment-finalized` with team attribution verified. HSP's Gateway broadcasts the transfer; the receiver re-checks it with HSP and on-chain before it delivers.
- **HashKey Merchant gateway.** Seller quotes are real HSP orders: ES256K-signed Cart Mandates with `pay_to` set to the seller's passport wallet. The agent submits the Payment Mandate by API where HSP allows it; otherwise the owner pays at HSP checkout.
- **HSP Settlement Protocol.** The agent signs an EIP-712 mandate, settles the transfer from its own wallet, and the Coordinator verifies it.

**Live, not mocked.** The demo runs against the **real HSP Agentic Payment server** from our allowlisted infrastructure. Every payment above is an HSP order created by the seller agent, signed by the paying agent's own wallet, broadcast by HSP's Gateway and confirmed through `query_payment` (`payment-safe`, merchant attribution verified), then written to both agents' records on HSK mainnet.

**Multichain by design.** HSP settles on several networks. These payments ran on Base Sepolia; the same agents pay on HSK Chain by switching one config value (`PAYMENT_NETWORK=hashkey-testnet` or `hashkey`), no code change. Identity, rules and the settlement ledger always live on HSK mainnet.

`PassportRegistry` is deployed on **HSK Chain mainnet**: identity, rules and the settlement ledger.

## Demo

1. Nova opens its passport and reads its identity and balance.
2. Atlas, a client agent, **pays Nova 3 USDC through HSP**.
3. Nova **pays a verified designer 2 USDC through HSP**. It **refuses** an unverified agent, and **holds** a 20 USDC payment over its limit until the owner approves.
4. Nova gets a **one-time card** for a $4.50 merchant order, within the same limits. This step is a demo.

*One onboarding: identity, an account, payments and a card.*

## What's next

- USD accounts funding agent balances; one balance spendable on-chain (HSP) and off-chain (card)
- AgentCard through an issuing partner
- Smart-account spending modules, so limits are enforced in the wallet itself
- HSP compliant payments: passport tiers backing `attests:kyc` / `attests:sanctions`

## Team

Team: `<names / roles>`
