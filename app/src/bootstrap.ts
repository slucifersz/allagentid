// Brings the chain side up. Local: start anvil, deploy PassportRegistry + MockUSDC, fund
// the agents. Live: use the registry on HSK mainnet and the HSP sandbox's stablecoin.
// Then make sure every demo agent has a passport.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUYER, CLIENT, SELLERS } from "./agents/catalog.js";
import { CONTRACTS_OUT, HSP_MODE, MODE, PAYMENT_NET, ROOT, live, merchant } from "./config.js";
import { emit } from "./events.js";
import { store } from "./store.js";

// anvil's well-known dev keys (accounts 0 and 1)
export const ANVIL_OPERATOR = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const ANVIL_ADAPTER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

export function ensureContractsBuilt() {
  if (fs.existsSync(path.join(CONTRACTS_OUT, "PassportRegistry.sol"))) return;
  console.log("Building contracts (forge build)…");
  execSync("forge build", { cwd: path.resolve(ROOT, "../contracts"), stdio: "inherit" });
}

let anvil: ChildProcess | undefined;

async function rpcUp(url: string) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureAnvil() {
  if (await rpcUp(PAYMENT_NET.rpcUrl)) return;
  const port = new URL(PAYMENT_NET.rpcUrl).port || "8545";
  console.log(`Starting anvil on :${port}…`);
  anvil = spawn("anvil", ["--port", port, "--silent"], { stdio: "ignore" });
  process.on("exit", () => anvil?.kill());
  for (let i = 0; i < 50; i++) {
    if (await rpcUp(PAYMENT_NET.rpcUrl)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not start; is Foundry installed?");
}

/** Returns the registry plus, in local mode, the MockUSDC address the emulator pins. */
export async function bootChain() {
  const { Registry, registryNet, registryArtifact, tokenArtifact } = await import("./chain.js");

  if (MODE === "live") {
    if (!live.operatorKey || !live.registry) throw new Error("Live mode needs OPERATOR_PRIVATE_KEY and REGISTRY_ADDRESS in .env (run npm run deploy:passports first)");
    if (HSP_MODE === "coordinator" && (!live.coordinatorUrl || !live.apiKey)) throw new Error("HSP_MODE=coordinator needs HSP_COORDINATOR_URL and HSP_API_KEY");
    if (HSP_MODE === "merchant" && (!merchant.appKey || !merchant.appSecret)) throw new Error("HSP_MODE=merchant needs HSP_APP_KEY and HSP_APP_SECRET from the HashKey Merchant console");
    if (HSP_MODE === "merchant" && !fs.existsSync(merchant.keyPath)) throw new Error(`HSP_MODE=merchant needs the merchant private key at ${merchant.keyPath}`);
    return { registry: new Registry(live.registry as Hex, live.operatorKey as Hex), localToken: undefined };
  }

  await ensureAnvil();
  let d = store.deployment(PAYMENT_NET.chainId);
  const hasCode = d && (await registryNet.client.getCode({ address: d.registry }))?.length;
  if (!d || !hasCode) {
    const w = registryNet.wallet(ANVIL_OPERATOR);
    const deploy = async (a: typeof registryArtifact) => {
      const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode } as never);
      return (await registryNet.client.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    d = { registry: await deploy(registryArtifact), token: await deploy(tokenArtifact) };
    store.setDeployment(PAYMENT_NET.chainId, d);
    console.log(`Deployed PassportRegistry ${d.registry} and MockUSDC ${d.token}`);
  }
  return { registry: new Registry(d.registry, ANVIL_OPERATOR), localToken: d.token };
}

/** Issue missing demo passports, set tiers and the buyer's policy; fund agents on the local chain. */
export async function seedAgents(registry: import("./chain.js").Registry, token: Address) {
  const { registryNet, paymentNet, tokenArtifact, toUnits } = await import("./chain.js");
  const owner = privateKeyToAccount(store.ownerKey()).address;
  const all = [{ handle: BUYER.handle, tier: BUYER.tier }, { handle: CLIENT.handle, tier: CLIENT.tier }, ...SELLERS.map((s) => ({ handle: s.handle, tier: s.tier }))];
  for (const a of all) {
    const wallet = privateKeyToAccount(store.agentKey(a.handle)).address;
    const p = await registry.passport(wallet);
    if (!p) {
      const tx = await registry.issuePassport(owner, a.handle, wallet);
      emit({ kind: "passport", title: `Passport issued: @${a.handle}`, txHash: tx });
    }
    if ((p?.tier ?? 0) !== a.tier) await registry.setTier(wallet, a.tier);
  }
  const buyer = privateKeyToAccount(store.agentKey(BUYER.handle)).address;
  const client = privateKeyToAccount(store.agentKey(CLIENT.handle)).address;
  if (!(await registry.passport(buyer))?.policy.active) await registry.setPolicy(buyer, BUYER.policy.perTxUsd, BUYER.policy.dailyUsd, BUYER.policy.minTier);
  if (!(await registry.passport(client))?.policy.active) await registry.setPolicy(client, CLIENT.policy.perTxUsd, CLIENT.policy.dailyUsd, CLIENT.policy.minTier);

  if (MODE === "local") {
    // the buyer settles with its own wallet, so it needs gas as well as USDC
    for (const a of [buyer, client]) await paymentNet.client.request({ method: "anvil_setBalance" as never, params: [a, "0x8AC7230489E80000"] as never });
    const w = registryNet.wallet(ANVIL_OPERATOR);
    // the owner pays at the (local) HSP checkout when the merchant rail can't take agent payments
    for (const to of [buyer, client, owner]) {
      const hash = await w.writeContract({ address: token, abi: tokenArtifact.abi, functionName: "mint", args: [to, toUnits(BUYER.fundUsd)] } as never);
      await paymentNet.client.waitForTransactionReceipt({ hash });
    }
  } else if (live.testStablecoin) {
    // fallback on HSK testnet: the operator keeps the paying agents stocked with test USDC and gas
    const w = paymentNet.wallet(live.operatorKey as Hex);
    for (const a of [buyer, client]) {
      const bal = (await paymentNet.client.readContract({ address: token, abi: tokenArtifact.abi, functionName: "balanceOf", args: [a] } as never)) as bigint;
      if (bal < toUnits(BUYER.fundUsd) / 2n) {
        const hash = await w.writeContract({ address: token, abi: tokenArtifact.abi, functionName: "mint", args: [a, toUnits(BUYER.fundUsd) - bal] } as never);
        await paymentNet.client.waitForTransactionReceipt({ hash });
      }
      if ((await paymentNet.client.getBalance({ address: a })) < TEST_GAS / 2n) {
        const hash = await w.sendTransaction({ to: a, value: TEST_GAS } as never);
        await paymentNet.client.waitForTransactionReceipt({ hash });
      }
    }
  }
}

/** testnet HSK the operator gives each paying agent for its own transfers */
const TEST_GAS = 10n ** 16n;
