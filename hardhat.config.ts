import "dotenv/config";
import hardhatToolbox from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolbox],
  solidity: {
    compilers: [
      {
        version: "0.8.28",
      },
    ],
  },
  networks: {
    sepolia: {
      type: "http",
      url: process.env.SEPOLIA_RPC_URL!,
      chainId: 11155111,
      timeout: 200000,
      accounts: [
        process.env.PRIVATE_KEY_OWNER,
        process.env.PRIVATE_KEY_SELLER,
        process.env.PRIVATE_KEY_BIDDER1,
        process.env.PRIVATE_KEY_BIDDER2,
      ].filter((key): key is string => Boolean(key)),
    },
  },
});
