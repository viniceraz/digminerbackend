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
    RPC_URL:             process.env.RPC_URL || '❌ MISSING',
    CHAIN_ID:            process.env.CHAIN_ID || '❌ MISSING',
    POOL_CONTRACT:       process.env.POOL_CONTRACT || '❌ MISSING',
    SIGNER_PRIVATE_KEY:  !!process.env.SIGNER_PRIVATE_KEY,
    ADMIN_WALLET:        process.env.ADMIN_WALLET || '❌ MISSING',
};
console.log('[ENV CHECK]', JSON.stringify(ENV_STATUS));

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

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
    WITHDRAW_FEE_PERCENT: 10,
    REFERRAL_PERCENT: 4,
    PLAY_COOLDOWN_MS: 24 * 60 * 60 * 1000,
    PLAY_ALL_FEE_DIGCOIN: 10,     // fee per miner when using Play All / Claim All
    SIGNATURE_DEADLINE_SECS: 3600,

    RARITIES: [
        { id: 0, name: 'Common',     chance: 30, dailyMin: 18, dailyMax: 20, nftAge: 45, repairPathUSD: 0.24, color: '#9E9E9E' },
        { id: 1, name: 'UnCommon',   chance: 30, dailyMin: 21, dailyMax: 23, nftAge: 48, repairPathUSD: 0.40, color: '#4CAF50' },
        { id: 2, name: 'Rare',       chance: 18, dailyMin: 24, dailyMax: 26, nftAge: 52, repairPathUSD: 0.60, color: '#2196F3' },
        { id: 3, name: 'Super Rare', chance: 8,  dailyMin: 27, dailyMax: 30, nftAge: 57, repairPathUSD: 0.80, color: '#E91E63' },
        { id: 4, name: 'Legendary',  chance: 4,  dailyMin: 31, dailyMax: 35, nftAge: 63, repairPathUSD: 1.00, color: '#FF9800' },
        { id: 5, name: 'Mythic',     chance: 2,  dailyMin: 36, dailyMax: 42, nftAge: 70, repairPathUSD: 1.50, color: '#9C27B0' },
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

        const { data: newPlayer } = await supabase.from('players')
            .insert({ wallet: w, referrer: ref })
            .select().single();
        player = newPlayer;
    }
    return player;
}

// ════════════════════════════════════════════
// GAME LOGIC
// ════════════════════════════════════════════

async function processDeposit(wallet, amountPathUSD, txHash = '') {
    const w = norm(wallet);

    // Prevent double-credit for the same on-chain tx
    if (txHash) {
        const { data: existing } = await supabase.from('deposits').select('id').eq('tx_hash', txHash).limit(1);
        if (existing?.length) {
            console.log(`⚠️  Duplicate deposit ignored: ${txHash}`);
            return { duplicate: true };
        }
    }

    const player = await getOrCreatePlayer(w);
    const digcoinAmount = amountPathUSD * CONFIG.DIGCOIN_PER_PATHUSD;

    await supabase.from('players').update({
        digcoin_balance: player.digcoin_balance + digcoinAmount,
        total_deposited_pathusd: player.total_deposited_pathusd + amountPathUSD,
    }).eq('wallet', w);

    await supabase.from('deposits').insert({
        wallet: w, amount_pathusd: amountPathUSD, digcoin_credited: digcoinAmount, tx_hash: txHash,
    });

    // Referral: 4%
    if (player.referrer) {
        const bonus = digcoinAmount * (CONFIG.REFERRAL_PERCENT / 100);
        const { data: ref } = await supabase.from('players').select('digcoin_balance, referral_earnings').eq('wallet', player.referrer).single();
        if (ref) {
            await supabase.from('players').update({
                digcoin_balance: ref.digcoin_balance + bonus,
                referral_earnings: ref.referral_earnings + bonus,
            }).eq('wallet', player.referrer);
        }
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

    // Atomic deduction: only succeeds if balance is still >= cost at write time
    const { data: deducted } = await supabase.from('players')
        .update({
            digcoin_balance: player.digcoin_balance - cost,
            total_spent_digcoin: player.total_spent_digcoin + cost,
            boxes_bought: player.boxes_bought + quantity,
        })
        .eq('wallet', w)
        .gte('digcoin_balance', cost)
        .select('digcoin_balance');

    if (!deducted?.length) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const miners = [];
    for (let i = 0; i < quantity; i++) {
        const rarity = rollRarity();
        const dailyDigcoin = randBetween(rarity.dailyMin, rarity.dailyMax);
        const stats = generateStats(rarity);

        const { data: miner } = await supabase.from('miners').insert({
            wallet: w, rarity_id: rarity.id, rarity_name: rarity.name,
            daily_digcoin: dailyDigcoin, nft_age_total: rarity.nftAge, nft_age_remaining: rarity.nftAge,
            ...stats,
        }).select().single();

        await supabase.from('box_purchases').insert({ wallet: w, miner_id: miner.id, cost_digcoin: CONFIG.BOX_PRICE_DIGCOIN });

        miners.push({
            id: miner.id, rarityId: rarity.id, rarityName: rarity.name,
            dailyDigcoin, nftAge: rarity.nftAge, color: rarity.color, ...stats,
            roi: Math.ceil(CONFIG.BOX_PRICE_DIGCOIN / dailyDigcoin),
        });
    }

    return { success: true, miners, cost, discount: quantity === CONFIG.BOX_BULK_QUANTITY ? '5%' : null };
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

    // After claiming → back to idle (last_play_at = null), player must Mine again
    await supabase.from('miners').update({
        nft_age_remaining: newAge, is_alive: !isDead, needs_repair: isDead,
        last_play_at: null, exp: miner.exp + Math.floor(reward),
    }).eq('id', minerId);

    // Use Supabase RPC-style update — for credits (additions) a simple update is safe since
    // we are adding, not subtracting. We still re-read to get fresh balance.
    const { data: player } = await supabase.from('players').select('digcoin_balance, total_earned_digcoin').eq('wallet', w).single();
    await supabase.from('players').update({
        digcoin_balance: player.digcoin_balance + reward,
        total_earned_digcoin: (player.total_earned_digcoin || 0) + reward,
    }).eq('wallet', w);

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

    // Atomic deduction: only succeeds if balance is still >= fee at write time
    const { data: deducted } = await supabase.from('players')
        .update({
            digcoin_balance: player.digcoin_balance - totalFee,
            total_spent_digcoin: (player.total_spent_digcoin || 0) + totalFee,
        })
        .eq('wallet', w)
        .gte('digcoin_balance', totalFee)
        .select('digcoin_balance');

    if (!deducted?.length) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    const now = new Date().toISOString();
    const ids = miners.map(m => m.id);
    await supabase.from('miners').update({ last_play_at: now }).in('id', ids);

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

    // Atomic fee deduction before crediting rewards, prevents race conditions
    const { data: feeDeducted } = await supabase.from('players')
        .update({
            digcoin_balance: player.digcoin_balance - totalFee,
            total_spent_digcoin: (player.total_spent_digcoin || 0) + totalFee,
        })
        .eq('wallet', w)
        .gte('digcoin_balance', totalFee)
        .select('digcoin_balance');

    if (!feeDeducted?.length) return { error: 'Insufficient balance for Claim All fee (concurrent update conflict — try again)' };

    let totalReward = 0, claimed = 0, died = 0;
    const details = [];

    for (const miner of ready) {
        const result = await claimMiner(w, miner.id);
        if (result.success) {
            totalReward += result.reward;
            claimed++;
            if (result.minerDead) died++;
        }
        details.push({ minerId: miner.id, rarityName: miner.rarity_name, ...result });
    }

    return {
        totalReward: Math.round(totalReward * 100) / 100,
        claimAllFee: totalFee,
        netReward: Math.round((totalReward - totalFee) * 100) / 100,
        claimed, died, details,
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

    // Atomic deduction before repairing
    const { data: deducted } = await supabase.from('players')
        .update({
            digcoin_balance: player.digcoin_balance - cost,
            total_spent_digcoin: (player.total_spent_digcoin || 0) + cost,
        })
        .eq('wallet', w)
        .gte('digcoin_balance', cost)
        .select('digcoin_balance');

    if (!deducted?.length) return { error: 'Insufficient balance (concurrent update conflict — try again)' };

    await supabase.from('miners').update({
        nft_age_remaining: miner.nft_age_total, is_alive: true, needs_repair: false,
    }).eq('id', minerId);

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
                            processDeposit(parsed.args.player, amt, log.transactionHash);
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
    const w = norm(req.params.wallet);
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

// Player info
app.get('/api/player/:wallet', async (req, res) => {
    try {
        const w = norm(req.params.wallet);
        const player = await getOrCreatePlayer(w);
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
                isAlive: m.is_alive, needsRepair: m.needs_repair,
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

// Register with referral
app.post('/api/register', async (req, res) => {
    try {
        const { wallet, referrer } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const player = await getOrCreatePlayer(wallet, referrer);
        res.json({ success: true, player });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deposit — requires txHash and verifies on-chain before crediting
app.post('/api/deposit', checkMaintenance, requireAuth, async (req, res) => {
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
app.post('/api/box/buy', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, quantity } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const qty = quantity === 10 ? 10 : 1;
        const result = await buyBoxes(wallet, qty);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mine single miner (idle → start 24h cycle)
app.post('/api/play/:minerId', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await startMining(wallet, parseInt(req.params.minerId));
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim single miner (ready → collect reward → back to idle)
app.post('/api/claim/:minerId', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await claimMiner(wallet, parseInt(req.params.minerId));
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Play All: start all idle miners (fee per miner)
app.post('/api/play-all', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await playAll(wallet);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim All: collect from all ready miners (fee per miner)
app.post('/api/claim-all', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await claimAll(wallet);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Repair
app.post('/api/repair/:minerId', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: 'wallet required' });
        const result = await repairMiner(wallet, parseInt(req.params.minerId));
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Withdraw
app.post('/api/withdraw', checkMaintenance, requireAuth, async (req, res) => {
    try {
        const { wallet, amountDigcoin } = req.body;
        if (!wallet || !amountDigcoin) return res.status(400).json({ error: 'wallet and amountDigcoin required' });
        const w = norm(wallet);
        const { data: player } = await supabase.from('players').select('digcoin_balance, total_withdrawn_pathusd').eq('wallet', w).single();
        const amount = parseFloat(amountDigcoin);
        if (amount <= 0 || amount > player.digcoin_balance) return res.status(400).json({ error: `Insufficient balance. Have ${player.digcoin_balance.toFixed(2)} DIGCOIN` });

        // 24h cooldown per wallet
        const { data: lastWithdraw } = await supabase.from('withdrawals')
            .select('created_at').eq('wallet', w).order('created_at', { ascending: false }).limit(1);
        if (lastWithdraw?.length) {
            const elapsed = Date.now() - new Date(lastWithdraw[0].created_at).getTime();
            const cooldown = 24 * 60 * 60 * 1000;
            if (elapsed < cooldown) {
                const rem = cooldown - elapsed;
                const h = Math.floor(rem / 3600000), m = Math.floor((rem % 3600000) / 60000);
                return res.status(400).json({ error: `Withdraw cooldown: wait ${h}h ${m}m`, cooldownMs: rem });
            }
        }

        const amountPathUSD = amount / CONFIG.DIGCOIN_PER_PATHUSD;
        const fee = amountPathUSD * (CONFIG.WITHDRAW_FEE_PERCENT / 100);
        const net = amountPathUSD - fee;

        // Atomic deduction: only succeeds if balance hasn't changed since we read it
        const { data: deducted } = await supabase.from('players')
            .update({
                digcoin_balance: player.digcoin_balance - amount,
                total_withdrawn_pathusd: (player.total_withdrawn_pathusd || 0) + net,
            })
            .eq('wallet', w)
            .gte('digcoin_balance', amount)
            .select('digcoin_balance');

        if (!deducted?.length) return res.status(400).json({ error: 'Insufficient balance (concurrent update conflict — try again)' });

        const sigData = await generateWithdrawSignature(w, amountPathUSD);
        await supabase.from('withdrawals').insert({ wallet: w, amount_digcoin: amount, amount_pathusd: amountPathUSD, fee_pathusd: fee, net_pathusd: net, nonce: parseInt(sigData.nonce), status: 'ready' });

        res.json({ success: true, amountDigcoin: amount, amountPathUSD, feePathUSD: fee, netPathUSD: net, signature: sigData });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// History
app.get('/api/history/:wallet', async (req, res) => {
    try {
        const w = norm(req.params.wallet);
        const limit = parseInt(req.query.limit) || 50;
        const { data: plays } = await supabase.from('play_history').select('*').eq('wallet', w).order('played_at', { ascending: false }).limit(limit);
        const { data: deps } = await supabase.from('deposits').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit);
        const { data: withs } = await supabase.from('withdrawals').select('*').eq('wallet', w).order('created_at', { ascending: false }).limit(limit);
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
        await supabase.from('players')
            .update({ digcoin_balance: player.digcoin_balance + amt })
            .eq('wallet', w);

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
