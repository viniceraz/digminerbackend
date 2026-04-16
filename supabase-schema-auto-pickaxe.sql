-- ═══════════════════════════════════════════════════════
-- DigMiner — Auto Pickaxe (player_perks table)
-- ═══════════════════════════════════════════════════════
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_perks (
    id            BIGSERIAL PRIMARY KEY,
    wallet        TEXT NOT NULL REFERENCES players(wallet),
    perk_type     TEXT NOT NULL,   -- 'auto_pickaxe'
    active        BOOLEAN NOT NULL DEFAULT true,
    purchased_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet, perk_type)
);

CREATE INDEX IF NOT EXISTS idx_player_perks_wallet ON player_perks(wallet);
CREATE INDEX IF NOT EXISTS idx_player_perks_type   ON player_perks(perk_type);

-- ═══════════════════════════════════════════════════════
-- ✅ Done! Auto Pickaxe table is ready.
-- ═══════════════════════════════════════════════════════
