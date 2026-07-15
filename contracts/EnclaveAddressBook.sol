// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveAddressBook — the one stable root the platform reads its
///        contract addresses from.
/// @notice Every Enclave component (supervisor, website, relays, CLI) bakes in
///         exactly ONE address — this contract's — and resolves the rest
///         (registry, deployments ledger, app catalog, pay forwarder, volume
///         access) from it at start, then polls for changes. Redeploying any
///         platform contract is then ONE owner transaction here instead of an
///         enclave release + site rebuild + relay-box env edits (the drift
///         class that repeatedly bit the 2026-07-07 contract redeploy).
///
/// Trust model (stated plainly, like everything else on this platform):
///   - The owner — the platform's governance EOA, the same key that approves
///     catalog apps and deploys contracts — can repoint any entry at any time,
///     and running components follow within one poll WITHOUT a new measured
///     release. Anyone verifying an enclave should understand that "which
///     contracts it talks to" is governed by this key; the measurement pins
///     the code and THIS book's address, not the addresses inside it.
///   - Keys are short ascii labels right-padded to bytes32 ("registry",
///     "deployments", "appCatalog", "enclavePay", "volumeAccess"); new keys
///     can be added later without redeploying the book. Setting a key to
///     address(0) retires it (readers treat zero as unset and keep their
///     baked fallback).
contract EnclaveAddressBook {
    address public owner;
    address public pendingOwner;              // two-step handoff: must accept()
    bytes32[] private _keys;                  // every key ever set, for all()
    mapping(bytes32 => address) public addr;  // key -> current address
    mapping(bytes32 => bool) private _seen;

    event AddressSet(bytes32 indexed key, address value);
    event OwnerChanged(address owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    constructor() { owner = msg.sender; }

    function set(bytes32 key, address value) public {
        require(msg.sender == owner, "!owner");
        require(key != bytes32(0), "key=0");
        if (!_seen[key]) { _seen[key] = true; _keys.push(key); }
        addr[key] = value;
        emit AddressSet(key, value);
    }

    function setMany(bytes32[] calldata keys_, address[] calldata values) external {
        require(keys_.length == values.length, "len");
        for (uint256 i = 0; i < keys_.length; i++) set(keys_[i], values[i]);
    }

    /// @notice The whole book in one eth_call — how components resolve at boot.
    function all() external view returns (bytes32[] memory keys_, address[] memory values) {
        keys_ = _keys;
        values = new address[](_keys.length);
        for (uint256 i = 0; i < _keys.length; i++) values[i] = addr[_keys[i]];
    }

    function count() external view returns (uint256) { return _keys.length; }

    /// @notice Begin a TWO-STEP ownership handoff. `newOwner` must then call
    ///         acceptOwnership(); until it does, `owner` is unchanged. This is the
    ///         root of the whole contract graph — a fat-fingered single-step
    ///         transfer here would strand every consumer's resolution, so the new
    ///         key must prove it can transact before it takes control.
    function setOwner(address newOwner) external {
        require(msg.sender == owner, "!owner");
        require(newOwner != address(0), "owner=0");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the handoff. Only the pending owner may finalize.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
