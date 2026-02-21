// Find the Polymarket proxy wallet address for our EOA
import "dotenv/config";
import { Wallet, Contract, providers } from "ethers";

const POLYGON_RPC = "https://polygon-rpc.com";
const EXCHANGE_ADDR = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

// Minimal ABI for getPolyProxyWalletAddress
const ABI = [
  "function getPolyProxyWalletAddress(address _addr) view returns (address)",
  "function getProxyFactory() view returns (address)",
  "function getSafeFactoryImplementation() view returns (address)",
];

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const eoaAddress = await signer.getAddress();
  console.log("EOA address:", eoaAddress);

  const provider = new providers.JsonRpcProvider(POLYGON_RPC);
  const exchange = new Contract(EXCHANGE_ADDR, ABI, provider);

  console.log("\nQuerying Polymarket Exchange contract...");
  const proxyAddress = await exchange.getPolyProxyWalletAddress(eoaAddress);
  console.log("Proxy wallet address:", proxyAddress);

  // Check USDC balance of proxy
  const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC on Polygon
  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const usdc = new Contract(USDC, erc20Abi, provider);

  const proxyBalance = await usdc.balanceOf(proxyAddress);
  console.log("Proxy USDC balance:", (Number(proxyBalance) / 1e6).toFixed(4));

  const eoaBalance = await usdc.balanceOf(eoaAddress);
  console.log("EOA USDC balance:", (Number(eoaBalance) / 1e6).toFixed(4));
}

main().catch(e => console.error("Error:", e.message));
