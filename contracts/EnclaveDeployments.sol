// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveDeployments — portable deployment ledger + failover lease market for Enclave.
/// @notice Makes a deployment a CHAIN OBJECT instead of one enclave's private state,
///         so any registered enclave can pick up a deployment whose runner died and
///         keep serving it until the funded time runs out. Three things move on-chain
///         that today live only in a supervisor's state.json:
///           1. the INTENT  — what to run (appRef), with what share/ports/visibility;
///           2. the BALANCE — funded runtime, credited by payments, burned by leases;
///           3. the LEASE   — which enclave is serving it right now, and until when.
///         Deployments become work items in a queue: an enclave CLAIMS one (taking a
///         bounded lease and burning its cost from the balance), RENEWs while healthy,
///         and RELEASEs on graceful shutdown (refunding the unused tail). If a runner
///         dies silently, its lease simply expires and any other enclave may claim
///         the remainder — at-most-one-runner-at-a-time is enforced by the chain, not
///         by an operator.
///
/// Non-custodial, like EnclavePay: funding forwards USDC/ETH payer -> payout in the SAME
///         transaction; nothing is ever held here. `balance6` is an ACCOUNTING number
///         (prepaid runtime, USDC 6dp), not escrowed money — so leases can "burn" and
///         "refund" it freely, but stopping a deployment cannot push funds back to the
///         payer on-chain (that stays a payout-wallet action, as today).
///
/// Trust model (consistent with the other Enclave contracts — claims here, attestation
///         gates trust at connect time):
///   - CREATE is permissionless: any address records an intent (it is inert until
///     funded — an unfunded deployment cannot be claimed and costs nobody anything).
///   - CLAIM is structurally gated to registered enclaves: msg.sender must be the
///     operator of an active EnclaveRegistry entry. That does NOT make the runner
///     trusted — callers still attest the enclave itself when they connect. A rogue
///     operator can claim, but can't fake the measurement clients verify.
///   - Catalog approval is enforced by RUNNERS, off-chain, exactly as today: an
///     enclave refuses to claim an ipfs:// appRef whose version isn't Approved in
///     EnclaveAppCatalog (one cidStatus eth_call, fail closed). The ledger doesn't parse
///     appRefs; the enclave that would run the code is the one that checks it.
///   - Pricing: two global per-second prices, hardcoded at deploy (~$6.00/hour
///     for a full GPU card, ~$2.00/hour for a full CPU node) and owner-adjustable
///     later; each deployment SNAPSHOTS its rate at create (price changes never
///     re-price existing deployments). A deployment BUYS two shares — gpuMilli
///     of a card's GPU+VRAM and cpuMilli of a node's vCPU+RAM, in 1/1000ths —
///     and pays for both: rate = (gpuPrice * gpuMilli + cpuPrice * cpuMilli)
///     / 1000, rounded up. Apps declare their EXACT resource specs (VRAM,
///     TFLOPS, RAM) in EnclaveAppCatalog; runners convert those specs into each
///     app's MINIMUM shares (spec / their hardware, the larger of the memory
///     and compute axes) and refuse deployments that bought less.
///
/// Fairness bounds (the cost of decentralized failover, all bounded by leaseSec):
///   - a runner that dies mid-lease has already burned that lease: the user loses at
///     most leaseSec of paid time per runner death (clean shutdowns refund via
///     release; the old per-tick freezing clock can't exist without a trusted party).
///   - two enclaves may race to claim; the loser's tx reverts (gas, cents on Base).
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

/// @dev Field order MUST match EnclaveRegistry.Enclave exactly (ABI-decoded struct).
interface IEnclaveRegistry {
    struct Enclave {
        string  endpoint;
        string  repo;
        bytes32 measurement;
        address operator;
        uint64  registeredAt;
        uint64  lastSeen;
        bool    active;
    }
    function get(bytes32 id) external view returns (Enclave memory);
}

/// @dev Chainlink price feed (ETH/USD, 8 decimals on Base).
interface IAggregatorV3 {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}

contract EnclaveDeployments {
    struct Deployment {
        bytes32 id;
        address owner;          // the user: controls config + active, receives nothing (non-custodial)
        string  appRef;         // "ipfs://<cid>" or a baked-in catalog id (e.g. "hello")
        string  ports;          // firewall CSV, same grammar as EnclaveAppCatalog Version.ports ("" = plain wasi:http)
        string  sshPubKey;      // optional OpenSSH public key every runner installs ("" = ssh disabled;
                                // enclave-minted keys are NOT portable — the private key would die with the runner)
        string  configCid;      // optional IPFS CID of a config blob ("" = none). NOTE: whatever it
                                // points at is PUBLIC unless encrypted; see DEPLOYMENTS.md "secrets".
        uint16  gpuMilli;       // GPU/VRAM share bought, in 1/1000ths of a card (0 = CPU-only
                                // deployment). GPU deployments (gpuMilli > 0) are claimable by GPU
                                // enclaves ONLY; CPU-only ones by CPU-only enclaves first, and by GPU
                                // enclaves with spare CPU/RAM after a grace window (runner-enforced).
                                // Must be >= the app's minimum share: runners derive minimums from the
                                // app's exact specs in EnclaveAppCatalog (spec / their hardware, the larger
                                // of the memory and compute axes) and refuse under-provisioned claims.
        uint16  cpuMilli;       // CPU/RAM share bought, in 1/1000ths of a node (1..1000). A GPU
                                // deployment's CPU share rides along on the same node, so it may never
                                // exceed the GPU share: gpuMilli == 0 || gpuMilli >= cpuMilli.
        uint32  appPort;        // guest HTTP port the app serves on
        bool    isPublic;       // anyone may hit the data path (vs owner-only)
        bool    active;         // owner-set; inactive is not claimable/fundable (kept for history)
        uint64  createdAt;
        // ---- billing (USDC 6dp; accounting numbers, never held funds) ----
        uint256 rate;           // per-second price, snapshotted at create
        uint256 balance6;       // funded runtime credit not yet burned by a lease
        uint256 spent6;         // burned by leases (release refunds the unused tail back to balance6)
        // ---- lease (the "processing lock") ----
        bytes32 runner;         // EnclaveRegistry enclave id currently serving (0x0 = unclaimed)
        address runnerOperator; // the operator EOA that claimed (sends renew/release)
        uint64  leaseUntil;     // lease expiry; in the past (or 0) = claimable
    }

    uint256 private constant MAX_APPREF = 100;   // ipfs://<cid> fits
    uint256 private constant MAX_PORTS  = 96;    // mirrors EnclaveAppCatalog
    uint256 private constant MAX_SSHKEY = 800;   // ed25519 ~100 chars; RSA-4096 ~740
    uint256 private constant MAX_CFG    = 100;   // a CID
    uint256 private constant FEED_MAX_AGE = 2 hours; // reject stale ETH/USD answers

    address public owner;                  // sets price/leaseSec/payout; NOT a custodian
    address public payout;                 // where funding lands (the Enclave cold wallet)
    IERC20Auth   public immutable usdc;
    IEnclaveRegistry public immutable registry;
    IAggregatorV3 public ethUsdFeed;       // 0x0 = ETH funding disabled (USDC only)

    // Prices are HARDCODED at deploy (no post-deploy setter txs needed — Base's
    // public RPC caps delegated EOAs at one in-flight tx, so follow-up sends
    // right after the deploy bounce). Owner setters remain for later changes.
    uint256 public pricePerSec6 = 1667;    // USDC 6dp per second, FULL card (gpuMilli = 1000): ~$6.00/hour
    uint256 public cpuPricePerSec6 = 556;  // USDC 6dp per second, FULL CPU node (cpuMilli = 1000): ~$2.00/hour
    uint64  public leaseSec = 1800;        // lease quantum: max claim/renew burn, max time lost to a dead runner

    bytes32[] private _ids;                                // every deployment ever created
    mapping(bytes32 => Deployment) private _deployments;
    mapping(bytes32 => bool) private _exists;
    mapping(address => uint64) private _nonces;            // per-creator id salt

    event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate);
    event ConfigSet(bytes32 indexed id, string sshPubKey, string configCid);
    event ActiveSet(bytes32 indexed id, bool active);
    event Funded(bytes32 indexed id, address indexed payer, uint256 amount6);
    event FundedEth(bytes32 indexed id, address indexed payer, uint256 amountWei, uint256 credited6);
    event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6);
    event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6);
    event Released(bytes32 indexed id, bytes32 indexed enclaveId, uint256 refunded6);
    event PriceSet(uint256 pricePerSec6);
    event CpuPriceSet(uint256 cpuPricePerSec6);
    event LeaseSecSet(uint64 leaseSec);
    event PayoutChanged(address indexed payout);
    event OwnerChanged(address indexed owner);
    event FeedChanged(address indexed feed);

    constructor(address _usdc, address _payout, address _registry, address _ethUsdFeed) {
        require(_usdc != address(0) && _payout != address(0) && _registry != address(0), "zero addr");
        owner = msg.sender;
        usdc = IERC20Auth(_usdc);
        payout = _payout;
        registry = IEnclaveRegistry(_registry);
        ethUsdFeed = IAggregatorV3(_ethUsdFeed);   // may be 0x0: ETH funding off
        emit PayoutChanged(_payout);
        emit OwnerChanged(msg.sender);
        emit PriceSet(pricePerSec6);               // prices are live from deploy (hardcoded defaults)
        emit CpuPriceSet(cpuPricePerSec6);
    }

    // ========================================================================
    // user side: create / configure / fund
    // ========================================================================

    /// @notice Record a deployment intent. Permissionless and inert until funded.
    /// @dev id embeds the creator + a per-creator nonce, so ids can't be squatted
    ///      or predicted across owners (same structural-ownership trick as the
    ///      catalog's appId). The rate snapshot makes future price changes
    ///      non-retroactive. The two shares pick which enclaves will claim:
    ///      gpuMilli > 0 is served by GPU enclaves only; gpuMilli == 0 is served
    ///      by CPU-only enclaves first, then by GPU enclaves with spare CPU/RAM.
    ///      A GPU deployment's CPU share may never exceed its GPU share. The
    ///      shares must also cover the app's minimum (derived by runners from
    ///      its EnclaveAppCatalog specs) or no enclave will claim the deployment.
    function create(
        string calldata appRef,
        uint16 gpuMilli,
        uint16 cpuMilli,
        uint32 appPort,
        string calldata ports,
        bool isPublic,
        string calldata sshPubKey,
        string calldata configCid
    ) external returns (bytes32 id) {
        require(bytes(appRef).length > 0 && bytes(appRef).length <= MAX_APPREF, "appRef length");
        require(cpuMilli > 0 && cpuMilli <= 1000, "cpuMilli range");
        require(gpuMilli <= 1000, "gpuMilli range");
        require(gpuMilli == 0 || gpuMilli >= cpuMilli, "gpuShare < cpuShare");
        require(appPort > 0, "appPort range");
        require(bytes(ports).length <= MAX_PORTS, "ports length");
        require(bytes(sshPubKey).length <= MAX_SSHKEY, "sshPubKey length");
        require(bytes(configCid).length <= MAX_CFG, "configCid length");

        id = keccak256(abi.encodePacked(msg.sender, _nonces[msg.sender]++));
        _exists[id] = true;
        _ids.push(id);

        Deployment storage d = _deployments[id];
        d.id = id;
        d.owner = msg.sender;
        d.appRef = appRef;
        d.ports = ports;
        d.sshPubKey = sshPubKey;
        d.configCid = configCid;
        _initScalars(d, appRef, gpuMilli, cpuMilli, appPort, isPublic);
    }

    /// @dev Split out (emit included) so create() keeps a workable stack frame
    ///      without viaIR (same shape as the catalog's `_reserveCid` / `_touchApp`).
    function _initScalars(Deployment storage d, string calldata appRef, uint16 gpuMilli,
                          uint16 cpuMilli, uint32 appPort, bool isPublic) private {
        require(cpuPricePerSec6 > 0 && (gpuMilli == 0 || pricePerSec6 > 0), "price unset");
        d.gpuMilli = gpuMilli;
        d.cpuMilli = cpuMilli;
        d.appPort = appPort;
        d.isPublic = isPublic;
        d.active = true;
        d.createdAt = uint64(block.timestamp);
        // both shares are paid for; ceil so a 1-milli deployment still pays >= 1 unit/sec
        d.rate = (pricePerSec6 * gpuMilli + cpuPricePerSec6 * cpuMilli + 999) / 1000;
        emit Created(d.id, msg.sender, appRef, gpuMilli, cpuMilli, d.rate);
    }

    /// @notice Update the portable config; runners apply it on the next (re)launch.
    function setConfig(bytes32 id, string calldata sshPubKey, string calldata configCid) external {
        Deployment storage d = _requireOwned(id);
        require(bytes(sshPubKey).length <= MAX_SSHKEY, "sshPubKey length");
        require(bytes(configCid).length <= MAX_CFG, "configCid length");
        d.sshPubKey = sshPubKey;
        d.configCid = configCid;
        emit ConfigSet(id, sshPubKey, configCid);
    }

    /// @notice Stop (or restart) a deployment. Stopping does NOT touch the current
    ///         lease — a well-behaved runner sees ActiveSet, tears down, and
    ///         releases (refunding the lease tail to the balance). The balance
    ///         stays recorded, so reactivating later resumes from what's left.
    function setActive(bytes32 id, bool active) external {
        Deployment storage d = _requireOwned(id);
        d.active = active;
        emit ActiveSet(id, active);
    }

    /// @notice Fund/top-up with a signed USDC authorization (EIP-3009). Callable by
    ///         anyone; the payer credited is `from`. Same non-custodial forward and
    ///         nonce-binding as EnclavePay: the authorization's nonce must start with
    ///         the first 16 bytes of `id`, so a relayer can't redirect the credit.
    function fundWithAuthorization(
        bytes32 id,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        Deployment storage d = _requireActive(id);
        require(value > 0, "amount=0");
        require(bytes16(nonce) == bytes16(id), "nonce !~ id");
        usdc.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        require(usdc.transfer(payout, value), "USDC transfer failed");
        d.balance6 += value;
        emit Funded(id, from, value);
    }

    /// @notice Fund/top-up with native ETH, credited as USDC-equivalent at the live
    ///         Chainlink ETH/USD rate (on-chain, unlike EnclavePay where the supervisor
    ///         priced it off-chain — here the BALANCE is chain state, so the
    ///         conversion must be too). Forwarded straight to payout.
    function fundEth(bytes32 id) external payable {
        Deployment storage d = _requireActive(id);
        require(msg.value > 0, "value=0");
        require(address(ethUsdFeed) != address(0), "eth funding disabled");
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        require(answer > 0 && block.timestamp - updatedAt <= FEED_MAX_AGE, "stale price");
        // wei(1e18) * price(1e8) -> USDC 6dp: divide by 1e20
        uint256 credited = (msg.value * uint256(answer)) / 1e20;
        require(credited > 0, "dust");
        (bool ok, ) = payout.call{value: msg.value}("");
        require(ok, "ETH transfer failed");
        d.balance6 += credited;
        emit FundedEth(id, msg.sender, msg.value, credited);
    }

    // ========================================================================
    // runner side: claim / renew / release (the failover queue)
    // ========================================================================

    /// @notice Take the lease on a claimable deployment. Burns min(leaseSec,
    ///         remaining funded time) from the balance and makes the caller the
    ///         sole legitimate runner until leaseUntil. Claimable = active, funded,
    ///         and no live lease (never claimed, expired, or released).
    /// @dev msg.sender must be the operator of `enclaveId`, an active EnclaveRegistry
    ///      entry — structural gating, same shape as catalog lineage ownership.
    ///      The previous runner's burned lease is NOT refunded (it may be dead;
    ///      nobody trustworthy can attest how much it actually served).
    function claim(bytes32 id, bytes32 enclaveId) external {
        Deployment storage d = _requireActive(id);
        require(block.timestamp > d.leaseUntil, "leased");
        IEnclaveRegistry.Enclave memory e = registry.get(enclaveId);
        require(e.operator == msg.sender, "not operator");
        require(e.active, "enclave inactive");

        (uint64 until, uint256 burned) = _burnLease(d, uint64(block.timestamp));
        d.runner = enclaveId;
        d.runnerOperator = msg.sender;
        d.leaseUntil = until;
        emit Claimed(id, enclaveId, msg.sender, until, burned);
    }

    /// @notice Extend a live lease (only the current runner, only before expiry —
    ///         after expiry the job is back in the open queue and even the same
    ///         runner must re-claim). Burns the next quantum; extends FROM
    ///         leaseUntil, since time up to there is already paid.
    function renew(bytes32 id) external {
        Deployment storage d = _requireActive(id);
        require(d.runnerOperator == msg.sender, "not runner");
        require(block.timestamp <= d.leaseUntil, "lease expired");
        (uint64 until, uint256 burned) = _burnLease(d, d.leaseUntil);
        d.leaseUntil = until;
        emit Renewed(id, d.runner, until, burned);
    }

    /// @notice Graceful hand-back: refund the unused lease tail to the balance and
    ///         reopen the queue. Called on clean shutdown, on teardown after the
    ///         owner stops the deployment, or when provisioning fails right after
    ///         a claim (so the user doesn't pay for a runner that never served).
    function release(bytes32 id) external {
        Deployment storage d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.runnerOperator == msg.sender, "not runner");
        uint256 refund = 0;
        if (d.leaseUntil > block.timestamp) {
            refund = (d.leaseUntil - block.timestamp) * d.rate;
            d.balance6 += refund;
            d.spent6 -= refund;
        }
        bytes32 enclaveId = d.runner;
        d.runner = bytes32(0);
        d.runnerOperator = address(0);
        d.leaseUntil = 0;
        emit Released(id, enclaveId, refund);
    }

    /// @dev Burn one lease quantum starting at `from`: as many seconds as the
    ///      balance affords, capped at leaseSec. Reverts if the balance can't buy
    ///      a single second ("no more time left" — the queue drops the item).
    function _burnLease(Deployment storage d, uint64 from) private returns (uint64 until, uint256 burned) {
        uint256 secs = d.balance6 / d.rate;
        if (secs > leaseSec) secs = leaseSec;
        require(secs > 0, "unfunded");
        burned = secs * d.rate;
        d.balance6 -= burned;
        d.spent6 += burned;
        until = from + uint64(secs);
    }

    // ========================================================================
    // admin (pricing + parameters; no custody, no access to balances)
    // ========================================================================

    function setPrice(uint256 _pricePerSec6) external {
        require(msg.sender == owner, "!owner");
        require(_pricePerSec6 > 0, "price=0");
        pricePerSec6 = _pricePerSec6;      // affects FUTURE creates only (rate is snapshotted)
        emit PriceSet(_pricePerSec6);
    }

    /// @notice Whole-CPU-node per-second price (every deployment pays it on its
    ///         cpuMilli). 0 keeps creates disabled until it is deliberately set.
    function setCpuPrice(uint256 _cpuPricePerSec6) external {
        require(msg.sender == owner, "!owner");
        require(_cpuPricePerSec6 > 0, "price=0");
        cpuPricePerSec6 = _cpuPricePerSec6;   // affects FUTURE creates only (rate is snapshotted)
        emit CpuPriceSet(_cpuPricePerSec6);
    }

    function setLeaseSec(uint64 _leaseSec) external {
        require(msg.sender == owner, "!owner");
        require(_leaseSec >= 60 && _leaseSec <= 1 days, "lease range");
        leaseSec = _leaseSec;
        emit LeaseSecSet(_leaseSec);
    }

    function setEthUsdFeed(address feed) external {
        require(msg.sender == owner, "!owner");
        ethUsdFeed = IAggregatorV3(feed);  // 0x0 disables ETH funding
        emit FeedChanged(feed);
    }

    function setPayout(address p) external {
        require(msg.sender == owner, "!owner");
        require(p != address(0), "zero addr");
        payout = p;
        emit PayoutChanged(p);
    }

    function setOwner(address o) external {
        require(msg.sender == owner, "!owner");
        require(o != address(0), "zero addr");
        owner = o;
        emit OwnerChanged(o);
    }

    // ========================================================================
    // reads (enclave work-queue polling + client endpoint resolution)
    // ========================================================================

    function count() external view returns (uint256) { return _ids.length; }
    function idAt(uint256 i) external view returns (bytes32) { return _ids[i]; }
    function get(bytes32 id) external view returns (Deployment memory) { return _deployments[id]; }

    /// @notice True iff an enclave may claim right now (active + funded + no live lease).
    function claimable(bytes32 id) public view returns (bool) {
        Deployment storage d = _deployments[id];
        return _exists[id] && d.active && block.timestamp > d.leaseUntil && d.balance6 >= d.rate;
    }

    /// @notice Funded runtime left OUTSIDE the current lease (what future claims can buy).
    function secondsFundable(bytes32 id) external view returns (uint256) {
        Deployment storage d = _deployments[id];
        return d.rate == 0 ? 0 : d.balance6 / d.rate;
    }

    /// @notice Paginated dump (enclaves filter client-side, like registry discovery).
    function getPage(uint256 start, uint256 n) external view returns (Deployment[] memory page) {
        uint256 len = _ids.length;
        if (start >= len) return new Deployment[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new Deployment[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _deployments[_ids[i]];
    }

    // ------------------------------------------------------------------------
    function _requireOwned(bytes32 id) private view returns (Deployment storage d) {
        d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.owner == msg.sender, "not owner");
    }
    function _requireActive(bytes32 id) private view returns (Deployment storage d) {
        d = _deployments[id];
        require(_exists[id], "unknown");
        require(d.active, "inactive");
    }
}

/*
FUTURE (deliberately not in v1):
  - runner stake + slashing: claim() requires a bond, slashable if a watcher
    proves the runner never served the lease (ties into the registry's planned
    stake-to-register). v1's exposure is already bounded at leaseSec per death.
  - per-deployment price floors/auctions: today price is platform-set; a market
    would let runners bid, with the lease going to the cheapest attested enclave.
  - consumed-time attestation: runners could periodically post signed usage
    checkpoints, shrinking the "dead runner burns one lease" loss toward zero.
*/
