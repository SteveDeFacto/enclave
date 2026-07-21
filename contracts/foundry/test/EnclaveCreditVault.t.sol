// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { EnclaveCreditVault, EnclaveCreditVaultFactory, IERC20, IAddressBook } from "../../EnclaveCreditVault.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockBook, MockDeployments } from "./mocks/MockPlatform.sol";

/// Drives the vault with REAL WebAuthn-shaped P-256 signatures: vm.signP256
/// signs op digests, vm.toBase64URL builds the clientDataJSON challenge (an
/// encoder independent of the contract's own base64url), and the RIP-7212
/// precompile address carries Daimo's verifier bytecode (fetched from Base,
/// precompile-compatible by construction) via vm.etch - the same bytes the
/// e2e stack etches into anvil.
contract EnclaveCreditVaultTest is Test {
    address constant P256_VERIFY = 0x0000000000000000000000000000000000000100;
    bytes32 constant BOOK_KEY_DEPLOYMENTS = 0x6465706c6f796d656e7473000000000000000000000000000000000000000000;

    uint256 constant PK1 = 0xA1CE;   // customer passkey scalar
    uint256 constant PK2 = 0xB0B2;   // second device

    MockUSDC usdc;
    MockBook book;
    MockDeployments dep;
    EnclaveCreditVaultFactory factory;
    EnclaveCreditVault vault;
    address treasury = address(0x7E57);
    uint256 x1; uint256 y1;

    function setUp() public {
        // forge's EVM serves RIP-7212 natively at 0x100 (probed in-repo); the
        // fixtures/p256-verifier.hex bytecode exists for the ANVIL e2e stack,
        // which lacks the precompile and gets it via anvil_setCode instead
        usdc = new MockUSDC();
        book = new MockBook();
        dep = new MockDeployments(IERC20(address(usdc)), address(0xFEE));
        book.set(BOOK_KEY_DEPLOYMENTS, address(dep));
        factory = new EnclaveCreditVaultFactory(IERC20(address(usdc)), IAddressBook(address(book)), treasury);
        (x1, y1) = vm.publicKeyP256(PK1);
        vault = EnclaveCreditVault(factory.createVault(x1, y1));
        usdc.mint(address(vault), 100e6);   // $100 of credit
    }

    // ---- helpers ----------------------------------------------------------------

    function _sig(uint256 pk, bytes32 digest) internal view returns (EnclaveCreditVault.WebAuthnSig memory w) {
        bytes memory auth = abi.encodePacked(bytes32(uint256(0x1234)), bytes1(0x05), uint32(7)); // rpIdHash|UP+UV|counter
        // vm.toBase64URL pads with '='; WebAuthn challenges are UNPADDED - strip
        bytes memory b64 = bytes(vm.toBase64URL(abi.encodePacked(digest)));
        uint256 len = b64.length; while (len > 0 && b64[len - 1] == "=") len--;
        bytes memory chal = new bytes(len);
        for (uint256 i = 0; i < len; i++) chal[i] = b64[i];
        string memory cdj = string(abi.encodePacked(
            '{"type":"webauthn.get","challenge":"', chal,
            '","origin":"https://enclave.host","crossOrigin":false}'));
        bytes32 message = sha256(abi.encodePacked(auth, sha256(bytes(cdj))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, message);
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        w = EnclaveCreditVault.WebAuthnSig(auth, cdj, uint256(r), uint256(s), px, py);
    }

    function _createCall() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("create(string,uint16,uint16,uint32,string,bool,string,address,uint256)",
            "ipfs://bafyvault", uint16(250), uint16(100), uint32(8080), "", true, "", address(0), uint256(0));
    }

    function _deployDigest(bytes memory createCall, uint256 fund6, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EnclaveVault.deployAndFund.v1"), address(vault), block.chainid,
            vault.nonce(), keccak256(createCall), fund6, deadline));
    }

    // ---- factory ---------------------------------------------------------------

    function test_counterfactualAddressMatches() public view {
        assertEq(factory.vaultFor(x1, y1), address(vault));
    }

    function test_duplicateVaultReverts() public {
        vm.expectRevert(bytes("exists"));
        factory.createVault(x1, y1);
    }

    function test_implementationIsInert() public {
        EnclaveCreditVault impl = factory.implementation();
        vm.prank(address(factory));
        vm.expectRevert(bytes("initialized"));
        impl.initialize(x1, y1);
    }

    function test_initializeOnlyFactory() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        address predicted = factory.vaultFor(x2, y2);
        factory.createVault(x2, y2);
        vm.expectRevert(bytes("factory only"));
        EnclaveCreditVault(predicted).initialize(x2, y2);
    }

    // ---- deployAndFund ----------------------------------------------------------

    function test_deployAndFund() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 30e6, deadline, _sig(PK1, _deployDigest(cc, 30e6, deadline)));
        assertEq(dep.ownerOf(id), address(vault), "vault owns the deployment");
        assertEq(dep.funded6(id), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 70e6);
        assertEq(usdc.balanceOf(address(0xFEE)), 30e6, "funding landed at the ledger payout");
        assertEq(vault.nonce(), 1);
    }

    function test_replayRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vault.deployAndFund(cc, 10e6, deadline, w);
        vm.expectRevert(bytes("bad signature"));   // nonce moved; old digest is dead
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_unregisteredKeyRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        // digest+sig BEFORE expectRevert: the helpers call vault.nonce(), an
        // external view that would otherwise consume the expected revert
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK2, _deployDigest(cc, 10e6, deadline));
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_tamperedAmountRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 99e6, deadline, w);   // signed $10, submitted $99
    }

    function test_expiredDeadlineRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(bytes("expired"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_missingUPFlagRejected() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(cc, 10e6, deadline));
        w.authenticatorData[32] = bytes1(0x04);   // UV without UP
        vm.expectRevert(bytes("bad signature"));
        vault.deployAndFund(cc, 10e6, deadline, w);
    }

    function test_nonCreateSelectorRejected() public {
        bytes memory evil = abi.encodeWithSignature("transfer(address,uint256)", address(0xdead), 100e6);
        uint256 deadline = block.timestamp + 300;
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, _deployDigest(evil, 0, deadline));
        vm.expectRevert(bytes("not create()"));
        vault.deployAndFund(evil, 0, deadline, w);
    }

    // ---- fund / control ---------------------------------------------------------

    function test_fundExisting() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.fundDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), id, 25e6, deadline));
        vault.fundDeployment(id, 25e6, deadline, _sig(PK1, digest));
        assertEq(dep.funded6(id), 35e6);
    }

    function test_controlAllowsLedgerSettersOnly() public {
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 10e6, deadline, _sig(PK1, _deployDigest(cc, 10e6, deadline)));

        bytes memory setA = abi.encodeWithSignature("setActive(bytes32,bool)", id, false);
        bytes32 d1 = keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(setA), deadline));
        vault.controlDeployment(setA, deadline, _sig(PK1, d1));
        assertEq(dep.activeOf(id), false);

        bytes memory evil = abi.encodeWithSignature("fund(bytes32,uint256)", id, 1);
        bytes32 d2 = keccak256(abi.encode(keccak256("EnclaveVault.controlDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), keccak256(evil), deadline));
        EnclaveCreditVault.WebAuthnSig memory w2 = _sig(PK1, d2);
        vm.expectRevert(bytes("selector not allowed"));
        vault.controlDeployment(evil, deadline, w2);
    }

    // ---- refund + keys ----------------------------------------------------------

    function test_refundGoesOnlyToTreasury() public {
        uint256 deadline = block.timestamp + 300;
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(40e6), deadline));
        vault.refundToTreasury(40e6, deadline, _sig(PK1, digest));
        assertEq(usdc.balanceOf(treasury), 40e6);
        assertEq(usdc.balanceOf(address(vault)), 60e6);
    }

    function test_addAndRemoveKey_lastKeyGuard() public {
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PK2);
        uint256 deadline = block.timestamp + 300;
        bytes32 dAdd = keccak256(abi.encode(keccak256("EnclaveVault.addKey.v1"), address(vault),
            block.chainid, vault.nonce(), x2, y2, deadline));
        vault.addKey(x2, y2, deadline, _sig(PK1, dAdd));
        assertEq(vault.keyCount(), 2);

        // the new device can sign ops
        bytes32 dRef = keccak256(abi.encode(keccak256("EnclaveVault.refundToTreasury.v1"), address(vault),
            block.chainid, vault.nonce(), uint256(1e6), deadline));
        vault.refundToTreasury(1e6, deadline, _sig(PK2, dRef));

        bytes32 kh1 = keccak256(abi.encode(x1, y1));
        bytes32 dDel = keccak256(abi.encode(keccak256("EnclaveVault.removeKey.v1"), address(vault),
            block.chainid, vault.nonce(), kh1, deadline));
        vault.removeKey(kh1, deadline, _sig(PK2, dDel));
        assertEq(vault.keyCount(), 1);

        bytes32 kh2 = keccak256(abi.encode(x2, y2));
        bytes32 dLast = keccak256(abi.encode(keccak256("EnclaveVault.removeKey.v1"), address(vault),
            block.chainid, vault.nonce(), kh2, deadline));
        EnclaveCreditVault.WebAuthnSig memory wLast = _sig(PK2, dLast);
        vm.expectRevert(bytes("last key"));
        vault.removeKey(kh2, deadline, wLast);
    }

    // ---- ERC-1271 ---------------------------------------------------------------

    function test_isValidSignature() public view {
        bytes32 h = keccak256("an enclave session challenge");
        EnclaveCreditVault.WebAuthnSig memory w = _sig(PK1, h);
        assertEq(vault.isValidSignature(h, abi.encode(w)), bytes4(0x1626ba7e));
        EnclaveCreditVault.WebAuthnSig memory bad = _sig(PK2, h);
        assertEq(vault.isValidSignature(h, abi.encode(bad)), bytes4(0xffffffff));
    }

    // ---- fuzz -------------------------------------------------------------------

    function testFuzz_fundAmounts(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 100e6);
        bytes memory cc = _createCall();
        uint256 deadline = block.timestamp + 300;
        bytes32 id = vault.deployAndFund(cc, 0, deadline, _sig(PK1, _deployDigest(cc, 0, deadline)));
        bytes32 digest = keccak256(abi.encode(keccak256("EnclaveVault.fundDeployment.v1"), address(vault),
            block.chainid, vault.nonce(), id, uint256(amount), deadline));
        vault.fundDeployment(id, amount, deadline, _sig(PK1, digest));
        assertEq(dep.funded6(id), amount);
    }
}
