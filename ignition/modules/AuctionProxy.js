import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AuctionProxyModule", (m) => {
  // Chainlink ETH/USD 价格预言机地址（Sepolia 测试网）
  const priceFeedAddress = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const proxyAdminOwner = m.getAccount(0);

  // 1. 部署 AuctionToken NFT 合约
  const auctionToken = m.contract("AuctionToken", [proxyAdminOwner]);

  // 2. 部署 AuctionV1 实现合约
  //    构造函数调用 _disableInitializers()，防止直接初始化
  const auctionV1Impl = m.contract("AuctionV1");

  // 3. 编码 initialize(priceFeed) 调用数据，作为代理部署时的初始化入口
  const initData = m.encodeFunctionCall(auctionV1Impl, "initialize", [
    priceFeedAddress,
  ]);

  // 4. 部署 AuctionTransparentProxy（继承自 TransparentUpgradeableProxy）
  //    内部自动创建 ProxyAdmin（owner 为 proxyAdminOwner）
  //    并在同一笔交易中调用 initialize
  const proxy = m.contract("AuctionTransparentProxy", [
    auctionV1Impl,      // 实现合约地址
    proxyAdminOwner,    // ProxyAdmin 的 owner
    initData,           // 初始化调用数据
  ]);

  return { auctionToken, auctionV1Impl, proxy };
});
