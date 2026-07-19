// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveReviews — 1-5 star ratings with comments for catalog apps.
/// @notice The store's word-of-mouth layer. A reviewer rates an EnclaveAppCatalog
///         app 1..5 and may leave a comment; the record lives here, on Base,
///         so it outlives this site and any relay.
///
/// Who may review — the gate is a RECEIPT, not an account:
///         reviewing `appId` requires naming one of YOUR EnclaveDeployments
///         records that (a) you own, (b) references that app, and (c) was
///         actually funded. Creating a deployment costs only gas, so the
///         funding test is what makes a sybil expensive: a fake fleet of
///         reviewers has to buy runtime for the app it wants to praise. The
///         contract reads the ledger itself — the caller can't forge the
///         receipt, only point at one.
///
///         This deliberately means reviews come from people who RAN the app,
///         not from people who looked at it. It's a narrower funnel than an
///         open review box and a much better signal.
///
/// One review per wallet per app, editable:
///         a second post() from the same wallet REPLACES the first (the tally
///         moves with it) rather than stacking. Ratings are an average, and an
///         average one wallet can stuff is not an average. Editing keeps the
///         original createdAt so the UI can still show "reviewed on".
///
/// Moderation — takedown only, never rewriting:
///         the owner can hide a review (illegal/abusive content). A hidden
///         review keeps its bytes on-chain (history is not editable) but drops
///         out of the tally, and STAYS hidden through an edit — otherwise a
///         takedown would last exactly one transaction. The owner cannot
///         change a rating, post as someone else, or delete anything.
///
/// Reading:
///         `talliesOf` answers a whole store page in one eth_call (count + sum
///         per app; the average is the reader's division — no rounding is
///         baked in). `getReviewsPage` pages one app's reviews in storage
///         order, hidden ones included and flagged, so the owner's moderation
///         view and the public view come from the same call.
interface IEnclaveAddressBook {
    function addr(bytes32 key) external view returns (address);
}

interface IEnclaveDeployments {
    /// EnclaveDeployments.Deployment, schema rev >= 2 (rev 3 and 4 share this
    /// layout; rev 1's extra sshPubKey string is NOT readable here — a rev-1
    /// ledger simply proves nothing, see _proved's fail-closed catch).
    /// Appended fields in a future rev stay compatible: a dynamic tuple's
    /// offsets are relative to its own head, so decoding a prefix is sound.
    struct Deployment {
        bytes32 id;
        address owner;
        string  appRef;
        string  ports;
        string  configCid;
        uint16  gpuMilli;
        uint16  cpuMilli;
        uint32  appPort;
        bool    isPublic;
        bool    active;
        uint64  createdAt;
        uint256 rate;
        uint256 balance6;
        uint256 spent6;
        bytes32 runner;
        address runnerOperator;
        uint64  leaseUntil;
    }
    function get(bytes32 id) external view returns (Deployment memory);
}

contract EnclaveReviews {
    struct Review {
        address reviewer;    // wallet that posted it (one review per wallet per app)
        uint8   stars;       // 1..5
        bool    hidden;      // owner takedown: out of the tally, still on-chain
        uint64  createdAt;   // first post (survives edits)
        uint64  updatedAt;   // last edit
        bytes32 deployment;  // the funded deployment that proved the reviewer ran the app
        string  body;        // the comment ("" = a bare rating)
    }

    /// @notice Struct-schema revision, for readers: 1 = this layout.
    uint256 public constant reviewsSchema = 1;
    /// @notice Comment ceiling in bytes. Generous for prose, small enough that
    ///         a review is never a data-availability dump.
    uint256 public constant MAX_BODY = 2000;

    address public owner;         // moderation (hide/unhide) only
    address public pendingOwner;  // two-step handoff: must acceptOwnership()

    /// @notice The platform root (EnclaveAddressBook). The ledger whose records
    ///         prove a reviewer ran an app is resolved THROUGH it on every
    ///         call, so a ledger redeploy reaches this contract the same way it
    ///         reaches the site, the CLI and the enclaves: one `set` on the
    ///         book, no transaction here, no drift to notice.
    ///
    ///         The trust statement is the book's own (see its header): the key
    ///         that governs the book governs which ledger counts as a receipt.
    ///         That key already approves catalog apps and deploys every
    ///         contract, so pinning a ledger here would add a lever without
    ///         adding a guarantee.
    IEnclaveAddressBook public immutable book;
    bytes32 public constant LEDGER_KEY = "deployments";   // ascii, right-padded — the book's derivation

    /// @notice Fallback ledger, used only when the book can't answer (no book
    ///         at all — a local or testnet deploy — or the key retired to
    ///         zero). Owner-settable so that case stays recoverable.
    address public ledgerFallback;

    struct Tally { uint32 count; uint32 sum; }   // visible reviews only; sum <= 5 * count

    mapping(bytes32 => Review[]) private _reviews;                  // appId -> reviews, storage order
    mapping(bytes32 => mapping(address => uint256)) private _idx1;  // appId -> reviewer -> index + 1 (0 = none)
    mapping(bytes32 => Tally) private _tally;                       // appId -> visible count/sum

    event ReviewPosted(bytes32 indexed appId, address indexed reviewer, uint8 stars, bytes32 deployment);
    event ReviewUpdated(bytes32 indexed appId, address indexed reviewer, uint8 stars);
    event ReviewHidden(bytes32 indexed appId, address indexed reviewer, bool hidden);
    event LedgerFallbackSet(address indexed ledger);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// @param _book        EnclaveAddressBook, the platform root (0 = none; then
    ///                     the fallback is the only ledger, and must be set).
    /// @param _ledgerFallback EnclaveDeployments to use when the book can't answer.
    constructor(address _book, address _ledgerFallback) {
        require(_book != address(0) || _ledgerFallback != address(0), "no ledger source");
        owner = msg.sender;
        book = IEnclaveAddressBook(_book);
        ledgerFallback = _ledgerFallback;
        emit LedgerFallbackSet(_ledgerFallback);
        emit OwnerChanged(msg.sender);
    }

    /// @notice The EnclaveDeployments ledger this contract checks receipts
    ///         against right now: the book's answer, or the fallback when the
    ///         book has none. Reads never revert — an unresolvable ledger is
    ///         address(0), which _proved treats as "proves nothing".
    function ledger() public view returns (address) {
        if (address(book) != address(0)) {
            try book.addr(LEDGER_KEY) returns (address a) { if (a != address(0)) return a; } catch {}
        }
        return ledgerFallback;
    }

    /* ---- write ---- */

    /// @notice Rate `appId` 1..5 with an optional comment, proving you ran it
    ///         with `deploymentId` — one of YOUR funded deployments of that app.
    ///         Posting again replaces your review (and moves the tally with it);
    ///         a hidden review stays hidden through the edit.
    function post(bytes32 appId, bytes32 deploymentId, uint8 stars, string calldata body) external {
        require(appId != bytes32(0), "zero app");
        require(stars >= 1 && stars <= 5, "stars 1..5");
        require(bytes(body).length <= MAX_BODY, "body too long");
        require(_proved(appId, deploymentId, msg.sender), "no funded deployment of this app");

        uint256 i1 = _idx1[appId][msg.sender];
        Tally storage t = _tally[appId];
        if (i1 == 0) {
            _reviews[appId].push(Review({
                reviewer: msg.sender, stars: stars, hidden: false,
                createdAt: uint64(block.timestamp), updatedAt: uint64(block.timestamp),
                deployment: deploymentId, body: body
            }));
            _idx1[appId][msg.sender] = _reviews[appId].length;
            t.count += 1;
            t.sum += stars;
            emit ReviewPosted(appId, msg.sender, stars, deploymentId);
        } else {
            Review storage r = _reviews[appId][i1 - 1];
            if (!r.hidden) t.sum = t.sum - r.stars + stars;   // hidden reviews are outside the tally
            r.stars = stars;
            r.body = body;
            r.deployment = deploymentId;
            r.updatedAt = uint64(block.timestamp);
            emit ReviewUpdated(appId, msg.sender, stars);
        }
    }

    /// @notice Owner moderation: take a review out of the tally (or put it
    ///         back). The text stays on-chain — this hides it from readers, it
    ///         does not rewrite the record.
    function setHidden(bytes32 appId, address reviewer, bool hidden) external {
        require(msg.sender == owner, "!owner");
        uint256 i1 = _idx1[appId][reviewer];
        require(i1 != 0, "no review");
        Review storage r = _reviews[appId][i1 - 1];
        if (r.hidden == hidden) return;
        r.hidden = hidden;
        Tally storage t = _tally[appId];
        if (hidden) { t.count -= 1; t.sum -= r.stars; }
        else        { t.count += 1; t.sum += r.stars; }
        emit ReviewHidden(appId, reviewer, hidden);
    }

    /* ---- the receipt ---- */

    /// @notice Would `who` be allowed to review `appId` with `deploymentId`?
    ///         The UI asks before it puts a wallet through a signature.
    function canReview(bytes32 appId, bytes32 deploymentId, address who) external view returns (bool) {
        return _proved(appId, deploymentId, who);
    }

    /// @dev The deployment must be theirs, reference this app, and have been
    ///      funded (balance + spent — a released lease refunds into balance, so
    ///      either side alone would miss real customers). Fail-closed either
    ///      way: a reverting or non-existent record returns false here, and a
    ///      reply this contract can't decode (the ledger pointer aimed at
    ///      something that isn't a rev-2+ ledger) reverts the whole call —
    ///      neither path can mint a review, which is the property that matters.
    function _proved(bytes32 appId, bytes32 deploymentId, address who) private view returns (bool) {
        if (deploymentId == bytes32(0) || who == address(0)) return false;
        address l = ledger();
        if (l == address(0)) return false;
        try IEnclaveDeployments(l).get(deploymentId) returns (IEnclaveDeployments.Deployment memory d) {
            if (d.owner != who) return false;
            if (d.balance6 + d.spent6 == 0) return false;
            (bytes32 id, bool ok) = _refAppId(d.appRef);
            return ok && id == appId;
        } catch {
            return false;
        }
    }

    /// @dev Pull the appId out of "catalog://0x<64 hex>/<index>". Anything else
    ///      (a raw ipfs:// ref, a malformed string) yields ok = false. Hex case
    ///      is accepted either way; nothing past the '/' matters — a review is
    ///      about the app, not one version of it.
    function _refAppId(string memory ref) private pure returns (bytes32, bool) {
        bytes memory b = bytes(ref);
        if (b.length < 78) return (bytes32(0), false);     // 12 prefix + 64 hex + '/' + >= 1 digit
        if (b[0] != bytes1("c") || b[1] != bytes1("a") || b[2] != bytes1("t") || b[3] != bytes1("a")
         || b[4] != bytes1("l") || b[5] != bytes1("o") || b[6] != bytes1("g") || b[7] != bytes1(":")
         || b[8] != bytes1("/") || b[9] != bytes1("/") || b[10] != bytes1("0")
         || (b[11] != bytes1("x") && b[11] != bytes1("X"))) return (bytes32(0), false);
        if (b[76] != bytes1("/")) return (bytes32(0), false);
        uint256 v;
        for (uint256 i = 12; i < 76; i++) {
            uint8 c = uint8(b[i]);
            uint256 d;
            if (c >= 48 && c <= 57) d = c - 48;            // 0-9
            else if (c >= 97 && c <= 102) d = c - 87;      // a-f
            else if (c >= 65 && c <= 70) d = c - 55;       // A-F
            else return (bytes32(0), false);
            v = (v << 4) | d;
        }
        return (bytes32(v), true);
    }

    /* ---- reads ---- */

    function reviewCount(bytes32 appId) external view returns (uint256) { return _reviews[appId].length; }

    /// @notice One app's reviews in storage order. Hidden ones are INCLUDED
    ///         and flagged: readers drop them, the owner's console lists them
    ///         to unhide, and both come from this one call.
    function getReviewsPage(bytes32 appId, uint256 start, uint256 n) external view returns (Review[] memory page) {
        Review[] storage rs = _reviews[appId];
        uint256 total = rs.length;
        if (start >= total) return new Review[](0);
        uint256 end = start + n; if (end > total) end = total;
        page = new Review[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = rs[i];
    }

    /// @notice A wallet's review of an app (reviewer == address(0) = none).
    function getReview(bytes32 appId, address reviewer) external view returns (Review memory) {
        uint256 i1 = _idx1[appId][reviewer];
        if (i1 == 0) return Review(address(0), 0, false, 0, 0, bytes32(0), "");
        return _reviews[appId][i1 - 1];
    }

    /// @notice Visible count + star sum. The average is count == 0 ? none :
    ///         sum / count — left to the reader so no rounding is baked in.
    function tallyOf(bytes32 appId) external view returns (uint32 count, uint32 sum) {
        Tally storage t = _tally[appId];
        return (t.count, t.sum);
    }

    /// @notice The store grid's call: every tile's rating in one round trip.
    function talliesOf(bytes32[] calldata appIds) external view returns (uint32[] memory counts, uint32[] memory sums) {
        counts = new uint32[](appIds.length);
        sums = new uint32[](appIds.length);
        for (uint256 i = 0; i < appIds.length; i++) {
            Tally storage t = _tally[appIds[i]];
            counts[i] = t.count;
            sums[i] = t.sum;
        }
    }

    /* ---- admin ---- */

    /// @notice Set the fallback ledger. Normally dead weight — with a book
    ///         configured, `ledger()` follows it and this is never consulted.
    function setLedgerFallback(address _ledger) external {
        require(msg.sender == owner, "!owner");
        ledgerFallback = _ledger;
        emit LedgerFallbackSet(_ledger);
    }
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "!owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "!pendingOwner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
