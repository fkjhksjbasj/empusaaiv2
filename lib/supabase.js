// EmpusaAI Supabase Integration — Bot ↔ Database communication
// Uses service role key to bypass RLS (bot is a trusted backend process)

import { createClient } from "@supabase/supabase-js";

const _slog = (...a) => { try { process.stdout.write(a.join(" ") + "\n"); } catch {} };

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  _slog("[Supabase] WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — pool sync disabled");
}

const supabase = (url && key) ? createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
}) : null;

export function isConnected() {
  return supabase !== null;
}

// ─── Pool Balance ────────────────────────────────
export async function getPoolBalance() {
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc("get_pool_balance");
  if (error) { _slog(`[Supabase] getPoolBalance error: ${error.message}`); return 0; }
  return Number(data) || 0;
}

// ─── Pool Trades ─────────────────────────────────
export async function createPoolTrade(trade) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("pool_trades")
    .insert({
      condition_id: trade.condition_id,
      token_id: trade.token_id,
      market_name: trade.market_name,
      asset: trade.asset,
      timeframe: trade.timeframe,
      side: trade.side,
      entry_price: trade.entry_price,
      total_size: trade.total_size,
      total_cost: trade.total_cost,
      pool_balance_at_entry: trade.pool_balance_at_entry,
      entry_reason: trade.entry_reason,
      bot_position_data: trade.bot_position_data || null,
      status: "active",
    })
    .select("id")
    .single();

  if (error) { _slog(`[Supabase] createPoolTrade error: ${error.message}`); return null; }
  return data.id;
}

export async function lockBalancesForTrade(poolTradeId, totalCost, marketName, side, entryPrice) {
  if (!supabase) return;
  const { error } = await supabase.rpc("lock_balances_for_trade", {
    p_pool_trade_id: poolTradeId,
    p_total_cost: totalCost,
    p_market_name: marketName,
    p_side: side,
    p_entry_price: entryPrice,
  });
  if (error) _slog(`[Supabase] lockBalancesForTrade error: ${error.message}`);
}

export async function distributeTradePnl(poolTradeId, exitPrice, totalPnl, exitReason) {
  if (!supabase) return;
  const { error } = await supabase.rpc("distribute_trade_pnl", {
    p_pool_trade_id: poolTradeId,
    p_exit_price: exitPrice,
    p_total_pnl: totalPnl,
    p_exit_reason: exitReason,
  });
  if (error) _slog(`[Supabase] distributeTradePnl error: ${error.message}`);
}

// Update current_price on all agent_actions for this pool trade (for live dashboard)
export async function updatePoolTradePrice(poolTradeId, currentPrice) {
  if (!supabase) return;
  const { error } = await supabase
    .from("agent_actions")
    .update({ current_price: currentPrice })
    .eq("pool_trade_id", poolTradeId)
    .eq("status", "active");
  if (error) _slog(`[Supabase] updatePoolTradePrice error: ${error.message}`);
}

// ─── Bot Logs ────────────────────────────────────
export async function pushLogsBatch(logs) {
  if (!supabase || !logs || logs.length === 0) return;
  const rows = logs.map(l => ({
    ts: l.ts,
    type: l.type,
    message: l.msg,
    metadata: l.metadata || null,
  }));
  const { error } = await supabase.from("bot_logs").insert(rows);
  if (error) _slog(`[Supabase] pushLogsBatch error: ${error.message}`);
}

export async function cleanOldLogs(hoursToKeep = 24) {
  if (!supabase) return;
  const cutoff = new Date(Date.now() - hoursToKeep * 3600 * 1000).toISOString();
  const { error } = await supabase
    .from("bot_logs")
    .delete()
    .lt("created_at", cutoff);
  if (error) _slog(`[Supabase] cleanOldLogs error: ${error.message}`);
}

// ─── Bot State (singleton row id=1) ──────────────
export async function saveState(state) {
  if (!supabase) return;
  const { error } = await supabase
    .from("bot_state")
    .upsert({
      id: 1,
      status: state.status || "running",
      positions: state.positions || [],
      history: (state.history || []).slice(0, 100),
      total_pnl: state.total_pnl || 0,
      total_bets: state.total_bets || 0,
      wins: state.wins || 0,
      losses: state.losses || 0,
      bankroll: state.bankroll || 0,
      starting_bankroll: state.starting_bankroll || 0,
      daily_pnl: state.daily_pnl || 0,
      daily_reset_date: state.daily_reset_date || null,
      tick_count: state.tick_count || 0,
      probe_results: state.probe_results || {},
      execution_stats: state.execution_stats || {},
      last_heartbeat: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (error) _slog(`[Supabase] saveState error: ${error.message}`);
}

export async function loadState() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("bot_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) { _slog(`[Supabase] loadState error: ${error.message}`); return null; }
  return data;
}

export async function sendHeartbeat() {
  if (!supabase) return;
  const { error } = await supabase
    .from("bot_state")
    .update({ last_heartbeat: new Date().toISOString() })
    .eq("id", 1);
  if (error) _slog(`[Supabase] sendHeartbeat error: ${error.message}`);
}

// Check if there's an active pool trade (for withdrawal safety)
export async function hasActivePoolTrade() {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("pool_trades")
    .select("id")
    .eq("status", "active")
    .limit(1);
  if (error) return false;
  return data && data.length > 0;
}
