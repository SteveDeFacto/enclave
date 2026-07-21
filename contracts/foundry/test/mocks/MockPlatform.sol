// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "../../../EnclaveCreditVault.sol";

interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// Minimal address book: owner-set key -> address, mirroring EnclaveAddressBook's addr().
contract MockBook {
    mapping(bytes32 => address) public addr;
    function set(bytes32 key, address a) external { addr[key] = a; }
}

/// Minimal EnclaveDeployments stand-in for vault unit tests: create() records
/// the caller as owner and returns a deterministic id; fund() pulls USDC from
/// the caller to `payout` (the real ledger's non-custodial shape). Both the
/// rev-3 7-arg and rev-4 9-arg create() selectors exist, like the sniffed real
/// ledgers. setAppRef/setActive are owner-gated no-ops that record the call.
contract MockDeployments {
    IERC20 public immutable usdc;
    address public immutable payout;
    uint256 public count;
    mapping(bytes32 => address) public ownerOf;
    mapping(bytes32 => uint256) public funded6;
    mapping(bytes32 => string) public appRefOf;
    mapping(bytes32 => bool) public activeOf;

    constructor(IERC20 _usdc, address _payout) { usdc = _usdc; payout = _payout; }

    function create(string calldata appRef, uint16, uint16, uint32, string calldata, bool, string calldata)
        external returns (bytes32) { return _create(appRef); }
    function create(string calldata appRef, uint16, uint16, uint32, string calldata, bool, string calldata, address, uint256)
        external returns (bytes32) { return _create(appRef); }
    function _create(string calldata appRef) private returns (bytes32 id) {
        id = keccak256(abi.encode(address(this), count++, appRef));
        ownerOf[id] = msg.sender;
        appRefOf[id] = appRef;
        activeOf[id] = true;
    }

    function fund(bytes32 id, uint256 value) external {
        require(ownerOf[id] != address(0), "no such deployment");
        require(IERC20TransferFrom(address(usdc)).transferFrom(msg.sender, payout, value), "transferFrom failed");
        funded6[id] += value;
    }

    function setAppRef(bytes32 id, string calldata appRef) external {
        require(msg.sender == ownerOf[id], "not owner");
        appRefOf[id] = appRef;
    }
    function setActive(bytes32 id, bool active) external {
        require(msg.sender == ownerOf[id], "not owner");
        activeOf[id] = active;
    }
}
