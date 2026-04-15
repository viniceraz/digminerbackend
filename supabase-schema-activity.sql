-- ═══════════════════════════════════════════════════════
-- DigMiner — Activity Log Table
-- ═══════════════════════════════════════════════════════
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- Captures: fusions, play_all fees, claim_all fees
-- (repairs and land_purchases already have their own tables)
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    wallet TEXT NOT NULL,
    type TEXT NOT NULL,        -- 'fusion' | 'play_all' | 'claim_all'
    detail TEXT,
    amount_digcoin DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_wallet ON activity_log(wallet);
CREATE INDEX IF NOT EXISTS idx_activity_log_type   ON activity_log(type);

-- ═══════════════════════════════════════════════════════
-- ✅ Done! Activity log table is ready.
-- ═══════════════════════════════════════════════════════
