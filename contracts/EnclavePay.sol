// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclavePay — non-custodial pay-per-deploy forwarder for Enclave.
/// @notice Users fund a deployment (and top it up) by paying USDC here. The
///         contract holds NOTHING across transactions: USDC is pulled from the
///         payer and forwarded to `payout` (the Enclave cold wallet's
///         address) in the SAME transaction. It emits Paid(deploymentId, payer,
///         amount) so the supervisor — which only WATCHES this contract, never
///         holds a key — can convert each payment into runtime and extend the
///         deployment's expiry. No balances, no escrow, no operator key that can
///         move funds.
///
/// Flow (EIP-3009, no approve): the payer signs a USDC ReceiveWithAuthorization
///       (EIP-712) with `to` = this contract, then anyone submits it via
///       payWithAuthorization(deploymentId, ...). USDC lands here and is
///       forwarded to payout in the same tx; Paid is emitted for attribution.
///       One transaction instead of approve+pay, no allowance left behind, and
///       the tx may be relayed by a third party (the payer needs no gas).
///
///       The authorization's nonce must start with the first 16 bytes of
///       deploymentId (the rest is random). USDC's receiveWithAuthorization
///       already requires `to == msg.sender`, so only this contract can consume
///       the signature; the nonce prefix additionally binds it to ONE
///       deployment, so a relayer can't credit a different deployment with the
///       payer's money.
///
///       Native ETH: call payEth(deploymentId) with msg.value — same
///       non-custodial forward, PaidEth is emitted; the supervisor converts
///       wei -> runtime at the Chainlink ETH/USD rate when it sees the event.
interface IERC20Auth {
    function transfer(address to, uint256 amount) external returns (bool);
    /// EIP-3009 (FiatTokenV2_2 bytes-signature variant: ECDSA or EIP-1271, so
    /// smart-contract wallets can pay too). Reverts unless to == msg.sender.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract EnclavePay {
    address public owner;             // can update payout / hand off ownership
    address public pendingOwner;      // two-step handoff: must acceptOwnership()
    address public payout;            // where USDC lands (the Enclave cold wallet)
    IERC20Auth public immutable usdc; // USDC token (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    uint256 private _entered = 1;      // reentrancy guard (1 = free, 2 = inside a value-moving call)

    /// @dev Cheap non-reentrancy lock (1/2 pattern avoids the cold-slot SSTORE
    ///      penalty). Guards the payout.call in payEth so, if `payout` is ever a
    ///      contract, it can't reenter — behavior is identical for the normal EOA
    ///      payout, which never calls back.
    modifier nonReentrant() {
        require(_entered == 1, "reentrant");
        _entered = 2;
        _;
        _entered = 1;
    }

    event Paid(bytes32 indexed deploymentId, address indexed payer, uint256 amount);
    event PaidEth(bytes32 indexed deploymentId, address indexed payer, uint256 amountWei);
    event PayoutChanged(address indexed payout);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    constructor(address _usdc, address _payout) {
        require(_usdc != address(0) && _payout != address(0), "zero addr");
        owner = msg.sender;
        usdc = IERC20Auth(_usdc);
        payout = _payout;
        emit PayoutChanged(_payout);
        emit OwnerChanged(msg.sender);
    }

    /// @notice Fund/top-up a deployment with a signed USDC authorization
    ///         (EIP-3009 receiveWithAuthorization). Callable by anyone; the
    ///         payer credited is `from` (the authorization's signer).
    /// @param deploymentId the supervisor's payment reference (keccak256 of its id)
    /// @param from         the payer (signer of the authorization)
    /// @param value        USDC amount (6 decimals)
    /// @param validAfter   authorization not valid before this unix time
    /// @param validBefore  authorization not valid at/after this unix time
    /// @param nonce        first 16 bytes MUST equal the first 16 bytes of
    ///                     deploymentId; remaining 16 bytes are random (lets the
    ///                     same payer top up the same deployment repeatedly)
    /// @param signature    the payer's EIP-712 signature (65-byte ECDSA, or
    ///                     EIP-1271 data for smart-contract wallets)
    function payWithAuthorization(
        bytes32 deploymentId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        require(value > 0, "amount=0");
        // the signed nonce commits to the deployment, so this signature cannot
        // be replayed (by the relayer or anyone) to credit a different one
        require(bytes16(nonce) == bytes16(deploymentId), "nonce !~ deploymentId");
        // USDC verifies the signature and requires to == msg.sender (us)
        usdc.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        // forward in the same tx; nothing is held here between transactions
        require(usdc.transfer(payout, value), "USDC transfer failed");
        emit Paid(deploymentId, from, value);
    }

    /// @notice Fund/top-up a deployment with native ETH. Forwarded straight to payout
    ///         in the same tx (never held here). The supervisor prices the wei at the
    ///         Chainlink ETH/USD rate when the PaidEth event lands.
    /// @param deploymentId the supervisor's payment reference (keccak256 of its id)
    function payEth(bytes32 deploymentId) external payable nonReentrant {
        require(msg.value > 0, "value=0");
        (bool ok, ) = payout.call{value: msg.value}("");
        require(ok, "ETH transfer failed");
        emit PaidEth(deploymentId, msg.sender, msg.value);
    }

    function setPayout(address p) external {
        require(msg.sender == owner, "!owner");
        require(p != address(0), "zero addr");
        payout = p;
        emit PayoutChanged(p);
    }

    /// @notice Begin a TWO-STEP ownership handoff. `o` must call acceptOwnership()
    ///         to take control; until then `owner` is unchanged, so a mistyped
    ///         address can never strand governance of the payout key.
    function setOwner(address o) external {
        require(msg.sender == owner, "!owner");
        require(o != address(0), "zero addr");
        pendingOwner = o;
        emit OwnershipTransferStarted(owner, o);
    }

    /// @notice Complete the handoff. Only the pending owner may finalize.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
