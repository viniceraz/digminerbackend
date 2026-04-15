-- ═══════════════════════════════════════════════════════
-- DigMiner — Lands System Tables
-- ═══════════════════════════════════════════════════════
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

-- Lands (permanent — no lifespan)
CREATE TABLE IF NOT EXISTS lands (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL REFERENCES players(wallet),
    rarity_id INTEGER NOT NULL,
    rarity_name TEXT NOT NULL,
    boost_percent INTEGER NOT NULL,
    miner_slots INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Land-Miner assignments (each miner can only be in one land at a time)
CREATE TABLE IF NOT EXISTS land_miners (
    id BIGSERIAL PRIMARY KEY,
    land_id BIGINT NOT NULL REFERENCES lands(id) ON DELETE CASCADE,
    miner_id BIGINT NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
    wallet TEXT NOT NULL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(miner_id)
);

-- Land box purchase log
CREATE TABLE IF NOT EXISTS land_purchases (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    land_id BIGINT,
    cost_digcoin DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lands_wallet ON lands(wallet);
CREATE INDEX IF NOT EXISTS idx_land_miners_land ON land_miners(land_id);
CREATE INDEX IF NOT EXISTS idx_land_miners_miner ON land_miners(miner_id);
CREATE INDEX IF NOT EXISTS idx_land_miners_wallet ON land_miners(wallet);

-- ═══════════════════════════════════════════════════════
-- Atomic assign: count check + insert in one transaction.
-- Prevents TOCTOU slot overflow when two concurrent requests
-- try to fill the last slot of the same land simultaneously.
-- Returns: 'assigned', 'full', 'already_assigned'
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION assign_miner_to_land(
    p_land_id   BIGINT,
    p_miner_id  BIGINT,
    p_wallet    TEXT
) RETURNS TEXT AS $$
DECLARE
    v_slots     INTEGER;
    v_current   INTEGER;
BEGIN
    -- Lock the land row to prevent concurrent slot-count races
    SELECT miner_slots INTO v_slots
    FROM public.lands
    WHERE id = p_land_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    SELECT COUNT(*) INTO v_current
    FROM public.land_miners
    WHERE land_id = p_land_id;

    IF v_current >= v_slots THEN
        RETURN 'full';
    END IF;

    INSERT INTO public.land_miners (land_id, miner_id, wallet)
    VALUES (p_land_id, p_miner_id, p_wallet)
    ON CONFLICT (miner_id) DO NOTHING;

    IF NOT FOUND THEN
        RETURN 'already_assigned';
    END IF;

    RETURN 'assigned';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- ═══════════════════════════════════════════════════════
-- ✅ Done! Land tables are ready.
-- ═══════════════════════════════════════════════════════
