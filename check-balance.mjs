import { config } from 'dotenv';
config();
import { ethers } from 'ethers';

const key = process.env.POLYMARKET_PRIVATE_KEY;
const cleanKey = key.startsWith("0x") ? key : `0x${key}`;
const wallet = new ethers.Wallet(cleanKey);
const address = wallet.address;
console.log('EOA:', address);

// Get proxy wallet address (where Polymarket funds actually live)
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Try multiple RPCs
const rpcs = [
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
  'https://polygon-bor-rpc.publicnode.com',
];

for (const rpc of rpcs) {
  try {
    console.log('\nTrying:', rpc);
    const provider = new ethers.providers.JsonRpcProvider(rpc);

    // Get proxy wallet
    const exchange = new ethers.Contract(EXCHANGE,
      ['function getPolyProxyWalletAddress(address) view returns (address)'],
      provider);
    const proxy = await exchange.getPolyProxyWalletAddress(address);
    console.log('Proxy wallet:', proxy);

    // Check USDC balance on BOTH addresses
    const usdc = new ethers.Contract(USDC_ADDR,
      ['function balanceOf(address) view returns (uint256)'],
      provider);

    const eoaBal = await usdc.balanceOf(address);
    console.log('EOA USDC:', (Number(eoaBal) / 1e6).toFixed(6));

    const proxyBal = await usdc.balanceOf(proxy);
    console.log('Proxy USDC:', (Number(proxyBal) / 1e6).toFixed(6));

    const total = (Number(eoaBal) + Number(proxyBal)) / 1e6;
    console.log('TOTAL USDC:', total.toFixed(6));

    // Check MATIC for gas
    const matic = await provider.getBalance(address);
    console.log('MATIC:', ethers.utils.formatEther(matic));

    console.log('\nSUCCESS');
    process.exit(0);
  } catch(e) {
    console.log('Failed:', e.message?.slice(0, 80));
  }
}
console.log('\nAll RPCs failed');
