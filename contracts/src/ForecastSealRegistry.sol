// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20BalanceRead {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title ForecastSealRegistry
 * @notice Pre-resolution hourly Keccak-256 Merkle commitment registry for KALIBR autonomous
 *         probability calibration forecasts on Robinhood Chain (4663).
 *
 * Security & Trust Properties:
 *  1. Zero custody / zero approvals: never accepts ETH, never holds tokens, never calls transferFrom.
 *  2. Pre-resolution immutability: once `epochHour` is sealed, its `merkleRoot` cannot be overwritten
 *     or backfilled by anyone (including owner or sealer). Unsealed epochs remain visibly `sealedAt == 0`.
 *  3. Sorted-pair Keccak-256 verification: anyone can verify any sealed Polymarket forecast leaf
 *     onchain via `verifyForecastLeaf` or offline in browser/CLI against `getSeal(epochHour)`.
 *  4. One-time token binding: `bindToken` binds the $KALIBR ERC-20 address once for read-only `tierOf`.
 */
contract ForecastSealRegistry {
    struct ForecastSeal {
        bytes32 merkleRoot;
        uint64 sealedAt;
        uint32 marketCount;
        uint32 mispricedCount;
    }

    error Unauthorized();
    error ZeroValue();
    error AlreadySealed(uint64 epochHour);
    error TokenAlreadyBound();

    uint256 public constant TIER_FORECASTER = 1_000_000 ether;
    uint256 public constant TIER_SYNDICATE = 5_000_000 ether;

    address public owner;
    address public sealer;
    address public kalibrToken;

    uint64 public latestEpoch;
    uint64 public totalEpochsSealed;
    uint64 public totalForecastsSealed;

    mapping(uint64 => ForecastSeal) private _seals;

    event ForecastEpochSealed(
        uint64 indexed epochHour,
        bytes32 indexed merkleRoot,
        uint32 marketCount,
        uint32 mispricedCount,
        uint64 sealedAt
    );
    event SealerUpdated(address indexed previousSealer, address indexed newSealer);
    event KalibrTokenBound(address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        sealer = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SealerUpdated(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlySealer() {
        if (msg.sender != sealer && msg.sender != owner) revert Unauthorized();
        _;
    }

    /**
     * @notice Commits an immutable pre-resolution Merkle root for `epochHour` (UTC unix timestamp floored to 3600s).
     */
    function sealEpoch(
        uint64 epochHour,
        bytes32 merkleRoot,
        uint32 marketCount,
        uint32 mispricedCount
    ) external onlySealer {
        if (epochHour == 0 || merkleRoot == bytes32(0) || marketCount == 0) revert ZeroValue();
        if (_seals[epochHour].sealedAt != 0) revert AlreadySealed(epochHour);

        uint64 ts = uint64(block.timestamp);
        _seals[epochHour] = ForecastSeal({
            merkleRoot: merkleRoot,
            sealedAt: ts,
            marketCount: marketCount,
            mispricedCount: mispricedCount
        });

        if (epochHour > latestEpoch) {
            latestEpoch = epochHour;
        }
        unchecked {
            totalEpochsSealed += 1;
            totalForecastsSealed += marketCount;
        }

        emit ForecastEpochSealed(epochHour, merkleRoot, marketCount, mispricedCount, ts);
    }

    /**
     * @notice Binds the $KALIBR ERC-20 token address once for read-only `tierOf` lookups.
     */
    function bindToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroValue();
        if (kalibrToken != address(0)) revert TokenAlreadyBound();
        kalibrToken = token;
        emit KalibrTokenBound(token);
    }

    function setSealer(address newSealer) external onlyOwner {
        if (newSealer == address(0)) revert ZeroValue();
        address prev = sealer;
        sealer = newSealer;
        emit SealerUpdated(prev, newSealer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    function getSeal(uint64 epochHour) external view returns (ForecastSeal memory) {
        return _seals[epochHour];
    }

    /**
     * @notice Verifies a sorted-pair Keccak-256 Merkle proof against the committed root for `epochHour`.
     */
    function verifyForecastLeaf(
        uint64 epochHour,
        bytes32 leafHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 root = _seals[epochHour].merkleRoot;
        if (root == bytes32(0)) return false;

        bytes32 computed = leafHash;
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 sibling = proof[i];
            if (computed <= sibling) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
            unchecked {
                ++i;
            }
        }
        return computed == root;
    }

    /**
     * @notice Read-only non-custodial holder tier check (0 = Visitor, 1 = Forecaster >= 1M, 2 = Syndicate >= 5M).
     */
    function tierOf(address wallet) external view returns (uint8 tier, uint256 balance) {
        address tok = kalibrToken;
        if (tok == address(0) || wallet == address(0)) {
            return (0, 0);
        }
        balance = IERC20BalanceRead(tok).balanceOf(wallet);
        if (balance >= TIER_SYNDICATE) return (2, balance);
        if (balance >= TIER_FORECASTER) return (1, balance);
        return (0, balance);
    }
}
