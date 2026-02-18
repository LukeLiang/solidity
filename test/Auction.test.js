import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

// ETH/USD 价格：3000 USD，Chainlink 使用 8 位小数
const INITIAL_ETH_PRICE = 3000_0000_0000n; // 3000e8
const DECIMALS = 8;

async function deployFixture() {
  const [owner, seller, bidder1, bidder2] = await ethers.getSigners();

  // 部署 Chainlink mock（8 位小数，初始价格 3000 USD）
  const mockPriceFeed = await ethers.deployContract("MockV3Aggregator", [
    DECIMALS,
    INITIAL_ETH_PRICE,
  ]);

  // 部署 Auction 合约
  const auction = await ethers.deployContract("Auction", [
    await mockPriceFeed.getAddress(),
  ]);

  // 部署 AuctionToken（NFT）
  const nft = await ethers.deployContract("AuctionToken", [owner.address]);

  return { auction, nft, mockPriceFeed, owner, seller, bidder1, bidder2 };
}

// 辅助函数：铸造 NFT 并授权给 Auction 合约
async function mintAndApprove(nft, auction, owner, seller) {
  const tokenId = 0n;
  await nft.connect(owner).safeMint(seller.address, "https://example.com/nft/0");
  await nft.connect(seller).approve(await auction.getAddress(), tokenId);
  return tokenId;
}

// 辅助函数：创建拍卖项（带默认参数）
async function createDefaultAuction(auction, nft, seller) {
  const endTime = (await networkHelpers.time.latest()) + 86400; // 1 天后
  const startingBid = ethers.parseEther("0.1");
  const tx = await auction
    .connect(seller)
    .createAuctionItem(await nft.getAddress(), 0n, startingBid, endTime);
  return { endTime, startingBid, tx };
}

describe("Auction", function () {
  // =========================================
  // createAuctionItem
  // =========================================
  describe("createAuctionItem", function () {
    it("应该成功创建拍卖项", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      const startingBid = ethers.parseEther("0.1");

      await expect(
        auction
          .connect(seller)
          .createAuctionItem(await nft.getAddress(), 0n, startingBid, endTime)
      )
        .to.emit(auction, "CreateAuction")
        .withArgs(0n, seller.address, await nft.getAddress(), 0n, startingBid, endTime);
    });

    it("返回值应为自增的 auctionId", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);

      // 铸造 2 个 NFT
      await nft.connect(owner).safeMint(seller.address, "uri-0");
      await nft.connect(owner).safeMint(seller.address, "uri-1");
      const auctionAddr = await auction.getAddress();
      await nft.connect(seller).approve(auctionAddr, 0n);
      await nft.connect(seller).approve(auctionAddr, 1n);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      const bid = ethers.parseEther("0.1");
      const nftAddr = await nft.getAddress();

      const id0 = await auction
        .connect(seller)
        .createAuctionItem.staticCall(nftAddr, 0n, bid, endTime);
      await auction.connect(seller).createAuctionItem(nftAddr, 0n, bid, endTime);

      const id1 = await auction
        .connect(seller)
        .createAuctionItem.staticCall(nftAddr, 1n, bid, endTime);

      expect(id0).to.equal(0n);
      expect(id1).to.equal(1n);
    });

    it("结束时间必须在未来", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);

      const pastTime = (await networkHelpers.time.latest()) - 1;
      await expect(
        auction
          .connect(seller)
          .createAuctionItem(
            await nft.getAddress(),
            0n,
            ethers.parseEther("0.1"),
            pastTime
          )
      ).to.be.revertedWith("End time must be in the future");
    });

    it("起拍价低于最低美元限额应回退", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      // 最低限额 = 10^12 wei 对应 USD（需要 ETH 价格 * amount / 1e8 >= 1e12）
      // 设 0 wei 肯定不够
      await expect(
        auction
          .connect(seller)
          .createAuctionItem(await nft.getAddress(), 0n, 0n, endTime)
      ).to.be.revertedWith("Bid price must be at least 0.000001 USD");
    });

    it("非 NFT 持有者不能创建拍卖", async function () {
      const { auction, nft, owner, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      // NFT 铸造给 owner，但 bidder1 尝试创建拍卖
      await nft.connect(owner).safeMint(owner.address, "uri-0");
      await nft.connect(owner).approve(await auction.getAddress(), 0n);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      await expect(
        auction
          .connect(bidder1)
          .createAuctionItem(
            await nft.getAddress(),
            0n,
            ethers.parseEther("0.1"),
            endTime
          )
      ).to.be.revertedWith("Seller must own the NFT");
    });

    it("未授权 Auction 合约时应回退", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      // 铸造但不授权
      await nft.connect(owner).safeMint(seller.address, "uri-0");

      const endTime = (await networkHelpers.time.latest()) + 86400;
      await expect(
        auction
          .connect(seller)
          .createAuctionItem(
            await nft.getAddress(),
            0n,
            ethers.parseEther("0.1"),
            endTime
          )
      ).to.be.revertedWith(
        "Auction contract must be approved to transfer the NFT"
      );
    });

    it("零地址 tokenContract 应回退", async function () {
      const { auction, seller } =
        await networkHelpers.loadFixture(deployFixture);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      await expect(
        auction
          .connect(seller)
          .createAuctionItem(
            ethers.ZeroAddress,
            0n,
            ethers.parseEther("0.1"),
            endTime
          )
      ).to.be.revertedWith("Invalid token contract address");
    });
  });

  // =========================================
  // placeBid
  // =========================================
  describe("placeBid", function () {
    it("应该成功出价", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      const bidAmount = ethers.parseEther("0.2");
      await expect(auction.connect(bidder1).placeBid(0n, { value: bidAmount }))
        .to.emit(auction, "PlaceBid")
        .withArgs(0n, bidder1.address, bidAmount);

      const item = await auction.auctionItems(0n);
      expect(item.highestBid).to.equal(bidAmount);
      expect(item.highestBidder).to.equal(bidder1.address);
    });

    it("拍卖未激活时应回退", async function () {
      const { auction, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(bidder1).placeBid(999n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Auction is not active");
    });

    it("拍卖已过期时应回退", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      // 时间推进到拍卖结束后
      await networkHelpers.time.increaseTo(endTime + 1);

      await expect(
        auction.connect(bidder1).placeBid(0n, { value: ethers.parseEther("0.2") })
      ).to.be.revertedWith("Auction has ended");
    });

    it("卖家不能对自己的拍卖出价", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      await expect(
        auction.connect(seller).placeBid(0n, { value: ethers.parseEther("0.2") })
      ).to.be.revertedWith("Seller cannot bid on their own auction");
    });

    it("出价低于起拍价应回退", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller); // startingBid = 0.1 ETH

      await expect(
        auction
          .connect(bidder1)
          .placeBid(0n, { value: ethers.parseEther("0.05") })
      ).to.be.revertedWith("Bid must be at least the starting bid");
    });

    it("新出价未超过当前最高价 5% 应回退", async function () {
      const { auction, nft, owner, seller, bidder1, bidder2 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      // bidder1 出价 1 ETH
      await auction.connect(bidder1).placeBid(0n, { value: ethers.parseEther("1") });

      // bidder2 出价 1.04 ETH（只比 1 ETH 多 4%，不满足 5% 最低加价）
      await expect(
        auction
          .connect(bidder2)
          .placeBid(0n, { value: ethers.parseEther("1.04") })
      ).to.be.revertedWith(
        "Bid must be at least 5% higher than the current highest bid"
      );
    });

    it("被超越的出价者应记录待退还金额", async function () {
      const { auction, nft, owner, seller, bidder1, bidder2 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      const bid1 = ethers.parseEther("1");
      await auction.connect(bidder1).placeBid(0n, { value: bid1 });

      // bidder2 超越出价
      const bid2 = ethers.parseEther("2");
      await auction.connect(bidder2).placeBid(0n, { value: bid2 });

      // bidder1 的出价应被记入 pendingReturns
      const pending = await auction.pendingReturns(0n, bidder1.address);
      expect(pending).to.equal(bid1);
    });
  });

  // =========================================
  // endAuction
  // =========================================
  describe("endAuction", function () {
    it("应该成功结束拍卖并转移 NFT 和 ETH", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      const bidAmount = ethers.parseEther("0.5");
      await auction.connect(bidder1).placeBid(0n, { value: bidAmount });

      // 推进时间到拍卖结束
      await networkHelpers.time.increaseTo(endTime);

      // 计算手续费：0.5 ETH → Tier1 (5%) = 0.025 ETH
      const feeRate = 500n;
      const feeAmount = (bidAmount * feeRate) / 10000n;
      const sellerAmount = bidAmount - feeAmount;

      await expect(auction.connect(seller).endAuction(0n))
        .to.emit(auction, "EndAuction")
        .withArgs(0n, bidder1.address, bidAmount)
        .and.to.emit(auction, "FeeCollected")
        .withArgs(0n, feeAmount, feeRate);

      // 验证 NFT 转移给了最高出价者
      expect(await nft.ownerOf(0n)).to.equal(bidder1.address);

      // 验证累积手续费
      expect(await auction.accumulatedFees()).to.equal(feeAmount);
    });

    it("拍卖未激活时应回退", async function () {
      const { auction, seller } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(seller).endAuction(999n)
      ).to.be.revertedWith("Auction is not active");
    });

    it("拍卖未到期时应回退", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      await auction
        .connect(bidder1)
        .placeBid(0n, { value: ethers.parseEther("0.2") });

      await expect(
        auction.connect(seller).endAuction(0n)
      ).to.be.revertedWith("Auction has not ended yet");
    });

    it("非卖家不能结束拍卖", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      await auction
        .connect(bidder1)
        .placeBid(0n, { value: ethers.parseEther("0.2") });

      await networkHelpers.time.increaseTo(endTime);

      await expect(
        auction.connect(bidder1).endAuction(0n)
      ).to.be.revertedWith("Only seller can end the auction");
    });

    it("没有出价时不能结束拍卖", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      await networkHelpers.time.increaseTo(endTime);

      await expect(
        auction.connect(seller).endAuction(0n)
      ).to.be.revertedWith("No bids placed");
    });
  });

  // =========================================
  // withdrawPendingReturn
  // =========================================
  describe("withdrawPendingReturn", function () {
    it("应该成功提取待退还金额", async function () {
      const { auction, nft, owner, seller, bidder1, bidder2 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      const bid1 = ethers.parseEther("1");
      await auction.connect(bidder1).placeBid(0n, { value: bid1 });

      // bidder2 超越出价
      await auction
        .connect(bidder2)
        .placeBid(0n, { value: ethers.parseEther("2") });

      // bidder1 提取退款
      await expect(
        auction.connect(bidder1).withdrawPendingReturn(0n)
      ).to.changeEtherBalance(ethers, bidder1, bid1);

      // 提取后余额应为 0
      expect(await auction.pendingReturns(0n, bidder1.address)).to.equal(0n);
    });

    it("无可提取金额时应回退", async function () {
      const { auction, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(bidder1).withdrawPendingReturn(0n)
      ).to.be.revertedWith("No funds to withdraw");
    });
  });

  // =========================================
  // cancelAuctionItem
  // =========================================
  describe("cancelAuctionItem", function () {
    it("卖家应能成功取消无出价的拍卖", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      await expect(auction.connect(seller).cancelAuctionItem(0n))
        .to.emit(auction, "CancelAuction")
        .withArgs(0n, seller.address);

      const item = await auction.auctionItems(0n);
      expect(item.active).to.equal(false);
    });

    it("非卖家不能取消拍卖", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      await expect(
        auction.connect(bidder1).cancelAuctionItem(0n)
      ).to.be.revertedWith("Only seller can cancel the auction");
    });

    it("拍卖未激活时应回退", async function () {
      const { auction, nft, owner, seller } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      // 先取消
      await auction.connect(seller).cancelAuctionItem(0n);

      // 再次取消应失败
      await expect(
        auction.connect(seller).cancelAuctionItem(0n)
      ).to.be.revertedWith("Auction is not active");
    });

    it("已有出价时不能取消拍卖", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      await createDefaultAuction(auction, nft, seller);

      await auction
        .connect(bidder1)
        .placeBid(0n, { value: ethers.parseEther("0.2") });

      await expect(
        auction.connect(seller).cancelAuctionItem(0n)
      ).to.be.revertedWith("Cannot cancel auction with bids");
    });
  });

  // =========================================
  // calculateFeeRate
  // =========================================
  describe("calculateFeeRate", function () {
    it("0-1 ETH 费率为 5%（500 基点）", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);
      expect(await auction.calculateFeeRate(ethers.parseEther("0.5"))).to.equal(500n);
      expect(await auction.calculateFeeRate(ethers.parseEther("1"))).to.equal(500n);
    });

    it("1-10 ETH 费率为 3%（300 基点）", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);
      expect(await auction.calculateFeeRate(ethers.parseEther("1.01"))).to.equal(300n);
      expect(await auction.calculateFeeRate(ethers.parseEther("10"))).to.equal(300n);
    });

    it("10-100 ETH 费率为 2%（200 基点）", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);
      expect(await auction.calculateFeeRate(ethers.parseEther("10.01"))).to.equal(200n);
      expect(await auction.calculateFeeRate(ethers.parseEther("100"))).to.equal(200n);
    });

    it("100+ ETH 费率为 1%（100 基点）", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);
      expect(await auction.calculateFeeRate(ethers.parseEther("100.01"))).to.equal(100n);
      expect(await auction.calculateFeeRate(ethers.parseEther("1000"))).to.equal(100n);
    });
  });

  // =========================================
  // calculateFee
  // =========================================
  describe("calculateFee", function () {
    it("各阶梯费用计算正确", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);

      // Tier1: 0.5 ETH * 5% = 0.025 ETH
      expect(await auction.calculateFee(ethers.parseEther("0.5"))).to.equal(
        ethers.parseEther("0.025")
      );

      // Tier2: 5 ETH * 3% = 0.15 ETH
      expect(await auction.calculateFee(ethers.parseEther("5"))).to.equal(
        ethers.parseEther("0.15")
      );

      // Tier3: 50 ETH * 2% = 1 ETH
      expect(await auction.calculateFee(ethers.parseEther("50"))).to.equal(
        ethers.parseEther("1")
      );

      // Tier4: 200 ETH * 1% = 2 ETH
      expect(await auction.calculateFee(ethers.parseEther("200"))).to.equal(
        ethers.parseEther("2")
      );
    });
  });

  // =========================================
  // withdrawFees
  // =========================================
  describe("withdrawFees", function () {
    it("owner 应能成功提取手续费", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);
      await mintAndApprove(nft, auction, owner, seller);
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      // 出价并结束拍卖以产生手续费
      const bidAmount = ethers.parseEther("1");
      await auction.connect(bidder1).placeBid(0n, { value: bidAmount });
      await networkHelpers.time.increaseTo(endTime);
      await auction.connect(seller).endAuction(0n);

      const feeAmount = (bidAmount * 500n) / 10000n; // 5% = 0.05 ETH
      expect(await auction.accumulatedFees()).to.equal(feeAmount);

      await expect(auction.connect(owner).withdrawFees())
        .to.emit(auction, "FeesWithdrawn")
        .withArgs(owner.address, feeAmount);

      expect(await auction.accumulatedFees()).to.equal(0n);
    });

    it("非 owner 不能提取手续费", async function () {
      const { auction, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(bidder1).withdrawFees()
      ).to.be.revertedWith("Only owner can call this function");
    });

    it("无手续费时应回退", async function () {
      const { auction, owner } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(owner).withdrawFees()
      ).to.be.revertedWith("No fees to withdraw");
    });
  });

  // =========================================
  // transferOwnership
  // =========================================
  describe("transferOwnership", function () {
    it("owner 应能成功转移所有权", async function () {
      const { auction, owner, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);

      await auction.connect(owner).transferOwnership(bidder1.address);
      expect(await auction.owner()).to.equal(bidder1.address);
    });

    it("非 owner 不能转移所有权", async function () {
      const { auction, bidder1 } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(bidder1).transferOwnership(bidder1.address)
      ).to.be.revertedWith("Only owner can call this function");
    });

    it("不能转移给零地址", async function () {
      const { auction, owner } =
        await networkHelpers.loadFixture(deployFixture);

      await expect(
        auction.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid new owner address");
    });
  });

  // =========================================
  // Chainlink 集成
  // =========================================
  describe("Chainlink 集成", function () {
    it("应返回正确的价格", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);

      const price = await auction.getLatestPrice();
      expect(price).to.equal(INITIAL_ETH_PRICE);
    });

    it("ETH→USD 转换应正确", async function () {
      const { auction } = await networkHelpers.loadFixture(deployFixture);

      // 1 ETH * 3000e8 / 1e8 = 3000e18 (3000 USD in wei units)
      const oneEth = ethers.parseEther("1");
      const usdValue = await auction.convertEthToUsd(oneEth);
      // 1 ETH = 3000 USD → 3000 * 10^18
      expect(usdValue).to.equal(ethers.parseEther("3000"));
    });

    it("价格为零时应回退", async function () {
      const { auction, mockPriceFeed } =
        await networkHelpers.loadFixture(deployFixture);

      await mockPriceFeed.updateAnswer(0);

      await expect(auction.getLatestPrice()).to.be.revertedWith(
        "Invalid price data"
      );
    });

    it("价格为负数时应回退", async function () {
      const { auction, mockPriceFeed } =
        await networkHelpers.loadFixture(deployFixture);

      await mockPriceFeed.updateAnswer(-100);

      await expect(auction.getLatestPrice()).to.be.revertedWith(
        "Invalid price data"
      );
    });
  });

  // =========================================
  // 完整流程测试
  // =========================================
  describe("完整流程", function () {
    it("创建→出价→超越出价→结束→提取退款", async function () {
      const { auction, nft, owner, seller, bidder1, bidder2 } =
        await networkHelpers.loadFixture(deployFixture);

      // 1. 铸造并授权 NFT
      await mintAndApprove(nft, auction, owner, seller);

      // 2. 创建拍卖
      const { endTime } = await createDefaultAuction(auction, nft, seller);

      // 3. bidder1 出价 1 ETH
      const bid1 = ethers.parseEther("1");
      await auction.connect(bidder1).placeBid(0n, { value: bid1 });

      // 4. bidder2 出价 2 ETH（超越 bidder1）
      const bid2 = ethers.parseEther("2");
      await auction.connect(bidder2).placeBid(0n, { value: bid2 });

      // 验证 bidder1 有待退还金额
      expect(await auction.pendingReturns(0n, bidder1.address)).to.equal(bid1);

      // 5. 时间推进到拍卖结束
      await networkHelpers.time.increaseTo(endTime);

      // 6. 卖家结束拍卖
      const feeRate = 300n; // 2 ETH → Tier2 (3%)
      const feeAmount = (bid2 * feeRate) / 10000n;

      await expect(auction.connect(seller).endAuction(0n))
        .to.emit(auction, "EndAuction")
        .withArgs(0n, bidder2.address, bid2);

      // 7. 验证 NFT 转移
      expect(await nft.ownerOf(0n)).to.equal(bidder2.address);

      // 8. bidder1 提取退款
      await expect(
        auction.connect(bidder1).withdrawPendingReturn(0n)
      ).to.changeEtherBalance(ethers, bidder1, bid1);

      // 9. owner 提取手续费
      await expect(auction.connect(owner).withdrawFees())
        .to.emit(auction, "FeesWithdrawn")
        .withArgs(owner.address, feeAmount);
    });
  });
});
