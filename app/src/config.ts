import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
export const DATA_DIR = path.join(ROOT, "data");
export const CONTRACTS_OUT = path.resolve(ROOT, "../contracts/out");

/** local: anvil + in-process HSP Coordinator emulator. live: HSK Chain + the hackathon HSP sandbox. */
export const MODE = (process.env.MODE ?? "local") as "local" | "live";
export const PORT = Number(process.env.PORT ?? 4300);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

export interface NetworkConfig {
  /** chain name the HSP Coordinator uses */
  hspName: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  label: string;
}

const NETWORKS: Record<string, NetworkConfig> = {
  local: { hspName: "local", chainId: 31337, rpcUrl: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545", explorer: "", label: "Local chain" },
  "hashkey-testnet": { hspName: "hashkey-testnet", chainId: 133, rpcUrl: "https://testnet.hsk.xyz", explorer: "https://testnet-explorer.hsk.xyz", label: "HSK Chain Testnet" },
  hashkey: { hspName: "hashkey", chainId: 177, rpcUrl: "https://mainnet.hsk.xyz", explorer: "https://hsk.blockscout.com", label: "HSK Chain Mainnet" },
};

function network(key: string, rpcOverride?: string): NetworkConfig {
  const n = NETWORKS[key];
  if (!n) throw new Error(`Unknown network ${key}`);
  return rpcOverride ? { ...n, rpcUrl: rpcOverride } : n;
}

/**
 * Two chains in live mode: the PassportRegistry lives on HSK mainnet (hackathon rule),
 * payments settle where the HSP sandbox runs (HSK testnet). Locally both are anvil.
 */
export const REGISTRY_NET = MODE === "local" ? NETWORKS.local : network(process.env.REGISTRY_NETWORK ?? "hashkey", process.env.REGISTRY_RPC_URL);
export const PAYMENT_NET = MODE === "local" ? NETWORKS.local : network(process.env.PAYMENT_NETWORK ?? "hashkey-testnet", process.env.PAYMENT_RPC_URL);

/** USDC on HSK Chain (from the HashKey payment docs). */
const HSK_USDC: Record<string, string> = {
  "hashkey-testnet": "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
  hashkey: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
};

export const live = {
  /** Empty = no hosted sandbox yet: run the built-in Coordinator against real USDC on PAYMENT_NETWORK. */
  coordinatorUrl: process.env.HSP_COORDINATOR_URL ?? "",
  apiKey: process.env.HSP_API_KEY ?? "",
  faucetUrl: process.env.HSP_FAUCET_URL ?? "",
  operatorKey: process.env.OPERATOR_PRIVATE_KEY ?? "",
  registry: process.env.REGISTRY_ADDRESS ?? "",
  /** Stablecoin the built-in Coordinator pins when there is no hosted sandbox. */
  stablecoin: process.env.STABLECOIN_ADDRESS || HSK_USDC[process.env.PAYMENT_NETWORK ?? "hashkey-testnet"] || "",
  /** STABLECOIN_ADDRESS is our own test USDC (npm run deploy:test-usdc): the operator tops up the paying agents. */
  testStablecoin: process.env.TEST_STABLECOIN === "1" && PAYMENT_NET.chainId !== 177,
};

const HSP_MERCHANT_HOSTS = { qa: "https://merchant-qa.hashkeymerchant.com", stg: "https://merchant-stg.hashkeymerchant.com", prod: "https://hsp.hashkey.com" };

/** HashKey Merchant (HSP gateway). QA serves testnets; staging and prod serve mainnet tokens. */
export const merchant = {
  baseUrl: process.env.HSP_MERCHANT_BASE_URL || (PAYMENT_NET.chainId === 177 ? HSP_MERCHANT_HOSTS.stg : HSP_MERCHANT_HOSTS.qa),
  appKey: process.env.HSP_APP_KEY ?? "",
  appSecret: process.env.HSP_APP_SECRET ?? "",
  /** Set only once HSP confirms agents may submit Payment Mandates by API; otherwise the owner pays at checkout. */
  payMandateUrl: process.env.HSP_PAY_MANDATE_URL ?? "",
  keyPath: path.resolve(ROOT, process.env.MERCHANT_PRIVATE_KEY_PATH || "../keys/merchant_private_key.pem"),
  name: process.env.MERCHANT_NAME || "AllScale",
};

/**
 * Which HSP rail pays:
 *   builtin     — HSP Settlement Protocol flow against the built-in Coordinator
 *   coordinator — the same flow against a hosted HSP Coordinator (HSP_COORDINATOR_URL)
 *   merchant    — HashKey Merchant gateway orders (HSP_APP_KEY / HSP_APP_SECRET)
 * In local mode every rail runs against local emulators.
 */
export const HSP_MODE = (process.env.HSP_MODE || (live.coordinatorUrl ? "coordinator" : merchant.appKey ? "merchant" : "builtin")) as "builtin" | "coordinator" | "merchant";
if (!["builtin", "coordinator", "merchant"].includes(HSP_MODE)) throw new Error(`HSP_MODE must be builtin, coordinator or merchant (got ${HSP_MODE})`);
