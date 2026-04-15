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
    PLAY_ALL_FEE_DIGCOIN: 10,     // fee per miner when using Play All / Claim All
    SIGNATURE_DEADLINE_SECS: 3600,

    RARITIES: [
        { id: 0, name: 'Common',     chance: 30, dailyMin: 18, dailyMax: 20, nftAge: 19, repairPathUSD: 0.24, color: '#9E9E9E' },
        { id: 1, name: 'UnCommon',   chance: 30, dailyMin: 21, dailyMax: 23, nftAge: 17, repairPathUSD: 0.40, color: '#4CAF50' },
        { id: 2, name: 'Rare',       chance: 18, dailyMin: 24, dailyMax: 26, nftAge: 15, repairPathUSD: 0.60, color: '#2196F3' },
        { id: 3, name: 'Super Rare', chance: 8,  dailyMin: 27, dailyMax: 30, nftAge: 14, repairPathUSD: 0.80, color: '#E91E63' },
        { id: 4, name: 'Legendary',  chance: 4,  dailyMin: 31, dailyMax: 35, nftAge: 13, repairPathUSD: 1.00, color: '#FF9800' },
        { id: 5, name: 'Mythic',     chance: 2,  dailyMin: 36, dailyMax: 42, nftAge: 11, repairPathUSD: 1.50, color: '#9C27B0' },
    ],
};

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
                ...stats,
            }).select().single();

            if (minerErr || !miner) throw new Error(minerErr?.message || 'Failed to create miner');

            await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: CONFIG.BOX_PRICE_DIGCOIN });

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
    // (concurrent requests may have both passed Check 1 before either inserted box_purchases)
    const { totalSold: totalSold2, walletBought: walletBought2 } = await getSaleBoxCounts(w);
    if (totalSold2 > CONFIG.SALE_BOX_MAX_TOTAL || walletBought2 > CONFIG.SALE_BOX_MAX_PER_WALLET) {
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

    // Lifespan = parent tier's lifespan (not result tier's)
    const parentRarity = CONFIG.RARITIES[m1.rarity_id];
    const fusedLifespan = parentRarity.nftAge;

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

    console.log(`🔥 Fuse: ${w} fused #${minerId1}(${m1.rarity_name}) + #${minerId2}(${m2.rarity_name}) → #${newMiner.id}(${rarity.name})`);

    return {
        success: true,
        miner: { ...newMiner, rarityId: newMiner.rarity_id, rarityName: newMiner.rarity_name },
        consumed: [minerId1, minerId2],
        cost,
    };
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

    const reward = miner.daily_digcoin;
    const newAge = miner.nft_age_remaining - 1;
    const isDead = newAge <= 0;

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

    return { success: true, reward, nftAgeRemaining: newAge, minerDead: isDead };
}

// Play All: start all idle miners (last_play_at IS NULL)
async function playAll(wallet) {
    const w = norm(wallet);
    const { data: miners } = await supabase.from('miners')
        .select('*').eq('wallet', w).eq('is_alive', true).eq('needs_repair', false).is('last_play_at', null);

    if (!miners?.length) return { error: 'No idle miners to start. All are mining or need repair.' };

    const totalFee = CONFIG.PLAY_ALL_FEE_DIGCOIN * miners.length;
    const { data: player } = await supabase.from('players').select('digcoin_balance, total_spent_digcoin').eq('wallet', w).single();

    if (player.digcoin_balance < totalFee) {
        return { error: `Insufficient balance. Need ${totalFee} DIGCOIN (${CONFIG.PLAY_ALL_FEE_DIGCOIN} per miner × ${miners.length} miners)` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: ok } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: totalFee });
    if (!ok) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const now = new Date().toISOString();
    const ids = miners.map(m => m.id);
    const { error: startErr } = await supabase.from('miners').update({ last_play_at: now }).in('id', ids);

    if (startErr) {
        // Refund fee since miners were not started
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: totalFee });
        if (refundErr) console.error(`❌ playAll REFUND FAILED for ${w} (${totalFee} DC): ${refundErr.message}`);
        throw new Error(`Failed to start miners: ${startErr.message}`);
    }

    return { success: true, started: miners.length, fee: totalFee };
}

// Claim All: collect from all ready miners (24h passed)
async function claimAll(wallet) {
    const w = norm(wallet);
    const { data: miners } = await supabase.from('miners')
        .select('*').eq('wallet', w).eq('is_alive', true).eq('needs_repair', false).not('last_play_at', 'is', null);

    if (!miners?.length) return { error: 'No miners are mining' };

    const now = Date.now();
    const ready = miners.filter(m => (now - new Date(m.last_play_at).getTime()) >= CONFIG.PLAY_COOLDOWN_MS);

    if (!ready.length) return { error: 'No miners ready to claim yet. Come back in 24h!' };

    const totalFee = CONFIG.PLAY_ALL_FEE_DIGCOIN * ready.length;
    const { data: player } = await supabase.from('players').select('digcoin_balance, total_spent_digcoin').eq('wallet', w).single();

    if (player.digcoin_balance < totalFee) {
        return { error: `Insufficient balance for Claim All fee. Need ${totalFee} DIGCOIN (${CONFIG.PLAY_ALL_FEE_DIGCOIN} × ${ready.length} miners)` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: feeOk } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: totalFee });
    if (!feeOk) return { error: 'Insufficient balance for Claim All fee (concurrent update conflict — try again)' };

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

    // Refund fee for any miners that couldn't be claimed (e.g., claimed concurrently by another request)
    const actualFee = CONFIG.PLAY_ALL_FEE_DIGCOIN * claimed;
    const refund = totalFee - actualFee;
    if (refund > 0) {
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: refund });
        if (refundErr) console.error(`❌ claimAll REFUND FAILED for ${w} (${refund} DC): ${refundErr.message}`);
    }

    return {
        totalReward: Math.round(totalReward * 100) / 100,
        claimAllFee: actualFee,
        netReward: Math.round((totalReward - actualFee) * 100) / 100,
        claimed, died, failed, details,
    };
}

async function repairMiner(wallet, minerId) {
    const w = norm(wallet);
    const { data: miner } = await supabase.from('miners').select('*').eq('id', minerId).eq('wallet', w).single();

    if (!miner) return { error: 'Miner not found' };
    if (miner.is_alive && !miner.needs_repair) return { error: 'Miner does not need repair' };

    const rarity = CONFIG.RARITIES[miner.rarity_id];
    const cost = rarity.repairPathUSD * CONFIG.DIGCOIN_PER_PATHUSD;

    const { data: player } = await supabase.from('players').select('digcoin_balance, total_spent_digcoin').eq('wallet', w).single();
    if (player.digcoin_balance < cost) {
        return { error: `Insufficient balance. Repair costs ${cost} DIGCOIN (${rarity.repairPathUSD} pathUSD)` };
    }

    // Atomic relative deduction — safe against concurrent double-spend
    const { data: repairOk } = await supabase.rpc('spend_digcoin', { p_wallet: w, p_amount: cost });
    if (!repairOk) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const { error: minerUpdateErr } = await supabase.from('miners').update({
        nft_age_remaining: miner.nft_age_total, is_alive: true, needs_repair: false,
    }).eq('id', minerId);

    if (minerUpdateErr) {
        // Refund since the miner was not actually repaired
        const { error: refundErr } = await supabase.rpc('add_digcoin', { p_wallet: w, p_amount: cost });
        if (refundErr) console.error(`❌ repair REFUND FAILED for ${w} miner ${minerId} (${cost} DC): ${refundErr.message}`);
        throw new Error(`Failed to repair miner: ${minerUpdateErr.message}`);
    }

    await supabase.from('repairs').insert({ wallet: w, miner_id: minerId, cost_digcoin: cost });

    return { success: true, costDigcoin: cost, costPathUSD: rarity.repairPathUSD };
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
        const { data: miners } = await supabase.from('miners').select('*').eq('wallet', w).order('created_at', { ascending: false });

        const now = Date.now();
        const mapped = (miners || []).map(m => {
            const rarity = CONFIG.RARITIES[m.rarity_id];
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
                isAlive: m.is_alive, needsRepair: m.needs_repair, isFused: !!m.is_fused,
                isIdle, isMining, canClaim,
                canPlay: canClaim, // backward compat alias
                cooldownRemaining,
                level: m.level, exp: m.exp, power: m.power, energy: m.energy, protective: m.protective, damage: m.damage,
                repairCostDigcoin: rarity.repairPathUSD * CONFIG.DIGCOIN_PER_PATHUSD,
                repairCostPathUSD: rarity.repairPathUSD, color: rarity.color,
            };
        });

        const alive = mapped.filter(m => m.isAlive && !m.needsRepair);
        res.json({
            player: {
                wallet: w, digcoinBalance: player.digcoin_balance,
                totalDepositedPathUSD: player.total_deposited_pathusd,
                totalWithdrawnPathUSD: player.total_withdrawn_pathusd,
                totalEarnedDigcoin: player.total_earned_digcoin,
                boxesBought: player.boxes_bought,
                referralLink: `${req.protocol}://${req.get('host')}?ref=${w}`,
                referralEarnings: player.referral_earnings, referrer: player.referrer,
            },
            miners: mapped,
            stats: { totalMiners: mapped.length, aliveMiners: alive.length, dailyIncome: alive.reduce((s, m) => s + m.dailyDigcoin, 0) },
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
        const { data: plays } = await supabase.from('play_history').select('*').eq('wallet', w).order('played_at', { ascending: false }).limit(limit);
        const { data: deps } = await supabase.from('deposits').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit);
        const { data: withs } = await supabase.from('withdrawals').select('*').eq('wallet', w).eq('status', 'ready').order('created_at', { ascending: false }).limit(limit);
        const { data: boxes } = await supabase.from('box_purchases').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit);

        const txs = [
            ...(plays || []).map(p => ({ type: 'play', detail: `Get Reward Miner #${p.miner_id} = ${p.reward_digcoin} DIGCOIN`, amount: p.reward_digcoin, date: p.played_at })),
            ...(deps || []).map(d => ({ type: 'deposit', detail: `Deposit ${d.amount_pathusd} pathUSD = ${d.digcoin_credited} DIGCOIN`, amount: d.digcoin_credited, date: d.created_at })),
            ...(withs || []).map(w => ({ type: 'withdraw', detail: `Withdraw ${w.amount_digcoin} DIGCOIN = ${w.net_pathusd} pathUSD (fee: ${w.fee_pathusd})`, amount: -w.amount_digcoin, date: w.created_at })),
            ...(boxes || []).map(b => ({ type: 'box', detail: `Buy Box → Miner #${b.miner_id}`, amount: -b.cost_digcoin, date: b.created_at })),
        ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

        res.json({ transactions: txs });
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

// Send DIGCOIN to any wallet (for giveaways, influencers, payments)
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
app.get('/api/admin/players', requireAdmin, async (req, res) => {
    try {
        const { data: players } = await supabase.from('players')
            .select('wallet, digcoin_balance, total_deposited_pathusd, total_earned_digcoin, boxes_bought, created_at')
            .order('digcoin_balance', { ascending: false })
            .limit(100);
        res.json({ players: players || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Global Stats
app.get('/api/stats', async (req, res) => {
    try {
        const { count: totalPlayers } = await supabase.from('players').select('*', { count: 'exact', head: true });
        const { count: totalMiners } = await supabase.from('miners').select('*', { count: 'exact', head: true });
        const { count: aliveMiners } = await supabase.from('miners').select('*', { count: 'exact', head: true }).eq('is_alive', true);
        const { data: agg } = await supabase.rpc('get_global_stats');
        res.json({ totalPlayers, totalMiners, aliveMiners, ...(agg?.[0] || {}) });
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
// START
// ════════════════════════════════════════════

app.listen(CONFIG.PORT, () => {
    console.log(`\n  ⛏️  DigMiner Backend (Supabase)\n  Port: ${CONFIG.PORT} | Play All Fee: ${CONFIG.PLAY_ALL_FEE_DIGCOIN} DIGCOIN/miner\n`);
    if (CONFIG.POOL_CONTRACT) startEventListener();
});

module.exports = app;
