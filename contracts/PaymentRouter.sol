// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PaymentRouter — non-custodial order-payment forwarder for Enclave.
/// @notice Customers pay a USD-quoted order in USDC here. The contract holds
///         NOTHING, ever: USDC moves payer -> treasury inside the transferFrom
///         of the same transaction, and PaymentReceived(orderRef, payer,
///         amount) is emitted so the relay's indexer — which only WATCHES this
///         contract, never holds a key that can move funds — can match the
///         payment to an order and provision it.
///
///         Unlike every other Enclave contract this one has NO owner, NO
///         setPayout, NO pause, NO rescue, NO upgrade path — deliberately.
///         The treasury is an immutable set at deploy; rotating the treasury
///         means deploying a new router and updating the address book. With no
///         admin surface and an identically-zero balance there is nothing an
///         operator key could ever take.
///
///         USDC only (v1): the token is fixed at deploy. No ETH — there is no
///         receive/fallback, and payable functions do not exist here.
///
/// Flow:  pay(amount, orderRef)            after a standard approve; or
///        payWithPermit(amount, orderRef, deadline, v, r, s)  single-tx via
///        EIP-2612 (Base native USDC, FiatTokenV2_2, supports permit). The
///        permit call is wrapped in try/catch: anyone can front-run a permit
///        by submitting the signature directly to the token, so if permit
///        reverts but the allowance already covers the amount, payment
///        proceeds anyway.
///
///        orderRef is an opaque bytes32 minted by the order service. The
///        contract does not validate it — a payment against an unknown or
///        expired ref still forwards to the treasury (funds are never stuck
///        here), and the indexer routes it to manual review.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20Permit {
    /// EIP-2612.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract PaymentRouter {
    IERC20  public immutable usdc;     // USDC token (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    address public immutable treasury; // where every payment lands, set once at deploy

    event PaymentReceived(bytes32 indexed orderRef, address indexed payer, uint256 amount);

    constructor(address _usdc, address _treasury) {
        require(_usdc != address(0) && _treasury != address(0), "zero addr");
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    /// @notice Pay an order after a standard USDC approve to this contract.
    /// @param amount   USDC amount (6 decimals)
    /// @param orderRef the order service's opaque bytes32 reference
    function pay(uint256 amount, bytes32 orderRef) external {
        _pay(amount, orderRef);
    }

    /// @notice Pay an order in a single transaction with an EIP-2612 permit.
    ///         If the permit has already been consumed (front-run) but the
    ///         allowance covers `amount`, the payment still goes through.
    /// @param amount   USDC amount (6 decimals); also the permit value
    /// @param orderRef the order service's opaque bytes32 reference
    /// @param deadline the permit deadline the payer signed
    /// @param v        permit signature v
    /// @param r        permit signature r
    /// @param s        permit signature s
    function payWithPermit(
        uint256 amount,
        bytes32 orderRef,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), amount, deadline, v, r, s) {
            // allowance granted by the permit
        } catch {
            require(usdc.allowance(msg.sender, address(this)) >= amount, "permit failed");
        }
        _pay(amount, orderRef);
    }

    function _pay(uint256 amount, bytes32 orderRef) private {
        require(amount > 0, "amount=0");
        // payer -> treasury DIRECT: the router's balance is zero even inside
        // the transaction; nothing is ever held here to pause or rescue
        require(usdc.transferFrom(msg.sender, treasury, amount), "USDC transferFrom failed");
        emit PaymentReceived(orderRef, msg.sender, amount);
    }
}
