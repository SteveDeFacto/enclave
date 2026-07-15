// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveAppCatalog — on-chain, versioned catalog of Enclave Wasm apps.
/// @notice The public source of truth for "which Wasm apps exist, their releases,
///         and where each release's code lives." Each app is a lineage of versions;
///         each version is a `wasi:http` component whose bytes live on IPFS. The
///         catalog stores the content address (CID), never the bytes — a CID is a
///         hash of the exact wasm, so a caller fetches it from any IPFS peer and
///         verifies the bytes match independently. Discovery, not custody.
///
/// Identity & versioning:
///   - An app is identified by `appId = keccak256(publisher, slug)`. The slug is a
///     stable key inside the publisher's own namespace, so your "hello" and someone
///     else's "hello" are different apps (distinguished by publisher). Because the
///     appId embeds msg.sender, only you can ever write to your app — lineage
///     ownership is STRUCTURAL, not an access check that can be spoofed.
///   - `publishVersion` appends an immutable Version (its own CID, label, and the
///     EXACT resources the app needs to run, on four axes: vramMb + gpuGflops of
///     a GPU card — both 0 for CPU-only apps — and memMb + cpuGflops of a node;
///     GFLOPS = 1/1000 TFLOPS). Runners calculate the two allocation shares from
///     these numbers against their hardware specs, each the LARGER of its
///     memory- and compute-derived share. Versions are append-only history; you
///     don't edit a released version, you publish a new one. A publisher can `yankVersion` a bad release (kept for
///     history, hidden by readers) and `editApp` the display metadata.
///   - CID ownership: a wasm artifact belongs to the app that FIRST listed it —
///     no other app (any publisher, any slug) can ever list the same CID, so a
///     CID unambiguously maps into one lineage. The owning app MAY re-list its
///     CID in a later version: that is the metadata fix (same bytes, new
///     config/specs/ports). A CID is NOT a version identity — versions sharing
///     bytes can differ entirely in approved config — which is why deployments
///     reference the version RECORD (appId + index), never a CID.
///
/// Trust model (mirrors EnclaveRegistry: claims on-chain, verification off-chain):
///   - `verified` is an OPTIONAL owner-curated signal, set PER VERSION (you verify
///     a specific CID, and a new release starts unverified — it must be re-checked).
///     It does not gate execution; the CID does. The site can filter to verified.
///   - `approval` DOES gate deploys, set PER VERSION by the owner (the address
///     that deployed this catalog). Publishing stays permissionless, but a
///     version starts Pending and runners refuse to deploy it until the owner
///     signs a setApproval(..., Approved) transaction; Rejected is a standing
///     "no". A new release starts Pending again — approval is of a specific
///     VERSION (its bytes, config, and ports together), never of a lineage.
///   - Deployments reference a chosen version as its on-chain RECORD:
///     `appRef = catalog://<appId>/<versionIndex>`. Runners resolve it with
///     `getApp` + `getVersion` and take EVERYTHING approval covered from the
///     record — the wasm CID (a fetch address, nothing more), the config
///     (delivered verbatim as ENCLAVE_CONFIG; its `volumes` key mounts model
///     volumes), and the ports. Version rows are append-only and immutable,
///     so a record means the same artifact forever; only the deployability
///     flags (approval / yanked / app active) are live, and runners re-check
///     them on every claim. `cidStatus` remains as the publish-time
///     CID-ownership pre-flight, not a deploy gate.
contract EnclaveAppCatalog {
    struct App {
        bytes32 appId;        // keccak256(publisher, slug); stable identity across versions
        address publisher;    // owns this app's lineage (only they add versions)
        string  slug;         // stable key within the publisher's namespace
        string  name;         // display name (editable)
        string  description;  // app-level blurb (editable)
        uint32  versionCount; // number of versions published
        uint64  createdAt;
        uint64  updatedAt;    // last version add or metadata edit
        bool    active;       // publisher can delist the whole app (kept for history)
    }
    struct Version {
        string  cid;          // IPFS CID of this release's .wasm (wasi:http component)
        string  version;      // label, e.g. "1.0.0"
        uint32  vramMb;       // EXACT minimum VRAM (MB) this release needs; 0 = no VRAM ask
        uint32  gpuGflops;    // EXACT minimum GPU compute (GFLOPS = 1/1000 TFLOPS); both GPU
                              // axes 0 = CPU-only app
        uint32  memMb;        // EXACT minimum RAM (MB) this release needs (>= 1)
        uint32  cpuGflops;    // EXACT minimum CPU compute (GFLOPS); 0 = RAM-driven. Runners derive
                              // the allocation shares from these against their hardware specs
        uint64  createdAt;
        bool    verified;     // owner-curated, per version (the CID is what's checked)
        bool    yanked;       // publisher pulled this release (kept for history)
        string  ports;        // firewall config: "" = standard web app (wasi:http serve);
                              // else CSV of "http:N" / "tcp:N" / "udp:N" the app may bind
                              // (per version — a release can change its port needs)
        uint8   approval;     // deploy gate, owner-ruled: 0 Pending, 1 Approved, 2 Rejected
        string  config;       // THE deployment config (JSON): runners deliver it verbatim
                              // to the app as ENCLAVE_CONFIG, straight from this record
                              // (its `volumes` key mounts model volumes). Not deployer
                              // input - deploys carry no config of their own. IMMUTABLE
                              // once published and covered by this version's approval -
                              // behavior can never be changed after the owner's ruling
                              // (a new config = a new version = Pending again, same as
                              // ports/specs). APPENDED LAST so rev-2 Version tuples are
                              // a strict prefix.
    }
    /// @dev CID -> owning version, for `cidStatus`. index1 is the version index + 1
    ///      so the zero value doubles as "CID not listed" (also enforces the global
    ///      CID-uniqueness rule that used to live in a separate bool mapping).
    struct CidRef { bytes32 appId; uint32 index1; }

    uint8 public constant APPROVAL_PENDING  = 0;
    uint8 public constant APPROVAL_APPROVED = 1;
    uint8 public constant APPROVAL_REJECTED = 2;

    /// @notice Struct-schema revision, for migration readers: 4 = Version
    ///         carries `config` (this layout). A source without this getter
    ///         is revision 2. Revision 3 was a short-lived APP-level-config
    ///         layout (deployed 2026-07-08 at 0xa036d5e8…, same marker
    ///         selector): its Version tuples have NO config — readers must
    ///         treat rev 3 versions as config-less or they mis-decode.
    uint256 public constant catalogSchema = 4;

    uint256 private constant MAX_SLUG = 40;
    uint256 private constant MAX_NAME = 80;
    uint256 private constant MAX_DESC = 500;
    uint256 private constant MAX_CONFIG = 4096;  // the version's ENCLAVE_CONFIG JSON (runners
                                                 // apply it from this record; nothing rides the
                                                 // deployment)
    uint256 private constant MAX_VER  = 32;
    uint256 private constant MAX_CID  = 100;
    uint32  private constant MAX_MB   = 1048576;   // 1 TB sanity bound on vramMb/memMb (the catalog
                                                    // is hardware-agnostic; runners enforce real fit)
    uint32  private constant MAX_GFLOPS = 10000000; // 10,000 TFLOPS sanity bound on gpuGflops/cpuGflops
    uint256 private constant MAX_PORTS = 96;   // CSV port spec, e.g. "http:8088,tcp:5432,udp:9053"
                                               // (runners restrict the range; 8080/8091 are infra-reserved)

    address public owner;                             // sets `verified` + `approval`; can hand off
    address public pendingOwner;                      // two-step handoff: must acceptOwnership()
    bytes32[] private _appIds;                        // every app ever created
    mapping(bytes32 => App) private _apps;
    mapping(bytes32 => bool) private _exists;
    mapping(bytes32 => Version[]) private _versions;  // appId -> release history
    mapping(bytes32 => CidRef) private _cidRefs;      // keccak256(cid) -> owning version (index1=0 -> unlisted)
    mapping(bytes32 => bool) private _verUsed;        // keccak256(appId, version) -> label taken (per-app uniqueness)
    mapping(bytes32 => bytes32) private _cidGrant;    // keccak256(cid) -> appId the owner authorized to override a squatted reservation (0 = none)

    event AppCreated(bytes32 indexed appId, address indexed publisher, string slug, string name);
    event AppEdited(bytes32 indexed appId, string name, string description);
    event VersionPublished(bytes32 indexed appId, uint256 indexed index, string version, string cid);
    event VersionVerified(bytes32 indexed appId, uint256 indexed index, bool verified);
    event VersionApprovalSet(bytes32 indexed appId, uint256 indexed index, uint8 status);
    event VersionYanked(bytes32 indexed appId, uint256 indexed index);
    event AppActiveSet(bytes32 indexed appId, bool active);
    event CidGranted(bytes32 indexed cidKey, bytes32 indexed appId);
    event OwnerChanged(address indexed owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    constructor() { owner = msg.sender; emit OwnerChanged(msg.sender); }

    /// @dev appId embeds the publisher, so a slug is owned per-address and cannot be squatted.
    function appIdOf(address publisher, string memory slug) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(publisher, slug));
    }

    /// @notice Publish a new version of your app `slug`, creating the app on first use.
    /// @return appId the app's stable id; index the new version's position.
    /// @dev Split into `_reserveCid` / `_touchApp` helpers so each has its own stack
    ///      frame (a single flat body hits "stack too deep" without viaIR).
    /// @dev `res` = [vramMb, gpuGflops, memMb, cpuGflops] — the four exact
    ///      resource axes, packed as an array (keeps the calldata layout stable
    ///      and the stack workable as axes grow).
    function publishVersion(
        string calldata slug,
        string calldata name,
        string calldata description,
        string calldata version,
        string calldata cid,
        uint32[4] calldata res,
        string calldata ports,
        string calldata config
    ) external returns (bytes32 appId, uint256 index) {
        require(bytes(version).length > 0 && bytes(version).length <= MAX_VER, "version length");
        require(bytes(cid).length > 0 && bytes(cid).length <= MAX_CID, "cid length");
        require(res[0] <= MAX_MB, "vramMb range");
        require(res[1] <= MAX_GFLOPS, "gpuGflops range");
        require(res[2] > 0 && res[2] <= MAX_MB, "memMb range");
        require(res[3] <= MAX_GFLOPS, "cpuGflops range");
        require(bytes(ports).length <= MAX_PORTS, "ports length");
        require(bytes(config).length <= MAX_CONFIG, "config length");

        appId = _touchApp(slug, name, description);
        bytes32 cidKey = _reserveCid(cid, appId);

        // version labels are unique within an app, so `slug:version` resolves to
        // exactly one CID (deterministic human-friendly deploy references).
        {
            bytes32 vk = keccak256(abi.encodePacked(appId, version));
            require(!_verUsed[vk], "version exists");
            _verUsed[vk] = true;
        }

        Version[] storage vs = _versions[appId];
        // field-by-field (not a struct literal): 10 fields with 3 dynamic strings
        // overflow the Yul stack even under viaIR; verified/yanked default false
        Version storage v = vs.push();
        v.cid = cid;
        v.version = version;
        v.vramMb = res[0];
        v.gpuGflops = res[1];
        v.memMb = res[2];
        v.cpuGflops = res[3];
        v.createdAt = uint64(block.timestamp);
        v.ports = ports;
        v.approval = APPROVAL_PENDING;
        v.config = config;
        index = vs.length - 1;
        _cidRefs[cidKey] = CidRef({ appId: appId, index1: uint32(index + 1) });

        App storage a = _apps[appId];
        a.versionCount = uint32(vs.length);
        a.updatedAt = uint64(block.timestamp);
        a.active = true;
        emit VersionPublished(appId, index, version, cid);
    }

    /// @dev A CID belongs to the app that FIRST listed it, forever: no other app
    ///      can ever list the same artifact, so a CID always maps into exactly
    ///      one lineage. The owning app may list it AGAIN in a later version —
    ///      how metadata (config/specs/ports) gets fixed without touching the bytes —
    ///      and the reverse-lookup entry is then overwritten so `cidStatus`
    ///      follows the newest listing (the superseded version stays as history).
    function _reserveCid(string calldata cid, bytes32 appId) private view returns (bytes32 cidKey) {
        cidKey = keccak256(bytes(cid));
        CidRef storage r = _cidRefs[cidKey];
        // ...unless the owner has granted THIS app override rights (anti-squat
        // remedy, see grantCid). appId is never 0, so an unset grant never matches.
        require(r.index1 == 0 || r.appId == appId || _cidGrant[cidKey] == appId,
                "cid listed by another app");
    }

    /// @dev Create the app on first use, then refresh its display metadata. Returns appId.
    function _touchApp(string calldata slug, string calldata name, string calldata description)
        private
        returns (bytes32 appId)
    {
        require(bytes(slug).length > 0 && bytes(slug).length <= MAX_SLUG, "slug length");
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME, "name length");
        require(bytes(description).length <= MAX_DESC, "desc length");
        appId = keccak256(abi.encodePacked(msg.sender, slug));
        App storage a = _apps[appId];
        if (!_exists[appId]) {
            _exists[appId] = true;
            _appIds.push(appId);
            a.appId = appId;
            a.publisher = msg.sender;
            a.slug = slug;
            a.createdAt = uint64(block.timestamp);
            emit AppCreated(appId, msg.sender, slug, name);
        }
        // the latest publish refreshes display metadata (the form pre-fills current values)
        a.name = name;
        a.description = description;
    }

    /// @notice Edit your app's DISPLAY metadata without cutting a new version.
    ///         Deliberately display-only (name/description): anything that
    ///         affects deployment behavior - bytes, specs, ports, config -
    ///         is per-version, immutable, and covered by the owner's approval.
    function editApp(string calldata slug, string calldata name, string calldata description) external {
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME, "name length");
        require(bytes(description).length <= MAX_DESC, "desc length");
        bytes32 appId = keccak256(abi.encodePacked(msg.sender, slug));
        require(_exists[appId], "unknown app");
        App storage a = _apps[appId];
        a.name = name;
        a.description = description;
        a.updatedAt = uint64(block.timestamp);
        emit AppEdited(appId, name, description);
    }

    /// @notice Delist / relist your whole app (kept on-chain for history either way).
    function setActive(string calldata slug, bool active) external {
        bytes32 appId = keccak256(abi.encodePacked(msg.sender, slug));
        require(_exists[appId], "unknown app");
        _apps[appId].active = active;
        emit AppActiveSet(appId, active);
    }

    /// @notice Pull a bad release. The version stays on-chain; readers hide it.
    function yankVersion(string calldata slug, uint256 index) external {
        bytes32 appId = keccak256(abi.encodePacked(msg.sender, slug));
        require(_exists[appId], "unknown app");
        require(index < _versions[appId].length, "bad index");
        _versions[appId][index].yanked = true;
        emit VersionYanked(appId, index);
    }

    /// @notice Owner-curated verification of a specific version (does not gate execution).
    function setVerified(bytes32 appId, uint256 index, bool v) external {
        require(msg.sender == owner, "!owner");
        require(_exists[appId], "unknown app");
        require(index < _versions[appId].length, "bad index");
        _versions[appId][index].verified = v;
        emit VersionVerified(appId, index, v);
    }

    /// @notice Owner ruling on a specific version: Approved unlocks deploys of
    ///         its record, Rejected is a standing "no", Pending re-opens review.
    /// @dev Unlike `verified` (a curation signal), THIS gates deploys: runners
    ///      refuse any version record that isn't Approved. Approval is per
    ///      VERSION — the ruling covers its bytes, config, and ports together,
    ///      and a new release of the same app starts Pending and must be
    ///      re-approved (even a re-list of the same bytes: config changes
    ///      behavior, so it is re-reviewed like any release).
    function setApproval(bytes32 appId, uint256 index, uint8 status) external {
        require(msg.sender == owner, "!owner");
        require(_exists[appId], "unknown app");
        require(index < _versions[appId].length, "bad index");
        require(status <= APPROVAL_REJECTED, "bad status");
        _versions[appId][index].approval = status;
        emit VersionApprovalSet(appId, index, status);
    }

    /// @notice Anti-squat remedy (owner-only). A CID belongs to the FIRST app to
    ///         list it, so an attacker could list an honest publisher's CID first
    ///         and permanently block them from ever publishing it. This authorizes
    ///         one specific app — `appIdOf(publisher, slug)`, computable before the
    ///         app even exists — to override a squatted reservation on its NEXT
    ///         publishVersion. Race-free: only the granted appId may use the grant,
    ///         and once it publishes, the reverse-lookup (`cidStatus`) points at the
    ///         honest lineage; the squatter's row stays as dead history (a squatted
    ///         version sits at Pending forever and can never deploy). Purely
    ///         additive — touches no version bytes, approval, or struct layout, and
    ///         changes nothing for CIDs no one has squatted.
    function grantCid(string calldata cid, bytes32 appId) external {
        require(msg.sender == owner, "!owner");
        require(appId != bytes32(0), "appId=0");
        bytes32 cidKey = keccak256(bytes(cid));
        _cidGrant[cidKey] = appId;
        emit CidGranted(cidKey, appId);
    }

    /// @notice Begin a TWO-STEP ownership handoff. `o` must call acceptOwnership()
    ///         to take control; until then `owner` is unchanged. Critical here:
    ///         the owner is the SOLE caller of setApproval(Approved), so a mistyped
    ///         single-step transfer would mean no app could ever be approved
    ///         again — a business-liveness cliff. The new key must prove it can
    ///         transact before it inherits that power.
    function transferOwnership(address o) external {
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

    // ----- one-time migration (owner-gated, permanently sealable) -----------

    /// @notice While true, the owner may still import lineages from a previous
    ///         EnclaveAppCatalog. Treat records as owner-attested until
    ///         `importsSealed`; after sealing, only the permissionless
    ///         publisher paths can add anything.
    bool public importsSealed;
    event ImportsSealed();

    /// @notice Migrate app lineages verbatim from a previous catalog (the admin
    ///         console reads getAppsPage and replays them here). Publishers keep
    ///         structural ownership: appId must equal keccak256(publisher, slug),
    ///         so the original publisher — and only they — can keep releasing to
    ///         the imported lineage.
    function importApps(App[] calldata items) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        for (uint256 i = 0; i < items.length; i++) {
            bytes32 appId = items[i].appId;
            require(appId == appIdOf(items[i].publisher, items[i].slug), "appId mismatch");
            require(!_exists[appId], "exists");
            _exists[appId] = true;
            _appIds.push(appId);
            _apps[appId] = items[i];
            emit AppCreated(appId, items[i].publisher, items[i].slug, items[i].name);
        }
    }

    /// @notice Migrate one app's release history, in order, appending to whatever
    ///         is already imported (chunkable). Replays the same invariants
    ///         publishVersion enforces — per-app version-label uniqueness and
    ///         global CID ownership — so the migrated catalog can't hold state
    ///         the permissionless path couldn't have produced (timestamps,
    ///         verified flags and approval rulings carry over verbatim).
    function importVersions(bytes32 appId, Version[] calldata items) external {
        require(msg.sender == owner, "!owner");
        require(!importsSealed, "sealed");
        require(_exists[appId], "unknown app");
        Version[] storage vs = _versions[appId];
        for (uint256 i = 0; i < items.length; i++) {
            bytes32 vk = keccak256(abi.encodePacked(appId, items[i].version));
            require(!_verUsed[vk], "version exists");
            _verUsed[vk] = true;
            bytes32 cidKey = keccak256(bytes(items[i].cid));
            CidRef storage r = _cidRefs[cidKey];
            require(r.index1 == 0 || r.appId == appId, "cid listed by another app");
            vs.push(items[i]);
            uint256 idx = vs.length - 1;
            _cidRefs[cidKey] = CidRef({ appId: appId, index1: uint32(vs.length) });
            emit VersionPublished(appId, idx, items[i].version, items[i].cid);
            // re-emit the per-version state so a LOG-ONLY indexer doesn't show an
            // imported Approved/Rejected/verified/yanked version as a fresh Pending
            // one: publishVersion starts every version Pending+unverified+unyanked,
            // and import carries the source flags verbatim in storage but was
            // otherwise silent about them.
            if (items[i].approval != APPROVAL_PENDING) emit VersionApprovalSet(appId, idx, items[i].approval);
            if (items[i].verified) emit VersionVerified(appId, idx, true);
            if (items[i].yanked) emit VersionYanked(appId, idx);
        }
        _apps[appId].versionCount = uint32(vs.length);   // keep the counter honest across chunks
    }

    /// @notice Permanently close the import window (there is no re-open).
    function sealImports() external {
        require(msg.sender == owner, "!owner");
        importsSealed = true;
        emit ImportsSealed();
    }

    /// @notice Batch several calls to THIS contract into one transaction
    ///         (delegatecall to self: msg.sender is preserved, so every inner
    ///         call keeps its own auth check). Atomic. Lets a whole migration
    ///         (importApps + every importVersions) ride one confirmation.
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(calls[i]);
            if (!ok) {
                if (ret.length == 0) revert("multicall failed");
                // memory-safe: only reads an existing bytes array to bubble the
                // revert; the annotation also lets viaIR spill stack vars to
                // memory elsewhere (without it _touchApp is stack-too-deep)
                assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
            }
            results[i] = ret;
        }
    }

    // ----- reads (off-chain discovery) -------------------------------------
    function appCount() external view returns (uint256) { return _appIds.length; }
    function appIdAt(uint256 i) external view returns (bytes32) { return _appIds[i]; }
    function getApp(bytes32 appId) external view returns (App memory) { return _apps[appId]; }
    function numVersions(bytes32 appId) external view returns (uint256) { return _versions[appId].length; }
    function getVersion(bytes32 appId, uint256 index) external view returns (Version memory) { return _versions[appId][index]; }

    /// @notice Publish-time CID resolver: which lineage owns these bytes, and the
    ///         newest listing's flags. Publishers pre-flight "is this CID already
    ///         listed, and by whom" before a publishVersion tx (which would revert
    ///         on another app's CID). NOT the deploy gate: deployments reference a
    ///         version RECORD (appId + index) and runners gate on getVersion/getApp
    ///         directly — a CID names bytes, and versions sharing bytes can differ
    ///         entirely in approved config. A CID its own app re-listed resolves to
    ///         the NEWEST listing (each re-list starts approval at Pending again —
    ///         a metadata change is re-reviewed like any release).
    function cidStatus(string calldata cid) external view returns (
        bool listed, bytes32 appId, uint256 index, uint8 approval, bool yanked, bool appActive,
        uint32[4] memory res
    ) {
        CidRef storage r = _cidRefs[keccak256(bytes(cid))];
        if (r.index1 == 0) return (false, bytes32(0), 0, 0, false, false, res);
        Version storage v = _versions[r.appId][r.index1 - 1];
        res = [v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops];
        return (true, r.appId, r.index1 - 1, v.approval, v.yanked, _apps[r.appId].active, res);
    }

    /// @notice Paginated app list (metadata only; fetch each app's versions separately).
    function getAppsPage(uint256 start, uint256 n) external view returns (App[] memory page) {
        uint256 len = _appIds.length;
        if (start >= len) return new App[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new App[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _apps[_appIds[i]];
    }

    /// @notice Paginated release history for one app.
    function getVersionsPage(bytes32 appId, uint256 start, uint256 n) external view returns (Version[] memory page) {
        uint256 len = _versions[appId].length;
        if (start >= len) return new Version[](0);
        uint256 end = start + n; if (end > len) end = len;
        page = new Version[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = _versions[appId][i];
    }
}
