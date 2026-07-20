// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../../PaymentRouter.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PaymentRouterTest is Test {
    MockUSDC usdc;
    PaymentRouter router;

    address treasury = makeAddr("treasury");
    uint256 payerKey;
    address payer;

    event PaymentReceived(bytes32 indexed orderRef, address indexed payer, uint256 amount);

    function setUp() public {
        (payer, payerKey) = makeAddrAndKey("payer");
        usdc = new MockUSDC();
        router = new PaymentRouter(address(usdc), treasury);
        usdc.mint(payer, 1_000_000e6);
    }

    // ---- constructor ----

    function test_constructor_zeroAddrReverts() public {
        vm.expectRevert(bytes("zero addr"));
        new PaymentRouter(address(0), treasury);
        vm.expectRevert(bytes("zero addr"));
        new PaymentRouter(address(usdc), address(0));
    }

    function test_immutables() public view {
        assertEq(address(router.usdc()), address(usdc));
        assertEq(router.treasury(), treasury);
    }

    // ---- pay (approve path) ----

    function test_pay_forwardsToTreasury() public {
        vm.startPrank(payer);
        usdc.approve(address(router), 25e6);
        router.pay(25e6, bytes32(uint256(1)));
        vm.stopPrank();

        assertEq(usdc.balanceOf(treasury), 25e6);
        assertEq(usdc.balanceOf(payer), 1_000_000e6 - 25e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_pay_emitsEvent() public {
        bytes32 ref = keccak256("ord_abc");
        vm.startPrank(payer);
        usdc.approve(address(router), 7e6);
        vm.expectEmit(true, true, false, true, address(router));
        emit PaymentReceived(ref, payer, 7e6);
        router.pay(7e6, ref);
        vm.stopPrank();
    }

    function test_pay_zeroAmountReverts() public {
        vm.prank(payer);
        vm.expectRevert(bytes("amount=0"));
        router.pay(0, bytes32(uint256(1)));
    }

    function test_pay_insufficientAllowanceReverts() public {
        vm.startPrank(payer);
        usdc.approve(address(router), 1e6);
        vm.expectRevert(bytes("allowance"));
        router.pay(2e6, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_pay_transferReturningFalseReverts() public {
        vm.startPrank(payer);
        usdc.approve(address(router), 5e6);
        usdc.setFailTransfers(true);
        vm.expectRevert(bytes("USDC transferFrom failed"));
        router.pay(5e6, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function testFuzz_pay(uint96 amount, bytes32 orderRef) public {
        amount = uint96(bound(amount, 1, 1_000_000e6));
        vm.startPrank(payer);
        usdc.approve(address(router), amount);
        vm.expectEmit(true, true, false, true, address(router));
        emit PaymentReceived(orderRef, payer, amount);
        router.pay(amount, orderRef);
        vm.stopPrank();

        assertEq(usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ---- payWithPermit ----

    function _signPermit(uint256 key, address owner, uint256 value, uint256 deadline)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            owner,
            address(router),
            value,
            usdc.nonces(owner),
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function test_payWithPermit_happy() public {
        bytes32 ref = keccak256("ord_permit");
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(payerKey, payer, 42e6, block.timestamp + 1 hours);

        vm.prank(payer);
        vm.expectEmit(true, true, false, true, address(router));
        emit PaymentReceived(ref, payer, 42e6);
        router.payWithPermit(42e6, ref, block.timestamp + 1 hours, v, r, s);

        assertEq(usdc.balanceOf(treasury), 42e6);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.allowance(payer, address(router)), 0); // fully consumed
    }

    /// A griefer can lift the permit signature from the mempool and submit it
    /// to the token directly; the router call must still succeed off the
    /// allowance that permit created.
    function test_payWithPermit_frontRun() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(payerKey, payer, 10e6, deadline);

        // front-run: consume the permit directly on the token
        usdc.permit(payer, address(router), 10e6, deadline, v, r, s);

        // the same signature now reverts inside permit (nonce consumed), but
        // the allowance is in place - payment must proceed
        vm.prank(payer);
        router.payWithPermit(10e6, bytes32(uint256(2)), deadline, v, r, s);
        assertEq(usdc.balanceOf(treasury), 10e6);
    }

    function test_payWithPermit_badSigNoAllowanceReverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(payerKey, payer, 10e6, block.timestamp + 1 hours);
        vm.prank(payer);
        vm.expectRevert(bytes("permit failed"));
        // wrong amount: struct hash mismatch -> permit reverts, no allowance
        router.payWithPermit(11e6, bytes32(uint256(3)), block.timestamp + 1 hours, v, r, s);
    }

    function test_payWithPermit_expiredNoAllowanceReverts() public {
        uint256 deadline = block.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(payerKey, payer, 10e6, deadline);
        vm.warp(deadline + 1);
        vm.prank(payer);
        vm.expectRevert(bytes("permit failed"));
        router.payWithPermit(10e6, bytes32(uint256(4)), deadline, v, r, s);
    }

    function testFuzz_payWithPermit(uint96 amount, bytes32 orderRef) public {
        amount = uint96(bound(amount, 1, 1_000_000e6));
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(payerKey, payer, amount, block.timestamp + 1 hours);

        vm.prank(payer);
        router.payWithPermit(amount, orderRef, block.timestamp + 1 hours, v, r, s);

        assertEq(usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
