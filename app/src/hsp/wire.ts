// HSP (HashKey Settlement Protocol) wire format, payer side: the 11-field EIP-712 Mandate
// (wire v1, signer profile eip712-eoa.v1). Field order and derivations match the HSP
// reference implementation so the digest is what the Coordinator verifies.
import { encodeAbiParameters, hashTypedData, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";

export const ZERO32: Hex = `0x${"00".repeat(32)}`;
export const EIP712_EOA_PROFILE_ID: Hex = keccak256(stringToBytes("eip712-eoa.v1"));

export interface HspDomain {
  name: "HSP";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

export interface MandateBody {
  nonce: Hex;
  signer: { profileId: Hex; payload: Hex };
  grantRef: Hex;
  requirementRef: Hex;
  recipient: { kind: number; payload: Hex }; // kind 0 = address
  token: Address;
  amount: string; // base units
  chainId: number;
  deadline: number; // unix seconds
  settlementBinding: Hex;
  requiredCapabilitiesHash: Hex;
}

export interface SignedMandate {
  body: MandateBody;
  signerProof: Hex;
  requiredCapabilities: Hex[];
}

export const MANDATE_TYPES = {
  Mandate: [
    { name: "nonce", type: "bytes32" },
    { name: "signer", type: "Signer" },
    { name: "grantRef", type: "bytes32" },
    { name: "requirementRef", type: "bytes32" },
    { name: "recipient", type: "Recipient" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "settlementBinding", type: "bytes32" },
    { name: "requiredCapabilitiesHash", type: "bytes32" },
  ],
  Signer: [
    { name: "profileId", type: "bytes32" },
    { name: "payload", type: "bytes" },
  ],
  Recipient: [
    { name: "kind", type: "uint8" },
    { name: "payload", type: "bytes" },
  ],
} as const;

export const encodeAddress = (a: Address) => encodeAbiParameters([{ type: "address" }], [a]);
export const decodeAddress = (payload: Hex) => `0x${payload.slice(-40)}` as Address;

/** Dedupe + sort capability ids; zero hash for the empty set (public payments). */
export function requiredCapabilitiesHash(caps: Hex[]): Hex {
  const sorted = [...new Set(caps.map((c) => c.toLowerCase() as Hex))].sort();
  return sorted.length ? keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [sorted])) : ZERO32;
}

export const typedData = (domain: HspDomain, b: MandateBody) =>
  ({
    domain,
    types: MANDATE_TYPES,
    primaryType: "Mandate",
    message: {
      ...b,
      amount: BigInt(b.amount),
      chainId: BigInt(b.chainId),
      deadline: BigInt(b.deadline),
    },
  }) as const;

/** The EIP-712 digest the payer signs. It is also the HSP paymentId. */
export const mandateHash = (domain: HspDomain, b: MandateBody): Hex => hashTypedData(typedData(domain, b) as never);

export function buildMandate(p: { signer: Address; to: Address; token: Address; amount: bigint; chainId: number; ttlSec?: number; caps?: Hex[] }): MandateBody {
  return {
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    signer: { profileId: EIP712_EOA_PROFILE_ID, payload: encodeAddress(p.signer) },
    grantRef: ZERO32,
    requirementRef: ZERO32,
    recipient: { kind: 0, payload: encodeAddress(p.to) },
    token: p.token,
    amount: p.amount.toString(),
    chainId: p.chainId,
    deadline: Math.floor(Date.now() / 1000) + (p.ttlSec ?? 3600),
    settlementBinding: ZERO32,
    requiredCapabilitiesHash: requiredCapabilitiesHash(p.caps ?? []),
  };
}
