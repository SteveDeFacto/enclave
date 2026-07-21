// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { EnclaveCreditVault, EnclaveCreditVaultFactory, IERC20, IAddressBook } from "../../EnclaveCreditVault.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockBook, MockDeployments } from "./mocks/MockPlatform.sol";
import { ensureP256 } from "./EnclaveCreditVault.t.sol";

/// The closed-loop money invariant: across ANY sequence of vault operations
/// (valid and garbage), USDC that entered a vault only ever exists at the
/// vault itself, the ledger's payout, or the company treasury. No sequence
/// reaches any other address.
contract VaultHandler is Test {
    EnclaveCreditVault public vault;
    MockUSDC public usdc;
    uint256 constant PK = 0xA1CE;
    uint256 public ghostIn;   // total ever deposited

    constructor(EnclaveCreditVault _vault, MockUSDC _usdc) {
        vault = _vault; usdc = _usdc;
    }

    function deposit(uint96 amount) public {
        amount = uint96(bound(amount, 1, 500e6));
        usdc.mint(address(vault), amount);
        ghostIn += amount;
    }

    function deployAndFund(uint96 fund6) public {
        fund6 = uint96(bound(fund6, 0, usdc.balanceOf(address(vault))));
        bytes memory cc = abi.encodeWithSignature("create(string,uint16,uint16,uint32,string,bool,string)",
            "ipfs://inv", uint16(100), uint16(100), uint32(8080), "", true, "");
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.deployAndFund.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(cc), uint256(fund6), deadline));
        try vault.deployAndFund(cc, fund6, deadline, _sig(digest)) {} catch {}
    }

    function refund(uint96 amount6) public {
        amount6 = uint96(bound(amount6, 0, usdc.balanceOf(address(vault))));
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(amount6), deadline));
        try vault.refundToTreasury(amount6, deadline, _sig(digest)) {} catch {}
    }

    function garbageSig(uint96 amount6, bytes32 noise) public {
        uint256 deadline = block.timestamp + 60;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(noise);   // signs the WRONG digest
        try vault.refundToTreasury(bound(amount6, 1, 1e9), deadline, w) {} catch {}
        try vault.fundDeployment(noise, bound(amount6, 1, 1e9), deadline, w) {} catch {}
    }

    function _sig(bytes32 digest) private view returns (EnclaveCreditVault.WebAuthnSig memory w) {
        bytes memory auth = abi.encodePacked(bytes32(0), bytes1(0x05), uint32(1));
        bytes memory b64 = bytes(vm.toBase64URL(abi.encodePacked(digest)));
        uint256 len = b64.length; while (len > 0 && b64[len - 1] == "=") len--;
        bytes memory chal = new bytes(len);
        for (uint256 i = 0; i < len; i++) chal[i] = b64[i];
        string memory cdj = string(abi.encodePacked('{"type":"webauthn.get","challenge":"', chal, '"}'));
        bytes32 message = sha256(abi.encodePacked(auth, sha256(bytes(cdj))));
        (bytes32 r, bytes32 s) = vm.signP256(PK, message);
        (uint256 px, uint256 py) = vm.publicKeyP256(PK);
        w = EnclaveCreditVault.WebAuthnSig(auth, cdj, uint256(r), uint256(s), px, py);
    }
}

contract EnclaveCreditVaultInvariantTest is Test {
    MockUSDC usdc;
    MockDeployments dep;
    EnclaveCreditVault vault;
    VaultHandler handler;
    address constant TREASURY = address(0x7E57);
    address constant PAYOUT = address(0xFEE);
    bytes32 constant BOOK_KEY_DEPLOYMENTS = 0x6465706c6f796d656e7473000000000000000000000000000000000000000000;

    function setUp() public {
        ensureP256(vm);
        usdc = new MockUSDC();
        MockBook book = new MockBook();
        dep = new MockDeployments(IERC20(address(usdc)), PAYOUT);
        book.set(BOOK_KEY_DEPLOYMENTS, address(dep));
        EnclaveCreditVaultFactory factory =
            new EnclaveCreditVaultFactory(IERC20(address(usdc)), IAddressBook(address(book)), TREASURY);
        (uint256 x, uint256 y) = vm.publicKeyP256(0xA1CE);
        vault = EnclaveCreditVault(factory.createVault(x, y));
        handler = new VaultHandler(vault, usdc);
        targetContract(address(handler));
    }

    /// every deposited cent is at the vault, the ledger payout, or the treasury
    function invariant_closedLoop() public view {
        assertEq(usdc.balanceOf(address(vault)) + usdc.balanceOf(PAYOUT) + usdc.balanceOf(TREASURY),
                 handler.ghostIn(), "USDC escaped the loop");
    }

    /// the ledger never holds funds itself (non-custodial passthrough)
    function invariant_ledgerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(dep)), 0);
    }
}
