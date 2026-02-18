// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @title AuctionV1 — 可升级版本的 NFT 英式拍卖合约
/// @notice 使用 OpenZeppelin v5 透明代理模式，通过 initialize 替代 constructor
contract AuctionV1 is Initializable {

    uint256 internal constant MINVALUE = 10 ** 12; // 0.000001 USD
    uint internal constant MINBIDRATE = 500; // 5%

    // 动态手续费阶梯（基于 ETH 金额）
    // 费率以基点表示，10000 = 100%
    uint256 internal constant FEE_TIER1_LIMIT = 1 ether;      // 0-1 ETH
    uint256 internal constant FEE_TIER2_LIMIT = 10 ether;     // 1-10 ETH
    uint256 internal constant FEE_TIER3_LIMIT = 100 ether;    // 10-100 ETH
    // 100+ ETH 为最高阶梯

    uint256 internal constant FEE_RATE_TIER1 = 500;   // 5%
    uint256 internal constant FEE_RATE_TIER2 = 300;   // 3%
    uint256 internal constant FEE_RATE_TIER3 = 200;   // 2%
    uint256 internal constant FEE_RATE_TIER4 = 100;   // 1%

    // ===== 存储槽顺序与 Auction.sol 完全一致 =====
    // slot 0: dataFeed
    AggregatorV3Interface internal dataFeed;
    // slot 1: owner
    address public owner;
    // slot 2: accumulatedFees
    uint256 public accumulatedFees;
    // slot 3: auctionCounter
    uint256 private auctionCounter;
    // slot 4: pendingReturns mapping
    mapping (uint256 => mapping (address => uint256)) public pendingReturns;
    // slot 5: auctionItems mapping
    mapping (uint256 => AuctionItem) public auctionItems;

    struct AuctionItem {
        address seller; // 卖家地址
        address tokenContract; // 代币合约地址
        uint256 tokenId;    // 代币ID
        uint256 startingBid; // 起始竞价
        uint256 highestBid; // 最高竞价
        address highestBidder; // 最高竞价者地址
        uint256 startTime; // 竞拍开始时间
        uint256 endTime; // 竞拍结束时间
        bool active; // 竞拍是否活跃
    }

    event CreateAuction(uint256 indexed auctionId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 startingBid, uint256 endTime);
    event PlaceBid(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event EndAuction(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event WithdrawPendingReturn(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event CancelAuction(uint256 indexed auctionId, address indexed seller);
    event FeeCollected(uint256 indexed auctionId, uint256 feeAmount, uint256 feeRate);
    event FeesWithdrawn(address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address priceFeed) public initializer {
        dataFeed = AggregatorV3Interface(priceFeed);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    function createAuctionItem(
        address tokenContract,
        uint256 tokenId,
        uint256 startingBid,
        uint256 endTime
    ) public virtual returns (uint256) {
        require(endTime > block.timestamp, "End time must be in the future");
        require(convertEthToUsd(startingBid) >= MINVALUE, "Bid price must be at least 0.000001 USD");
        require(tokenContract != address(0), "Invalid token contract address");

        // 检查卖家是否是 NFT 的所有者
        IERC721 nft = IERC721(tokenContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Seller must own the NFT");

        // 检查卖家是否已授权 Auction 合约转移该 NFT
        require(
            nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)),
            "Auction contract must be approved to transfer the NFT"
        );

        uint256 auctionId = auctionCounter++;
        auctionItems[auctionId] = AuctionItem({
            seller: msg.sender,
            tokenContract: tokenContract,
            tokenId: tokenId,
            startingBid: startingBid,
            highestBid: 0,
            highestBidder: address(0),
            startTime: block.timestamp,
            endTime: endTime,
            active: true
        });
        emit CreateAuction(auctionId, msg.sender, tokenContract, tokenId, startingBid, endTime);
        return auctionId;
    }

    function placeBid(uint256 auctionId) public virtual payable {
        AuctionItem storage item = auctionItems[auctionId];
        require(item.active, "Auction is not active");
        require(block.timestamp < item.endTime, "Auction has ended");
        require(msg.sender != item.seller, "Seller cannot bid on their own auction");
        uint256 bidAmount = msg.value;
        require(bidAmount >= item.startingBid, "Bid must be at least the starting bid");
        require(bidAmount > item.highestBid + (item.highestBid * MINBIDRATE / 10000), "Bid must be at least 5% higher than the current highest bid");
        if (item.highestBidder != address(0)) {
            pendingReturns[auctionId][item.highestBidder] += item.highestBid;
        }
        item.highestBid = bidAmount;
        item.highestBidder = msg.sender;
        emit PlaceBid(auctionId, msg.sender, bidAmount);
    }

    function endAuction(uint256 auctionId) external {
        AuctionItem storage item = auctionItems[auctionId];
        require(item.active, "Auction is not active");
        require(block.timestamp >= item.endTime, "Auction has not ended yet");
        require(msg.sender == item.seller, "Only seller can end the auction");
        require(item.highestBidder != address(0), "No bids placed");
        item.active = false;

        // 计算动态手续费
        uint256 feeRate = calculateFeeRate(item.highestBid);
        uint256 feeAmount = (item.highestBid * feeRate) / 10000;
        uint256 sellerAmount = item.highestBid - feeAmount;

        // 累积手续费
        accumulatedFees += feeAmount;

        // 先转移 NFT 给最高出价者
        IERC721(item.tokenContract).safeTransferFrom(item.seller, item.highestBidder, item.tokenId);
        // 再转移 ETH 给卖家（扣除手续费后）
        (bool success, ) = item.seller.call{value: sellerAmount}("");
        require(success, "Failed to transfer funds to seller");

        emit FeeCollected(auctionId, feeAmount, feeRate);
        emit EndAuction(auctionId, item.highestBidder, item.highestBid);
    }

    function withdrawPendingReturn(uint256 auctionId) external {
        uint256 amount = pendingReturns[auctionId][msg.sender];
        require(amount > 0, "No funds to withdraw");
        pendingReturns[auctionId][msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Failed to withdraw funds");
        emit WithdrawPendingReturn(auctionId, msg.sender, amount);
    }

    function cancelAuctionItem(uint256 auctionId) external {
        AuctionItem storage item = auctionItems[auctionId];
        require(item.seller == msg.sender, "Only seller can cancel the auction");
        require(item.active, "Auction is not active");
        require(item.highestBidder == address(0), "Cannot cancel auction with bids");
        item.active = false;
        emit CancelAuction(auctionId, msg.sender);
    }

    function getChainlinkDataFeedLatestAnswer() public view returns (int256) {
        (
            /* uint80 roundId */,
            int256 answer,
            /*uint256 startedAt*/,
            /*uint256 updatedAt*/,
            /*uint80 answeredInRound*/
        ) = dataFeed.latestRoundData();
        return answer;
    }

    function getLatestPrice() public view returns (uint256) {
        int256 price = getChainlinkDataFeedLatestAnswer();
        require(price > 0, "Invalid price data");
        return uint256(price);
    }

    function convertEthToUsd(uint256 ethAmount) public view returns (uint256) {
        // 1个eth 兑换多少美元（返回的美元带有8为小数）
        uint256 ethPrice = getLatestPrice(); // e.g., 3000.00 USD with 8 decimals
        uint256 ethAmountInUsd = (ethAmount * ethPrice) / 10 ** 8; // Adjusting for decimals
        return ethAmountInUsd;
    }

    /// @notice 根据拍卖金额计算动态手续费率
    /// @param amount 拍卖金额（ETH）
    /// @return 手续费率（基点，10000 = 100%）
    function calculateFeeRate(uint256 amount) public pure returns (uint256) {
        if (amount <= FEE_TIER1_LIMIT) {
            return FEE_RATE_TIER1; // 5%
        } else if (amount <= FEE_TIER2_LIMIT) {
            return FEE_RATE_TIER2; // 3%
        } else if (amount <= FEE_TIER3_LIMIT) {
            return FEE_RATE_TIER3; // 2%
        } else {
            return FEE_RATE_TIER4; // 1%
        }
    }

    /// @notice 计算指定金额的手续费
    /// @param amount 拍卖金额（ETH）
    /// @return 手续费金额
    function calculateFee(uint256 amount) public pure returns (uint256) {
        uint256 feeRate = calculateFeeRate(amount);
        return (amount * feeRate) / 10000;
    }

    /// @notice 合约所有者提取累积的手续费
    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        require(amount > 0, "No fees to withdraw");
        accumulatedFees = 0;
        (bool success, ) = payable(owner).call{value: amount}("");
        require(success, "Failed to withdraw fees");
        emit FeesWithdrawn(owner, amount);
    }

    /// @notice 转移合约所有权
    /// @param newOwner 新所有者地址
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid new owner address");
        owner = newOwner;
    }
}
