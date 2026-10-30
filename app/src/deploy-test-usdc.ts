// Fallback while no hosted HSP sandbox or official testnet USDC is available: deploy our own
// test USDC (MockUSDC, EIP-3009) on PAYMENT_NETWORK and save STABLECOIN_ADDRESS + TEST_STABLECOIN=1
// to .env. The server then tops up the paying agents with test USDC and gas from the operator.
import fs from "node:fs";
import path from "node:path";
import { ensureContractsBuilt } from "./bootstrap.js";
import { ROOT, live } from "./config.js";

ensureContractsBuilt();
const { paymentNet, tokenArtifact } = await import("./chain.js");

if (paymentNet.config.chainId === 177) throw new Error("Refusing to deploy a test stablecoin on HSK mainnet; set PAYMENT_NETWORK=hashkey-testnet");
if (!live.operatorKey) throw new Error("OPERATOR_PRIVATE_KEY missing; run npm run setup:keys");
const w = paymentNet.wallet(live.operatorKey as `0x${string}`);
const gas = await paymentNet.client.getBalance({ address: w.account.address });
console.log(`Deploying test USDC to ${paymentNet.config.label} (chain ${paymentNet.config.chainId}) from ${w.account.address}, balance ${Number(gas) / 1e18} HSK`);
if (gas === 0n) throw new Error("operator has no testnet HSK for gas (use the HSK testnet faucet)");

const hash = await w.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode } as never);
const address = (await paymentNet.client.waitForTransactionReceipt({ hash })).contractAddress!;
console.log(`Test USDC deployed: ${address}\n${paymentNet.addressUrl(address)}`);

const envPath = path.join(ROOT, ".env");
let env = fs.readFileSync(envPath, "utf8");
const set = (k: string, v: string) => (env = new RegExp(`^${k}=`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`);
set("STABLECOIN_ADDRESS", address);
set("TEST_STABLECOIN", "1");
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log("Saved STABLECOIN_ADDRESS and TEST_STABLECOIN=1 to .env");
