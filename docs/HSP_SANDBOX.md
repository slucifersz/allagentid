# HSP status and what we asked the organizers

The Track 2 text says: "The interface API for HSP is this: https://hashkey-merchant.github.io/#/", which is the **HashKey Merchant** gateway. The HSP **Settlement Protocol** sandbox guide (https://hashfans.io/docs?id=HSP, added June 2026) belongs to an earlier edition. Its Coordinator domain `hsp-hackathon.hashkeymerchant.com` no longer resolves, while `merchant-qa.hashkeymerchant.com` does.

AllScale Agent ID supports both, switched by `HSP_MODE` (see the README).

## Asked in the support group (https://t.me/+M5yaRB-u4PRiNWM1)
1. Who do we send HashKey Merchant onboarding to? Description: "AllScale Agent ID – AllScale's one-stop financial identity for AI agents (identity, balance, payments), settling via HSP (hackathon project)". The ES256K public key is `keys/merchant_public_key.pem`. We also asked about a fast track.
2. May an AI agent submit the signed Payment Mandate by API, without the hosted checkout? If so, what is the endpoint and format? (The architecture diagram shows `POST /api/v1/payment/pay-mandate`.)
3. Is there a Mumbai HSP sandbox Coordinator (URL, API key, faucet, SDK repo)?

## When the answers arrive
- Merchant credentials → `HSP_APP_KEY`, `HSP_APP_SECRET` (QA host for testnet) → `npm run check:hsp` with `HSP_MODE=merchant`
- Pay-by-API confirmed → `HSP_PAY_MANDATE_URL=<endpoint>`. Agents then pay without the owner.
- Sandbox Coordinator → `HSP_COORDINATOR_URL`, `HSP_API_KEY`, `HSP_FAUCET_URL` → `npm run faucet`, `npm run check:hsp`

## If nothing arrives before the deadline
Run `HSP_MODE=builtin`: the HSP Settlement Protocol flow against our built-in Coordinator, on **real** USDC transfers on HSK Chain. Say so in the submission and mention that we asked about both HSP paths.

Keep `keys/` as is: the merchant rail signs Cart Mandates with that key, and its public half is what goes to HSP.
