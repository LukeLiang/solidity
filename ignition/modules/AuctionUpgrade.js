import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import AuctionProxyModule from "./AuctionProxy.js";

export default buildModule("AuctionUpgradeModule", (m) => {
  const proxyAdminOwner = m.getAccount(0);

  // 1. 复用已部署的代理模块，获取 proxy 和 V1 实现
  const { proxy } = m.useModule(AuctionProxyModule);

  // 2. 从代理部署时发出的 AdminChanged 事件中读取 ProxyAdmin 地址
  //    OZ v5 TransparentUpgradeableProxy 构造函数会发出：
  //    AdminChanged(address(0), proxyAdminAddress)
  const proxyAdminAddress = m.readEventArgument(
    proxy,
    "AdminChanged",
    "newAdmin"
  );

  // 3. 获取 ProxyAdmin 合约实例（使用本地包装合约 ABI）
  const proxyAdmin = m.contractAt("AuctionProxyAdmin", proxyAdminAddress);

  // 4. 部署 AuctionV2 实现合约
  const auctionV2Impl = m.contract("AuctionV2");

  // 5. 编码 initializeV2() 调用数据
  const initV2Data = m.encodeFunctionCall(auctionV2Impl, "initializeV2", []);

  // 6. 通过 ProxyAdmin.upgradeAndCall 将代理升级至 V2，并调用 initializeV2
  m.call(proxyAdmin, "upgradeAndCall", [proxy, auctionV2Impl, initV2Data], {
    from: proxyAdminOwner,
  });

  return { proxy, auctionV2Impl, proxyAdmin };
});
