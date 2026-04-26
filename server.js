/**
 * DigMiner Backend — Supabase Edition
 * ═══════════════════════════════════════════
 * Database: Supabase (PostgreSQL cloud — free tier)
 * Host: Railway / Render (free tier)
 * 
 * DIGCOIN = offchain currency (100 DIGCOIN = 1 pathUSD)
 */

try { require('dotenv').config(); } catch(e) {}
const crypto = require('crypto');

// Startup env check
const ENV_STATUS = {
    SUPABASE_URL:        !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY:!!process.env.SUPABASE_SERVICE_KEY,
    RPC_URL:             !!process.env.RPC_URL,
    CHAIN_ID:            !!process.env.CHAIN_ID,
    POOL_CONTRACT:       !!process.env.POOL_CONTRACT,
    SIGNER_PRIVATE_KEY:  !!process.env.SIGNER_PRIVATE_KEY,
    ADMIN_WALLET:        !!process.env.ADMIN_WALLET,
};
console.log('[ENV CHECK]', JSON.stringify(ENV_STATUS));

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Trust Railway/Vercel proxy so rate-limit sees real client IPs
app.use(cors({
    origin: ['https://digminer.xyz', 'https://www.digminer.xyz', 'http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '16kb' }));

// Global rate limit: 60 requests per minute per IP
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down and try again in a minute' },
    skip: (req) => req.path === '/health', // health check always passes
}));

// Stricter limit for financial write endpoints: 10 per minute per IP
const financialLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests on this endpoint — wait a minute' },
});

// Health — always up, shows which env vars are loaded
app.get('/health', (_req, res) => res.json({ ok: true, env: ENV_STATUS, ts: new Date().toISOString() }));

// ════════════════════════════════════════════
// SUPABASE CLIENT
// ════════════════════════════════════════════

const supabase = createClient(
    process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'placeholder-key'
);

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════

const CONFIG = {
    PORT: process.env.PORT || 3000,
    RPC_URL: process.env.RPC_URL || 'https://rpc.tempo.xyz',
    POOL_CONTRACT: process.env.POOL_CONTRACT,
    PATHUSD_DECIMALS: 6,
    SIGNER_PRIVATE_KEY: process.env.SIGNER_PRIVATE_KEY,
    CHAIN_ID: parseInt(process.env.CHAIN_ID || '1'),

    ADMIN_WALLET: (process.env.ADMIN_WALLET || '').toLowerCase(),
    THIEFCAT: { rarityId: 6, rarityName: 'ThiefCat', daily: 30, nftAge: 7, repairPathUSD: 0.30, maxHp: 100, season: 4 },
    MARKETPLACE_FEE_PERCENT: 10,
    MARKETPLACE_FEE_WALLET: '0x8174db20bdc835c35f70a0a536c019c89c783d8c',
    S2_DUNGEON_BUFFS: {
        0: { name: 'Resilient',  hpReduction: 0.25 },                                                          // Common:     -25% HP lost
        1: { name: 'Swift',      cooldownMs: 10 * 1000 },                                                      // UnCommon:   cooldown 10s
        2: { name: 'Looter',     boxMultiplier: 2 },                                                           // Rare:       2x box drop
        3: { name: 'Lucky',      winBonus: 0.10 },                                                             // Super Rare: +10% win chance
        4: { name: 'Scavenger',  mapRecovery: 0.15 },                                                         // Legendary:  15% map recovery
        5: { name: 'Dominator',  winBonus: 0.10, mapRecovery: 0.15, boxMultiplier: 2 },                      // Mythic:     all profit buffs
    },
    STAKE_TIERS: [
        { lockDays: 15, apy: 50  },
        { lockDays: 30, apy: 120 },
        { lockDays: 90, apy: 300 },
    ],
    STAKE_MIN_AMOUNT: 100, // minimum DC to stake
    DIGCOIN_PER_PATHUSD: 100,
    BOX_PRICE_DIGCOIN: 300,        // 3 pathUSD
    BOX_BULK_QUANTITY: 10,
    BOX_BULK_PRICE_DIGCOIN: 2850,  // 10 boxes = 5% discount
    FUSE_COST_DIGCOIN: 50,              // cost to fuse 2 miners
    SALE_BOX_PRICE_DIGCOIN: 150,        // 50% off limited sale
    SALE_BOX_MAX_TOTAL: 2000,           // global supply cap
    SALE_BOX_MAX_PER_WALLET: 50,        // per-wallet cap
    SALE_BOX_END_TIME: 0, // sale permanently closed
    WITHDRAW_FEE_PERCENT: 6,
    REFERRAL_PERCENT: 4,
    PLAY_COOLDOWN_MS: 24 * 60 * 60 * 1000,
    PLAY_ALL_FEE_DIGCOIN: 5,      // fee per miner when using Play All / Claim All

    DUNGEON_COOLDOWN_MS: 20 * 1000, // 20 seconds between dungeon runs
    DUNGEONS: {
        easy:     { name: 'Goblins',     mapItem: 'map_easy',     mapCost: 50,  prize: 100, winChance: 0.45, hpLoss: 25, boxDropChance: 0.02 },
        medium:   { name: 'Spiders',     mapItem: 'map_medium',   mapCost: 150, prize: 300, winChance: 0.40, hpLoss: 40, boxDropChance: 0.05 },
        hard:     { name: "Miner's Bane",mapItem: 'map_hard',     mapCost: 400, prize: 900, winChance: 0.35, hpLoss: 60, boxDropChance: 0.10 },
        weremole: { name: 'Weremole Lair',mapItem: 'map_weremole', mapCost: 200, prize: 0,   winChance: 0.10, hpLoss: 30, boxDropChance: 0, weremoleDungeon: true },
    },
    DUNGEON_MAPS: {
        map_easy:     { name: 'Goblin Map',        price: 50,  dungeonType: 'easy'     },
        map_medium:   { name: 'Spider Map',        price: 150, dungeonType: 'medium'   },
        map_hard:     { name: "Miner's Bane Map",  price: 400, dungeonType: 'hard'     },
        map_weremole: { name: 'Weremole Map',      price: 200, dungeonType: 'weremole' },
    },
    AUTO_PICKAXE_PRICE: 3000,     // one-time lifetime purchase
    AUTO_PICKAXE_MAX_SUPPLY: 500, // hard cap
    SIGNATURE_DEADLINE_SECS: 3600,

    RARITIES: [
        { id: 0, name: 'Common',     chance: 30, dailyMin: 18, dailyMax: 20, nftAge: 19, repairPathUSD: 0.24, color: '#9E9E9E', maxHp: 100 },
        { id: 1, name: 'UnCommon',   chance: 30, dailyMin: 21, dailyMax: 23, nftAge: 17, repairPathUSD: 0.40, color: '#4CAF50', maxHp: 125 },
        { id: 2, name: 'Rare',       chance: 18, dailyMin: 24, dailyMax: 26, nftAge: 15, repairPathUSD: 0.60, color: '#2196F3', maxHp: 150 },
        { id: 3, name: 'Super Rare', chance: 8,  dailyMin: 27, dailyMax: 30, nftAge: 14, repairPathUSD: 0.80, color: '#E91E63', maxHp: 200 },
        { id: 4, name: 'Legendary',  chance: 4,  dailyMin: 31, dailyMax: 35, nftAge: 13, repairPathUSD: 1.00, color: '#FF9800', maxHp: 250 },
        { id: 5, name: 'Mythic',     chance: 2,  dailyMin: 36, dailyMax: 42, nftAge: 11, repairPathUSD: 1.50, color: '#9C27B0', maxHp: 350 },
    ],

    // ── Season 2 ───────────────────────────────────────
    S2_BOX_PRICE_DIGCOIN: 400,
    S2_BOX_10_PRICE_DIGCOIN: Math.round(400*10*0.95),   // 3800 DC (5% off)
    S2_BOX_100_PRICE_DIGCOIN: Math.round(400*100*0.90), // 36000 DC (10% off)
    S2_BOX_MAX_SUPPLY: 1000,
    S2_RARITIES: [
        { id: 0, name: 'Common',     chance: 30, dailyMin: 38, dailyMax: 42, nftAge: 13, repairPathUSD: 0.40, color: '#9E9E9E', maxHp: 100 },
        { id: 1, name: 'UnCommon',   chance: 30, dailyMin: 43, dailyMax: 47, nftAge: 12, repairPathUSD: 0.65, color: '#4CAF50', maxHp: 125 },
        { id: 2, name: 'Rare',       chance: 18, dailyMin: 48, dailyMax: 53, nftAge: 11, repairPathUSD: 1.00, color: '#2196F3', maxHp: 150 },
        { id: 3, name: 'Super Rare', chance: 8,  dailyMin: 55, dailyMax: 60, nftAge: 10, repairPathUSD: 1.40, color: '#E91E63', maxHp: 200 },
        { id: 4, name: 'Legendary',  chance: 4,  dailyMin: 64, dailyMax: 70, nftAge: 9,  repairPathUSD: 1.80, color: '#FF9800', maxHp: 250 },
        { id: 5, name: 'Mythic',     chance: 2,  dailyMin: 76, dailyMax: 85, nftAge: 8,  repairPathUSD: 2.80, color: '#9C27B0', maxHp: 350 },
    ],

    // ── Lands ──────────────────────────────────────────
    LAND_BOX_PRICE_DIGCOIN: 300,       // 3 pathUSD
    LAND_BOX_BULK_QUANTITY: 10,
    LAND_BOX_BULK_PRICE_DIGCOIN: 2550, // 10 boxes = 15% off (25.50 pathUSD)
    LAND_BOX_MAX_SUPPLY: 500,          // total land boxes ever mintable
    LAND_RARITIES: [
        { id: 0, name: 'Common',     chance: 35, boostPercent: 5,  minerSlots: 2, color: '#9E9E9E' },
        { id: 1, name: 'UnCommon',   chance: 28, boostPercent: 10, minerSlots: 3, color: '#4CAF50' },
        { id: 2, name: 'Rare',       chance: 18, boostPercent: 15, minerSlots: 4, color: '#2196F3' },
        { id: 3, name: 'Super Rare', chance: 10, boostPercent: 20, minerSlots: 5, color: '#E91E63' },
        { id: 4, name: 'Legendary',  chance: 6,  boostPercent: 25, minerSlots: 6, color: '#FF9800' },
        { id: 5, name: 'Mythic',     chance: 3,  boostPercent: 35, minerSlots: 8, color: '#9C27B0' },
    ],
};

// Land sale opens 240 minutes after first server boot (persists for the process lifetime)
const LAND_SALE_START_MS = 1776296008834; // Fixed: 2026-04-15T23:33:28 UTC — does not reset on server restart

// S2 launch timestamp — set once in DB on first boot, never overwritten on restart
let S2_LAUNCH_AT_MS = Infinity; // safe default: locked until DB value loads
async function initS2LaunchTime() {
    const launchDate = new Date(Date.now() + 15 * 60 * 60 * 1000).toISOString();
    // Insert only if key doesn't exist yet
    await supabase.from('game_config').upsert(
        { key: 's2_launch_at', value: launchDate },
        { onConflict: 'key', ignoreDuplicates: true }
    );
    const { data } = await supabase.from('game_config').select('value').eq('key', 's2_launch_at').single();
    if (data?.value) {
        S2_LAUNCH_AT_MS = new Date(data.value).getTime();
        console.log(`🌟 S2 launch at: ${data.value} (${S2_LAUNCH_AT_MS > Date.now() ? 'PENDING' : 'LIVE'})`);
    }
}

// ════════════════════════════════════════════
// AUTH (EIP-191 wallet signatures)
// ════════════════════════════════════════════

const nonceStore   = new Map(); // wallet  → { nonce, expiresAt }
const sessionStore = new Map(); // token   → { wallet, expiresAt }
const NONCE_TTL_MS   = 5  * 60 * 1000;      // 5 min
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// Clean up expired entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of nonceStore)   if (v.expiresAt < now) nonceStore.delete(k);
    for (const [k, v] of sessionStore) if (v.expiresAt < now) sessionStore.delete(k);
}, 60_000);

// Maintenance mode (in-memory; resets on redeploy — intentional)
let MAINTENANCE_MODE = false;

function checkMaintenance(req, res, next) {
    if (MAINTENANCE_MODE) return res.status(503).json({ error: '🔧 Game is under maintenance. Come back soon!' });
    next();
}

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required — connect your wallet in the app' });
    const token = auth.slice(7);
    const session = sessionStore.get(token);
    if (!session || session.expiresAt < Date.now()) return res.status(401).json({ error: 'Session expired — reconnect your wallet' });
    // If the body has a wallet field, make sure it matches the session
    const bodyWallet = req.body.wallet ? norm(req.body.wallet) : null;
    if (bodyWallet && bodyWallet !== session.wallet) return res.status(403).json({ error: 'Wallet mismatch — token does not match requested wallet' });
    req.authWallet = session.wallet;
    next();
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!CONFIG.ADMIN_WALLET) return res.status(403).json({ error: 'Admin wallet not configured on server' });
        if (req.authWallet !== CONFIG.ADMIN_WALLET) return res.status(403).json({ error: 'Forbidden — admin only' });
        next();
    });
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

const norm = w => w.toLowerCase();
const isValidAddress = addr => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
const isValidMinerId = id => Number.isInteger(id) && id > 0;

// Nonce rate-limit: max 1 request per 15s per wallet (prevents nonce-stomping attacks)
const nonceRateLimit = new Map(); // wallet → last request ts
setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [k, ts] of nonceRateLimit) if (ts < cutoff) nonceRateLimit.delete(k);
}, 60_000);
const randBetween = (min, max) => Math.round((Math.random() * (max - min) + min) * 100) / 100;

function rollRarity() {
    const roll = Math.random() * 100;
    let c = 0;
    for (const r of CONFIG.RARITIES) { c += r.chance; if (roll < c) return r; }
    return CONFIG.RARITIES[0];
}

function rollLandRarity() {
    const roll = Math.random() * 100;
    let c = 0;
    for (const r of CONFIG.LAND_RARITIES) { c += r.chance; if (roll < c) return r; }
    return CONFIG.LAND_RARITIES[0];
}

function generateStats(rarity) {
    const base = (rarity.id + 1) * 150;
    return {
        power: Math.floor(base + Math.random() * 200),
        energy: Math.floor(100 + rarity.id * 25 + Math.random() * 50),
        protective: Math.floor(100 + rarity.id * 30 + Math.random() * 80),
        damage: Math.floor(25 + rarity.id * 5 + Math.random() * 20),
    };
}

async function getOrCreatePlayer(wallet, referrer = null) {
    const w = norm(wallet);
    let { data: player } = await supabase.from('players').select('*').eq('wallet', w).single();

    if (!player) {
        let ref = referrer ? norm(referrer) : null;
        if (ref && ref !== w) {
            const { data: refExists } = await supabase.from('players').select('wallet').eq('wallet', ref).single();
            if (!refExists) ref = null;
        } else { ref = null; }

        const { data: newPlayer, error: insertErr } = await supabase.from('players')
            .insert({ wallet: w, referrer: ref })
            .select().single();
        if (insertErr && insertErr.code !== '23505') {
            throw new Error(`Failed to create player: ${insertErr.message}`);
        }
        // If 23505 (unique violation), another concurrent request created the player — re-fetch
        if (!newPlayer) {
            const { data: retried } = await supabase.from('players').select('*').eq('wallet', w).single();
            player = retried;
        } else {
            player = newPlayer;
        }
    }
    if (!player) throw new Error(`Player not found and could not be created: ${w}`);
    return player;
}

// ════════════════════════════════════════════
// GAME LOGIC
// ════════════════════════════════════════════

async function processDeposit(wallet, amountPathUSD, txHash = '') {
    const w = norm(wallet);
    const digcoinAmount = amountPathUSD * CONFIG.DIGCOIN_PER_PATHUSD;

    // Ensure player exists before the atomic deposit (process_deposit does UPDATE, not UPSERT)
    const player = await getOrCreatePlayer(w);

    // Single atomic Postgres call: inserts deposit record AND credits balance in one transaction.
    // The UNIQUE index on tx_hash guards against concurrent duplicate submissions.
    const { data: result, error: depositErr } = await supabase.rpc('process_deposit', {
        p_wallet: w,
        p_amount_pathusd: amountPathUSD,
        p_digcoin_amount: digcoinAmount,
        p_tx_hash: txHash || null,
    });
    if (depositErr) {
        console.error(`❌ process_deposit failed for ${w} (${digcoinAmount} DC): ${depositErr.message} [code: ${depositErr.code}]`);
        throw new Error(`Failed to process deposit: ${depositErr.message}`);
    }
    if (result === 'duplicate') {
        console.log(`⚠️  Duplicate deposit ignored: ${txHash}`);
        return { duplicate: true };
    }

    console.log(`✅ Deposit credited: ${digcoinAmount} DIGCOIN to ${w} (tx: ${txHash})`);

    // Referral: 4%
    if (player.referrer) {
        const bonus = digcoinAmount * (CONFIG.REFERRAL_PERCENT / 100);
        const { error: refErr } = await supabase.rpc('add_digcoin', {
            p_wallet: player.referrer,
            p_amount: bonus,
            p_referral_digcoin: bonus,
        });
        if (refErr) console.error(`❌ Referral bonus failed for ${player.referrer}: ${refErr.message}`);
    }

    return { digcoinCredited: digcoinAmount, newBalance: player.digcoin_balance + digcoinAmount };
}

async function buyBoxes(wallet, quantity = 1) {
    const w = norm(wallet);
    const player = await getOrCreatePlayer(w);

    const cost = quantity === CONFIG.BOX_BULK_QUANTITY ? CONFIG.BOX_BULK_PRICE_DIGCOIN : CONFIG.BOX_PRICE_DIGCOIN * quantity;

    if (player.digcoin_balance < cost) {
        return { error: `Insufficient balance. Need ${cost} DIGCOIN (have ${player.digcoin_balance.toFixed(2)})` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!ok) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const miners = [];
    try {
        for (let i = 0; i < quantity; i++) {
            const rarity = rollRarity();
            const dailyDigcoin = randBetween(rarity.dailyMin, rarity.dailyMax);
            const stats = generateStats(rarity);

            const { data: miner, error: minerErr } = await supabase.from('miners').insert({
                wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
                daily_digcoin: dailyDigcoin, nft_age_total: rarity.nftAge, nft_age_remaining: rarity.nftAge,
                hp: rarity.maxHp, max_hp: rarity.maxHp,
                ...stats,
            }).select().single();

            if (minerErr || !miner) throw new Error(minerErr?.message || 'Failed to create miner');

            await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: Math.round(cost / quantity) });

            miners.push({
                id: miner.id, rarityId: rarity.id, rarityName: rarity.name,
                dailyDigcoin, nftAge: rarity.nftAge, color: rarity.color, ...stats,
                roi: Math.ceil(CONFIG.BOX_PRICE_DIGCOIN / dailyDigcoin),
            });
        }
        // Increment boxes_bought only after all miners are successfully created
        await supabase.rpc('add_digcoin', { p_wallet: w, p_boxes: quantity });
    } catch (insertErr) {
        // Rollback: refund balance (boxes_bought was never incremented)
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ buyBoxes REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        console.error(`❌ buyBoxes insert failed for ${w}, balance restored:`, insertErr.message);
        return { error: 'Failed to open box — balance restored, please try again' };
    }

    return { success: true, miners, cost, discount: quantity === CONFIG.BOX_BULK_QUANTITY ? '5%' : null };
}

async function getSaleBoxCounts(wallet) {
    const w = norm(wallet);
    const [{ count: totalSold }, { count: walletBought }] = await Promise.all([
        supabase.from('box_purchases').select('*', { count: 'exact', head: true }).eq('box_type', 'sale'),
        supabase.from('box_purchases').select('*', { count: 'exact', head: true }).eq('box_type', 'sale').eq('wallet', w),
    ]);
    return { totalSold: totalSold || 0, walletBought: walletBought || 0 };
}

async function buySaleBoxes(wallet, quantity = 1) {
    const w = norm(wallet);
    const price = CONFIG.SALE_BOX_PRICE_DIGCOIN;
    const cost = price * quantity;

    // Check 1 — pre-deduction fast-path rejection
    const { totalSold, walletBought } = await getSaleBoxCounts(w);
    const globalRemaining = CONFIG.SALE_BOX_MAX_TOTAL - totalSold;
    const walletRemaining = CONFIG.SALE_BOX_MAX_PER_WALLET - walletBought;

    if (Date.now() > CONFIG.SALE_BOX_END_TIME) return { error: 'The sale has ended! Only regular boxes are available.' };
    if (globalRemaining <= 0) return { error: 'Sale boxes are sold out!' };
    if (walletRemaining <= 0) return { error: `Wallet limit reached (max ${CONFIG.SALE_BOX_MAX_PER_WALLET} sale boxes per wallet)` };
    if (quantity > globalRemaining) return { error: `Only ${globalRemaining} sale boxes left globally` };
    if (quantity > walletRemaining) return { error: `You can only buy ${walletRemaining} more sale boxes` };

    const player = await getOrCreatePlayer(w);
    if (player.digcoin_balance < cost) {
        return { error: `Insufficient balance. Need ${cost} DIGCOIN (have ${player.digcoin_balance.toFixed(2)})` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: deducted } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!deducted) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    // Check 2 — post-deduction re-check to close TOCTOU window on sale limits
    // Counts don't include this request yet (boxes not inserted), so add quantity to projected total
    const { totalSold: totalSold2, walletBought: walletBought2 } = await getSaleBoxCounts(w);
    if ((totalSold2 + quantity) > CONFIG.SALE_BOX_MAX_TOTAL || (walletBought2 + quantity) > CONFIG.SALE_BOX_MAX_PER_WALLET) {
        // Re-fetch fresh balance to avoid stale-snapshot corruption on refund
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ buySaleBoxes limit-exceeded REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        return { error: 'Sale box limit exceeded (concurrent purchase) — balance restored, try again' };
    }

    const miners = [];
    const insertedMinerIds = [];
    try {
        for (let i = 0; i < quantity; i++) {
            const rarity = rollRarity();
            const dailyDigcoin = randBetween(rarity.dailyMin, rarity.dailyMax);
            const stats = generateStats(rarity);

            const { data: miner, error: minerErr } = await supabase.from('miners').insert({
                wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
                daily_digcoin: dailyDigcoin, nft_age_total: rarity.nftAge, nft_age_remaining: rarity.nftAge,
                hp: rarity.maxHp, max_hp: rarity.maxHp,
                ...stats,
            }).select().single();

            if (minerErr || !miner) throw new Error(minerErr?.message || 'Failed to create miner');

            insertedMinerIds.push(miner.id);
            await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: price, box_type: 'sale' });

            miners.push({
                id: miner.id, rarityId: rarity.id, rarityName: rarity.name,
                dailyDigcoin, nftAge: rarity.nftAge, color: rarity.color, ...stats,
                roi: Math.ceil(price / dailyDigcoin),
            });
        }
    } catch (insertErr) {
        // Full rollback: delete orphaned miners + their box_purchases (preserves sale quota)
        if (insertedMinerIds.length > 0) {
            await supabase.from('box_purchases').delete().in('miner_id', insertedMinerIds).eq('box_type', 'sale');
            await supabase.from('miners').delete().in('id', insertedMinerIds);
        }
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ buySaleBoxes REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        console.error(`❌ buySaleBoxes insert failed for ${w}, balance restored:`, insertErr.message);
        return { error: 'Failed to open sale box — balance restored, please try again' };
    }

    return { success: true, miners, cost, saleBox: true };
}

// ════════════════════════════════════════════
// SEASON 2 BOX
// ════════════════════════════════════════════
function rollS2Rarity() {
    const rarities = CONFIG.S2_RARITIES;
    const total = rarities.reduce((s, r) => s + r.chance, 0);
    let roll = Math.random() * total;
    for (const r of rarities) { roll -= r.chance; if (roll <= 0) return r; }
    return rarities[rarities.length - 1];
}

async function buyS2Boxes(wallet, quantity = 1) {
    const w = norm(wallet);
    const cost = quantity===100 ? CONFIG.S2_BOX_100_PRICE_DIGCOIN
               : quantity===10  ? CONFIG.S2_BOX_10_PRICE_DIGCOIN
               : CONFIG.S2_BOX_PRICE_DIGCOIN * quantity;
    const price = Math.round(cost / quantity);

    const { data: player } = await supabase.from('players').select('digcoin_balance').eq('wallet', w).single();
    if (!player) return { error: 'Player not found' };
    if (player.digcoin_balance < cost) return { error: `Insufficient balance. Need ${cost} DIGCOIN` };

    const { count: totalSold } = await supabase.from('box_purchases').select('*', { count: 'exact', head: true }).eq('box_type', 's2');
    if ((totalSold || 0) + quantity > CONFIG.S2_BOX_MAX_SUPPLY)
        return { error: `Only ${CONFIG.S2_BOX_MAX_SUPPLY - (totalSold || 0)} S2 boxes remaining` };

    const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!ok) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const miners = [];
    const insertedMinerIds = [];
    try {
        for (let i = 0; i < quantity; i++) {
            const rarity = rollS2Rarity();
            const dailyDigcoin = randBetween(rarity.dailyMin, rarity.dailyMax);
            const stats = generateStats(rarity);

            const { data: miner, error: minerErr } = await supabase.from('miners').insert({
                wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
                daily_digcoin: dailyDigcoin, nft_age_total: rarity.nftAge, nft_age_remaining: rarity.nftAge,
                hp: rarity.maxHp, max_hp: rarity.maxHp, season: 2,
                ...stats,
            }).select().single();

            if (minerErr || !miner) throw new Error(minerErr?.message || 'Failed to create S2 miner');
            insertedMinerIds.push(miner.id);

            await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: price, box_type: 's2' });

            miners.push({
                id: miner.id, rarityId: rarity.id, rarityName: rarity.name,
                dailyDigcoin, nftAge: rarity.nftAge, color: rarity.color, season: 2, ...stats,
                roi: Math.ceil(price / dailyDigcoin),
            });
        }
        await supabase.rpc('add_digcoin', { p_wallet: w, p_boxes: quantity });
    } catch (insertErr) {
        if (insertedMinerIds.length > 0) {
            await supabase.from('box_purchases').delete().in('miner_id', insertedMinerIds).eq('box_type', 's2');
            await supabase.from('miners').delete().in('id', insertedMinerIds);
        }
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ buyS2Boxes REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        return { error: 'Failed to open S2 box — balance restored, please try again' };
    }

    return { success: true, miners, cost, s2Box: true };
}

// ════════════════════════════════════════════
// FUSE MINERS
// ════════════════════════════════════════════

async function fuseMiner(wallet, minerId1, minerId2) {
    const w = norm(wallet);

    if (minerId1 === minerId2) return { error: 'Cannot fuse a miner with itself' };

    // Fetch both miners — must belong to this wallet
    const [{ data: m1 }, { data: m2 }] = await Promise.all([
        supabase.from('miners').select('*').eq('id', minerId1).eq('wallet', w).single(),
        supabase.from('miners').select('*').eq('id', minerId2).eq('wallet', w).single(),
    ]);

    if (!m1) return { error: 'Miner #' + minerId1 + ' not found' };
    if (!m2) return { error: 'Miner #' + minerId2 + ' not found' };

    // Both must be same rarity
    if (m1.rarity_id !== m2.rarity_id) return { error: 'Both miners must be the same rarity to fuse.' };

    // Cannot fuse Mythic (highest tier — no tier above)
    if (m1.rarity_id >= 5) return { error: 'Mythic miners are already the highest tier and cannot be fused.' };

    // Cannot fuse Season 2 or Season 3 (Weremole) miners
    if (m1.season === 2) return { error: `Miner #${minerId1} is a Season 2 miner and cannot be fused.` };
    if (m2.season === 2) return { error: `Miner #${minerId2} is a Season 2 miner and cannot be fused.` };
    if (m1.season === 3) return { error: `Miner #${minerId1} is a Weremole and cannot be fused.` };
    if (m2.season === 3) return { error: `Miner #${minerId2} is a Weremole and cannot be fused.` };
    if (m1.season === 4) return { error: `Miner #${minerId1} is a ThiefCat and cannot be fused.` };
    if (m2.season === 4) return { error: `Miner #${minerId2} is a ThiefCat and cannot be fused.` };

    // Cannot fuse already-fused miners
    if (m1.is_fused) return { error: `Miner #${minerId1} is already a Fused miner and cannot be fused again.` };
    if (m2.is_fused) return { error: `Miner #${minerId2} is already a Fused miner and cannot be fused again.` };

    // Both must be idle (not currently mining)
    if (m1.last_play_at) return { error: 'Miner #' + minerId1 + ' is currently mining. Claim first.' };
    if (m2.last_play_at) return { error: 'Miner #' + minerId2 + ' is currently mining. Claim first.' };

    // Fetch balance and deduct atomically
    const cost = CONFIG.FUSE_COST_DIGCOIN;
    const { data: player } = await supabase.from('players').select('digcoin_balance, total_spent_digcoin').eq('wallet', w).single();
    if (!player) return { error: 'Player not found' };
    if (player.digcoin_balance < cost) return { error: `Insufficient balance. Need ${cost} DIGCOIN to fuse.` };

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: fuseOk } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!fuseOk) return { error: 'Insufficient balance (concurrent update — try again)' };

    // Result = parent rarity + 1 tier
    const resultRarityId = m1.rarity_id + 1;
    const rarity = CONFIG.RARITIES[resultRarityId];

    // Daily = (parent1 + parent2) × 1.20, rounded to 1 decimal
    const fusedDaily = Math.round((m1.daily_digcoin + m2.daily_digcoin) * 1.20 * 10) / 10;

    // Lifespan = average of both parents' remaining lifespan
    const fusedLifespan = Math.max(1, Math.round((m1.nft_age_remaining + m2.nft_age_remaining) / 2));

    const stats = generateStats(rarity);

    // Create new fused miner
    const { data: newMiner, error: insertErr } = await supabase.from('miners').insert({
        wallet: w,
        rarity_id: rarity.id,
        rarity_name: rarity.name,
        daily_digcoin: fusedDaily,
        nft_age_total: fusedLifespan,
        nft_age_remaining: fusedLifespan,
        is_fused: true,
        hp: rarity.maxHp, max_hp: rarity.maxHp,
        ...stats,
    }).select().single();

    if (insertErr || !newMiner) {
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ fuse REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        return { error: 'Failed to create fused miner — balance restored, please try again' };
    }

    // Atomically delete both original miners and verify exactly 2 rows were removed.
    // If a concurrent fuse request already consumed one of them, fewer than 2 rows
    // will be deleted — in that case we roll back the new miner and refund DIGCOIN.
    const { data: deleted } = await supabase.from('miners')
        .delete().in('id', [minerId1, minerId2]).eq('wallet', w).select('id');

    if (!deleted || deleted.length !== 2) {
        await supabase.from('miners').delete().eq('id', newMiner.id);
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ fuse race-condition REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        return { error: 'Fuse failed — one of the miners was already used in a concurrent request. Balance restored.' };
    }

    await supabase.from('activity_log').insert({
        wallet: w, type: 'fusion',
        detail: `Fused #${minerId1}(${m1.rarity_name}) + #${minerId2}(${m2.rarity_name}) → #${newMiner.id}(${rarity.name})`,
        amount_digcoin: cost,
    });

    console.log(`🔥 Fuse: ${w} fused #${minerId1}(${m1.rarity_name}) + #${minerId2}(${m2.rarity_name}) → #${newMiner.id}(${rarity.name})`);

    return {
        success: true,
        miner: { ...newMiner, rarityId: newMiner.rarity_id, rarityName: newMiner.rarity_name },
        consumed: [minerId1, minerId2],
        cost,
    };
}

// ════════════════════════════════════════════
// LANDS
// ════════════════════════════════════════════

async function buyLandBox(wallet, quantity = 1) {
    const w = norm(wallet);
    if (Date.now() < LAND_SALE_START_MS) {
        return { error: 'Land sale has not started yet. Check the countdown timer!' };
    }
    const qty = quantity === CONFIG.LAND_BOX_BULK_QUANTITY ? CONFIG.LAND_BOX_BULK_QUANTITY : 1;
    const cost = qty === CONFIG.LAND_BOX_BULK_QUANTITY ? CONFIG.LAND_BOX_BULK_PRICE_DIGCOIN : CONFIG.LAND_BOX_PRICE_DIGCOIN * qty;

    // Fast-path supply check (before deduction — just avoids obvious waste)
    const { count: totalMintedPre } = await supabase.from('lands').select('*', { count: 'exact', head: true });
    if ((totalMintedPre || 0) >= CONFIG.LAND_BOX_MAX_SUPPLY) {
        return { error: 'All 1000 Mystery Land Boxes have been sold out!' };
    }

    const player = await getOrCreatePlayer(w);
    if (player.digcoin_balance < cost) {
        return { error: `Insufficient balance. Need ${cost} DIGCOIN (have ${player.digcoin_balance.toFixed(2)})` };
    }
    const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!ok) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    // Post-deduction re-check — projected count must not exceed supply
    const { count: totalMinted } = await supabase.from('lands').select('*', { count: 'exact', head: true });
    const remaining = CONFIG.LAND_BOX_MAX_SUPPLY - (totalMinted || 0);
    if (remaining < qty) {
        await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        return { error: remaining <= 0 ? 'All 1000 Mystery Land Boxes have been sold out!' : `Only ${remaining} land box${remaining !== 1 ? 'es' : ''} remaining — balance restored.` };
    }

    const lands = [];
    const insertedLandIds = [];
    try {
        for (let i = 0; i < qty; i++) {
            const rarity = rollLandRarity();
            const { data: land, error: landErr } = await supabase.from('lands').insert({
                wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
                boost_percent: rarity.boostPercent, miner_slots: rarity.minerSlots,
            }).select().single();

            if (landErr || !land) throw new Error(landErr?.message || 'Failed to create land');

            insertedLandIds.push(land.id);
            await supabase.from('land_purchases').insert({ wallet: w, land_id: land.id, cost_digcoin: Math.round(cost / qty) });

            lands.push({
                id: land.id, rarityId: rarity.id, rarityName: rarity.name,
                boostPercent: rarity.boostPercent, minerSlots: rarity.minerSlots, color: rarity.color,
                assignedMiners: [],
            });
        }
    } catch (insertErr) {
        // Rollback: delete orphaned lands + refund
        if (insertedLandIds.length > 0) {
            await supabase.from('land_purchases').delete().in('land_id', insertedLandIds);
            await supabase.from('lands').delete().in('id', insertedLandIds);
        }
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ buyLandBox REFUND FAILED for ${w} (${cost} DC): ${refundErr.message}`);
        return { error: 'Failed to create land — balance restored, please try again' };
    }

    console.log(`🌍 Land box(es) bought: ${w} × ${qty} (cost: ${cost} DC)`);
    return { success: true, lands, cost };
}

async function getLands(wallet) {
    const w = norm(wallet);
    const { data: lands } = await supabase.from('lands').select('*').eq('wallet', w).order('created_at', { ascending: false });
    if (!lands?.length) return { lands: [] };

    const landIds = lands.map(l => l.id);
    const { data: assignments } = await supabase
        .from('land_miners')
        .select('land_id, miner_id, miners(id, rarity_id, rarity_name, daily_digcoin, last_play_at, is_alive, needs_repair, season)')
        .in('land_id', landIds);

    const assignmentsByLand = {};
    for (const a of assignments || []) {
        if (!assignmentsByLand[a.land_id]) assignmentsByLand[a.land_id] = [];
        assignmentsByLand[a.land_id].push(a);
    }

    return {
        lands: lands.map(l => {
            const rarity = CONFIG.LAND_RARITIES[l.rarity_id];
            return {
                id: l.id, rarityId: l.rarity_id, rarityName: l.rarity_name,
                boostPercent: l.boost_percent, minerSlots: l.miner_slots,
                color: rarity?.color || '#9E9E9E',
                assignedMiners: (assignmentsByLand[l.id] || []).map(a => {
                    const m = a.miners;
                    return {
                        minerId: a.miner_id,
                        rarityId: m?.rarity_id,
                        rarityName: m?.rarity_name,
                        dailyDigcoin: m?.daily_digcoin,
                        isIdle: !m?.last_play_at,
                        isAlive: m?.is_alive,
                        needsRepair: m?.needs_repair,
                        season: m?.season ?? 1,
                    };
                }),
            };
        }),
    };
}

async function assignMinerToLand(wallet, landId, minerId) {
    const w = norm(wallet);

    const [{ data: land }, { data: miner }] = await Promise.all([
        supabase.from('lands').select('*').eq('id', landId).eq('wallet', w).single(),
        supabase.from('miners').select('*').eq('id', minerId).eq('wallet', w).single(),
    ]);

    if (!land) return { error: 'Land not found' };
    if (!miner) return { error: 'Miner not found' };
    if (!miner.is_alive || miner.needs_repair) return { error: 'Miner must be alive to assign to a land' };
    if (miner.last_play_at) return { error: 'Miner must be IDLE to assign to a land. Claim or wait for mining to finish.' };

    const { data: activeListing } = await supabase.from('land_listings').select('id').eq('land_id', landId).eq('status', 'active').maybeSingle();
    if (activeListing) return { error: 'Cannot assign miners to a land listed for sale. Cancel the listing first.' };

    // Atomic: slot count check + insert in one DB transaction (prevents TOCTOU overflow)
    const { data: rpcResult, error: rpcErr } = await supabase.rpc('assign_miner_to_land', {
        p_land_id: landId, p_miner_id: minerId, p_wallet: w,
    });
    if (rpcErr) return { error: `Failed to assign: ${rpcErr.message}` };
    if (rpcResult === 'full') return { error: `Land is full (max ${land.miner_slots} miners). Unassign one first.` };
    if (rpcResult === 'already_assigned') return { error: 'Miner is already assigned to a land' };
    if (rpcResult !== 'assigned') return { error: 'Failed to assign miner to land' };

    return { success: true };
}

async function unassignMinerFromLand(wallet, minerId) {
    const w = norm(wallet);

    const { data: assignment } = await supabase
        .from('land_miners')
        .select('id, miners(last_play_at)')
        .eq('miner_id', minerId)
        .eq('wallet', w)
        .single();

    if (!assignment) return { error: 'Assignment not found' };
    if (assignment.miners?.last_play_at) {
        return { error: 'Miner must be IDLE to unassign from land. Claim rewards first.' };
    }

    const { error: deleteErr } = await supabase.from('land_miners').delete().eq('miner_id', minerId).eq('wallet', w);
    if (deleteErr) return { error: `Failed to unassign: ${deleteErr.message}` };

    return { success: true };
}

// Start mining: idle miner → sets last_play_at = NOW, no reward yet
async function startMining(wallet, minerId) {
    const w = norm(wallet);
    const { data: miner } = await supabase.from('miners').select('*').eq('id', minerId).eq('wallet', w).single();

    if (!miner) return { error: 'Miner not found' };
    if (!miner.is_alive) return { error: 'Miner is dead. Repair it!' };
    if (miner.needs_repair) return { error: 'Miner needs repair!' };

    if (miner.last_play_at) {
        const elapsed = Date.now() - new Date(miner.last_play_at).getTime();
        if (elapsed < CONFIG.PLAY_COOLDOWN_MS) {
            const rem = CONFIG.PLAY_COOLDOWN_MS - elapsed;
            const h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000);
            return { error: `Already mining. Claim in ${h}h ${m}m`, cooldown: rem };
        }
        return { error: 'Miner is ready to claim, not idle.' };
    }

    await supabase.from('miners').update({ last_play_at: new Date().toISOString() }).eq('id', minerId);
    return { success: true, miningStarted: true };
}

// Claim reward: ready miner (24h passed) → gives reward, resets to idle
async function claimMiner(wallet, minerId) {
    const w = norm(wallet);
    const { data: miner } = await supabase.from('miners').select('*').eq('id', minerId).eq('wallet', w).single();

    if (!miner) return { error: 'Miner not found' };
    if (!miner.is_alive) return { error: 'Miner is dead. Repair it!' };
    if (miner.needs_repair) return { error: 'Miner needs repair!' };
    if (!miner.last_play_at) return { error: 'Miner is idle. Start mining first!' };

    const elapsed = Date.now() - new Date(miner.last_play_at).getTime();
    if (elapsed < CONFIG.PLAY_COOLDOWN_MS) {
        const rem = CONFIG.PLAY_COOLDOWN_MS - elapsed;
        const h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000), s = Math.floor((rem % 60000) / 1000);
        return { error: `Wait ${h}h ${m}m ${s}s`, cooldown: rem };
    }

    // Apply land boost if miner is assigned to a land
    const { data: landAsgn } = await supabase.from('land_miners').select('land_id').eq('miner_id', minerId).single();
    let boostPercent = 0;
    if (landAsgn) {
        const { data: land } = await supabase.from('lands').select('boost_percent').eq('id', landAsgn.land_id).single();
        if (land) boostPercent = land.boost_percent;
    }
    const reward = Math.round(miner.daily_digcoin * (1 + boostPercent / 100) * 100) / 100;
    // Season 3 (Weremole) miners are permanent — age never decrements
    const newAge = miner.season === 3 ? miner.nft_age_remaining : miner.nft_age_remaining - 1;
    const isDead = miner.season === 3 ? false : newAge <= 0;

    // Atomic miner state transition: only succeeds if last_play_at is still set.
    // This prevents double-claim from concurrent requests (second update finds last_play_at=null → 0 rows → rejected).
    const { data: minerUpdated } = await supabase.from('miners')
        .update({
            nft_age_remaining: newAge, is_alive: !isDead, needs_repair: isDead,
            last_play_at: null, exp: miner.exp + Math.floor(reward),
        })
        .eq('id', minerId)
        .not('last_play_at', 'is', null) // guard: only claim if still in mining state
        .select('id');

    if (!minerUpdated?.length) return { error: 'Reward already claimed (concurrent request)' };

    // Atomic relative increment — no stale-read risk (RPC does UPDATE SET col=col+delta)
    const { error: rewardErr } = await supabase.rpc('add_digcoin', {
        p_wallet: w,
        p_amount: reward,
        p_earned_digcoin: reward,
    });
    if (rewardErr) {
        console.error(`❌ add_digcoin failed for claim ${w} miner ${minerId}: ${rewardErr.message} [code: ${rewardErr.code}]`);
        // Restore miner to claimable state so the user can retry
        await supabase.from('miners').update({ last_play_at: new Date().toISOString() }).eq('id', minerId);
        throw new Error(`Failed to credit reward: ${rewardErr.message}`);
    }

    await supabase.from('play_history').insert({ wallet: w, miner_id: minerId, reward_digcoin: reward });

    return { success: true, reward, nftAgeRemaining: newAge, minerDead: isDead, boostPercent };
}

// Play All: start all idle miners (last_play_at IS NULL)
async function playAll(wallet) {
    const w = norm(wallet);
    const [{ data: miners }, { data: perk }] = await Promise.all([
        supabase.from('miners').select('*').eq('wallet', w).eq('is_alive', true).eq('needs_repair', false).is('last_play_at', null),
        supabase.from('player_perks').select('active').eq('wallet', w).eq('perk_type', 'auto_pickaxe').maybeSingle(),
    ]);

    if (!miners?.length) return { error: 'No idle miners to start. All are mining or need repair.' };

    const feeWaived = perk?.active === true;
    const totalFee = feeWaived ? 0 : CONFIG.PLAY_ALL_FEE_DIGCOIN * miners.length;

    if (!feeWaived) {
        const { data: player } = await supabase.from('players').select('digcoin_balance').eq('wallet', w).single();
        if (player.digcoin_balance < totalFee) {
            return { error: `Insufficient balance. Need ${totalFee} DIGCOIN (${CONFIG.PLAY_ALL_FEE_DIGCOIN} per miner × ${miners.length} miners)` };
        }
        const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: totalFee });
        if (!ok) return { error: 'Insufficient balance (concurrent update conflict — try again)' };
    }

    const now = new Date().toISOString();
    const ids = miners.map(m => m.id);
    const { error: startErr } = await supabase.from('miners').update({ last_play_at: now }).in('id', ids);

    if (startErr) {
        if (!feeWaived) {
            const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: totalFee });
            if (refundErr) console.error(`❌ playAll REFUND FAILED for ${w} (${totalFee} DC): ${refundErr.message}`);
        }
        throw new Error(`Failed to start miners: ${startErr.message}`);
    }

    await supabase.from('activity_log').insert({
        wallet: w, type: 'play_all',
        detail: `Play All — started ${miners.length} miner${miners.length !== 1 ? 's' : ''}${feeWaived ? ' (Auto Pickaxe — fee waived)' : ''}`,
        amount_digcoin: totalFee,
    });

    return { success: true, started: miners.length, fee: totalFee, feeWaived };
}

// Claim All: collect from all ready miners (24h passed)
async function claimAll(wallet) {
    const w = norm(wallet);
    const [{ data: miners }, { data: perk }] = await Promise.all([
        supabase.from('miners').select('*').eq('wallet', w).eq('is_alive', true).eq('needs_repair', false).not('last_play_at', 'is', null),
        supabase.from('player_perks').select('active').eq('wallet', w).eq('perk_type', 'auto_pickaxe').maybeSingle(),
    ]);

    if (!miners?.length) return { error: 'No miners are mining' };

    const now = Date.now();
    const ready = miners.filter(m => (now - new Date(m.last_play_at).getTime()) >= CONFIG.PLAY_COOLDOWN_MS);

    if (!ready.length) return { error: 'No miners ready to claim yet. Come back in 24h!' };

    const feeWaived = perk?.active === true;
    const totalFee = feeWaived ? 0 : CONFIG.PLAY_ALL_FEE_DIGCOIN * ready.length;

    if (!feeWaived) {
        const { data: player } = await supabase.from('players').select('digcoin_balance').eq('wallet', w).single();
        if (player.digcoin_balance < totalFee) {
            return { error: `Insufficient balance for Claim All fee. Need ${totalFee} DIGCOIN (${CONFIG.PLAY_ALL_FEE_DIGCOIN} × ${ready.length} miners)` };
        }
        const { data: feeOk } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: totalFee });
        if (!feeOk) return { error: 'Insufficient balance for Claim All fee (concurrent update conflict — try again)' };
    }

    let totalReward = 0, claimed = 0, died = 0, failed = 0;
    const details = [];

    for (const miner of ready) {
        try {
            const result = await claimMiner(w, miner.id);
            if (result.success) {
                totalReward += result.reward;
                claimed++;
                if (result.minerDead) died++;
            } else {
                failed++;
            }
            details.push({ minerId: miner.id, rarityName: miner.rarity_name, ...result });
        } catch (claimErr) {
            failed++;
            console.error(`❌ claimAll: claimMiner failed for miner ${miner.id}: ${claimErr.message}`);
            details.push({ minerId: miner.id, rarityName: miner.rarity_name, error: claimErr.message });
        }
    }

    // Refund partial fee for miners that failed (only if fee was charged)
    const actualFee = feeWaived ? 0 : CONFIG.PLAY_ALL_FEE_DIGCOIN * claimed;
    if (!feeWaived) {
        const refund = totalFee - actualFee;
        if (refund > 0) {
            const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: refund });
            if (refundErr) console.error(`❌ claimAll REFUND FAILED for ${w} (${refund} DC): ${refundErr.message}`);
        }
    }

    if (claimed > 0) {
        await supabase.from('activity_log').insert({
            wallet: w, type: 'claim_all',
            detail: `Claim All — ${claimed} miner${claimed !== 1 ? 's' : ''} claimed, fee ${actualFee} DC, reward ${Math.round(totalReward * 100) / 100} DC${feeWaived ? ' (Auto Pickaxe — fee waived)' : ''}`,
            amount_digcoin: actualFee,
        });
    }

    return {
        totalReward: Math.round(totalReward * 100) / 100,
        claimAllFee: actualFee,
        netReward: Math.round((totalReward - actualFee) * 100) / 100,
        claimed, died, failed, details, feeWaived,
    };
}

async function repairMiner(wallet, minerId) {
    const w = norm(wallet);
    const { data: miner } = await supabase.from('miners').select('*').eq('id', minerId).eq('wallet', w).single();

    if (!miner) return { error: 'Miner not found' };
    if (miner.season === 3) return { error: 'Weremole miners never need repair.' };
    if (miner.is_alive && !miner.needs_repair) return { error: 'Miner does not need repair' };

    const rarityConfig = miner.season === 2 ? CONFIG.S2_RARITIES : CONFIG.RARITIES;
    const rarity = rarityConfig[miner.rarity_id];
    const fusedMultiplier = miner.is_fused ? 2 : 1;
    const repairPathUSD = rarity.repairPathUSD * fusedMultiplier;
    const cost = repairPathUSD * CONFIG.DIGCOIN_PER_PATHUSD;

    const { data: player } = await supabase.from('players').select('digcoin_balance, total_spent_digcoin').eq('wallet', w).single();
    if (player.digcoin_balance < cost) {
        return { error: `Insufficient balance. Repair costs ${cost} DIGCOIN (${repairPathUSD} pathUSD)${miner.is_fused ? ' — fused miner rate' : ''}` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: repairOk } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!repairOk) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const { error: minerUpdateErr } = await supabase.from('miners').update({
        nft_age_remaining: rarity.nftAge, nft_age_total: rarity.nftAge, is_alive: true, needs_repair: false,
        hp: rarity.maxHp,
    }).eq('id', minerId);

    if (minerUpdateErr) {
        // Refund since the miner was not actually repaired
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ repair REFUND FAILED for ${w} miner ${minerId} (${cost} DC): ${refundErr.message}`);
        throw new Error(`Failed to repair miner: ${minerUpdateErr.message}`);
    }

    await supabase.from('repairs').insert({ wallet: w, miner_id: minerId, cost_digcoin: cost });

    return { success: true, costDigcoin: cost, costPathUSD: repairPathUSD };
}

// ════════════════════════════════════════════
// EIP-712 SIGNATURE (WITHDRAW)
// ════════════════════════════════════════════

const DOMAIN = { name: 'MinerPool', version: '1', chainId: CONFIG.CHAIN_ID, verifyingContract: CONFIG.POOL_CONTRACT };
const WITHDRAW_TYPES = {
    Withdraw: [
        { name: 'player', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ],
};

async function generateWithdrawSignature(wallet, amountPathUSD) {
    const w = norm(wallet);
    const signerWallet = new ethers.Wallet(CONFIG.SIGNER_PRIVATE_KEY);
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const pool = new ethers.Contract(CONFIG.POOL_CONTRACT, ['function getNonce(address) view returns (uint256)'], provider);
    const nonce = await pool.getNonce(w);
    const deadline = Math.floor(Date.now() / 1000) + CONFIG.SIGNATURE_DEADLINE_SECS;
    const amountWei = ethers.parseUnits(amountPathUSD.toFixed(CONFIG.PATHUSD_DECIMALS), CONFIG.PATHUSD_DECIMALS);
    const signature = await signerWallet.signTypedData(DOMAIN, WITHDRAW_TYPES, { player: w, amount: amountWei, nonce, deadline });
    return { amount: amountWei.toString(), nonce: nonce.toString(), deadline, signature };
}

// ════════════════════════════════════════════
// EVENT LISTENER
// ════════════════════════════════════════════

async function startEventListener() {
    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const iface = new ethers.Interface([
            'event Deposited(address indexed player, uint256 amount, uint256 timestamp)',
            'event Withdrawn(address indexed player, uint256 amount, uint256 fee, uint256 nonce, uint256 timestamp)',
        ]);
        const depositTopic = iface.getEvent('Deposited').topicHash;
        const withdrawTopic = iface.getEvent('Withdrawn').topicHash;

        let lastBlock = await provider.getBlockNumber();
        console.log(`🔗 Event poller started at block ${lastBlock}`);

        const poll = async () => {
            try {
                const current = await provider.getBlockNumber();
                if (current > lastBlock) {
                    const logs = await provider.getLogs({
                        address: CONFIG.POOL_CONTRACT,
                        fromBlock: lastBlock + 1,
                        toBlock: current,
                        topics: [[depositTopic, withdrawTopic]],
                    });
                    for (const log of logs) {
                        const parsed = iface.parseLog(log);
                        if (parsed.name === 'Deposited') {
                            const amt = parseFloat(ethers.formatUnits(parsed.args.amount, CONFIG.PATHUSD_DECIMALS));
                            console.log(`💰 On-chain Deposit: ${amt} pathUSD from ${parsed.args.player}`);
                            await processDeposit(parsed.args.player, amt, log.transactionHash);
                        } else if (parsed.name === 'Withdrawn') {
                            const amt = parseFloat(ethers.formatUnits(parsed.args.amount, CONFIG.PATHUSD_DECIMALS));
                            console.log(`🏧 On-chain Withdraw: ${amt} pathUSD to ${parsed.args.player}`);
                        }
                    }
                    lastBlock = current;
                }
            } catch (e) {
                console.error('⚠️  Poll error:', e.message);
            }
            setTimeout(poll, 10000); // poll every 10s
        };

        poll();
    } catch (err) {
        console.error('❌ Listener init error:', err.message);
        setTimeout(startEventListener, 30000);
    }
}

// ════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════

// Auth: issue a nonce for a wallet to sign
app.get('/api/nonce/:wallet', (req, res) => {
    const raw = req.params.wallet;
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address' });
    const w = norm(raw);

    // Rate limit: 1 nonce per 15 seconds per wallet
    const last = nonceRateLimit.get(w);
    if (last && Date.now() - last < 15_000) return res.status(429).json({ error: 'Too many nonce requests — wait 15 seconds' });
    nonceRateLimit.set(w, Date.now());

    const nonce = crypto.randomBytes(16).toString('hex');
    nonceStore.set(w, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
    const message = `DigMiner auth\nWallet: ${w}\nNonce: ${nonce}`;
    res.json({ nonce, message });
});

// Auth: verify signed nonce → return session token (valid 24 h)
app.post('/api/auth', (req, res) => {
    try {
        const { wallet, signature } = req.body;
        if (!wallet || !signature) return res.status(400).json({ error: 'wallet and signature required' });
        if (!isValidAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
        const w = norm(wallet);
        const stored = nonceStore.get(w);
        if (!stored || stored.expiresAt < Date.now()) return res.status(401).json({ error: 'Nonce expired — request a new one' });
        const message = `DigMiner auth\nWallet: ${w}\nNonce: ${stored.nonce}`;
        let recovered;
        try { recovered = ethers.verifyMessage(message, signature).toLowerCase(); } catch (_) { return res.status(401).json({ error: 'Invalid signature' }); }
        if (recovered !== w) return res.status(401).json({ error: 'Signature does not match wallet' });
        nonceStore.delete(w); // one-time use
        const token = crypto.randomBytes(32).toString('hex');
        sessionStore.set(token, { wallet: w, expiresAt: Date.now() + SESSION_TTL_MS });
        res.json({ success: true, token, expiresIn: SESSION_TTL_MS });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Player info — read-only, does NOT create accounts (creation happens via /api/register)
app.get('/api/player/:wallet', async (req, res) => {
    try {
        const raw = req.params.wallet;
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address' });
        const w = norm(raw);
        const { data: player } = await supabase.from('players').select('*').eq('wallet', w).single();
        if (!player) return res.status(404).json({ error: 'Player not found' });
        const [{ data: miners }, { data: perkData }, { data: boxSpend }, { data: landSpend }, { data: repairSpend }, { data: actSpend }] = await Promise.all([
            supabase.from('miners').select('*').eq('wallet', w).order('created_at', { ascending: false }),
            supabase.from('player_perks').select('active').eq('wallet', w).eq('perk_type', 'auto_pickaxe').maybeSingle(),
            supabase.from('box_purchases').select('cost_digcoin').eq('wallet', w),
            supabase.from('land_purchases').select('cost_digcoin').eq('wallet', w),
            supabase.from('repairs').select('cost_digcoin').eq('wallet', w),
            supabase.from('activity_log').select('amount_digcoin').eq('wallet', w),
        ]);
        const totalSpentDigcoin =
            (boxSpend    || []).reduce((s, r) => s + (r.cost_digcoin   || 0), 0) +
            (landSpend   || []).reduce((s, r) => s + (r.cost_digcoin   || 0), 0) +
            (repairSpend || []).reduce((s, r) => s + (r.cost_digcoin   || 0), 0) +
            (actSpend    || []).reduce((s, r) => s + (r.amount_digcoin || 0), 0);

        const now = Date.now();
        const WEREMOLE_RARITY_FALLBACK = { repairPathUSD: 0, maxHp: 100, color: '#8B4513' };
        const THIEFCAT_RARITY = { repairPathUSD: 0.30, maxHp: 100, color: '#FF6B35' };
        const mapped = (miners || []).map(m => {
            const rarity = m.season === 4 ? THIEFCAT_RARITY : m.season === 3 ? WEREMOLE_RARITY_FALLBACK : (CONFIG.RARITIES[m.rarity_id] || CONFIG.S2_RARITIES[m.rarity_id] || WEREMOLE_RARITY_FALLBACK);
            const healthy = m.is_alive && !m.needs_repair;
            let isIdle = false, isMining = false, canClaim = false, cooldownRemaining = 0;
            if (healthy) {
                if (!m.last_play_at) {
                    isIdle = true;
                } else {
                    const elapsed = now - new Date(m.last_play_at).getTime();
                    if (elapsed >= CONFIG.PLAY_COOLDOWN_MS) {
                        canClaim = true;
                    } else {
                        isMining = true;
                        cooldownRemaining = CONFIG.PLAY_COOLDOWN_MS - elapsed;
                    }
                }
            }
            return {
                id: m.id, rarityId: m.rarity_id, rarityName: m.rarity_name,
                dailyDigcoin: m.daily_digcoin, nftAgeTotal: m.nft_age_total, nftAgeRemaining: m.nft_age_remaining,
                isAlive: m.is_alive, needsRepair: m.needs_repair, isFused: !!m.is_fused, season: m.season || 1,
                isIdle, isMining, canClaim,
                canPlay: canClaim, // backward compat alias
                cooldownRemaining,
                miningEndsAt: m.last_play_at ? new Date(m.last_play_at).getTime() + CONFIG.PLAY_COOLDOWN_MS : null,
                level: m.level, exp: m.exp, power: m.power, energy: m.energy, protective: m.protective, damage: m.damage,
                hp: m.hp ?? 100, maxHp: m.max_hp ?? 100,
                lastDungeonAt: m.last_dungeon_at,
                lastDungeonType: m.last_dungeon_type || null,
                dungeonCooldownRemaining: m.last_dungeon_at ? Math.max(0, CONFIG.DUNGEON_COOLDOWN_MS - (Date.now() - new Date(m.last_dungeon_at).getTime())) : 0,
                repairCostDigcoin: rarity.repairPathUSD * (m.is_fused ? 2 : 1) * CONFIG.DIGCOIN_PER_PATHUSD,
                repairCostPathUSD: rarity.repairPathUSD * (m.is_fused ? 2 : 1), color: rarity.color,
            };
        });

        const alive = mapped.filter(m => m.isAlive && !m.needsRepair);
        res.json({
            player: {
                wallet: w, digcoinBalance: player.digcoin_balance,
                totalDepositedPathUSD: player.total_deposited_pathusd,
                totalWithdrawnPathUSD: player.total_withdrawn_pathusd,
                totalEarnedDigcoin: player.total_earned_digcoin,
                totalSpentDigcoin: Math.round(totalSpentDigcoin),
                boxesBought: player.boxes_bought,
                referralLink: `${req.protocol}://${req.get('host')}?ref=${w}`,
                referralEarnings: player.referral_earnings, referrer: player.referrer,
            },
            miners: mapped,
            stats: { totalMiners: mapped.length, aliveMiners: alive.length, dailyIncome: alive.reduce((s, m) => s + m.dailyDigcoin, 0) },
            autoPickaxe: perkData ? { owned: true, active: perkData.active } : { owned: false, active: false },
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Register with referral (called on first connect to attach referrer)
app.post('/api/register', requireAuth, async (req, res) => {
    try {
        const { wallet, referrer } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        if (!isValidAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
        if (referrer && !isValidAddress(referrer)) return res.status(400).json({ error: 'Invalid referrer address' });
        const player = await getOrCreatePlayer(wallet, referrer);
        res.json({ success: true, player });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deposit — requires txHash and verifies on-chain before crediting
app.post('/api/deposit', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, amountPathUSD, txHash } = req.body;
        if (!wallet || !amountPathUSD) return res.status(400).json({ error: 'wallet and amountPathUSD required' });
        if (!txHash) return res.status(400).json({ error: 'txHash required — deposit must originate from on-chain transaction' });

        // Verify txHash is a real Deposited event from our contract
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const iface = new ethers.Interface(['event Deposited(address indexed player, uint256 amount, uint256 timestamp)']);
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        if (!receipt) return res.status(400).json({ error: 'Transaction not found on-chain' });

        const depositLog = receipt.logs.find(log =>
            log.address.toLowerCase() === CONFIG.POOL_CONTRACT.toLowerCase() &&
            log.topics[0] === iface.getEvent('Deposited').topicHash
        );
        if (!depositLog) return res.status(400).json({ error: 'No Deposited event found in transaction' });

        const parsed = iface.parseLog(depositLog);
        const onChainWallet = parsed.args.player.toLowerCase();
        const onChainAmount = parseFloat(ethers.formatUnits(parsed.args.amount, CONFIG.PATHUSD_DECIMALS));

        if (onChainWallet !== wallet.toLowerCase()) return res.status(400).json({ error: 'Wallet mismatch — transaction belongs to a different address' });

        const result = await processDeposit(onChainWallet, onChainAmount, txHash);
        if (result.duplicate) return res.json({ success: true, duplicate: true, message: 'Already credited' });
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buy Box (1 or 10)
app.post('/api/box/buy', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, quantity } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const qty = quantity === 10 ? 10 : 1;
        const result = await buyBoxes(wallet, qty);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sale Box info (global sold + wallet bought)
app.get('/api/box/sale-info', async (req, res) => {
    try {
        const wallet = req.query.wallet || '';
        const counts = await getSaleBoxCounts(wallet);
        const now = Date.now();
        const isActive = now < CONFIG.SALE_BOX_END_TIME;
        res.json({
            totalSold: counts.totalSold,
            walletBought: counts.walletBought,
            maxTotal: CONFIG.SALE_BOX_MAX_TOTAL,
            maxPerWallet: CONFIG.SALE_BOX_MAX_PER_WALLET,
            price: CONFIG.SALE_BOX_PRICE_DIGCOIN,
            globalRemaining: Math.max(0, CONFIG.SALE_BOX_MAX_TOTAL - counts.totalSold),
            walletRemaining: Math.max(0, CONFIG.SALE_BOX_MAX_PER_WALLET - counts.walletBought),
            endTime: CONFIG.SALE_BOX_END_TIME,
            isActive,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buy Sale Box (limited 50% off)
app.post('/api/box/buy-sale', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, quantity } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const qty = Math.max(1, Math.min(parseInt(quantity) || 1, CONFIG.SALE_BOX_MAX_PER_WALLET));
        const result = await buySaleBoxes(wallet, qty);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/box/buy-s2', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        if (Date.now() < S2_LAUNCH_AT_MS) {
            const secsLeft = Math.ceil((S2_LAUNCH_AT_MS - Date.now()) / 1000);
            return res.status(400).json({ error: `Season 2 has not launched yet. Available in ${secsLeft} seconds.` });
        }
        const { wallet, quantity } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const qty = Math.max(1, Math.min(parseInt(quantity) || 1, 100));
        const result = await buyS2Boxes(wallet, qty);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fuse 2 miners → 1 new miner
app.post('/api/miner/fuse', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, minerId1, minerId2 } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const id1 = parseInt(minerId1), id2 = parseInt(minerId2);
        if (!isValidMinerId(id1) || !isValidMinerId(id2)) return res.status(400).json({ error: 'Invalid miner IDs' });
        const result = await fuseMiner(wallet, id1, id2);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mine single miner (idle → start 24h cycle)
app.post('/api/play/:minerId', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const minerId = parseInt(req.params.minerId);
        if (!isValidMinerId(minerId)) return res.status(400).json({ error: 'Invalid miner ID' });
        const result = await startMining(wallet, minerId);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim single miner (ready → collect reward → back to idle)
app.post('/api/claim/:minerId', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const minerId = parseInt(req.params.minerId);
        if (!isValidMinerId(minerId)) return res.status(400).json({ error: 'Invalid miner ID' });
        const result = await claimMiner(wallet, minerId);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Play All: start all idle miners (fee per miner)
app.post('/api/play-all', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await playAll(wallet);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim All: collect from all ready miners (fee per miner)
app.post('/api/claim-all', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await claimAll(wallet);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Repair
app.post('/api/repair/:minerId', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const minerId = parseInt(req.params.minerId);
        if (!isValidMinerId(minerId)) return res.status(400).json({ error: 'Invalid miner ID' });
        const result = await repairMiner(wallet, minerId);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buy Auto Pickaxe (lifetime perk)
app.post('/api/buy-auto-pickaxe', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet || !isValidAddress(wallet)) return res.status(400).json({ error: 'wallet required' });
        const w = norm(wallet);

        const [{ count: supply }, { data: existing }] = await Promise.all([
            supabase.from('player_perks').select('*', { count: 'exact', head: true }).eq('perk_type', 'auto_pickaxe'),
            supabase.from('player_perks').select('id').eq('wallet', w).eq('perk_type', 'auto_pickaxe').maybeSingle(),
        ]);

        if ((supply || 0) >= CONFIG.AUTO_PICKAXE_MAX_SUPPLY) return res.status(400).json({ error: `Auto Pickaxe sold out! (${CONFIG.AUTO_PICKAXE_MAX_SUPPLY}/${CONFIG.AUTO_PICKAXE_MAX_SUPPLY})` });
        if (existing) return res.status(400).json({ error: 'You already own an Auto Pickaxe!' });

        const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: CONFIG.AUTO_PICKAXE_PRICE });
        if (!ok) return res.status(400).json({ error: `Insufficient balance. Auto Pickaxe costs ${CONFIG.AUTO_PICKAXE_PRICE} DIGCOIN` });

        // Post-deduction re-check to close race window on supply cap
        const { count: supplyNow } = await supabase.from('player_perks').select('*', { count: 'exact', head: true }).eq('perk_type', 'auto_pickaxe');
        if ((supplyNow || 0) >= CONFIG.AUTO_PICKAXE_MAX_SUPPLY) {
            await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: CONFIG.AUTO_PICKAXE_PRICE });
            return res.status(400).json({ error: `Auto Pickaxe sold out — balance restored.` });
        }

        const { error: insertErr } = await supabase.from('player_perks').insert({ wallet: w, perk_type: 'auto_pickaxe', active: true });
        if (insertErr) {
            await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: CONFIG.AUTO_PICKAXE_PRICE });
            throw new Error(`Failed to grant perk: ${insertErr.message}`);
        }

        await supabase.from('activity_log').insert({
            wallet: w, type: 'auto_pickaxe_purchase',
            detail: `Purchased Auto Pickaxe (lifetime)`,
            amount_digcoin: CONFIG.AUTO_PICKAXE_PRICE,
        });

        res.json({ success: true, autoPickaxe: { owned: true, active: true } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle Auto Pickaxe on/off
app.post('/api/toggle-auto-pickaxe', requireAuth, async (req, res) => {
    try {
        const { wallet, active } = req.body;
        if (!wallet || !isValidAddress(wallet)) return res.status(400).json({ error: 'wallet required' });
        if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
        const w = norm(wallet);

        const { data: existing } = await supabase.from('player_perks').select('id').eq('wallet', w).eq('perk_type', 'auto_pickaxe').maybeSingle();
        if (!existing) return res.status(400).json({ error: 'You do not own an Auto Pickaxe' });

        await supabase.from('player_perks').update({ active }).eq('wallet', w).eq('perk_type', 'auto_pickaxe');
        res.json({ success: true, autoPickaxe: { owned: true, active } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Withdraw
app.post('/api/withdraw', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, amountDigcoin } = req.body;
        if (!wallet || !amountDigcoin) return res.status(400).json({ error: 'wallet and amountDigcoin required' });
        const w = norm(wallet);
        const { data: player } = await supabase.from('players').select('digcoin_balance, total_withdrawn_pathusd').eq('wallet', w).single();
        const amount = parseFloat(amountDigcoin);
        const MIN_WITHDRAW = 100; // 1 pathUSD minimum
        if (isNaN(amount) || amount < MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} DIGCOIN (1 pathUSD)` });
        if (amount > player.digcoin_balance) return res.status(400).json({ error: `Insufficient balance. Have ${player.digcoin_balance.toFixed(2)} DIGCOIN` });

        // Check player has enough pathUSD on-chain to cover gas fees (pathUSD is gas token on Tempo)
        const MIN_GAS_RESERVE = ethers.parseUnits('0.5', CONFIG.PATHUSD_DECIMALS);
        try {
            const _provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
            const pathUSDToken = new ethers.Contract(
                '0x20C0000000000000000000000000000000000000',
                ['function balanceOf(address) view returns (uint256)'],
                _provider
            );
            const onChainBalance = await pathUSDToken.balanceOf(w);
            if (onChainBalance < MIN_GAS_RESERVE) {
                const bal = ethers.formatUnits(onChainBalance, CONFIG.PATHUSD_DECIMALS);
                return res.status(400).json({ error: `Insufficient pathUSD for gas fees. You need at least 0.5 pathUSD in your wallet to cover the transaction fee. Current balance: ${bal} pathUSD` });
            }
        } catch (gasCheckErr) {
            console.warn('⚠️ Gas check failed (non-blocking):', gasCheckErr.message);
        }

        const COOLDOWN_MS = 24 * 60 * 60 * 1000;

        // Initial cooldown check (fast-path rejection for obvious cases)
        const { data: lastWithdraw } = await supabase.from('withdrawals')
            .select('created_at').eq('wallet', w).neq('status', 'cancelled')
            .order('created_at', { ascending: false }).limit(1);
        if (lastWithdraw?.length) {
            const elapsed = Date.now() - new Date(lastWithdraw[0].created_at).getTime();
            if (elapsed < COOLDOWN_MS) {
                const rem = COOLDOWN_MS - elapsed;
                const h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000);
                return res.status(400).json({ error: `Withdraw cooldown: wait ${h}h ${m}m`, cooldownMs: rem });
            }
        }

        const amountPathUSD = amount / CONFIG.DIGCOIN_PER_PATHUSD;
        const fee = amountPathUSD * (CONFIG.WITHDRAW_FEE_PERCENT / 100);
        const net = amountPathUSD - fee;

        // INSERT "pending" record FIRST — this is the atomic lock that closes the race window.
        // Any concurrent request that checks cooldown AFTER this point will see this record and be blocked.
        const { data: pending, error: pendingErr } = await supabase.from('withdrawals')
            .insert({ wallet: w, amount_digcoin: amount, amount_pathusd: amountPathUSD, fee_pathusd: fee, net_pathusd: net, nonce: 0, status: 'pending' })
            .select('id').single();

        if (pendingErr || !pending) {
            return res.status(500).json({ error: 'Failed to reserve withdrawal slot — please try again' });
        }

        // Re-check cooldown to catch concurrent requests that slipped through the initial check.
        // Look for any non-cancelled withdrawal in the last 24h OTHER than the one we just inserted.
        const { data: recheck } = await supabase.from('withdrawals')
            .select('id, created_at').eq('wallet', w).neq('status', 'cancelled').neq('id', pending.id)
            .order('created_at', { ascending: false }).limit(1);

        if (recheck?.length) {
            const elapsed = Date.now() - new Date(recheck[0].created_at).getTime();
            if (elapsed < COOLDOWN_MS) {
                // Race detected — cancel our pending record and return cooldown error
                await supabase.from('withdrawals').update({ status: 'cancelled' }).eq('id', pending.id);
                const rem = COOLDOWN_MS - elapsed;
                const h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000);
                return res.status(400).json({ error: `Withdraw cooldown: wait ${h}h ${m}m`, cooldownMs: rem });
            }
        }

        // Atomic relative deduction — safe against concurrent double-spend
        const { data: withdrawOk } = await supabase.rpc('spend_digcoin', {
            p_wallet: w, p_amount: amount, p_withdrawn_pathusd: net,
        });
        if (!withdrawOk) {
            await supabase.from('withdrawals').update({ status: 'cancelled' }).eq('id', pending.id);
            return res.status(400).json({ error: 'Insufficient balance (concurrent update conflict — try again)' });
        }

        // Generate signature — if this fails, restore balance and cancel the pending record
        let sigData;
        try {
            sigData = await generateWithdrawSignature(w, amountPathUSD);
        } catch (sigErr) {
            // Undo the atomic deduction: add back balance and reverse the withdrawal stat
            const { error: refundErr } = await supabase.rpc('add_digcoin', {
                p_wallet: w,
                p_amount: amount,
                p_withdrawn_pathusd: -net,
            });
            if (refundErr) console.error(`❌ withdraw REFUND FAILED for ${w} (${amount} DC): ${refundErr.message}`);
            await supabase.from('withdrawals').update({ status: 'cancelled' }).eq('id', pending.id);
            console.error(`❌ Withdraw signature failed for ${w}, balance restored:`, sigErr.message);
            return res.status(500).json({ error: 'Failed to generate withdrawal signature — balance restored, please try again' });
        }

        // Promote pending → ready with the real nonce
        await supabase.from('withdrawals')
            .update({ nonce: parseInt(sigData.nonce), status: 'ready' })
            .eq('id', pending.id);

        res.json({ success: true, amountDigcoin: amount, amountPathUSD, feePathUSD: fee, netPathUSD: net, signature: sigData });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// History — auth required so users can only see their own data
app.get('/api/history/:wallet', requireAuth, async (req, res) => {
    try {
        const w = norm(req.params.wallet);
        if (req.authWallet !== w) return res.status(403).json({ error: 'Cannot view history of another wallet' });
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const [
            { data: plays }, { data: deps }, { data: withs }, { data: boxes },
            { data: repairs }, { data: landBuys }, { data: actLog },
        ] = await Promise.all([
            supabase.from('play_history').select('*').eq('wallet', w).order('played_at', { ascending: false }).limit(limit),
            supabase.from('deposits').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit),
            supabase.from('withdrawals').select('*').eq('wallet', w).eq('status', 'ready').order('created_at', { ascending: false }).limit(limit),
            supabase.from('box_purchases').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit),
            supabase.from('repairs').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit),
            supabase.from('land_purchases').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit),
            supabase.from('activity_log').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit),
        ]);

        const txs = [
            ...(plays    || []).map(p => ({ type: 'claim',      detail: `Claim Miner #${p.miner_id} → +${p.reward_digcoin} DC`,                                                      amount:  p.reward_digcoin,  date: p.played_at    })),
            ...(deps     || []).map(d => ({ type: 'deposit',    detail: `Deposit ${d.amount_pathusd} pathUSD → +${d.digcoin_credited} DC`,                                            amount:  d.digcoin_credited, date: d.created_at   })),
            ...(withs    || []).map(w => ({ type: 'withdraw',   detail: `Withdraw ${w.amount_digcoin} DC → ${w.net_pathusd} pathUSD (fee: ${w.fee_pathusd})`,                         amount: -w.amount_digcoin,  date: w.created_at   })),
            ...(boxes    || []).map(b => ({ type: 'box',        detail: `Buy Miner Box → Miner #${b.miner_id}${b.box_type === 'sale' ? ' (Sale)' : ''}`,                             amount: -b.cost_digcoin,    date: b.created_at   })),
            ...(repairs  || []).map(r => ({ type: 'repair',     detail: `Repair Miner #${r.miner_id}`,                                                                               amount: -r.cost_digcoin,    date: r.created_at   })),
            ...(landBuys || []).map(l => ({ type: 'land',       detail: `Buy Land Box${l.land_id ? ` → Land #${l.land_id}` : ''}`,                                                  amount: -l.cost_digcoin,    date: l.created_at   })),
            ...(actLog   || []).map(a => ({ type: a.type,       detail: a.detail,                                                                                                    amount: -a.amount_digcoin,  date: a.created_at   })),
        ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

        res.json({ transactions: txs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// DUNGEON SYSTEM
// ════════════════════════════════════════════

// Buy dungeon maps
app.post('/api/dungeon/buy-map', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, mapType, quantity = 1 } = req.body;
        if (!wallet || !isValidAddress(wallet)) return res.status(400).json({ error: 'wallet required' });
        if (mapType === 'map_weremole' && Date.now() < S2_LAUNCH_AT_MS) {
            const secsLeft = Math.ceil((S2_LAUNCH_AT_MS - Date.now()) / 1000);
            return res.status(400).json({ error: `Weremole Lair has not opened yet. Available in ${secsLeft} seconds.` });
        }
        const w = norm(wallet);
        const mapDef = CONFIG.DUNGEON_MAPS[mapType];
        if (!mapDef) return res.status(400).json({ error: 'Invalid map type. Use: map_easy, map_medium, map_hard, map_weremole' });
        const qty = parseInt(quantity);
        if (isNaN(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Quantity must be between 1 and 50' });

        const totalCost = mapDef.price * qty;
        const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: totalCost });
        if (!ok) return res.status(400).json({ error: `Insufficient balance. ${qty}x ${mapDef.name} costs ${totalCost} DC` });

        // Upsert inventory
        const { error: invErr } = await supabase.rpc('add_inventory_item', { p_wallet: w, p_item_type: mapType, p_quantity: qty });
        if (invErr) {
            await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: totalCost });
            throw new Error(`Failed to add maps to inventory: ${invErr.message}`);
        }

        // Feed dungeon pool
        await supabase.rpc('add_dungeon_pool', { p_amount: totalCost });

        await supabase.from('activity_log').insert({
            wallet: w, type: 'buy_map',
            detail: `Bought ${qty}x ${mapDef.name}`,
            amount_digcoin: totalCost,
        });

        const { data: inv } = await supabase.from('inventory').select('item_type, quantity').eq('wallet', w);
        res.json({ success: true, cost: totalCost, inventory: inv || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Run dungeon
app.post('/api/dungeon/run', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, minerId, dungeonType } = req.body;
        if (!wallet || !isValidAddress(wallet)) return res.status(400).json({ error: 'wallet required' });
        if (!minerId || !dungeonType) return res.status(400).json({ error: 'minerId and dungeonType required' });
        const w = norm(wallet);
        const mid = parseInt(minerId);
        if (!isValidMinerId(mid)) return res.status(400).json({ error: 'Invalid miner ID' });

        const dungeon = CONFIG.DUNGEONS[dungeonType];
        if (!dungeon) return res.status(400).json({ error: 'Invalid dungeon type.' });

        // Fetch miner and player
        const [{ data: miner }, { data: player }, { data: invRow }] = await Promise.all([
            supabase.from('miners').select('*').eq('id', mid).eq('wallet', w).single(),
            supabase.from('players').select('digcoin_balance').eq('wallet', w).single(),
            supabase.from('inventory').select('quantity').eq('wallet', w).eq('item_type', dungeon.mapItem).maybeSingle(),
        ]);

        if (!miner) return res.status(404).json({ error: 'Miner not found' });
        if (!miner.is_alive) return res.status(400).json({ error: 'Miner is dead' });
        if (miner.needs_repair) return res.status(400).json({ error: 'Miner needs repair before entering dungeon' });
        if (miner.last_play_at) return res.status(400).json({ error: 'Miner is currently mining. Claim first.' });
        if (dungeon.weremoleDungeon && miner.season !== 2) return res.status(400).json({ error: 'Only Season 2 miners can enter the Weremole Lair.' });


        const mapQty = invRow?.quantity || 0;
        if (mapQty < 1) return res.status(400).json({ error: `No ${dungeon.name} maps in inventory. Buy maps first.` });

        // Cooldown check
        if (miner.last_dungeon_at) {
            const elapsed = Date.now() - new Date(miner.last_dungeon_at).getTime();
            if (elapsed < CONFIG.DUNGEON_COOLDOWN_MS) {
                const remaining = Math.ceil((CONFIG.DUNGEON_COOLDOWN_MS - elapsed) / 1000);
                return res.status(400).json({ error: `Dungeon cooldown active. Try again in ${remaining} seconds.`, cooldownRemaining: remaining * 1000 });
            }
        }

        // Check dungeon pool has enough to cover the prize (skip for weremole — no DC prize)
        if (!dungeon.weremoleDungeon) {
            const { data: poolRow } = await supabase.from('dungeon_pool').select('balance_digcoin').eq('id', 1).single();
            const poolBalance = parseFloat(poolRow?.balance_digcoin || 0);
            if (poolBalance < dungeon.prize) {
                return res.status(400).json({ error: `Dungeon temporarily closed — prize pool is refilling. Check back soon!` });
            }
        }

        // Consume map
        const { error: mapErr } = await supabase.rpc('spend_inventory_item', { p_wallet: w, p_item_type: dungeon.mapItem, p_quantity: 1 });
        if (mapErr) return res.status(400).json({ error: 'Failed to consume map. Try again.' });

        // Post-consumption re-check — guards against concurrent winners draining the pool (skip for weremole)
        if (!dungeon.weremoleDungeon) {
            const { data: poolRecheck } = await supabase.from('dungeon_pool').select('balance_digcoin').eq('id', 1).single();
            if (parseFloat(poolRecheck?.balance_digcoin || 0) < dungeon.prize) {
                await supabase.rpc('add_inventory_item', { p_wallet: w, p_item_type: dungeon.mapItem, p_quantity: 1 });
                return res.status(400).json({ error: 'Dungeon temporarily closed — prize pool is refilling. Map returned to inventory.' });
            }
        }

        // S2 dungeon buffs
        const s2Buff = miner.season === 2 ? (CONFIG.S2_DUNGEON_BUFFS[miner.rarity_id] || null) : null;
        const finalWinChance = dungeon.weremoleDungeon ? dungeon.winChance
            : Math.min(0.95, dungeon.winChance + (s2Buff?.winBonus || 0));

        const roll = Math.random();
        const won = roll < finalWinChance;

        let rewardDigcoin = 0;
        let boxDropped = false;
        let hpLost = 0;
        let newHp = miner.hp ?? 100;
        let needsRepair = false;
        let mapRecovered = false;

        let weremoleMiner = null;
        if (won) {
            if (dungeon.weremoleDungeon) {
                // Prize is a permanent Weremole miner (season=3), no DC awarded
                const { data: newWeremole } = await supabase.from('miners').insert({
                    wallet: w,
                    rarity_id: 7,
                    rarity_name: 'Weremole',
                    daily_digcoin: 30,
                    nft_age_total: 9999,
                    nft_age_remaining: 9999,
                    hp: 100,
                    max_hp: 100,
                    season: 3,
                    is_alive: true,
                    needs_repair: false,
                    level: 1,
                    exp: 0,
                    power: 999,
                    energy: 999,
                    protective: 999,
                    damage: 99,
                }).select().single();
                weremoleMiner = newWeremole;
            } else {
                rewardDigcoin = dungeon.prize;
                const effectiveBoxChance = dungeon.boxDropChance * (s2Buff?.boxMultiplier || 1);
                const boxRoll = Math.random();
                boxDropped = boxRoll < effectiveBoxChance;

                // Legendary/Mythic: chance to recover map
                if (s2Buff?.mapRecovery && Math.random() < s2Buff.mapRecovery) {
                    await supabase.rpc('add_inventory_item', { p_wallet: w, p_item_type: dungeon.mapItem, p_quantity: 1 });
                    mapRecovered = true;
                }

                // Award prize from dungeon pool
                await supabase.rpc('spend_dungeon_pool', { p_amount: rewardDigcoin });
                await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: rewardDigcoin });

                if (boxDropped) {
                    const boxRarity = rollRarity();
                    const dailyDigcoin = Math.floor(boxRarity.dailyMin + Math.random() * (boxRarity.dailyMax - boxRarity.dailyMin + 1));
                    const stats = generateStats(boxRarity);
                    const { data: newMiner } = await supabase.from('miners').insert({
                        wallet: w, rarity_id: boxRarity.id, rarity_name: boxRarity.name,
                        daily_digcoin: dailyDigcoin, nft_age_total: boxRarity.nftAge, nft_age_remaining: boxRarity.nftAge,
                        hp: boxRarity.maxHp, max_hp: boxRarity.maxHp,
                        ...stats,
                    }).select().single();
                    if (newMiner) {
                        await supabase.from('box_purchases').insert({ wallet: w, miner_id: newMiner.id, cost_digcoin: 0 });
                    }
                }
            }
        } else {
            // Common S2 buff: -25% HP lost on defeat
            hpLost = s2Buff?.hpReduction
                ? Math.floor(dungeon.hpLoss * (1 - s2Buff.hpReduction))
                : dungeon.hpLoss;
            // Weremole is permanent — HP floors at 1, never dies or needs repair
            newHp = miner.season === 3
                ? Math.max(1, (miner.hp ?? 100) - hpLost)
                : Math.max(0, (miner.hp ?? 100) - hpLost);
            needsRepair = miner.season === 3 ? false : newHp <= 0;
        }

        // UnCommon S2 buff: shorter cooldown — store earlier timestamp
        const cooldownMs = s2Buff?.cooldownMs ?? CONFIG.DUNGEON_COOLDOWN_MS;
        const lastDungeonAt = s2Buff?.cooldownMs
            ? new Date(Date.now() - (CONFIG.DUNGEON_COOLDOWN_MS - s2Buff.cooldownMs)).toISOString()
            : new Date().toISOString();

        // Update miner HP + cooldown
        await supabase.from('miners').update({
            hp: newHp,
            needs_repair: needsRepair,
            is_alive: needsRepair ? false : miner.is_alive,
            last_dungeon_at: lastDungeonAt,
            last_dungeon_type: dungeonType,
        }).eq('id', mid);

        // Log run
        await supabase.from('dungeon_runs').insert({
            wallet: w, miner_id: mid, dungeon_type: dungeonType,
            result: won ? 'win' : 'loss',
            reward_digcoin: rewardDigcoin,
            box_dropped: boxDropped,
            hp_lost: hpLost,
        });

        res.json({
            success: true,
            result: won ? 'win' : 'loss',
            dungeonName: dungeon.name,
            rewardDigcoin,
            boxDropped,
            hpLost,
            newHp,
            maxHp: CONFIG.RARITIES[miner.rarity_id]?.maxHp ?? 100,
            needsRepair,
            finalWinChance: Math.round(finalWinChance * 100),
            weremoleMiner: weremoleMiner ? { id: weremoleMiner.id, dailyDigcoin: weremoleMiner.daily_digcoin } : null,
            mapRecovered,
            s2Buff: s2Buff ? s2Buff.name : null,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get inventory
app.get('/api/dungeon/inventory', requireAuth, async (req, res) => {
    try {
        const w = norm(req.query.wallet);
        if (!w || !isValidAddress(w)) return res.status(400).json({ error: 'wallet required' });
        if (req.authWallet !== w) return res.status(403).json({ error: 'Forbidden' });

        const [{ data: inv }, { data: runs }] = await Promise.all([
            supabase.from('inventory').select('item_type, quantity').eq('wallet', w),
            supabase.from('dungeon_runs').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(100),
        ]);

        const maps = { map_easy: 0, map_medium: 0, map_hard: 0, map_weremole: 0 };
        (inv || []).forEach(i => { if (maps.hasOwnProperty(i.item_type)) maps[i.item_type] = i.quantity; });

        res.json({ maps, recentRuns: runs || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// MARKETPLACE
// ════════════════════════════════════════════

// GET /api/marketplace/listings?rarity=&sort=asc|desc
app.get('/api/marketplace/listings', async (req, res) => {
    try {
        const { rarity, sort } = req.query;
        const { data, error } = await supabase
            .from('land_listings')
            .select('*, lands(id, rarity_id, rarity_name, boost_percent, miner_slots, wallet)')
            .eq('status', 'active')
            .order('price_digcoin', { ascending: sort !== 'desc' });
        if (error) throw error;
        let listings = (data || []).map(l => ({
            id: l.id,
            landId: l.land_id,
            seller: l.seller_wallet,
            priceDigcoin: l.price_digcoin,
            rarityId: l.lands?.rarity_id,
            rarityName: l.lands?.rarity_name,
            boostPercent: l.lands?.boost_percent,
            minerSlots: l.lands?.miner_slots,
            listedAt: l.created_at,
        }));
        // Filter by rarity in-memory (rarity_id lives on lands, not land_listings)
        if (rarity !== undefined && rarity !== '') {
            const rid = parseInt(rarity);
            listings = listings.filter(l => l.rarityId === rid);
        }
        res.json({ listings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/marketplace/list — list a land for sale
app.post('/api/marketplace/list', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, landId, priceDigcoin } = req.body;
        const w = norm(wallet);
        if (!landId || !priceDigcoin || priceDigcoin < 1) return res.status(400).json({ error: 'Invalid land or price.' });

        // Verify land belongs to seller
        const { data: land } = await supabase.from('lands').select('*').eq('id', landId).eq('wallet', w).single();
        if (!land) return res.status(404).json({ error: 'Land not found or not yours.' });

        // Block if miners assigned
        const { count: assignedCount } = await supabase.from('land_miners').select('*', { count: 'exact', head: true }).eq('land_id', landId);
        if (assignedCount > 0) return res.status(400).json({ error: 'Unassign all miners before listing.' });

        // Block if already listed
        const { data: existing } = await supabase.from('land_listings').select('id').eq('land_id', landId).eq('status', 'active').maybeSingle();
        if (existing) return res.status(400).json({ error: 'Land is already listed.' });

        const { data: listing, error } = await supabase.from('land_listings').insert({
            land_id: landId,
            seller_wallet: w,
            price_digcoin: Math.round(priceDigcoin),
            status: 'active',
        }).select().single();
        if (error) throw error;

        res.json({ success: true, listing });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/marketplace/cancel/:id — cancel listing
app.delete('/api/marketplace/cancel/:id', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        const w = norm(wallet);
        const { data: listing } = await supabase.from('land_listings').select('*').eq('id', req.params.id).eq('status', 'active').single();
        if (!listing) return res.status(404).json({ error: 'Listing not found.' });
        if (listing.seller_wallet !== w) return res.status(403).json({ error: 'Not your listing.' });

        await supabase.from('land_listings').update({ status: 'cancelled' }).eq('id', listing.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/marketplace/buy/:id — buy a land
app.post('/api/marketplace/buy/:id', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        const w = norm(wallet);

        const { data: listing } = await supabase.from('land_listings').select('*, lands(*)').eq('id', req.params.id).eq('status', 'active').single();
        if (!listing) return res.status(404).json({ error: 'Listing not found or already sold.' });
        if (listing.seller_wallet === w) return res.status(400).json({ error: 'Cannot buy your own listing.' });

        const price = listing.price_digcoin;
        const fee = Math.round(price * CONFIG.MARKETPLACE_FEE_PERCENT / 100);
        const sellerReceives = price - fee;

        // Check buyer balance
        const { data: buyer } = await supabase.from('players').select('digcoin_balance').eq('wallet', w).single();
        if (!buyer || buyer.digcoin_balance < price) return res.status(400).json({ error: `Insufficient balance. Need ${price} DC.` });

        // Ensure fee wallet has a player row (deploy wallet may not be registered)
        await getOrCreatePlayer(CONFIG.MARKETPLACE_FEE_WALLET);

        // Deduct from buyer
        const { data: deducted } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: price });
        if (!deducted) return res.status(400).json({ error: 'Failed to deduct balance.' });

        // Credit seller (90%) + fee wallet (10%) — log errors but don't block
        const [sellerRes, feeRes] = await Promise.all([
            supabase.rpc('add_digcoin', { p_wallet: listing.seller_wallet, p_amount: sellerReceives, p_referral_digcoin: 0 }),
            supabase.rpc('add_digcoin', { p_wallet: CONFIG.MARKETPLACE_FEE_WALLET, p_amount: fee, p_referral_digcoin: 0 }),
        ]);
        if (sellerRes.error) console.error(`❌ marketplace seller credit failed: ${sellerRes.error.message}`);
        if (feeRes.error)    console.error(`❌ marketplace fee credit failed: ${feeRes.error.message}`);

        // Transfer land ownership + mark sold (atomic via Promise.all)
        await Promise.all([
            supabase.from('lands').update({ wallet: w }).eq('id', listing.land_id),
            supabase.from('land_listings').update({ status: 'sold', buyer_wallet: w }).eq('id', listing.id),
        ]);

        const rarityName = listing.lands?.rarity_name || 'Land';

        // Log activity
        await supabase.from('activity_log').insert([
            { wallet: w,                     type: 'marketplace_buy',  detail: `Bought Land #${listing.land_id} (${rarityName}) for ${price} DC`, amount_digcoin: price },
            { wallet: listing.seller_wallet,  type: 'marketplace_sell', detail: `Sold Land #${listing.land_id} (${rarityName}) for ${sellerReceives} DC (fee: ${fee} DC)`, amount_digcoin: 0 },
        ]);

        res.json({ success: true, landId: listing.land_id, price, fee, sellerReceives });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// STAKING
// ════════════════════════════════════════════

function calcPendingRewards(stake) {
    const now = Date.now();
    const lastClaim = new Date(stake.last_reward_at).getTime();
    const elapsed = Math.max(0, now - lastClaim); // ms
    const dailyRate = stake.apy_percent / 100 / 365;
    return stake.amount_digcoin * dailyRate * (elapsed / 86400000);
}

// GET /api/marketplace/history
app.get('/api/marketplace/history', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('land_listings')
            .select('id, land_id, seller_wallet, buyer_wallet, price_digcoin, created_at, lands(rarity_id, rarity_name)')
            .eq('status', 'sold')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        const history = (data || []).map(l => ({
            id: l.id,
            landId: l.land_id,
            rarityId: l.lands?.rarity_id,
            rarityName: l.lands?.rarity_name || 'Land',
            priceDigcoin: l.price_digcoin,
            seller: l.seller_wallet ? l.seller_wallet.slice(0,6)+'...'+l.seller_wallet.slice(-4) : '—',
            buyer: l.buyer_wallet ? l.buyer_wallet.slice(0,6)+'...'+l.buyer_wallet.slice(-4) : '—',
            soldAt: l.created_at,
        }));
        res.json({ history });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stake/leaderboard
app.get('/api/stake/leaderboard', async (req, res) => {
    try {
        const { data } = await supabase.from('stakes').select('wallet, amount_digcoin, apy_percent, lock_days, started_at').eq('status', 'active').order('amount_digcoin', { ascending: false }).limit(20);
        const grouped = {};
        for (const s of data || []) {
            if (!grouped[s.wallet]) grouped[s.wallet] = 0;
            grouped[s.wallet] += s.amount_digcoin;
        }
        const leaderboard = Object.entries(grouped)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([wallet, total], i) => ({
                rank: i + 1,
                wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4),
                totalStaked: total,
                points: total, // 1 DC staked = 1 point
            }));
        res.json({ leaderboard });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stake/:wallet
app.get('/api/stake/:wallet', async (req, res) => {
    try {
        const w = norm(req.params.wallet);
        const { data: stakes } = await supabase.from('stakes').select('*').eq('wallet', w).eq('status', 'active').order('started_at', { ascending: false });
        const result = (stakes || []).map(s => ({
            id: s.id,
            amountDigcoin: s.amount_digcoin,
            lockDays: s.lock_days,
            apyPercent: s.apy_percent,
            startedAt: s.started_at,
            unlocksAt: s.unlocks_at,
            lastRewardAt: s.last_reward_at,
            pendingRewards: parseFloat(calcPendingRewards(s).toFixed(4)),
            unlocked: new Date(s.unlocks_at).getTime() <= Date.now(),
            points: s.amount_digcoin, // 1 DC staked = 1 point
        }));
        const totalPoints = result.reduce((s, x) => s + x.points, 0);
        res.json({ stakes: result, totalPoints });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/stake/deposit
app.post('/api/stake/deposit', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, amountDigcoin } = req.body;
        const lockDays = parseInt(req.body.lockDays);
        const w = norm(wallet);
        const tier = CONFIG.STAKE_TIERS.find(t => t.lockDays === lockDays);
        if (!tier) return res.status(400).json({ error: 'Invalid lock period. Choose 15, 30, or 90 days.' });
        const amount = Math.floor(amountDigcoin);
        if (!amount || amount < CONFIG.STAKE_MIN_AMOUNT) return res.status(400).json({ error: `Minimum stake is ${CONFIG.STAKE_MIN_AMOUNT} DC.` });

        const { data: player } = await supabase.from('players').select('digcoin_balance').eq('wallet', w).single();
        if (!player || player.digcoin_balance < amount) return res.status(400).json({ error: `Insufficient balance. Need ${amount} DC.` });

        const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: amount });
        if (!ok) return res.status(400).json({ error: 'Failed to lock balance.' });

        const unlocksAt = new Date(Date.now() + lockDays * 86400000).toISOString();
        const { data: stake, error } = await supabase.from('stakes').insert({
            wallet: w, amount_digcoin: amount, lock_days: lockDays,
            apy_percent: tier.apy, unlocks_at: unlocksAt, last_reward_at: new Date().toISOString(),
            status: 'active',
        }).select().single();
        if (error) throw error;

        console.log(`💎 Stake: ${w.slice(0,8)} locked ${amount} DC for ${lockDays}d @ ${tier.apy}% APY`);
        res.json({ success: true, stake: { id: stake.id, amountDigcoin: amount, lockDays, apyPercent: tier.apy, unlocksAt } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/stake/claim/:id — collect accumulated rewards
app.post('/api/stake/claim/:id', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        const w = norm(wallet);
        const { data: stake } = await supabase.from('stakes').select('*').eq('id', req.params.id).eq('wallet', w).eq('status', 'active').single();
        if (!stake) return res.status(404).json({ error: 'Stake not found.' });

        const rewards = calcPendingRewards(stake);
        if (rewards < 0.01) return res.status(400).json({ error: 'No rewards to claim yet.' });

        const rewardRounded = parseFloat(rewards.toFixed(2));
        await Promise.all([
            supabase.rpc('add_digcoin', { p_wallet: w, p_amount: rewardRounded, p_referral_digcoin: 0 }),
            supabase.from('stakes').update({ last_reward_at: new Date().toISOString() }).eq('id', stake.id),
        ]);

        await supabase.from('activity_log').insert({ wallet: w, type: 'stake_reward', detail: `Stake #${stake.id} reward: +${rewardRounded} DC (${stake.apy_percent}% APY, ${stake.lock_days}d lock)`, amount_digcoin: 0 });
        res.json({ success: true, rewardClaimed: rewardRounded });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/stake/withdraw/:id — unstake after lock expires
app.post('/api/stake/withdraw/:id', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        const w = norm(wallet);
        const { data: stake } = await supabase.from('stakes').select('*').eq('id', req.params.id).eq('wallet', w).eq('status', 'active').single();
        if (!stake) return res.status(404).json({ error: 'Stake not found.' });
        if (new Date(stake.unlocks_at).getTime() > Date.now()) return res.status(400).json({ error: `Still locked. Unlocks at ${new Date(stake.unlocks_at).toUTCString()}.` });

        // Claim any remaining rewards first
        const pending = calcPendingRewards(stake);
        const pendingRounded = parseFloat(pending.toFixed(2));

        await Promise.all([
            supabase.rpc('add_digcoin', { p_wallet: w, p_amount: stake.amount_digcoin + pendingRounded, p_referral_digcoin: 0 }),
            supabase.from('stakes').update({ status: 'withdrawn' }).eq('id', stake.id),
        ]);

        await supabase.from('activity_log').insert({ wallet: w, type: 'stake_withdraw', detail: `Stake #${stake.id} withdrawn: ${stake.amount_digcoin} DC + ${pendingRounded} DC rewards`, amount_digcoin: 0 });
        res.json({ success: true, principalReturned: stake.amount_digcoin, rewardClaimed: pendingRounded, total: stake.amount_digcoin + pendingRounded });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════

// Public: any client can check maintenance state (used for full-screen overlay)
app.get('/api/maintenance', (_req, res) => {
    res.json({ maintenance: MAINTENANCE_MODE });
});

// Check if current session is admin (used by frontend to show/hide panel)
app.get('/api/admin/status', requireAdmin, (_req, res) => {
    res.json({ isAdmin: true, maintenance: MAINTENANCE_MODE, adminWallet: CONFIG.ADMIN_WALLET });
});

// Toggle maintenance mode
app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
    const { enabled } = req.body;
    MAINTENANCE_MODE = !!enabled;
    console.log(`👑 [ADMIN] Maintenance mode → ${MAINTENANCE_MODE}`);
    res.json({ success: true, maintenance: MAINTENANCE_MODE });
});

// Seed dungeon pool (admin only — house funding)
app.post('/api/admin/seed-dungeon-pool', requireAdmin, async (req, res) => {
    try {
        const { amount } = req.body;
        const n = parseFloat(amount);
        if (!n || n <= 0) return res.status(400).json({ error: 'amount required' });
        await supabase.rpc('add_dungeon_pool', { p_amount: n });
        await supabase.from('activity_log').insert({
            wallet: CONFIG.ADMIN_WALLET,
            type: 'dungeon_pool_seed',
            detail: `Admin seeded dungeon pool with ${n} DC`,
            amount_digcoin: n,
        });
        const { data: pool } = await supabase.from('dungeon_pool').select('balance_digcoin').eq('id', 1).single();
        console.log(`👑 [ADMIN] Dungeon pool seeded +${n} DC → total: ${pool?.balance_digcoin}`);
        res.json({ success: true, newBalance: pool?.balance_digcoin || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send DIGCOIN to any wallet (for giveaways, influencers, payments)
// Gift miner boxes to a list of wallets (no cost, admin only)
app.post('/api/admin/gift-boxes', requireAdmin, async (req, res) => {
    try {
        const { wallets } = req.body;
        if (!Array.isArray(wallets) || wallets.length === 0) return res.status(400).json({ error: 'wallets array required' });
        if (wallets.length > 50) return res.status(400).json({ error: 'Max 50 wallets per batch' });

        const results = [];
        for (const raw of wallets) {
            const w = norm(raw);
            if (!/^0x[0-9a-f]{40}$/.test(w)) {
                results.push({ wallet: raw, success: false, error: 'Invalid address' });
                continue;
            }
            try {
                await getOrCreatePlayer(w);
                const rarity = rollRarity();
                const dailyDigcoin = randBetween(rarity.dailyMin, rarity.dailyMax);
                const stats = generateStats(rarity);

                const { data: miner, error: minerErr } = await supabase.from('miners').insert({
                    wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
                    daily_digcoin: dailyDigcoin, nft_age_total: rarity.nftAge, nft_age_remaining: rarity.nftAge,
                    ...stats,
                }).select().single();

                if (minerErr || !miner) throw new Error(minerErr?.message || 'Failed to create miner');

                // Log as a free box purchase (cost = 0, distinguishable from paid)
                await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: 0, box_type: 'gift' });
                await supabase.rpc('add_digcoin', { p_wallet: w, p_boxes: 1 });

                console.log(`🎁 [ADMIN] Gift box → ${w}: ${rarity.name} miner #${miner.id} (${dailyDigcoin} DC/day)`);
                results.push({ wallet: w, success: true, minerId: miner.id, rarityName: rarity.name, dailyDigcoin });
            } catch (e) {
                results.push({ wallet: raw, success: false, error: e.message });
            }
        }

        const sent = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        res.json({ sent, failed, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/send-digcoin', requireAdmin, async (req, res) => {
    try {
        const { toWallet, amount, reason } = req.body;
        if (!toWallet || !amount) return res.status(400).json({ error: 'toWallet and amount required' });
        const amt = parseFloat(amount);
        if (amt <= 0 || isNaN(amt)) return res.status(400).json({ error: 'Amount must be a positive number' });
        const w = norm(toWallet);
        if (!/^0x[0-9a-f]{40}$/.test(w)) return res.status(400).json({ error: 'Invalid wallet address' });

        const player = await getOrCreatePlayer(w);
        await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: amt });

        // Log as a deposit with tx_hash starting with "admin_" so it never double-credits
        await supabase.from('deposits').insert({
            wallet: w, amount_pathusd: 0, digcoin_credited: amt,
            tx_hash: `admin_${Date.now()}_${(reason || 'gift').replace(/\s+/g, '_').slice(0, 40)}`,
        });

        console.log(`👑 [ADMIN] Sent ${amt} DIGCOIN → ${w} (reason: ${reason || 'gift'})`);
        res.json({ success: true, wallet: w, amountSent: amt, newBalance: player.digcoin_balance + amt, reason: reason || 'gift' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// List players (admin view — wallet + balance + miner count)
// Withdrawals by day — returns all completed withdrawals for a given date (UTC)
app.get('/api/admin/withdrawals-by-day', requireAdmin, async (req, res) => {
    try {
        const date = req.query.date; // YYYY-MM-DD
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
        const from = `${date}T00:00:00.000Z`;
        const to   = `${date}T23:59:59.999Z`;
        const { data: rows } = await supabase.from('withdrawals')
            .select('wallet, amount_digcoin, amount_pathusd, fee_pathusd, net_pathusd, status, created_at')
            .gte('created_at', from).lte('created_at', to)
            .in('status', ['completed', 'pending', 'ready'])
            .order('created_at', { ascending: false });
        const list = rows || [];
        const totalDigcoin = list.reduce((s, r) => s + (r.amount_digcoin || 0), 0);
        const totalPathUSD = list.reduce((s, r) => s + (r.amount_pathusd || 0), 0);
        const totalFees    = list.reduce((s, r) => s + (r.fee_pathusd || 0), 0);
        res.json({ date, withdrawals: list, totalDigcoin, totalPathUSD, totalFees, count: list.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dungeon runs by day
app.get('/api/admin/dungeon-runs-by-day', requireAdmin, async (req, res) => {
    try {
        const date = req.query.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
        const from = `${date}T00:00:00.000Z`;
        const to   = `${date}T23:59:59.999Z`;
        const [{ data: rows }, { data: mapRows }] = await Promise.all([
            supabase.from('dungeon_runs')
                .select('wallet, miner_id, dungeon_type, result, reward_digcoin, box_dropped, hp_lost, created_at')
                .gte('created_at', from).lte('created_at', to)
                .neq('wallet', CONFIG.ADMIN_WALLET)
                .order('created_at', { ascending: false }),
            supabase.from('activity_log')
                .select('wallet, detail, amount_digcoin, created_at')
                .eq('type', 'buy_map')
                .gte('created_at', from).lte('created_at', to)
                .neq('wallet', CONFIG.ADMIN_WALLET)
                .order('created_at', { ascending: false }),
        ]);
        const list = rows || [];
        const maps = mapRows || [];
        const wins          = list.filter(r => r.result === 'win').length;
        const losses        = list.filter(r => r.result === 'loss').length;
        const totalPaid     = list.reduce((s, r) => s + (parseFloat(r.reward_digcoin) || 0), 0);
        const boxDrops      = list.filter(r => r.box_dropped).length;
        const totalMapSpent = maps.reduce((s, m) => s + (parseFloat(m.amount_digcoin) || 0), 0);
        res.json({ date, runs: list, total: list.length, wins, losses, totalPaid, boxDrops, maps, totalMapSpent });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deposits by day
app.get('/api/admin/deposits-by-day', requireAdmin, async (req, res) => {
    try {
        const date = req.query.date;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
        const from = `${date}T00:00:00.000Z`;
        const to   = `${date}T23:59:59.999Z`;
        const { data: rows } = await supabase.from('deposits')
            .select('wallet, amount_pathusd, digcoin_credited, tx_hash, created_at')
            .gte('created_at', from).lte('created_at', to)
            .order('created_at', { ascending: false });
        const list = rows || [];
        const realDeposits = list.filter(r => !r.tx_hash?.startsWith('admin_'));
        const adminCredits = list.filter(r => r.tx_hash?.startsWith('admin_'));
        const totalPathUSD = realDeposits.reduce((s, r) => s + (r.amount_pathusd || 0), 0);
        const totalDigcoin = list.reduce((s, r) => s + (r.digcoin_credited || 0), 0);
        res.json({ date, deposits: list, totalPathUSD, totalDigcoin, count: list.length, realCount: realDeposits.length, adminCount: adminCredits.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/players', requireAdmin, async (req, res) => {
    try {
        const { data: players } = await supabase.from('players')
            .select('wallet, digcoin_balance, total_deposited_pathusd, total_earned_digcoin, boxes_bought, created_at')
            .order('digcoin_balance', { ascending: false })
            .limit(100);
        res.json({ players: players || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/airdrop-thiefcat — send ThiefCat miners to affected wallets
app.post('/api/admin/airdrop-thiefcat', requireAdmin, async (req, res) => {
    try {
        const { wallets } = req.body;
        if (!Array.isArray(wallets) || wallets.length === 0) return res.status(400).json({ error: 'wallets array required' });
        if (wallets.length > 100) return res.status(400).json({ error: 'Max 100 wallets per batch' });

        const tc = CONFIG.THIEFCAT;
        const results = { success: [], failed: [] };

        for (const raw of wallets) {
            if (!isValidAddress(raw)) { results.failed.push({ wallet: raw, error: 'Invalid address' }); continue; }
            const w = norm(raw);
            try {
                await getOrCreatePlayer(w);
                const { data: miner, error } = await supabase.from('miners').insert({
                    wallet: w,
                    rarity_id: tc.rarityId,
                    rarity_name: tc.rarityName,
                    daily_digcoin: tc.daily,
                    nft_age_total: tc.nftAge,
                    nft_age_remaining: tc.nftAge,
                    hp: tc.maxHp,
                    max_hp: tc.maxHp,
                    season: tc.season,
                    is_alive: true,
                    needs_repair: false,
                    level: 1, exp: 0, power: 100, energy: 100, protective: 100, damage: 20,
                }).select().single();
                if (error) throw new Error(error.message);
                await supabase.from('activity_log').insert({ wallet: w, type: 'thiefcat_airdrop', detail: `ThiefCat airdrop — Miner #${miner.id} (FarmCats rug compensation)`, amount_digcoin: 0 });
                results.success.push({ wallet: w, minerId: miner.id });
                console.log(`🐱 ThiefCat airdrop → ${w} (Miner #${miner.id})`);
            } catch (e) {
                results.failed.push({ wallet: w, error: e.message });
            }
        }

        res.json({ success: true, sent: results.success.length, failed: results.failed.length, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// LAND ROUTES
// ════════════════════════════════════════════

// Buy Land Box (1 or 10)
app.post('/api/land/buy', financialLimit, checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, quantity } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const qty = parseInt(quantity) === CONFIG.LAND_BOX_BULK_QUANTITY ? CONFIG.LAND_BOX_BULK_QUANTITY : 1;
        const result = await buyLandBox(wallet, qty);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get lands for wallet (public read)
app.get('/api/land/:wallet', async (req, res) => {
    try {
        const raw = req.params.wallet;
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address' });
        const result = await getLands(raw);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Assign miner to land
app.post('/api/land/assign', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, landId, minerId } = req.body;
        if (!wallet || !landId || !minerId) return res.status(400).json({ error: 'wallet, landId and minerId required' });
        const result = await assignMinerToLand(wallet, parseInt(landId), parseInt(minerId));
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unassign miner from land
app.post('/api/land/unassign', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, minerId } = req.body;
        if (!wallet || !minerId) return res.status(400).json({ error: 'wallet and minerId required' });
        const result = await unassignMinerFromLand(wallet, parseInt(minerId));
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Global Stats
app.get('/api/stats', async (req, res) => {
    try {
        const { count: totalPlayers } = await supabase.from('players').select('*', { count: 'exact', head: true });
        const { count: totalMiners } = await supabase.from('miners').select('*', { count: 'exact', head: true });
        const { count: aliveMiners } = await supabase.from('miners').select('*', { count: 'exact', head: true }).eq('is_alive', true);
        const { count: landsMinted } = await supabase.from('lands').select('*', { count: 'exact', head: true });
        const { count: autoPickaxesMinted } = await supabase.from('player_perks').select('*', { count: 'exact', head: true }).eq('perk_type', 'auto_pickaxe');
        const { count: s2BoxesMinted } = await supabase.from('box_purchases').select('*', { count: 'exact', head: true }).eq('box_type', 's2');
        const [{ data: agg }, { data: dungeonPool }, { data: recentWins }, { data: totalPaidRow }, { data: mktSold }] = await Promise.all([
            supabase.rpc('get_global_stats'),
            supabase.from('dungeon_pool').select('balance_digcoin').eq('id', 1).single(),
            supabase.from('dungeon_runs').select('wallet,dungeon_type,reward_digcoin,created_at').eq('result', 'win').order('created_at', { ascending: false }).limit(5),
            supabase.from('dungeon_runs').select('reward_digcoin').eq('result', 'win'),
            supabase.from('land_listings').select('price_digcoin').eq('status', 'sold'),
        ]);
        const dungeonTotalPaid = (totalPaidRow || []).reduce((s, r) => s + (parseFloat(r.reward_digcoin) || 0), 0);
        const marketplaceVolume = (mktSold || []).reduce((s, r) => s + (r.price_digcoin || 0), 0);
        res.json({
            totalPlayers, totalMiners, aliveMiners, ...(agg?.[0] || {}),
            landSaleStartMs: LAND_SALE_START_MS,
            landsMinted: landsMinted || 0,
            landMaxSupply: CONFIG.LAND_BOX_MAX_SUPPLY,
            autoPickaxesMinted: autoPickaxesMinted || 0,
            autoPickaxeMaxSupply: CONFIG.AUTO_PICKAXE_MAX_SUPPLY,
            s2BoxesMinted: s2BoxesMinted || 0,
            s2BoxMaxSupply: CONFIG.S2_BOX_MAX_SUPPLY,
            s2LaunchAtMs: S2_LAUNCH_AT_MS,
            dungeonPoolBalance: dungeonPool?.balance_digcoin || 0,
            dungeonTotalPaid,
            marketplaceVolume,
            marketplaceSales: mktSold?.length || 0,
            dungeonRecentWins: (recentWins || []).map(r => ({
                wallet: r.wallet.slice(0, 6) + '...' + r.wallet.slice(-4),
                dungeonType: r.dungeon_type,
                reward: r.reward_digcoin,
                date: r.created_at,
            })),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Faucet — disabled on mainnet
app.post('/api/faucet', (_req, res) => {
    res.status(403).json({ error: 'Faucet not available on mainnet' });
});

// Config (public)
app.get('/api/config', (req, res) => {
    res.json({
        boxPriceDigcoin: CONFIG.BOX_PRICE_DIGCOIN,
        boxBulkQuantity: CONFIG.BOX_BULK_QUANTITY,
        boxBulkPriceDigcoin: CONFIG.BOX_BULK_PRICE_DIGCOIN,
        saleBoxPriceDigcoin: CONFIG.SALE_BOX_PRICE_DIGCOIN,
        saleBoxMaxTotal: CONFIG.SALE_BOX_MAX_TOTAL,
        saleBoxMaxPerWallet: CONFIG.SALE_BOX_MAX_PER_WALLET,
        saleBoxEndTime: CONFIG.SALE_BOX_END_TIME,
        saleBoxIsActive: Date.now() < CONFIG.SALE_BOX_END_TIME,
        fuseCostDigcoin: CONFIG.FUSE_COST_DIGCOIN,
        digcoinPerPathUSD: CONFIG.DIGCOIN_PER_PATHUSD,
        withdrawFee: CONFIG.WITHDRAW_FEE_PERCENT + '%',
        referralBonus: CONFIG.REFERRAL_PERCENT + '%',
        playAllFee: CONFIG.PLAY_ALL_FEE_DIGCOIN,
        rarities: CONFIG.RARITIES.map(r => ({
            ...r,
            roiDays: Math.ceil(CONFIG.BOX_PRICE_DIGCOIN / ((r.dailyMin + r.dailyMax) / 2)),
            totalReturnAvg: (((r.dailyMin + r.dailyMax) / 2) * r.nftAge).toFixed(0),
            repairCostDigcoin: r.repairPathUSD * CONFIG.DIGCOIN_PER_PATHUSD,
        })),
    });
});

// ════════════════════════════════════════════
// AUTO PICKAXE WORKER
// Runs every hour — claims ready miners and restarts idle ones
// for all wallets with active Auto Pickaxe perk. Fees are already
// waived inside claimAll/playAll when perk.active === true.
// ════════════════════════════════════════════

async function runAutoPickaxeWorker() {
    if (MAINTENANCE_MODE) return;
    try {
        const { data: perks } = await supabase.from('player_perks')
            .select('wallet').eq('perk_type', 'auto_pickaxe').eq('active', true);
        if (!perks?.length) return;
        console.log(`🪓 [Auto Pickaxe] Processing ${perks.length} active wallet(s)...`);
        for (const { wallet: w } of perks) {
            try {
                const claimResult = await claimAll(w);
                if (claimResult.claimed > 0) {
                    console.log(`🪓 [Auto Pickaxe] ${w}: claimed ${claimResult.claimed} miners (+${claimResult.totalReward} DC)`);
                }
                const playResult = await playAll(w);
                if (playResult.started > 0) {
                    console.log(`🪓 [Auto Pickaxe] ${w}: started ${playResult.started} miners`);
                }
            } catch (err) {
                console.error(`❌ [Auto Pickaxe] Worker error for ${w}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error(`❌ [Auto Pickaxe] Worker fatal: ${err.message}`);
    }
}

// Run once at startup (catch up any missed cycles), then every hour
setTimeout(runAutoPickaxeWorker, 30_000);
setInterval(runAutoPickaxeWorker, 60 * 60 * 1000);

// Init S2 launch time from DB (set once, never reset on restart)
initS2LaunchTime();

// ════════════════════════════════════════════
// START
// ════════════════════════════════════════════

app.listen(CONFIG.PORT, () => {
    console.log(`\n  ⛏️  DigMiner Backend (Supabase)\n  Port: ${CONFIG.PORT} | Play All Fee: ${CONFIG.PLAY_ALL_FEE_DIGCOIN} DIGCOIN/miner\n`);
    if (CONFIG.POOL_CONTRACT) startEventListener();
});

module.exports = app;
