import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AuctionModule", (m) => {
  // Chainlink ETH/USD 价格预言机地址（Sepolia测试网）
  const priceFeedAddress = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

  // 部署 AuctionToken
  const auctionToken = m.contract("AuctionToken", [m.getAccount(0)]);

  // 部署 Auction，传入价格预言机地址
  const auction = m.contract("Auction", [priceFeedAddress]);

  return { auctionToken, auction };
});
