import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

// ETH/USD 价格：3000 USD，Chainlink 使用 8 位小数
const INITIAL_ETH_PRICE = 3000_0000_0000n; // 3000e8
const DECIMALS = 8;

// ============================================================
// 辅助函数：从代理部署收据的 AdminChanged 事件中读取 ProxyAdmin 地址
// OZ v5 TransparentUpgradeableProxy 构造函数发出：
// AdminChanged(address(0), proxyAdminAddress)
// ============================================================
async function getProxyAdminAddress(proxyContract) {
  const receipt = await proxyContract.deploymentTransaction().wait();
  const iface = new ethers.Interface([
    "event AdminChanged(address previousAdmin, address newAdmin)",
  ]);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "AdminChanged") {
        return parsed.args.newAdmin;
      }
    } catch {}
  }
  throw new Error("AdminChanged event not found in deployment receipt");
}

// ============================================================
// Fixture 1：部署 AuctionV1 + 透明代理（未升级）
// ============================================================
async function deployProxyFixture() {
  const [owner, seller, bidder1, bidder2] = await ethers.getSigners();

  // 部署 Chainlink 价格预言机 Mock
  const mockPriceFeed = await ethers.deployContract("MockV3Aggregator", [
    DECIMALS,
    INITIAL_ETH_PRICE,
  ]);

  // 部署 AuctionToken NFT 合约
  const nft = await ethers.deployContract("AuctionToken", [owner.address]);

  // 部署 V1 实现合约（构造函数调用 _disableInitializers）
  const auctionV1Impl = await ethers.deployContract("AuctionV1");

  // 编码 initialize 调用数据
  const v1Iface = (await ethers.getContractFactory("AuctionV1")).interface;
  const initData = v1Iface.encodeFunctionData("initialize", [
    await mockPriceFeed.getAddress(),
  ]);

  // 部署 TransparentUpgradeableProxy
  // 构造函数内部自动创建 ProxyAdmin 并调用 initialize
  const proxyContract = await ethers.deployContract(
    "AuctionTransparentProxy",
    [await auctionV1Impl.getAddress(), owner.address, initData]
  );

  const proxyAddress = await proxyContract.getAddress();
  const proxyAdminAddress = await getProxyAdminAddress(proxyContract);
  const proxyAdmin = await ethers.getContractAt("AuctionProxyAdmin", proxyAdminAddress);

  // 将代理地址包装为 AuctionV1 接口，用于与代理交互
  const auction = await ethers.getContractAt("AuctionV1", proxyAddress);

  return {
    auction,
    nft,
    mockPriceFeed,
    proxyContract,
    proxyAdmin,
    auctionV1Impl,
    owner,
    seller,
    bidder1,
    bidder2,
  };
}

// ============================================================
// Fixture 2：部署 V1 + 代理，写入拍卖数据，再升级至 V2
// ============================================================
async function deployAndUpgradeFixture() {
  const [owner, seller, bidder1, bidder2] = await ethers.getSigners();

  const mockPriceFeed = await ethers.deployContract("MockV3Aggregator", [
    DECIMALS,
    INITIAL_ETH_PRICE,
  ]);
  const nft = await ethers.deployContract("AuctionToken", [owner.address]);
  const auctionV1Impl = await ethers.deployContract("AuctionV1");

  const v1Iface = (await ethers.getContractFactory("AuctionV1")).interface;
  const initData = v1Iface.encodeFunctionData("initialize", [
    await mockPriceFeed.getAddress(),
  ]);

  const proxyContract = await ethers.deployContract(
    "AuctionTransparentProxy",
    [await auctionV1Impl.getAddress(), owner.address, initData]
  );

  const proxyAddress = await proxyContract.getAddress();
  const proxyAdminAddress = await getProxyAdminAddress(proxyContract);
  const proxyAdmin = await ethers.getContractAt("AuctionProxyAdmin", proxyAdminAddress);
  const auction = await ethers.getContractAt("AuctionV1", proxyAddress);

  // 在升级前写入拍卖状态，用于验证升级后数据保持不变
  await nft.connect(owner).safeMint(seller.address, "https://example.com/nft/0");
  await nft.connect(seller).approve(proxyAddress, 0n);
  const endTime = (await networkHelpers.time.latest()) + 86400;
  await auction
    .connect(seller)
    .createAuctionItem(
      await nft.getAddress(),
      0n,
      ethers.parseEther("0.1"),
      endTime
    );
  // bidder1 出价 0.2 ETH
  await auction.connect(bidder1).placeBid(0n, { value: ethers.parseEther("0.2") });
  // bidder2 出价 0.5 ETH（超越 bidder1）→ bidder1 进入 pendingReturns
  await auction.connect(bidder2).placeBid(0n, { value: ethers.parseEther("0.5") });

  // ---- 升级至 V2 ----
  const auctionV2Impl = await ethers.deployContract("AuctionV2");
  const v2Iface = (await ethers.getContractFactory("AuctionV2")).interface;
  const initV2Data = v2Iface.encodeFunctionData("initializeV2", []);
  await proxyAdmin
    .connect(owner)
    .upgradeAndCall(proxyAddress, await auctionV2Impl.getAddress(), initV2Data);

  // 将代理地址包装为 AuctionV2 接口
  const auctionV2 = await ethers.getContractAt("AuctionV2", proxyAddress);

  return {
    auctionV2,
    nft,
    mockPriceFeed,
    proxyContract,
    proxyAdmin,
    auctionV1Impl,
    auctionV2Impl,
    owner,
    seller,
    bidder1,
    bidder2,
    endTime,
  };
}

// ============================================================
// 测试套件
// ============================================================
describe("透明代理 (TransparentUpgradeableProxy)", function () {
  // ----------------------------------------------------------
  // V1 部署与初始化
  // ----------------------------------------------------------
  describe("V1 部署与初始化", function () {
    it("应正确初始化 owner", async function () {
      const { auction, owner } =
        await networkHelpers.loadFixture(deployProxyFixture);
      expect(await auction.owner()).to.equal(owner.address);
    });

    it("应能通过代理读取 Chainlink 价格", async function () {
      const { auction } =
        await networkHelpers.loadFixture(deployProxyFixture);
      expect(await auction.getLatestPrice()).to.equal(INITIAL_ETH_PRICE);
    });

    it("不能重复调用 initialize", async function () {
      const { auction, mockPriceFeed } =
        await networkHelpers.loadFixture(deployProxyFixture);
      await expect(
        auction.initialize(await mockPriceFeed.getAddress())
      ).to.be.revertedWithCustomError(auction, "InvalidInitialization");
    });

    it("直接调用实现合约的 initialize 应失败（_disableInitializers）", async function () {
      const { auctionV1Impl, mockPriceFeed } =
        await networkHelpers.loadFixture(deployProxyFixture);
      await expect(
        auctionV1Impl.initialize(await mockPriceFeed.getAddress())
      ).to.be.revertedWithCustomError(auctionV1Impl, "InvalidInitialization");
    });

    it("通过代理应能完成创建拍卖和出价", async function () {
      const { auction, nft, owner, seller, bidder1 } =
        await networkHelpers.loadFixture(deployProxyFixture);

      await nft.connect(owner).safeMint(seller.address, "uri-0");
      await nft.connect(seller).approve(await auction.getAddress(), 0n);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      await auction
        .connect(seller)
        .createAuctionItem(
          await nft.getAddress(),
          0n,
          ethers.parseEther("0.1"),
          endTime
        );

      await auction
        .connect(bidder1)
        .placeBid(0n, { value: ethers.parseEther("0.2") });

      const item = await auction.auctionItems(0n);
      expect(item.highestBidder).to.equal(bidder1.address);
      expect(item.highestBid).to.equal(ethers.parseEther("0.2"));
    });
  });

  // ----------------------------------------------------------
  // 代理管理权限
  // ----------------------------------------------------------
  describe("代理管理权限", function () {
    it("ProxyAdmin 的 owner 应为部署者", async function () {
      const { proxyAdmin, owner } =
        await networkHelpers.loadFixture(deployProxyFixture);
      expect(await proxyAdmin.owner()).to.equal(owner.address);
    });

    it("非 owner 不能通过 ProxyAdmin 升级代理", async function () {
      const { proxyAdmin, auctionV1Impl, proxyContract, bidder1 } =
        await networkHelpers.loadFixture(deployProxyFixture);
      await expect(
        proxyAdmin.connect(bidder1).upgradeAndCall(
          await proxyContract.getAddress(),
          await auctionV1Impl.getAddress(),
          "0x"
        )
      ).to.be.revertedWithCustomError(proxyAdmin, "OwnableUnauthorizedAccount");
    });
  });

  // ----------------------------------------------------------
  // 升级到 V2
  // ----------------------------------------------------------
  describe("升级到 V2", function () {
    it("升级后原有拍卖数据应保持不变", async function () {
      const { auctionV2 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      const item = await auctionV2.auctionItems(0n);
      expect(item.active).to.equal(true);
      expect(item.highestBid).to.equal(ethers.parseEther("0.5"));
      expect(item.startingBid).to.equal(ethers.parseEther("0.1"));
    });

    it("升级后 owner 应保持不变", async function () {
      const { auctionV2, owner } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      expect(await auctionV2.owner()).to.equal(owner.address);
    });

    it("升级后 pendingReturns 应保持不变", async function () {
      const { auctionV2, bidder1 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      // bidder1 被 bidder2 超越，应有 0.2 ETH 待退款
      expect(await auctionV2.pendingReturns(0n, bidder1.address)).to.equal(
        ethers.parseEther("0.2")
      );
    });

    it("升级后 paused 初始值为 false", async function () {
      const { auctionV2 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      expect(await auctionV2.paused()).to.equal(false);
    });

    it("不能重复调用 initializeV2", async function () {
      const { auctionV2 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await expect(
        auctionV2.initializeV2()
      ).to.be.revertedWithCustomError(auctionV2, "InvalidInitialization");
    });

    it("owner 可以暂停合约", async function () {
      const { auctionV2, owner } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await expect(auctionV2.connect(owner).pause())
        .to.emit(auctionV2, "Paused")
        .withArgs(owner.address);
      expect(await auctionV2.paused()).to.equal(true);
    });

    it("owner 可以恢复合约", async function () {
      const { auctionV2, owner } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await auctionV2.connect(owner).pause();
      await expect(auctionV2.connect(owner).unpause())
        .to.emit(auctionV2, "Unpaused")
        .withArgs(owner.address);
      expect(await auctionV2.paused()).to.equal(false);
    });

    it("非 owner 不能暂停", async function () {
      const { auctionV2, bidder1 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await expect(
        auctionV2.connect(bidder1).pause()
      ).to.be.revertedWith("Only owner can call this function");
    });

    it("暂停后不能出价", async function () {
      const { auctionV2, owner, seller } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await auctionV2.connect(owner).pause();
      await expect(
        auctionV2.connect(seller).placeBid(0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Contract is paused");
    });

    it("暂停后不能创建新拍卖", async function () {
      const { auctionV2, nft, owner, seller } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await auctionV2.connect(owner).pause();

      // 铸造第 2 个 NFT（tokenId=1）
      await nft.connect(owner).safeMint(seller.address, "uri-1");
      await nft.connect(seller).approve(await auctionV2.getAddress(), 1n);

      const endTime = (await networkHelpers.time.latest()) + 86400;
      await expect(
        auctionV2
          .connect(seller)
          .createAuctionItem(
            await nft.getAddress(),
            1n,
            ethers.parseEther("0.1"),
            endTime
          )
      ).to.be.revertedWith("Contract is paused");
    });

    it("恢复后可以正常出价", async function () {
      const { auctionV2, owner, bidder1 } =
        await networkHelpers.loadFixture(deployAndUpgradeFixture);
      await auctionV2.connect(owner).pause();
      await auctionV2.connect(owner).unpause();

      // 当前最高价 0.5 ETH（bidder2），bidder1 出 1 ETH（>5%）应成功
      await expect(
        auctionV2.connect(bidder1).placeBid(0n, { value: ethers.parseEther("1") })
      ).to.emit(auctionV2, "PlaceBid");
    });
  });
});
