-- ═══════════════════════════════════════════════════════
-- DigMiner — Supabase Database Setup
-- ═══════════════════════════════════════════════════════
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

-- Players
CREATE TABLE IF NOT EXISTS players (
    wallet TEXT PRIMARY KEY,
    digcoin_balance DOUBLE PRECISION DEFAULT 0,
    total_deposited_pathusd DOUBLE PRECISION DEFAULT 0,
    total_withdrawn_pathusd DOUBLE PRECISION DEFAULT 0,
    total_earned_digcoin DOUBLE PRECISION DEFAULT 0,
    total_spent_digcoin DOUBLE PRECISION DEFAULT 0,
    boxes_bought INTEGER DEFAULT 0,
    referrer TEXT,
    referral_earnings DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Miners (NFTs)
CREATE TABLE IF NOT EXISTS miners (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL REFERENCES players(wallet),
    rarity_id INTEGER NOT NULL,
    rarity_name TEXT NOT NULL,
    daily_digcoin DOUBLE PRECISION NOT NULL,
    nft_age_total INTEGER NOT NULL,
    nft_age_remaining INTEGER NOT NULL,
    power INTEGER DEFAULT 0,
    energy INTEGER DEFAULT 0,
    exp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    protective INTEGER DEFAULT 0,
    damage INTEGER DEFAULT 0,
    is_alive BOOLEAN DEFAULT TRUE,
    needs_repair BOOLEAN DEFAULT FALSE,
    last_play_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Play History
CREATE TABLE IF NOT EXISTS play_history (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    miner_id BIGINT NOT NULL,
    reward_digcoin DOUBLE PRECISION NOT NULL,
    played_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deposits
CREATE TABLE IF NOT EXISTS deposits (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount_pathusd DOUBLE PRECISION NOT NULL,
    digcoin_credited DOUBLE PRECISION NOT NULL,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Withdrawals
CREATE TABLE IF NOT EXISTS withdrawals (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount_digcoin DOUBLE PRECISION NOT NULL,
    amount_pathusd DOUBLE PRECISION NOT NULL,
    fee_pathusd DOUBLE PRECISION NOT NULL,
    net_pathusd DOUBLE PRECISION NOT NULL,
    nonce INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Box Purchases
CREATE TABLE IF NOT EXISTS box_purchases (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    miner_id BIGINT,
    cost_digcoin DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Repairs
CREATE TABLE IF NOT EXISTS repairs (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    miner_id BIGINT NOT NULL,
    cost_digcoin DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_miners_wallet ON miners(wallet);
CREATE INDEX IF NOT EXISTS idx_miners_alive ON miners(wallet, is_alive);
CREATE INDEX IF NOT EXISTS idx_play_wallet ON play_history(wallet);
CREATE INDEX IF NOT EXISTS idx_deposits_wallet ON deposits(wallet);

-- Global stats function (used by /api/stats)
CREATE OR REPLACE FUNCTION get_global_stats()
RETURNS TABLE (
    total_deposited DOUBLE PRECISION,
    total_withdrawn DOUBLE PRECISION,
    total_boxes INTEGER
) AS $$
BEGIN
    RETURN QUERY SELECT
        COALESCE(SUM(total_deposited_pathusd), 0),
        COALESCE(SUM(total_withdrawn_pathusd), 0),
        COALESCE(SUM(boxes_bought)::INTEGER, 0)
    FROM players;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════
-- ✅ Done! Your database is ready.
-- ═══════════════════════════════════════════════════════
