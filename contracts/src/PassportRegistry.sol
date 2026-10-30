// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentPassport registry
/// @notice On-chain passports for AI agents: a unique handle, a verification tier set by
///         an attester (AllScale), owner-defined spending rules, and a settlement ledger
///         that payments made through HSP are written back to.
/// @dev Spending rules are enforced by the AllScale pay agent before it signs a payment;
///      this contract is the source of truth it reads and the audit trail it writes.
contract PassportRegistry {
    // Verification tiers
    uint8 public constant TIER_UNVERIFIED = 0;
    uint8 public constant TIER_OWNER_KYC = 1; // owner passed AllScale KYC
    uint8 public constant TIER_HUMAN = 2; // owner is a proven unique human

    struct Passport {
        address owner;
        uint8 tier;
        uint64 createdAt;
        uint32 settlementsPaid;
        uint32 settlementsReceived;
        uint128 volumePaid; // token base units (6 decimals for USDC/USDT)
        uint128 volumeReceived;
        string handle;
    }

    struct Policy {
        uint128 perTxLimit;
        uint128 dailyLimit;
        uint8 minCounterpartyTier;
        bool active;
    }

    address public admin;
    mapping(address => bool) public attesters;

    mapping(address wallet => Passport) private _passports;
    mapping(bytes32 handleHash => address wallet) private _handles;
    mapping(address wallet => Policy) private _policies;
    mapping(address wallet => mapping(uint256 day => uint128 spent)) private _spent;
    mapping(bytes32 paymentRequestId => bool) public settled;

    uint256 public passportCount;

    event PassportIssued(address indexed wallet, address indexed owner, string handle);
    event TierChanged(address indexed wallet, uint8 tier);
    event PolicyChanged(address indexed wallet, uint128 perTxLimit, uint128 dailyLimit, uint8 minCounterpartyTier);
    event Settlement(
        bytes32 indexed paymentRequestId, address indexed from, address indexed to, uint128 amount, bytes32 txHash
    );
    event AttesterChanged(address indexed attester, bool allowed);

    error NotAdmin();
    error NotAttester();
    error NotOwnerOrAttester();
    error InvalidHandle();
    error HandleTaken();
    error AlreadyRegistered();
    error NoPassport();
    error InvalidTier();
    error AlreadySettled();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAttester() {
        if (!attesters[msg.sender]) revert NotAttester();
        _;
    }

    constructor() {
        admin = msg.sender;
        attesters[msg.sender] = true;
        emit AttesterChanged(msg.sender, true);
    }

    // ---------------------------------------------------------------- admin

    function setAttester(address attester, bool allowed) external onlyAdmin {
        attesters[attester] = allowed;
        emit AttesterChanged(attester, allowed);
    }

    function transferAdmin(address next) external onlyAdmin {
        admin = next;
    }

    // ---------------------------------------------------------------- issuing

    /// @notice Owner claims a passport for their agent wallet.
    function register(string calldata handle, address wallet) external {
        _issue(msg.sender, handle, wallet);
    }

    /// @notice AllScale issues a passport on the owner's behalf (owner signed up through AllScale).
    function registerFor(address owner, string calldata handle, address wallet) external onlyAttester {
        _issue(owner, handle, wallet);
    }

    function _issue(address owner, string calldata handle, address wallet) internal {
        if (!_validHandle(bytes(handle))) revert InvalidHandle();
        if (_passports[wallet].owner != address(0)) revert AlreadyRegistered();
        bytes32 h = keccak256(bytes(handle));
        if (_handles[h] != address(0)) revert HandleTaken();

        _handles[h] = wallet;
        Passport storage p = _passports[wallet];
        p.owner = owner;
        p.handle = handle;
        p.createdAt = uint64(block.timestamp);
        passportCount++;
        emit PassportIssued(wallet, owner, handle);
    }

    /// @dev 3-32 chars of a-z, 0-9, '-' and '.', not starting or ending with a separator.
    function _validHandle(bytes memory b) internal pure returns (bool) {
        if (b.length < 3 || b.length > 32) return false;
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            bool alnum = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
            bool sep = c == 0x2d || c == 0x2e;
            if (!alnum && !sep) return false;
            if (sep && (i == 0 || i == b.length - 1)) return false;
        }
        return true;
    }

    function setTier(address wallet, uint8 tier) external onlyAttester {
        if (_passports[wallet].owner == address(0)) revert NoPassport();
        if (tier > TIER_HUMAN) revert InvalidTier();
        _passports[wallet].tier = tier;
        emit TierChanged(wallet, tier);
    }

    function setPolicy(address wallet, uint128 perTxLimit, uint128 dailyLimit, uint8 minCounterpartyTier) external {
        Passport storage p = _passports[wallet];
        if (p.owner == address(0)) revert NoPassport();
        if (msg.sender != p.owner && !attesters[msg.sender]) revert NotOwnerOrAttester();
        if (minCounterpartyTier > TIER_HUMAN) revert InvalidTier();
        _policies[wallet] = Policy(perTxLimit, dailyLimit, minCounterpartyTier, true);
        emit PolicyChanged(wallet, perTxLimit, dailyLimit, minCounterpartyTier);
    }

    // ---------------------------------------------------------------- settlement ledger

    /// @notice Record a payment that settled through HSP. Counts toward the payer's daily spend.
    function recordSettlement(bytes32 paymentRequestId, address from, address to, uint128 amount, bytes32 txHash)
        external
        onlyAttester
    {
        if (settled[paymentRequestId]) revert AlreadySettled();
        settled[paymentRequestId] = true;

        Passport storage payer = _passports[from];
        if (payer.owner != address(0)) {
            payer.settlementsPaid++;
            payer.volumePaid += amount;
        }
        Passport storage payee = _passports[to];
        if (payee.owner != address(0)) {
            payee.settlementsReceived++;
            payee.volumeReceived += amount;
        }
        _spent[from][block.timestamp / 1 days] += amount;
        emit Settlement(paymentRequestId, from, to, amount, txHash);
    }

    // ---------------------------------------------------------------- views

    function passportOf(address wallet) external view returns (Passport memory) {
        return _passports[wallet];
    }

    function policyOf(address wallet) external view returns (Policy memory) {
        return _policies[wallet];
    }

    function resolve(string calldata handle) external view returns (address) {
        return _handles[keccak256(bytes(handle))];
    }

    function hasPassport(address wallet) public view returns (bool) {
        return _passports[wallet].owner != address(0);
    }

    function spentToday(address wallet) public view returns (uint128) {
        return _spent[wallet][block.timestamp / 1 days];
    }

    /// @notice Would `from` be allowed to pay `to` this amount under its owner's policy?
    /// @return ok      true if the payment is within policy
    /// @return reason  0 ok, 1 payer has no passport, 2 payee has no passport,
    ///                 3 payee tier too low, 4 over per-payment limit, 5 over daily limit
    function checkPayment(address from, address to, uint128 amount) external view returns (bool ok, uint8 reason) {
        if (!hasPassport(from)) return (false, 1);
        if (!hasPassport(to)) return (false, 2);
        Policy memory pol = _policies[from];
        if (!pol.active) return (true, 0);
        if (_passports[to].tier < pol.minCounterpartyTier) return (false, 3);
        if (pol.perTxLimit != 0 && amount > pol.perTxLimit) return (false, 4);
        if (pol.dailyLimit != 0 && spentToday(from) + amount > pol.dailyLimit) return (false, 5);
        return (true, 0);
    }
}
