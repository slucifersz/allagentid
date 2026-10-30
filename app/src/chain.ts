// Chain access. The PassportRegistry lives on REGISTRY_NET (HSK mainnet in live mode);
// stablecoin payments settle on PAYMENT_NET (HSK testnet, where the HSP sandbox runs).
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseSignature,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_OUT, PAYMENT_NET, REGISTRY_NET, type NetworkConfig } from "./config.js";

function artifact(file: string, name: string) {
  const json = JSON.parse(fs.readFileSync(path.join(CONTRACTS_OUT, file, `${name}.json`), "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

export const registryArtifact = artifact("PassportRegistry.sol", "PassportRegistry");
export const tokenArtifact = artifact("MockUSDC.sol", "MockUSDC");
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

function makeNet(n: NetworkConfig) {
  const chain = defineChain({
    id: n.chainId,
    name: n.label,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [n.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(n.rpcUrl) });
  return {
    config: n,
    client,
    wallet: (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(n.rpcUrl) }),
    txUrl: (h: string) => (n.explorer ? `${n.explorer}/tx/${h}` : ""),
    addressUrl: (a: string) => (n.explorer ? `${n.explorer}/address/${a}` : ""),
  };
}

export const registryNet = makeNet(REGISTRY_NET);
export const paymentNet = makeNet(PAYMENT_NET);

export const TIER_NAMES = ["Unverified", "Owner KYC", "Verified human"] as const;
export const CHECK_REASONS = [
  "within policy",
  "payer has no passport",
  "payee has no passport",
  "payee verification tier too low",
  "over the per-payment limit",
  "over the daily limit",
] as const;

export const USDC_DECIMALS = 6;
export const toUnits = (usd: string) => BigInt(Math.round(Number(usd) * 10 ** USDC_DECIMALS));
export const fromUnits = (v: bigint) => formatUnits(v, USDC_DECIMALS);

export interface PassportView {
  wallet: Hex;
  owner: Hex;
  handle: string;
  tier: number;
  tierName: string;
  createdAt: number;
  settlementsPaid: number;
  settlementsReceived: number;
  volumePaid: string;
  volumeReceived: string;
  policy: { perTxLimit: string; dailyLimit: string; minCounterpartyTier: number; active: boolean };
  spentToday: string;
}

/** PassportRegistry reads and operator writes. */
export class Registry {
  constructor(public address: Hex, private operatorKey: Hex) {}

  private async write(functionName: string, args: unknown[]) {
    const hash = await registryNet.wallet(this.operatorKey).writeContract({ address: this.address, abi: registryArtifact.abi, functionName, args } as never);
    const receipt = await registryNet.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  private read<T>(functionName: string, args: unknown[]): Promise<T> {
    return registryNet.client.readContract({ address: this.address, abi: registryArtifact.abi, functionName, args }) as Promise<T>;
  }

  issuePassport(owner: Hex, handle: string, wallet: Hex) {
    return this.write("registerFor", [owner, handle, wallet]);
  }
  setTier(wallet: Hex, tier: number) {
    return this.write("setTier", [wallet, tier]);
  }
  setPolicy(wallet: Hex, perTxUsd: string, dailyUsd: string, minTier: number) {
    return this.write("setPolicy", [wallet, toUnits(perTxUsd), toUnits(dailyUsd), minTier]);
  }
  /** paymentId is the HSP mandate hash (bytes32). */
  recordSettlement(paymentId: Hex, from: Hex, to: Hex, amount: bigint, txHash: Hex) {
    return this.write("recordSettlement", [paymentId, from, to, amount, txHash]);
  }

  resolve(handle: string) {
    return this.read<Hex>("resolve", [handle]);
  }

  async passport(wallet: Hex): Promise<PassportView | null> {
    const [p, pol, spent] = await Promise.all([
      this.read<{ owner: Hex; tier: number; createdAt: bigint; settlementsPaid: number; settlementsReceived: number; volumePaid: bigint; volumeReceived: bigint; handle: string }>("passportOf", [wallet]),
      this.read<{ perTxLimit: bigint; dailyLimit: bigint; minCounterpartyTier: number; active: boolean }>("policyOf", [wallet]),
      this.read<bigint>("spentToday", [wallet]),
    ]);
    if (/^0x0+$/.test(p.owner)) return null;
    return {
      wallet,
      owner: p.owner,
      handle: p.handle,
      tier: p.tier,
      tierName: TIER_NAMES[p.tier],
      createdAt: Number(p.createdAt),
      settlementsPaid: p.settlementsPaid,
      settlementsReceived: p.settlementsReceived,
      volumePaid: fromUnits(p.volumePaid),
      volumeReceived: fromUnits(p.volumeReceived),
      policy: { perTxLimit: fromUnits(pol.perTxLimit), dailyLimit: fromUnits(pol.dailyLimit), minCounterpartyTier: pol.minCounterpartyTier, active: pol.active },
      spentToday: fromUnits(spent),
    };
  }

  async checkPayment(from: Hex, to: Hex, amount: bigint) {
    const [ok, reason] = await this.read<[boolean, number]>("checkPayment", [from, to, amount]);
    return { ok, reason, reasonText: CHECK_REASONS[reason] };
  }
}

/** Stablecoin on the payment chain. */
export const stable = {
  async balance(token: Address, wallet: Address) {
    return fromUnits((await paymentNet.client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [wallet] })) as bigint);
  },
  async gas(wallet: Address) {
    return Number(await paymentNet.client.getBalance({ address: wallet })) / 1e18;
  },
  /** Wallet-settling transfer: the mandate signer moves its own stablecoin. */
  async transfer(key: Hex, token: Address, to: Address, amount: bigint) {
    const hash = await paymentNet.wallet(key).writeContract({ address: token, abi: ERC20, functionName: "transfer", args: [to, amount] } as never);
    const receipt = await paymentNet.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transfer reverted (${hash})`);
    return hash;
  },
};

// ---------------------------------------------------------------- EIP-3009 (HashKey Merchant x402 path)

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** EIP-712 domain of a USDC-style token (name() + version()). */
export async function tokenDomain(token: Address) {
  const abi = parseAbi(["function name() view returns (string)", "function version() view returns (string)"]);
  const [name, version] = await Promise.all([
    paymentNet.client.readContract({ address: token, abi, functionName: "name" }),
    paymentNet.client.readContract({ address: token, abi, functionName: "version" }).catch(() => "2"),
  ]);
  return { name, version, chainId: paymentNet.config.chainId, verifyingContract: token };
}

/** Sign an EIP-3009 TransferWithAuthorization from `key`'s wallet. */
export async function signTransferAuthorization(key: Hex, token: Address, to: Address, value: bigint, ttlSec = 3600) {
  const account = privateKeyToAccount(key);
  const authorization = {
    from: account.address,
    to,
    value: value.toString(),
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + ttlSec),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: await tokenDomain(token),
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value, validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return { authorization, signature };
}

/** Relayer call: settle an EIP-3009 authorization on-chain (what the HSP gateway does). */
export async function relayTransferWithAuthorization(
  relayerKey: Hex,
  token: Address,
  auth: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex },
  signature: Hex,
) {
  const { v, r, s } = parseSignature(signature);
  return paymentNet.wallet(relayerKey).writeContract({
    address: token,
    abi: tokenArtifact.abi,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number(v), r, s],
  } as never);
}
