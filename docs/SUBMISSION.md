# DoraHacks BUIDL submission (copy-paste)

**Name:** AgentPassport by AllScale

**Track:** Agent Payments & A2A Settlement (HSP)

**One-liner:** AllScale's one-stop financial identity for AI agents. One onboarding gives an agent an on-chain identity, a balance, HSP payments with other agents and merchants, spending rules, and a US card (coming soon).

**Links**
- GitHub: https://github.com/slucifersz/agentpassport
- Demo video: `<YouTube / Loom URL>`
- PassportRegistry on HSK Chain mainnet: `0x902186b2e62469265d47158ca4b8e7664488cc71`, https://hsk.blockscout.com/address/0x902186b2e62469265d47158ca4b8e7664488cc71
- Example HSP payment, nova.agent → pixel.design, 2 USDC:
  - USDC transfer (HSK testnet): https://testnet-explorer.hsk.xyz/tx/0x914eef8d6e5cf29a0085ffd893cfb1eccbf3e4b5cf27accc66ee0d287b573748
  - Settlement recorded on both passports (HSK mainnet): https://hsk.blockscout.com/tx/0x8260ad90100e7f2133af14083ba0a55ff1e41329433d37f81c930a555b6c1e84
- Example receive, atlas.client → nova.agent, 3 USDC:
  - USDC transfer (HSK testnet): https://testnet-explorer.hsk.xyz/tx/0xdaf921d5c885d62d3883b28ec65e52f039631fb88fe218aba995a404bd0a5873
  - Settlement recorded (HSK mainnet): https://hsk.blockscout.com/tx/0x49bcaf6cf2fcff9145e5d39ab33eb50678e800423a6cada400249a510d991797
- Test USDC on HSK testnet: `0x902186b2e62469265d47158ca4b8e7664488cc71`, https://testnet-explorer.hsk.xyz/address/0x902186b2e62469265d47158ca4b8e7664488cc71
- Live demo: `<public URL>`

---

## Problem

AI agents are starting to transact, but they have no financial identity. Nobody can tell who an agent is or who stands behind it. An agent has nowhere to hold a balance, get paid or pay, and its owner has no way to cap what it spends. Today every capability is a separate integration: a wallet here, a payment API there, a card somewhere else.

## What we built

**AgentPassport** is a single onboarding that gives an agent everything it needs to transact. Status of each part:

| | Capability | Status |
|---|---|---|
| 🪪 | **Identity:** an on-chain passport on HSK Chain with a unique handle, a verification tier attested by AllScale (unverified / owner KYC / verified human) and its owner | live |
| 💰 | **Account and balance:** a stablecoin balance the agent can read and spend | live |
| 💰 | AllScale USD account (AllScale VA) | coming soon |
| ⚡ | **Receive and pay:** settlement with other agents and merchants **through HSP on HSK Chain**. Every payment is recorded on both passports | live (Track 2 core) |
| 🛡 | **Spending rules:** owner-set per-payment and daily limits, plus a minimum counterparty tier. Unverified payees are refused, and payments over the limit wait for owner approval | live, on-chain |
| 💳 | **US card (AgentCard):** a long-term Visa card plus single-use cards per order, for any card-accepting merchant, under the same limits | **demo only**, coming soon via an issuing partner; no real card is issued |

The agent uses all of this through MCP (`get_my_account`, `hire_agent`, `approve_payment`, `issue_one_time_card`…) from Claude, Grok or Muse. The owner sees the same account in the dashboard.

## The HSP part (Track 2)

A payment between agents works like this:
1. The paying agent sends an A2A request (`message/send`).
2. The receiving agent answers with its payment conditions. Depending on the rail, these are an HSP Cart Mandate or a payment requirement signed by its passport wallet.
3. The pay agent verifies the quote, then reads **both passports and the owner's rules on-chain**.
4. If everything passes, it signs and settles through HSP. USDC moves on HSK Chain.
5. The settlement is written to both passports. The receiver independently checks the payment with HSP and on-chain before it delivers.

**Two HSP integrations, switched by config:**
- **HashKey Merchant gateway.** Seller quotes are real HSP orders: ES256K-signed Cart Mandates with `pay_to` set to the seller's passport wallet. The agent submits the Payment Mandate by API where HSP allows it; otherwise the owner pays at HSP checkout.
- **HSP Settlement Protocol.** The agent signs an EIP-712 mandate, settles the transfer from its own wallet, and the Coordinator verifies it.

**What runs in this submission.** The hosted HSP sandbox from earlier editions is offline, and we are still waiting for HashKey Merchant credentials. So this submission runs the HSP Settlement Protocol flow (signed EIP-712 mandate → transfer from the agent's own wallet → observe → SETTLED) against our built-in Coordinator, with real transfers on **HSK Chain testnet** in a test USDC we deployed (`0x902186b2e62469265d47158ca4b8e7664488cc71`). The merchant rail is fully implemented and switches on with one config change once credentials arrive. We have asked the organizers about merchant onboarding, agent pay-by-API and the sandbox.

`PassportRegistry` is deployed on **HSK Chain mainnet**: identity, rules and the settlement ledger.

## Demo

1. Nova opens its passport and reads its identity and balance.
2. Atlas, a client agent, **pays Nova 3 USDC through HSP**.
3. Nova **pays a verified designer 2 USDC through HSP**. It **refuses** an unverified agent, and **holds** a 20 USDC payment over its limit until the owner approves.
4. Nova gets a **one-time card** for a $4.50 merchant order, within the same limits. This step is a demo.

*One AllScale onboarding: identity, an account, payments and a card.*

## What's next

- AllScale USD accounts (VA) funding agent balances; one balance spendable on-chain (HSP) and off-chain (card)
- AgentCard through an issuing partner
- Smart-account spending modules, so limits are enforced in the wallet itself
- HSP compliant payments: passport tiers backing `attests:kyc` / `attests:sanctions`

## Team

AllScale: `<names / roles>`
