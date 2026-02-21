// Fix bot state in Supabase — clear stale position, set real bankroll
import { config } from 'dotenv'; config();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Clear the stale 1d DOWN position and set bankroll to real wallet balance
const { error } = await supabase
  .from("bot_state")
  .upsert({
    id: 1,
    status: "running",
    positions: [],
    history: [],
    total_pnl: 0,
    total_bets: 1,
    wins: 1,
    losses: 0,
    bankroll: 2.44,
    starting_bankroll: 2.44,
    daily_pnl: 0,
    daily_reset_date: "2026-02-21",
    tick_count: 0,
    probe_results: {},
    execution_stats: { fills: 1, failures: 0, totalSlippage: 0, totalSpreadCost: 0 },
    last_heartbeat: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

if (error) {
  console.log("ERROR:", error.message);
} else {
  console.log("Supabase bot_state updated: positions cleared, bankroll=$2.44");
}

// Verify
const { data } = await supabase.from("bot_state").select("*").eq("id", 1).single();
console.log("Verified:", data.positions?.length, "positions,", "bankroll:", data.bankroll);
