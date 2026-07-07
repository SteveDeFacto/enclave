// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EnclaveVolumeAccess — on-chain ACL for wallet-gated encrypted volumes.
/// @notice The allowlist of wallets that may decrypt a Enclave encrypted volume, and
///         the sealed key material each one holds. This is the on-chain half of
///         the wallet-gated vault design (the cryptographic half is
///         scripts/enclave-vault.mjs — the shared protocol every party implements).
///
///         A volume is encrypted ONCE with a symmetric Volume Encryption Key
///         (VEK). Access is not a secret stored here — it is CRYPTOGRAPHIC: each
///         authorized wallet publishes an X25519 public key (derived from a
///         deterministic wallet signature; see enclave-vault DERIVE_MESSAGE), and the
///         owner or the enclave SEALS the VEK to that pubkey. The sealed blob is
///         safe to store on a public chain: only the holder of the matching
///         wallet-derived secret can unseal it. So EVERYTHING here is public and
///         untrusted — confidentiality rests on the sealing, not on-chain secrecy
///         (same ethos as EnclaveRegistry: published, verified, never trusted).
///
/// Trust model / who can write:
///   - Each volume has an `owner` = its deployer. volId = keccak256(deployer,name)
///     binds the volume to the deployer's address namespace, so it CANNOT be
///     front-run, and it OUTLIVES any single deployment or enclave (same volume,
///     new runner on failover — the ACL persists on-chain).
///   - Writers = the volume `owner` OR the enclave `operator` EOA. The owner
///     grants/revokes directly. The RUNNING enclave (which holds the VEK in RAM
///     after an authorized unlock) auto-grants self-registering members by sealing
///     the VEK to their pubkey and calling grant() via the operator EOA — self-
///     serve access without the deployer signing every grant. This is exactly the
///     user requirement: "written to by the deployer of the wasm app OR by the
///     enclave itself... users can register inside the wasm app to gain access."
///   - register() is PERMISSIONLESS but only ever sets msg.sender's OWN pubkey, so
///     there is no impersonation. Registering publishes a key; it does NOT grant
///     access (role stays None until a writer seals the VEK to it).
///
/// Roles: Reader / Writer are stored here for the app + enclave to enforce
/// (read/write volumes are a follow-on; the ROLE bit is recorded now so policy is
/// ready). The contract does not itself gate data — it gates who holds a decryptable
/// VEK and at what role.
contract EnclaveVolumeAccess {
    enum Role { None, Reader, Writer } // None = 0 = no access

    struct Member {
        bytes32 pubkey;     // X25519 public key derived from the member's wallet signature (32B)
        bytes   sealedVEK;  // VEK sealed to `pubkey` (ephPub32||nonce24||AEAD; ~104B). Empty until granted.
        Role    role;       // Reader / Writer; None once revoked
        bool    registered; // has published a pubkey via register()
        uint64  updatedAt;  // last register/grant/revoke touching this member
    }

    struct Volume {
        address owner;      // the deployer; grants/revokes/transfers
        bool    exists;
        uint64  createdAt;
        address[] memberList;                 // enumeration (self-registrants + granted)
        mapping(address => Member) members;
    }

    address public admin;    // deployer of THIS contract; may rotate the operator + admin
    address public operator; // the enclave operator EOA (auto-grant writer; the existing runner key)

    mapping(bytes32 => Volume) private _vol;

    event VolumeCreated(bytes32 indexed volId, address indexed owner, string name);
    event Registered(bytes32 indexed volId, address indexed member, bytes32 pubkey);
    event Granted(bytes32 indexed volId, address indexed member, Role role);
    event Revoked(bytes32 indexed volId, address indexed member);
    event OwnerTransferred(bytes32 indexed volId, address indexed newOwner);
    event OperatorChanged(address indexed operator);
    event AdminChanged(address indexed admin);

    constructor(address _operator) {
        admin = msg.sender;
        operator = _operator;
        emit AdminChanged(msg.sender);
        emit OperatorChanged(_operator);
    }

    /// @dev The volume id is bound to the deployer's address, so it is unforgeable
    ///      and deployment-independent. Uses abi.encode (length-prefixed) — NOT
    ///      encodePacked — so (addr,name) can never collide across a name boundary.
    function volumeId(address deployer, string calldata name) public pure returns (bytes32) {
        return keccak256(abi.encode(deployer, name));
    }

    // ----- lifecycle -------------------------------------------------------

    /// @notice Create a volume in the caller's namespace. Must precede register/grant.
    function createVolume(string calldata name) external returns (bytes32 volId) {
        volId = volumeId(msg.sender, name);
        Volume storage v = _vol[volId];
        require(!v.exists, "exists");
        v.exists = true;
        v.owner = msg.sender;
        v.createdAt = uint64(block.timestamp);
        emit VolumeCreated(volId, msg.sender, name);
    }

    /// @notice Publish (or rotate) YOUR OWN X25519 pubkey for a volume. Permissionless
    ///         self-registration; does not grant access. A writer then seals the VEK
    ///         to this pubkey via grant().
    /// @dev Rotating to a NEW pubkey invalidates any prior sealedVEK (it was sealed to
    ///      the old key), so we clear it and drop the role — a stale seal must never be
    ///      read as live access.
    function register(bytes32 volId, bytes32 pubkey) external {
        Volume storage v = _vol[volId];
        require(v.exists, "no volume");
        require(pubkey != bytes32(0), "pubkey required");
        Member storage m = v.members[msg.sender];
        bool rotating = m.registered && m.pubkey != pubkey && m.sealedVEK.length != 0;
        if (!m.registered) {
            v.memberList.push(msg.sender);
            m.registered = true;
        }
        m.pubkey = pubkey;
        m.updatedAt = uint64(block.timestamp);
        if (rotating) {
            delete m.sealedVEK;
            m.role = Role.None;
            emit Revoked(volId, msg.sender);
        }
        emit Registered(volId, msg.sender, pubkey);
    }

    /// @notice Grant `member` access by storing the VEK sealed to their pubkey.
    ///         Callable by the volume owner OR the enclave operator (auto-grant).
    ///         The VEK is sealed OFF-CHAIN (see enclave-vault seal()); this only records it.
    function grant(bytes32 volId, address member, Role role, bytes calldata sealedVEK) external {
        Volume storage v = _vol[volId];
        require(v.exists, "no volume");
        require(msg.sender == v.owner || msg.sender == operator, "not writer");
        require(role != Role.None, "use revoke");
        Member storage m = v.members[member];
        require(m.registered, "member not registered");
        require(sealedVEK.length != 0, "empty seal");
        m.role = role;
        m.sealedVEK = sealedVEK;
        m.updatedAt = uint64(block.timestamp);
        emit Granted(volId, member, role);
    }

    /// @notice Remove `member`'s access. Callable by the owner or the operator.
    /// @dev On-chain revocation stops FUTURE unlocks/reads of the sealed VEK. It does
    ///      NOT claw back a VEK a member already unsealed — cryptographic revocation
    ///      requires ROTATING the volume (fresh VEK, re-seal to remaining members,
    ///      re-encrypt the data). Tracked as the volume-rotation follow-on.
    function revoke(bytes32 volId, address member) external {
        Volume storage v = _vol[volId];
        require(v.exists, "no volume");
        require(msg.sender == v.owner || msg.sender == operator, "not writer");
        Member storage m = v.members[member];
        require(m.registered, "unknown member");
        m.role = Role.None;
        delete m.sealedVEK;
        m.updatedAt = uint64(block.timestamp);
        emit Revoked(volId, member);
    }

    /// @notice Hand a volume's ownership to a new address (e.g. multisig / DAO).
    function transferVolumeOwner(bytes32 volId, address newOwner) external {
        Volume storage v = _vol[volId];
        require(v.exists, "no volume");
        require(msg.sender == v.owner, "not owner");
        require(newOwner != address(0), "zero owner");
        v.owner = newOwner;
        emit OwnerTransferred(volId, newOwner);
    }

    // ----- admin (operator rotation only; no custody, no key access) -------

    function setOperator(address o) external {
        require(msg.sender == admin, "!admin");
        operator = o;
        emit OperatorChanged(o);
    }

    function transferAdmin(address a) external {
        require(msg.sender == admin, "!admin");
        require(a != address(0), "zero admin");
        admin = a;
        emit AdminChanged(a);
    }

    // ----- reads (enclave ACL check, app member list, auto-grant sweep) ----

    function getVolume(bytes32 volId)
        external view
        returns (address owner, bool exists, uint64 createdAt, uint256 members)
    {
        Volume storage v = _vol[volId];
        return (v.owner, v.exists, v.createdAt, v.memberList.length);
    }

    /// @notice Full member record. sealedVEK is safe to return publicly — only the
    ///         member's wallet-derived secret can open it.
    function getMember(bytes32 volId, address member)
        external view
        returns (Role role, bytes32 pubkey, bool registered, bytes memory sealedVEK, uint64 updatedAt)
    {
        Member storage m = _vol[volId].members[member];
        return (m.role, m.pubkey, m.registered, m.sealedVEK, m.updatedAt);
    }

    /// @notice True iff `member` currently holds any access (Reader or Writer).
    ///         The enclave uses this to gate unlock-sealed against the on-chain ACL.
    function isAuthorized(bytes32 volId, address member) external view returns (bool) {
        return _vol[volId].members[member].role != Role.None;
    }

    function memberCount(bytes32 volId) external view returns (uint256) {
        return _vol[volId].memberList.length;
    }

    function memberAt(bytes32 volId, uint256 i) external view returns (address) {
        return _vol[volId].memberList[i];
    }

    /// @notice Paginated member roll (address + role + pubkey) for the app's access
    ///         list and the enclave's auto-grant sweep. Fetch each member's sealedVEK
    ///         individually via getMember (it is variable-length + read per-recipient).
    function getMemberPage(bytes32 volId, uint256 start, uint256 n)
        external view
        returns (address[] memory addrs, Role[] memory roles, bytes32[] memory pubs)
    {
        address[] storage list = _vol[volId].memberList;
        uint256 len = list.length;
        if (start >= len) return (new address[](0), new Role[](0), new bytes32[](0));
        uint256 end = start + n;
        if (end > len) end = len;
        uint256 k = end - start;
        addrs = new address[](k);
        roles = new Role[](k);
        pubs  = new bytes32[](k);
        for (uint256 i = 0; i < k; i++) {
            address a = list[start + i];
            Member storage m = _vol[volId].members[a];
            addrs[i] = a;
            roles[i] = m.role;
            pubs[i]  = m.pubkey;
        }
    }
}

/*
FAILOVER (why the ACL lives on-chain, not in the enclave):
  When the runner enclave dies, the VEK it held in RAM is GONE (never persisted —
  that is the guarantee). The new enclave has a DIFFERENT attested X25519 identity,
  so nothing sealed to the old enclave is usable. Recovery is multi-party: ANY
  authorized wallet reads its own sealedVEK from this contract, unseals it to the
  VEK, verifies the NEW enclave's attestation, re-seals the VEK to the new enclave's
  pubkey, and POSTs it to unlock-sealed. A tiny always-on "unlock agent" holding one
  authorized wallet automates this — the key never leaves that wallet. This is the
  failover fix over the passphrase model (there, only the lone deployer could recover).

FUTURE (not implemented — layer on without changing the trust model):
  - Volume rotation: mint a new VEK, re-seal to remaining members, re-encrypt +
    republish the ciphertext, bump an on-chain epoch. This is the cryptographic
    revocation that plain revoke() cannot give.
  - Read/WRITE volumes: Writer role is recorded now; durable encrypted write-back
    (gocryptfs forward mode over a host-backed disk) + versioning/concurrency is the
    follow-on. Read-only volumes need none of it (ciphertext rides Modelwrap).
  - Per-member expiry / time-boxed grants (uint64 expiresAt on Member).
*/
