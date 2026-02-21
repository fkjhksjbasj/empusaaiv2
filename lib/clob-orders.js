// Real Polymarket CLOB order execution
// Uses @polymarket/clob-client SDK for actual order placement
// Entry: BUY shares at ask price (GTC with 60s expiry)
// Exit: SELL shares at bid price (GTC, or FOK near expiry)

import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { Wallet, Contract, providers } from "ethers";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const CHAIN_ID = 137; // Polygon mainnet
const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";
const EXCHANGE_ADDR = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

export class ClobOrders {
  constructor() {
    this.client = null;
    this.signer = null;
    this.apiCreds = null;
    this.ready = false;
    this.address = null;      // EOA signer address
    this.proxyAddress = null;  // Polymarket proxy wallet (holds funds)
    this._orders = new Map(); // orderId → { tokenId, side, size, price, ts }
  }

  async init(privateKey) {
    if (!privateKey) throw new Error("No private key provided");

    // Strip 0x prefix if present for ethers
    const cleanKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.signer = new Wallet(cleanKey);
    this.address = await this.signer.getAddress();
    _slog(`[CLOB] EOA signer: ${this.address}`);

    // Look up Polymarket proxy wallet address (where funds live)
    const provider = new providers.JsonRpcProvider(POLYGON_RPC);
    const exchange = new Contract(EXCHANGE_ADDR,
      ["function getPolyProxyWalletAddress(address) view returns (address)"],
      provider);
    this.proxyAddress = await exchange.getPolyProxyWalletAddress(this.address);
    _slog(`[CLOB] Proxy wallet: ${this.proxyAddress}`);

    // Derive API credentials (deterministic from private key — always works)
    _slog("[CLOB] Deriving API credentials...");
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, this.signer);
    this.apiCreds = await tempClient.deriveApiKey();

    if (!this.apiCreds || !this.apiCreds.key) {
      throw new Error("Could not derive API credentials");
    }
    _slog(`[CLOB] API Key: ${this.apiCreds.key.slice(0, 8)}...`);

    // Create authenticated client with proxy wallet as funder
    this.client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      this.signer,
      this.apiCreds,
      SignatureType.POLY_PROXY, // EOA signs on behalf of proxy wallet
      this.proxyAddress,        // proxy wallet holds the funds
    );

    // Verify connection
    const ok = await this.client.getOk();
    _slog(`[CLOB] Server status: ${ok}`);

    this.ready = true;
    _slog("[CLOB] Ready for real trading");
    return this.address;
  }

  // ─── BUY shares (entry) ───────────────────────────
  // Places a GTC limit order at or slightly above the ask
  // Returns { success, orderId, fillPrice } or { success: false, error }
  async buyShares(tokenId, size, price) {
    if (!this.ready) return { success: false, error: "CLOB client not ready" };

    try {
      // Round price to valid tick size (Polymarket uses 0.01 or 0.001)
      const tickSize = await this.client.getTickSize(tokenId);
      const roundedPrice = this._roundToTick(price, tickSize);

      // Calculate dollar amount: we want to spend $size, buying at $roundedPrice per share
      // Polymarket size = number of shares, not dollar amount
      // shares = dollarAmount / pricePerShare
      const shares = Math.ceil((size / roundedPrice) * 100) / 100;
      if (shares < 1) return { success: false, error: `Too few shares: ${shares}` };

      _slog(`[CLOB] BUY ${shares} shares of ${tokenId.slice(0, 12)}... @$${roundedPrice} ($${size})`);

      const resp = await this.client.createAndPostOrder({
        tokenID: tokenId,
        price: roundedPrice,
        side: Side.BUY,
        size: shares,
      }, OrderType.GTC);

      if (resp && resp.success) {
        const orderId = resp.orderID || resp.orderId || "unknown";
        this._orders.set(orderId, {
          tokenId, side: "BUY", shares, price: roundedPrice, dollarSize: size,
          ts: Date.now(), status: "placed",
        });
        _slog(`[CLOB] BUY order placed: ${orderId}`);
        return {
          success: true,
          orderId,
          execPrice: roundedPrice,
          shares,
          slippage: 0,
          spread: 0,
          filled: true,
        };
      } else {
        const errMsg = resp?.errorMsg || resp?.error || JSON.stringify(resp);
        _slog(`[CLOB] BUY failed: ${errMsg}`);
        return { success: false, error: errMsg };
      }
    } catch (e) {
      _slog(`[CLOB] BUY error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // ─── SELL shares (exit) ───────────────────────────
  // Places a GTC limit at bid price, or FOK for urgent exits
  async sellShares(tokenId, shares, price, urgent = false) {
    if (!this.ready) return { success: false, error: "CLOB client not ready" };

    try {
      // Approve conditional token allowance before selling
      try {
        await this.client.updateBalanceAllowance({
          asset_type: "CONDITIONAL",
          token_id: tokenId,
        });
        _slog(`[CLOB] Conditional token allowance updated for ${tokenId.slice(0, 12)}...`);
      } catch (approveErr) {
        _slog(`[CLOB] Allowance update warning: ${approveErr.message}`);
      }

      const tickSize = await this.client.getTickSize(tokenId);
      const roundedPrice = this._roundToTick(price, tickSize);
      const roundedShares = Math.floor(shares * 100) / 100;
      if (roundedShares < 1) return { success: false, error: `Too few shares: ${roundedShares}` };

      const orderType = urgent ? OrderType.FOK : OrderType.GTC;
      _slog(`[CLOB] SELL ${roundedShares} shares of ${tokenId.slice(0, 12)}... @$${roundedPrice} (${urgent ? "FOK" : "GTC"})`);

      const resp = await this.client.createAndPostOrder({
        tokenID: tokenId,
        price: roundedPrice,
        side: Side.SELL,
        size: roundedShares,
      }, orderType);

      if (resp && resp.success) {
        const orderId = resp.orderID || resp.orderId || "unknown";
        this._orders.set(orderId, {
          tokenId, side: "SELL", shares: roundedShares, price: roundedPrice,
          ts: Date.now(), status: "placed",
        });
        _slog(`[CLOB] SELL order placed: ${orderId}`);
        return {
          success: true,
          orderId,
          execPrice: roundedPrice,
          shares: roundedShares,
          filled: true,
        };
      } else {
        const errMsg = resp?.errorMsg || resp?.error || JSON.stringify(resp);
        _slog(`[CLOB] SELL failed: ${errMsg}`);
        return { success: false, error: errMsg };
      }
    } catch (e) {
      _slog(`[CLOB] SELL error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // ─── Verify order was matched ─────────────────────
  async verifyOrder(orderId) {
    if (!this.ready) return { matched: false, error: "not ready" };
    try {
      const order = await this.client.getOrder(orderId);
      if (!order) return { matched: false, error: "order not found" };
      const matched = order.status === "MATCHED" && parseFloat(order.size_matched) > 0;
      _slog(`[CLOB] Order ${orderId.slice(0, 16)}... status: ${order.status} matched: ${order.size_matched}/${order.original_size}`);
      return { matched, status: order.status, sizeMatched: parseFloat(order.size_matched || 0) };
    } catch (e) {
      _slog(`[CLOB] Verify failed: ${e.message}`);
      return { matched: false, error: e.message };
    }
  }

  // ─── Get USDC balance ──────────────────────────────
  async getBalance() {
    if (!this.ready) return 0;
    try {
      const bal = await this.client.getBalanceAllowance({ asset_type: "COLLATERAL" });
      // Balance is in smallest USDC units (6 decimals)
      return parseFloat(bal.balance) / 1e6;
    } catch (e) {
      _slog(`[CLOB] Balance check failed: ${e.message}`);
      return -1;
    }
  }

  // ─── Cancel order ─────────────────────────────────
  async cancelOrder(orderId) {
    if (!this.ready) return false;
    try {
      await this.client.cancelOrder(orderId);
      const tracked = this._orders.get(orderId);
      if (tracked) tracked.status = "cancelled";
      _slog(`[CLOB] Cancelled: ${orderId}`);
      return true;
    } catch (e) {
      _slog(`[CLOB] Cancel failed: ${e.message}`);
      return false;
    }
  }

  // ─── Cancel all open orders ───────────────────────
  async cancelAll() {
    if (!this.ready) return;
    try {
      await this.client.cancelAll();
      _slog("[CLOB] All orders cancelled");
    } catch (e) {
      _slog(`[CLOB] Cancel all failed: ${e.message}`);
    }
  }

  // ─── Check if a specific order has been filled ───
  async checkOrderFilled(orderId) {
    if (!this.ready) return { filled: false };
    try {
      const order = await this.client.getOrder(orderId);
      if (!order) return { filled: false, status: "not_found" };
      const filled = order.status === "MATCHED" && parseFloat(order.size_matched) > 0;
      return { filled, status: order.status, sizeMatched: parseFloat(order.size_matched || 0) };
    } catch (e) {
      return { filled: false, error: e.message };
    }
  }

  // ─── Get open orders ─────────────────────────────
  async getOpenOrders() {
    if (!this.ready) return [];
    try {
      return await this.client.getOpenOrders();
    } catch (e) {
      _slog(`[CLOB] Get orders failed: ${e.message}`);
      return [];
    }
  }

  // ─── Get trade history ────────────────────────────
  async getTrades() {
    if (!this.ready) return [];
    try {
      return await this.client.getTrades();
    } catch (e) {
      _slog(`[CLOB] Get trades failed: ${e.message}`);
      return [];
    }
  }

  // ─── Utils ────────────────────────────────────────

  _roundToTick(price, tickSize) {
    const tick = parseFloat(tickSize) || 0.01;
    return Math.round(price / tick) * tick;
  }

  getStats() {
    return {
      ready: this.ready,
      address: this.address,
      pendingOrders: this._orders.size,
    };
  }
}
