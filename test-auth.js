// Diagnostic: test all auth approaches for Polymarket CLOB
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const address = await signer.getAddress();
  console.log("EOA address:", address);

  // 1. Check server health
  console.log("\n--- Server Health ---");
  try {
    const client = new ClobClient(HOST, CHAIN_ID);
    const ok = await client.getOk();
    console.log("Server OK:", ok);
  } catch (e) {
    console.log("Server unreachable:", e.message);
  }

  // 2. Try createApiKey (POST /auth/api-key) — nonce 0
  console.log("\n--- createApiKey (nonce=0) ---");
  try {
    const c = new ClobClient(HOST, CHAIN_ID, signer);
    const result = await c.createApiKey(0);
    console.log("CREATE result:", JSON.stringify(result));
  } catch (e) {
    console.log("CREATE failed:", e?.response?.data || e.message || e);
  }

  // 3. Try deriveApiKey (GET /auth/derive-api-key) — nonce 0
  console.log("\n--- deriveApiKey (nonce=0) ---");
  try {
    const c = new ClobClient(HOST, CHAIN_ID, signer);
    const result = await c.deriveApiKey(0);
    console.log("DERIVE result:", JSON.stringify(result));
  } catch (e) {
    console.log("DERIVE failed:", e?.response?.data || e.message || e);
  }

  // 4. Try deriveApiKey — nonce 1
  console.log("\n--- deriveApiKey (nonce=1) ---");
  try {
    const c = new ClobClient(HOST, CHAIN_ID, signer);
    const result = await c.deriveApiKey(1);
    console.log("DERIVE result:", JSON.stringify(result));
  } catch (e) {
    console.log("DERIVE failed:", e?.response?.data || e.message || e);
  }

  // 5. Try with server time (in case local clock is off)
  console.log("\n--- deriveApiKey (server time) ---");
  try {
    const c = new ClobClient(HOST, CHAIN_ID, signer, undefined, undefined, undefined, undefined, true);
    const serverTime = await c.getServerTime();
    console.log("Server time:", serverTime, "Local:", Math.floor(Date.now()/1000));
    const result = await c.deriveApiKey(0);
    console.log("DERIVE result:", JSON.stringify(result));
  } catch (e) {
    console.log("DERIVE failed:", e?.response?.data || e.message || e);
  }

  // 6. List existing API keys
  console.log("\n--- getApiKeys ---");
  try {
    const c = new ClobClient(HOST, CHAIN_ID, signer);
    const keys = await c.getApiKeys();
    console.log("Existing keys:", JSON.stringify(keys));
  } catch (e) {
    console.log("getApiKeys failed:", e?.response?.data || e.message || e);
  }

  // 7. Raw fetch to check geo-blocking
  console.log("\n--- Raw health check ---");
  try {
    const resp = await fetch(`${HOST}/`);
    const text = await resp.text();
    console.log("Status:", resp.status, "Body:", text.slice(0, 200));
  } catch (e) {
    console.log("Fetch failed:", e.message);
  }
}

main().catch(e => console.error("Fatal:", e));
