// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

/// @dev 透明代理本地包装合约
/// 继承自 OpenZeppelin TransparentUpgradeableProxy，使 Hardhat 为其生成 artifact
/// 功能与原合约完全一致：内部自动部署 ProxyAdmin，并在同一笔交易中调用 initialize
contract AuctionTransparentProxy is TransparentUpgradeableProxy {
    constructor(
        address logic,
        address initialOwner,
        bytes memory data
    ) TransparentUpgradeableProxy(logic, initialOwner, data) {}
}

/// @dev ProxyAdmin 本地包装合约
/// 继承自 OpenZeppelin ProxyAdmin，使 Hardhat 为其生成 artifact（用于测试中的 getContractAt）
/// 实际的 ProxyAdmin 是由 AuctionTransparentProxy 构造函数内部通过 new 创建的
contract AuctionProxyAdmin is ProxyAdmin {
    constructor(address initialOwner) ProxyAdmin(initialOwner) {}
}
