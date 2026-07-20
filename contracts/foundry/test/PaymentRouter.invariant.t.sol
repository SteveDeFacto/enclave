// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PaymentRouter} from "../../PaymentRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Handler the invariant fuzzer drives: random actors mint, approve, permit,
/// pay, over/under-approve, and hit reverting paths. Ghost counters track
/// every USDC the router ever forwarded so the invariants can assert
/// (a) the router balance is identically zero after every operation and
/// (b) the treasury received exactly the sum of emitted payments.
contract RouterHandler is Test {
    PaymentRouter public router;
    MockUSDC public usdc;
    address public treasury;

    uint256 public ghostPaid;      // sum of amounts successfully paid
    uint256 public ghostCalls;

    address[3] actors;
    uint256[3] keys;

    constructor(PaymentRouter _router, MockUSDC _usdc, address _treasury) {
        router = _router;
        usdc = _usdc;
        treasury = _treasury;
        for (uint256 i = 0; i < 3; i++) {
            (actors[i], keys[i]) = makeAddrAndKey(string(abi.encodePacked("actor", i)));
        }
    }

    function _actor(uint256 seed) private view returns (address a, uint256 k) {
        uint256 i = seed % 3;
        return (actors[i], keys[i]);
    }

    function mint(uint256 seed, uint96 amount) external {
        (address a,) = _actor(seed);
        usdc.mint(a, bound(amount, 0, 1_000_000e6));
    }

    function approveRouter(uint256 seed, uint96 amount) external {
        (address a,) = _actor(seed);
        vm.prank(a);
        usdc.approve(address(router), amount);
    }

    function pay(uint256 seed, uint96 amount, bytes32 orderRef) external {
        (address a,) = _actor(seed);
        ghostCalls++;
        vm.prank(a);
        try router.pay(amount, orderRef) {
            ghostPaid += amount;
        } catch {}
    }

    function payWithApprove(uint256 seed, uint96 amount, bytes32 orderRef) external {
        (address a,) = _actor(seed);
        uint256 amt = bound(amount, 1, 1_000_000e6);
        usdc.mint(a, amt);
        vm.startPrank(a);
        usdc.approve(address(router), amt);
        try router.pay(amt, orderRef) {
            ghostPaid += amt;
        } catch {}
        vm.stopPrank();
    }

    function payWithPermit(uint256 seed, uint96 amount, bytes32 orderRef) external {
        (address a, uint256 k) = _actor(seed);
        uint256 amt = bound(amount, 1, 1_000_000e6);
        usdc.mint(a, amt);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            a, address(router), amt, usdc.nonces(a), deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, digest);
        vm.prank(a);
        try router.payWithPermit(amt, orderRef, deadline, v, r, s) {
            ghostPaid += amt;
        } catch {}
    }

    function payWithBadPermit(uint256 seed, uint96 amount, bytes32 orderRef) external {
        (address a,) = _actor(seed);
        vm.prank(a);
        try router.payWithPermit(amount, orderRef, block.timestamp + 1, 27, bytes32(seed), bytes32(uint256(seed) + 1)) {
            ghostPaid += amount;
        } catch {}
    }

    /// Someone transfers USDC straight to the router by mistake. The zero-
    /// balance invariant is about ROUTED funds: pay() must never leave
    /// anything behind. A direct transfer is out-of-band (and out of reach:
    /// no rescue function exists, deliberately), so the handler does not do
    /// this - kept as documentation of the boundary.
    function toggleFailTransfers(uint256 seed) external {
        usdc.setFailTransfers(seed % 5 == 0);
    }
}

contract PaymentRouterInvariant is StdInvariant, Test {
    MockUSDC usdc;
    PaymentRouter router;
    RouterHandler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockUSDC();
        router = new PaymentRouter(address(usdc), treasury);
        handler = new RouterHandler(router, usdc, treasury);
        targetContract(address(handler));
    }

    /// The router's token balance is zero after EVERY operation, including
    /// arbitrary fuzzed sequences with reverting calls interleaved.
    function invariant_routerBalanceZero() public view {
        assertEq(usdc.balanceOf(address(router)), 0, "router must never hold USDC");
    }

    /// Everything that was ever successfully paid landed at the treasury,
    /// in full (no fee skim, no residue).
    function invariant_treasuryGotEverything() public view {
        assertEq(usdc.balanceOf(treasury), handler.ghostPaid(), "treasury delta != sum(paid)");
    }
}
