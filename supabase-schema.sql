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
    box_type TEXT DEFAULT 'regular',  -- 'regular' | 'sale'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add box_type to existing table if not present
ALTER TABLE box_purchases ADD COLUMN IF NOT EXISTS box_type TEXT DEFAULT 'regular';

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

-- Unique guard: prevents double-credit when two concurrent requests submit the same txHash.
-- NULL values are excluded (PostgreSQL allows multiple NULLs in a partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash_unique ON deposits(tx_hash) WHERE tx_hash IS NOT NULL;

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
    FROM public.players;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Atomic relative balance increment — prevents lost-update race conditions.
-- All balance ADDITIONS go through this function; deductions use spend_digcoin.
CREATE OR REPLACE FUNCTION add_digcoin(
    p_wallet              TEXT,
    p_amount              DOUBLE PRECISION DEFAULT 0,
    p_deposited_pathusd   DOUBLE PRECISION DEFAULT 0,
    p_earned_digcoin      DOUBLE PRECISION DEFAULT 0,
    p_referral_digcoin    DOUBLE PRECISION DEFAULT 0,
    p_withdrawn_pathusd   DOUBLE PRECISION DEFAULT 0,
    p_boxes               INTEGER DEFAULT 0
) RETURNS void AS $$
BEGIN
    UPDATE public.players SET
        digcoin_balance         = digcoin_balance         + p_amount,
        total_deposited_pathusd = total_deposited_pathusd + p_deposited_pathusd,
        total_earned_digcoin    = total_earned_digcoin    + p_earned_digcoin,
        referral_earnings       = referral_earnings       + p_referral_digcoin,
        total_withdrawn_pathusd = total_withdrawn_pathusd + p_withdrawn_pathusd,
        boxes_bought            = boxes_bought            + p_boxes
    WHERE wallet = p_wallet;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Atomic relative balance deduction — prevents concurrent double-spend.
-- Returns TRUE if deduction succeeded (balance >= p_amount), FALSE otherwise.
-- The absolute-SET + .gte() SDK pattern is NOT safe: two concurrent requests both
-- reading the same stale balance would both pass the check and write the same value,
-- effectively charging only once. This function uses a relative UPDATE so each
-- concurrent call deducts from the current live balance.
CREATE OR REPLACE FUNCTION spend_digcoin(
    p_wallet              TEXT,
    p_amount              DOUBLE PRECISION,
    p_withdrawn_pathusd   DOUBLE PRECISION DEFAULT 0
) RETURNS BOOLEAN AS $$
DECLARE
    rows_updated INTEGER;
BEGIN
    UPDATE public.players SET
        digcoin_balance         = digcoin_balance - p_amount,
        total_spent_digcoin     = CASE WHEN p_withdrawn_pathusd = 0
                                       THEN total_spent_digcoin + p_amount
                                       ELSE total_spent_digcoin END,
        total_withdrawn_pathusd = total_withdrawn_pathusd + p_withdrawn_pathusd
    WHERE wallet = p_wallet AND digcoin_balance >= p_amount;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RETURN rows_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Atomic deposit processing: inserts deposit record AND credits player balance
-- in a single transaction. Returns: 'credited', 'duplicate', or raises an exception.
-- This prevents the race condition where INSERT succeeds but the balance RPC fails.
CREATE OR REPLACE FUNCTION process_deposit(
    p_wallet          TEXT,
    p_amount_pathusd  DOUBLE PRECISION,
    p_digcoin_amount  DOUBLE PRECISION,
    p_tx_hash         TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    v_inserted INTEGER;
BEGIN
    -- Try to insert deposit record (UNIQUE constraint on tx_hash guards against duplicates)
    IF p_tx_hash IS NOT NULL THEN
        INSERT INTO public.deposits (wallet, amount_pathusd, digcoin_credited, tx_hash)
        VALUES (p_wallet, p_amount_pathusd, p_digcoin_amount, p_tx_hash)
        ON CONFLICT (tx_hash) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
            RETURN 'duplicate';
        END IF;
    ELSE
        INSERT INTO public.deposits (wallet, amount_pathusd, digcoin_credited, tx_hash)
        VALUES (p_wallet, p_amount_pathusd, p_digcoin_amount, p_tx_hash);
    END IF;

    -- Credit balance atomically in the same transaction
    UPDATE public.players SET
        digcoin_balance         = digcoin_balance         + p_digcoin_amount,
        total_deposited_pathusd = total_deposited_pathusd + p_amount_pathusd
    WHERE wallet = p_wallet;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found: %', p_wallet;
    END IF;

    RETURN 'credited';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- ═══════════════════════════════════════════════════════
-- ✅ Done! Your database is ready.
-- ═══════════════════════════════════════════════════════
