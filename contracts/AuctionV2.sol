// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AuctionV1} from "./AuctionV1.sol";

/// @title AuctionV2 — 在 V1 基础上新增暂停功能的升级版本
/// @notice 继承 AuctionV1，新增 paused 状态变量（slot 6），通过 reinitializer(2) 初始化
contract AuctionV2 is AuctionV1 {

    // 新增存储变量，追加在 V1 之后（slot 6）
    bool public paused;

    event Paused(address indexed account);
    event Unpaused(address indexed account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice V2 初始化函数，通过 upgradeAndCall 的 data 参数调用
    function initializeV2() public reinitializer(2) {
        paused = false;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    /// @notice 暂停合约，仅 owner 可调用
    function pause() external onlyOwner {
        require(!paused, "Already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice 恢复合约，仅 owner 可调用
    function unpause() external onlyOwner {
        require(paused, "Not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice 创建拍卖项（暂停时不可用）
    function createAuctionItem(
        address tokenContract,
        uint256 tokenId,
        uint256 startingBid,
        uint256 endTime
    ) public virtual override whenNotPaused returns (uint256) {
        return super.createAuctionItem(tokenContract, tokenId, startingBid, endTime);
    }

    /// @notice 出价（暂停时不可用）
    function placeBid(uint256 auctionId) public virtual override whenNotPaused payable {
        super.placeBid(auctionId);
    }
}
