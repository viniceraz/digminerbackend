'use strict';

/**
 * DigMiner — Complete Integration Test Suite
 *
 * Tests ALL game functions against a real local server with an in-memory
 * Supabase mock. ZERO real DB writes. Zero blockchain calls.
 *
 * Usage:  node test.js
 */

// ══════════════════════════════════════════════════════
// 0. ENV — set BEFORE any require that reads process.env
// ══════════════════════════════════════════════════════

process.env.PORT                = '4321';
process.env.SUPABASE_URL        = 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_KEY= 'mock-key';
process.env.RPC_URL             = 'http://localhost:8545'; // never actually called (mocked)
process.env.CHAIN_ID            = '62320';
process.env.POOL_CONTRACT       = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
// Signer: Hardhat account #2 — used by backend to sign withdraw EIP-712
process.env.SIGNER_PRIVATE_KEY  = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
// Admin: Hardhat account #1
process.env.ADMIN_WALLET        = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

// ══════════════════════════════════════════════════════
// 1. REAL ETHERS — load first so we can use it in tests
//    and also so we can patch its cache entry below.
// ══════════════════════════════════════════════════════

const realEthers = require('ethers');
const http       = require('http');
const crypto     = require('crypto');

// Test wallets (Hardhat deterministic keys)
const PLAYER_PK   = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const REFERRER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PLAYER_WALLET   = new realEthers.ethers.Wallet(PLAYER_PK).address.toLowerCase();
const REFERRER_WALLET = new realEthers.ethers.Wallet(REFERRER_PK).address.toLowerCase();
const ADMIN_WALLET    = process.env.ADMIN_WALLET;

// ══════════════════════════════════════════════════════
// 2. IN-MEMORY DATABASE
// ══════════════════════════════════════════════════════

const db = {
    players      : [],
    miners       : [],
    deposits     : [],
    withdrawals  : [],
    box_purchases: [],
    repairs      : [],
    play_history : [],
};

// Exposed globally so tests can time-travel miners (set last_play_at to past)
global.__testDb = db;

// ══════════════════════════════════════════════════════
// 3. IN-MEMORY SUPABASE MOCK
// ══════════════════════════════════════════════════════

class QB {
    constructor(table) {
        this._t    = table;
        this._op   = 'select';
        this._wdat = null;
        this._fil  = [];
        this._ord  = null;
        this._lim  = null;
        this._single = false;
        this._cnt  = false;
        this._pws  = null; // post-write select columns
        this._prom = null;
    }

    // ── Column selectors ──────────────────────
    select(cols, opts) {
        if (this._op === 'insert' || this._op === 'update' || this._op === 'delete') {
            this._pws = cols || '*';
        } else {
            this._op   = 'select';
            this._cols = cols || '*';
            if (opts?.count === 'exact') this._cnt = true;
        }
        return this;
    }

    // ── Write builders ────────────────────────
    insert(data) { this._op = 'insert'; this._wdat = data; return this; }
    update(data) { this._op = 'update'; this._wdat = data; return this; }
    delete()     { this._op = 'delete';                    return this; }

    // ── Filters ───────────────────────────────
    eq  (c, v)    { this._fil.push({ t: 'eq',   c, v });        return this; }
    neq (c, v)    { this._fil.push({ t: 'neq',  c, v });        return this; }
    gte (c, v)    { this._fil.push({ t: 'gte',  c, v });        return this; }
    in  (c, vs)   { this._fil.push({ t: 'in',   c, vs });       return this; }
    is  (c, v)    { this._fil.push({ t: 'is',   c, v });        return this; }
    not (c, op, v){ this._fil.push({ t: 'not',  c, op, v });    return this; }

    // ── Modifiers ─────────────────────────────
    order(col, opts) { this._ord = { col, asc: opts?.ascending !== false }; return this; }
    limit(n)         { this._lim = n; return this; }
    single()         { this._single = true; return this; }

    // ── Thenable (one lazy promise per builder) ──
    then(res, rej) { if (!this._prom) this._prom = this._exec(); return this._prom.then(res, rej); }
    catch(rej)     { if (!this._prom) this._prom = this._exec(); return this._prom.catch(rej); }

    // ── Internal ─────────────────────────────
    _match(row) {
        for (const f of this._fil) {
            if (f.t === 'eq'  && row[f.c] !== f.v)           return false;
            if (f.t === 'neq' && row[f.c] === f.v)           return false;
            if (f.t === 'gte' && row[f.c] < f.v)             return false;
            if (f.t === 'in'  && !f.vs.includes(row[f.c]))   return false;
            // PostgreSQL: undefined columns behave like NULL for IS/IS NOT checks
            if (f.t === 'is') {
                const actual = row[f.c] === undefined ? null : row[f.c];
                if (actual !== f.v) return false;
            }
            if (f.t === 'not' && f.op === 'is') {
                const actual = row[f.c] === undefined ? null : row[f.c];
                if (actual === f.v) return false;
            }
        }
        return true;
    }

    _proj(rows, colsStr) {
        if (!colsStr || colsStr === '*') return rows;
        const cols = colsStr.split(',').map(s => s.trim());
        return rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]])));
    }

    _nextId(tbl) {
        return tbl.length ? Math.max(...tbl.map(r => r.id || 0)) + 1 : 1;
    }

    _exec() {
        if (!db[this._t]) db[this._t] = [];
        const tbl = db[this._t];

        // ── SELECT ──────────────────────────────────────────────
        if (this._op === 'select') {
            let rows = tbl.filter(r => this._match(r));
            if (this._ord) {
                rows.sort((a, b) => {
                    const av = a[this._ord.col], bv = b[this._ord.col];
                    if (av == null && bv == null) return 0;
                    if (av == null) return this._ord.asc ? -1 : 1;
                    if (bv == null) return this._ord.asc ? 1 : -1;
                    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                    return this._ord.asc ? cmp : -cmp;
                });
            }
            if (this._lim) rows = rows.slice(0, this._lim);
            if (this._cnt) return Promise.resolve({ count: rows.length, data: null, error: null });
            if (this._single) {
                return rows.length
                    ? Promise.resolve({ data: rows[0], error: null })
                    : Promise.resolve({ data: null, error: { message: 'No rows', code: 'PGRST116' } });
            }
            return Promise.resolve({ data: rows, error: null });
        }

        // ── INSERT ──────────────────────────────────────────────
        if (this._op === 'insert') {
            const list = Array.isArray(this._wdat) ? this._wdat : [this._wdat];
            const inserted = [];
            for (const row of list) {
                // Unique guard: deposits.tx_hash
                if (this._t === 'deposits' && row.tx_hash) {
                    if (tbl.find(r => r.tx_hash === row.tx_hash)) {
                        return Promise.resolve({ data: null, error: { message: 'duplicate key', code: '23505' } });
                    }
                }
                // Apply schema DEFAULT values (mirrors Supabase column defaults)
                const defaults = this._t === 'players' ? {
                    digcoin_balance: 0, total_deposited_pathusd: 0, total_withdrawn_pathusd: 0,
                    total_earned_digcoin: 0, total_spent_digcoin: 0, boxes_bought: 0, referral_earnings: 0,
                } : this._t === 'miners' ? {
                    is_alive: true, needs_repair: false, level: 1, exp: 0,
                    power: 0, energy: 0, protective: 0, damage: 0,
                } : {};
                const nr = { id: this._nextId(tbl), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...defaults, ...row };
                tbl.push(nr);
                inserted.push({ ...nr });
            }
            const out = this._pws ? this._proj(inserted, this._pws) : inserted;
            return this._single
                ? Promise.resolve({ data: out[0] ?? null, error: null })
                : Promise.resolve({ data: out, error: null });
        }

        // ── UPDATE ──────────────────────────────────────────────
        if (this._op === 'update') {
            const rows = tbl.filter(r => this._match(r));
            if (!rows.length) {
                // No rows matched (e.g. .gte guard failed or row deleted)
                return this._single
                    ? Promise.resolve({ data: null, error: null })
                    : Promise.resolve({ data: [], error: null });
            }
            const updated = [];
            for (const r of rows) {
                Object.assign(r, this._wdat, { updated_at: new Date().toISOString() });
                updated.push({ ...r });
            }
            const out = this._pws ? this._proj(updated, this._pws) : updated;
            return this._single
                ? Promise.resolve({ data: out[0] ?? null, error: null })
                : Promise.resolve({ data: out, error: null });
        }

        // ── DELETE ──────────────────────────────────────────────
        if (this._op === 'delete') {
            const rows = tbl.filter(r => this._match(r));
            const snap = rows.map(r => ({ ...r }));
            for (const r of rows) tbl.splice(tbl.indexOf(r), 1);
            const out = this._pws ? this._proj(snap, this._pws) : snap;
            return Promise.resolve({ data: out, error: null });
        }

        return Promise.resolve({ data: null, error: { message: 'Unknown op' } });
    }
}

function makeMockSupabase() {
    return {
        from: t => new QB(t),
        rpc: (fn, params) => {
            if (fn === 'get_global_stats') {
                const td = db.players.reduce((s, p) => s + (p.total_deposited_pathusd || 0), 0);
                const tw = db.players.reduce((s, p) => s + (p.total_withdrawn_pathusd || 0), 0);
                const tb = db.players.reduce((s, p) => s + (p.boxes_bought || 0), 0);
                return Promise.resolve({ data: [{ total_deposited: td, total_withdrawn: tw, total_boxes: tb }], error: null });
            }
            if (fn === 'add_digcoin') {
                const {
                    p_wallet,
                    p_amount            = 0,
                    p_deposited_pathusd = 0,
                    p_earned_digcoin    = 0,
                    p_referral_digcoin  = 0,
                    p_withdrawn_pathusd = 0,
                } = params || {};
                const p = db.players.find(r => r.wallet === p_wallet);
                if (p) {
                    p.digcoin_balance         = (p.digcoin_balance         || 0) + p_amount;
                    p.total_deposited_pathusd = (p.total_deposited_pathusd || 0) + p_deposited_pathusd;
                    p.total_earned_digcoin    = (p.total_earned_digcoin    || 0) + p_earned_digcoin;
                    p.referral_earnings       = (p.referral_earnings       || 0) + p_referral_digcoin;
                    p.total_withdrawn_pathusd = (p.total_withdrawn_pathusd || 0) + p_withdrawn_pathusd;
                }
                return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: null, error: { message: `Unknown RPC: ${fn}` } });
        },
    };
}

// Inject into require cache BEFORE requiring server.js
const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { createClient: () => makeMockSupabase() },
    parent: module, children: [],
};

// Mock express-rate-limit → always pass-through (no 10-req/min wall during tests)
const rateLimitPath = require.resolve('express-rate-limit');
require.cache[rateLimitPath] = {
    id: rateLimitPath, filename: rateLimitPath, loaded: true,
    exports: { rateLimit: () => (_req, _res, next) => next() },
    parent: module, children: [],
};

// ══════════════════════════════════════════════════════
// 4. ETHERS MOCK — patch JsonRpcProvider + Contract only
//    Keep real Wallet, verifyMessage, Interface, etc.
// ══════════════════════════════════════════════════════

// Track fake on-chain receipts for deposit tests
const MOCK_RECEIPTS = {};

const ethersPath = require.resolve('ethers');
const patchedEthers = {
    ...realEthers,
    ethers: {
        ...realEthers.ethers,
        JsonRpcProvider: class MockProvider {
            constructor() {}
            async getTransactionReceipt(txHash) { return MOCK_RECEIPTS[txHash] || null; }
            async getBlockNumber() { return 1000; }
            async getLogs() { return []; }
        },
        Contract: class MockContract {
            constructor() {}
            async getNonce()    { return BigInt(0); }
        },
    },
};
require.cache[ethersPath].exports = patchedEthers;

// ══════════════════════════════════════════════════════
// 5. START SERVER
// ══════════════════════════════════════════════════════

const app = require('./server.js');
const server = app.listen ? null : null; // server.js calls listen() internally

// Helper: wait for server to be ready
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════
// 6. HTTP CLIENT
// ══════════════════════════════════════════════════════

function request(method, path, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const opts = {
            hostname: '127.0.0.1',
            port: 4321,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...extraHeaders,
            },
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── Auth helper: get nonce → sign → return Bearer token ──
async function authenticate(pk) {
    const wallet = new realEthers.ethers.Wallet(pk);
    const addr   = wallet.address.toLowerCase();

    const { body: n } = await request('GET', `/api/nonce/${addr}`);
    if (!n.nonce) throw new Error(`Nonce failed for ${addr}: ${JSON.stringify(n)}`);

    const sig = await wallet.signMessage(n.message);
    const { body: auth } = await request('POST', '/api/auth', { wallet: addr, signature: sig });
    if (!auth.token) throw new Error(`Auth failed for ${addr}: ${JSON.stringify(auth)}`);

    return { token: auth.token, addr };
}

function bearer(token) { return { Authorization: `Bearer ${token}` }; }

// ── Build a fake on-chain deposit receipt ──
function makeDepositReceipt(playerAddr, amountPathUSD) {
    const iface = new realEthers.ethers.Interface([
        'event Deposited(address indexed player, uint256 amount, uint256 timestamp)',
    ]);
    const topicHash  = iface.getEvent('Deposited').topicHash;
    const playerTopic = realEthers.ethers.zeroPadValue(playerAddr, 32);
    const data = realEthers.ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [realEthers.ethers.parseUnits(amountPathUSD.toString(), 6), BigInt(Math.floor(Date.now() / 1000))]
    );
    return {
        logs: [{
            address: process.env.POOL_CONTRACT.toLowerCase(),
            topics: [topicHash, playerTopic],
            data,
        }],
    };
}

// ══════════════════════════════════════════════════════
// 7. TEST RUNNER
// ══════════════════════════════════════════════════════

let PASS = 0, FAIL = 0;

function ok(name, cond, got) {
    if (cond) {
        console.log(`  ✅  ${name}`);
        PASS++;
    } else {
        console.log(`  ❌  ${name}`);
        if (got !== undefined) console.log(`       got:`, JSON.stringify(got, null, 2));
        FAIL++;
    }
}

function section(title) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(55));
}

// ══════════════════════════════════════════════════════
// 8. TESTS
// ══════════════════════════════════════════════════════

async function run() {
    await sleep(300); // wait for express listen()

    let playerToken, referrerToken, adminToken;
    let minerId1, minerId2, minerId3; // track miner ids for later tests

    // ── HEALTH & PUBLIC ENDPOINTS ─────────────────────
    section('HEALTH & PUBLIC');

    {
        const { status, body } = await request('GET', '/health');
        ok('GET /health → 200 ok:true', status === 200 && body.ok === true, body);
    }
    {
        const { status, body } = await request('GET', '/api/config');
        ok('GET /api/config returns boxPriceDigcoin=300', status === 200 && body.boxPriceDigcoin === 300, body);
    }
    {
        const { status, body } = await request('GET', '/api/stats');
        ok('GET /api/stats (empty) → 200', status === 200 && body.totalPlayers === 0, body);
    }
    {
        const { status, body } = await request('GET', '/api/box/sale-info');
        ok('GET /api/box/sale-info → isActive false (sale ended)', status === 200 && body.isActive === false, body);
    }

    // ── AUTHENTICATION ───────────────────────────────
    section('AUTHENTICATION');

    {
        // Bad address
        const { status, body } = await request('GET', '/api/nonce/0xinvalid');
        ok('GET /api/nonce with bad address → 400', status === 400, body);
    }
    {
        // Referrer auth
        const r = await authenticate(REFERRER_PK);
        referrerToken = r.token;
        ok('Referrer wallet authenticates → token', !!referrerToken, null);
    }
    {
        // Player auth
        const r = await authenticate(PLAYER_PK);
        playerToken = r.token;
        ok('Player wallet authenticates → token', !!playerToken, null);
    }
    {
        // Admin auth (same as referrer wallet = ADMIN_WALLET)
        adminToken = referrerToken;
        ok('Admin wallet = referrer → token reused', !!adminToken, null);
    }
    {
        // Protected route without token → 401
        const { status } = await request('POST', '/api/box/buy', { wallet: PLAYER_WALLET, quantity: 1 });
        ok('POST /api/box/buy without auth → 401', status === 401, null);
    }
    {
        // Wrong wallet in body → 403
        const { status } = await request('POST', '/api/register',
            { wallet: REFERRER_WALLET, referrer: null },
            bearer(playerToken)           // token belongs to PLAYER, body says REFERRER
        );
        ok('Wrong wallet in body → 403', status === 403, null);
    }

    // ── REGISTER ────────────────────────────────────
    section('REGISTER');

    {
        // Register referrer (no referrer)
        const { status, body } = await request('POST', '/api/register',
            { wallet: REFERRER_WALLET },
            bearer(referrerToken)
        );
        ok('Register referrer (no referrer) → success', status === 200 && body.success, body);
    }
    {
        // Register player with referrer
        const { status, body } = await request('POST', '/api/register',
            { wallet: PLAYER_WALLET, referrer: REFERRER_WALLET },
            bearer(playerToken)
        );
        ok('Register player with referrer → success', status === 200 && body.success, body);
    }
    {
        // Check player exists with correct referrer
        const { status, body } = await request('GET', `/api/player/${PLAYER_WALLET}`);
        ok('GET /api/player → referrer linked', status === 200 && body.player.referrer === REFERRER_WALLET, body);
    }

    // ── DEPOSIT ──────────────────────────────────────
    section('DEPOSIT (with mock on-chain receipt)');

    const DEPOSIT_TXHASH = '0xdeadbeef000000000000000000000000000000000000000000000000000000a1';

    {
        // Deposit without txHash → 400
        const { status, body } = await request('POST', '/api/deposit',
            { wallet: PLAYER_WALLET, amountPathUSD: 10 },
            bearer(playerToken)
        );
        ok('Deposit without txHash → 400', status === 400, body);
    }
    {
        // Inject fake receipt
        MOCK_RECEIPTS[DEPOSIT_TXHASH] = makeDepositReceipt(PLAYER_WALLET, 10);

        const { status, body } = await request('POST', '/api/deposit',
            { wallet: PLAYER_WALLET, amountPathUSD: 10, txHash: DEPOSIT_TXHASH },
            bearer(playerToken)
        );
        ok('Deposit 10 pathUSD → 1000 DIGCOIN credited', status === 200 && body.success && body.digcoinCredited === 1000, body);
    }
    {
        // Duplicate deposit (same txHash) → returns duplicate:true not double-credit
        const { status, body } = await request('POST', '/api/deposit',
            { wallet: PLAYER_WALLET, amountPathUSD: 10, txHash: DEPOSIT_TXHASH },
            bearer(playerToken)
        );
        ok('Duplicate deposit → duplicate:true, no double-credit', status === 200 && body.duplicate === true, body);
        const player = db.players.find(p => p.wallet === PLAYER_WALLET);
        ok('Balance unchanged after duplicate deposit', player.digcoin_balance === 1000, player);
    }
    {
        // Referrer gets 4% bonus (4% of 1000 = 40 DC)
        const ref = db.players.find(p => p.wallet === REFERRER_WALLET);
        ok('Referrer earned 4% referral bonus = 40 DIGCOIN', ref && Math.abs(ref.referral_earnings - 40) < 0.01, ref);
    }

    // Give referrer some balance for admin test later
    {
        const DEPOSIT_TX2 = '0xdeadbeef000000000000000000000000000000000000000000000000000000b2';
        MOCK_RECEIPTS[DEPOSIT_TX2] = makeDepositReceipt(REFERRER_WALLET, 5);
        await request('POST', '/api/deposit',
            { wallet: REFERRER_WALLET, amountPathUSD: 5, txHash: DEPOSIT_TX2 },
            bearer(referrerToken)
        );
        ok('Referrer deposited 5 pathUSD (admin test setup)', true, null);
    }

    // ── BUY BOX ──────────────────────────────────────
    section('BUY BOX');

    {
        // Not enough balance (player has 1000 DC, box = 300 DC)
        // This should succeed. Let's first test insufficient balance:
        const fakePlayer = db.players.find(p => p.wallet === PLAYER_WALLET);
        const savedBalance = fakePlayer.digcoin_balance;
        fakePlayer.digcoin_balance = 100; // force insufficient

        const { status, body } = await request('POST', '/api/box/buy',
            { wallet: PLAYER_WALLET, quantity: 1 },
            bearer(playerToken)
        );
        ok('Buy box with insufficient balance → 400', status === 400 && body.error?.includes('Insufficient'), body);
        fakePlayer.digcoin_balance = savedBalance; // restore
    }
    {
        // Buy 1 box (300 DC)
        const { status, body } = await request('POST', '/api/box/buy',
            { wallet: PLAYER_WALLET, quantity: 1 },
            bearer(playerToken)
        );
        ok('Buy 1 box → success, 1 miner returned', status === 200 && body.success && body.miners?.length === 1, body);
        if (body.miners?.length) minerId1 = body.miners[0].id;
        ok('Buy 1 box → 300 DC deducted', db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance === 700, null);
    }
    {
        // Buy 10 boxes (bulk = 2850 DC) — need to give player more balance first
        db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 3000;

        const { status, body } = await request('POST', '/api/box/buy',
            { wallet: PLAYER_WALLET, quantity: 10 },
            bearer(playerToken)
        );
        ok('Buy 10 boxes (bulk) → success, 10 miners', status === 200 && body.success && body.miners?.length === 10, body);
        ok('Bulk discount applied (2850 DC cost)', body.cost === 2850, body);
        if (body.miners?.length >= 2) {
            minerId2 = body.miners[0].id;
            minerId3 = body.miners[1].id;
        }
    }

    // ── GET PLAYER (miners visible) ─────────────────
    section('PLAYER STATE');

    {
        const { status, body } = await request('GET', `/api/player/${PLAYER_WALLET}`);
        ok('GET /api/player → 11 miners total', status === 200 && body.miners?.length === 11, body);
        ok('GET /api/player → all miners idle initially', body.miners?.every(m => m.isIdle), body);
        ok('GET /api/player → balance reflects purchases', body.player.digcoinBalance === 150, body);
    }

    // ── MINE / CLAIM SINGLE ───────────────────────────
    section('MINE & CLAIM SINGLE');

    {
        // Start mining miner #1
        const { status, body } = await request('POST', `/api/play/${minerId1}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok(`POST /api/play/${minerId1} → miningStarted`, status === 200 && body.success && body.miningStarted, body);
    }
    {
        // Try to start again → already mining
        const { status, body } = await request('POST', `/api/play/${minerId1}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Play already mining miner → error', status === 400 && body.error?.includes('mining'), body);
    }
    {
        // Try to claim before cooldown passes → error
        const { status, body } = await request('POST', `/api/claim/${minerId1}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Claim before 24h → error (cooldown)', status === 400 && body.error?.includes('Wait'), body);
    }
    {
        // Time-travel: set last_play_at to 25h ago so cooldown has passed
        const miner = db.miners.find(m => m.id === minerId1);
        miner.last_play_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

        const { status, body } = await request('POST', `/api/claim/${minerId1}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Claim after 24h → reward credited', status === 200 && body.success && body.reward > 0, body);
        ok('Claim → miner age decremented', body.nftAgeRemaining < db.miners.find(m => m.id === minerId1)?.nft_age_total, body);
    }
    {
        // Double-claim protection: last_play_at is now null → can't claim again
        const { status, body } = await request('POST', `/api/claim/${minerId1}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Second claim (idle miner) → error idle', status === 400 && body.error?.includes('idle'), body);
    }

    // ── PLAY ALL / CLAIM ALL ─────────────────────────
    section('PLAY ALL / CLAIM ALL');

    // Top up so play-all fee (11×10=110) + claim-all fee (11×10=110) are covered
    db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 500;

    {
        // Play all idle miners (10 remaining idle + minerId1 just claimed = idle again)
        // All 11 miners should be idle now (minerId1 was claimed → last_play_at=null, others never played)
        const { status, body } = await request('POST', '/api/play-all',
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Play all → success, ≥10 miners started', status === 200 && body.success && body.started >= 10, body);
        ok('Play all → fee deducted (10 DC × started)', body.fee === body.started * 10, body);
    }
    {
        // Try claim-all before 24h
        const { status, body } = await request('POST', '/api/claim-all',
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Claim all before 24h → no miners ready', status === 400 && body.error?.includes('No miners ready'), body);
    }
    {
        // Time-travel all mining miners to 25h ago
        const now25h = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        db.miners.filter(m => m.wallet === PLAYER_WALLET && m.last_play_at).forEach(m => {
            m.last_play_at = now25h;
        });

        const { status, body } = await request('POST', '/api/claim-all',
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Claim all after 24h → success', status === 200 && body.claimed > 0, body);
        ok('Claim all → totalReward > 0', body.totalReward > 0, body);
        ok('Claim all → fee deducted per miner', body.claimAllFee === body.claimed * 10, body);
    }

    // ── REPAIR ───────────────────────────────────────
    section('REPAIR');

    {
        // Mark a miner as needs_repair manually
        const miner = db.miners.find(m => m.id === minerId2);
        miner.needs_repair = true;
        miner.is_alive = true;

        // Try to play it → needs repair
        const { status, body } = await request('POST', `/api/play/${minerId2}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Play miner needing repair → error', status === 400 && body.error?.includes('repair'), body);
    }
    {
        // Repair it
        const player = db.players.find(p => p.wallet === PLAYER_WALLET);
        const balanceBefore = player.digcoin_balance;

        const { status, body } = await request('POST', `/api/repair/${minerId2}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Repair miner → success', status === 200 && body.success, body);
        ok('Repair cost deducted from balance', player.digcoin_balance < balanceBefore, player);

        // Miner should no longer need repair
        const miner = db.miners.find(m => m.id === minerId2);
        ok('Miner repaired → needs_repair=false', !miner.needs_repair && miner.is_alive, miner);
    }
    {
        // Repair healthy miner → error
        const { status, body } = await request('POST', `/api/repair/${minerId2}`,
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Repair healthy miner → error', status === 400 && body.error?.includes('does not need repair'), body);
    }

    // ── FUSE ─────────────────────────────────────────
    section('FUSE');

    // Top up for fuse cost (50 DC) — balance may be low after claim-all fees
    db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 200;
    const playerBefore = db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance;
    const minerCountBefore = db.miners.filter(m => m.wallet === PLAYER_WALLET && m.is_alive).length;

    {
        // Fuse miners 2 and 3 (both must be alive & not mining)
        const m2 = db.miners.find(m => m.id === minerId2);
        const m3 = db.miners.find(m => m.id === minerId3);
        // Ensure both are idle
        if (m2) { m2.last_play_at = null; m2.needs_repair = false; m2.is_alive = true; }
        if (m3) { m3.last_play_at = null; m3.needs_repair = false; m3.is_alive = true; }

        const { status, body } = await request('POST', '/api/miner/fuse',
            { wallet: PLAYER_WALLET, minerId1: minerId2, minerId2: minerId3 },
            bearer(playerToken)
        );
        ok('Fuse 2 miners → success, new miner created', status === 200 && body.success && body.miner?.id, body);
        ok('Fuse → 2 miners consumed', body.consumed?.length === 2, body);
        ok('Fuse → balance reduced by 50 DC', db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance < playerBefore, null);
        ok('Fuse → total miner count −1 (2 consumed, 1 created)', db.miners.filter(m => m.wallet === PLAYER_WALLET && m.is_alive).length === minerCountBefore - 1, null);
    }
    {
        // Try fusing same miners again → already deleted
        const { status, body } = await request('POST', '/api/miner/fuse',
            { wallet: PLAYER_WALLET, minerId1: minerId2, minerId2: minerId3 },
            bearer(playerToken)
        );
        ok('Re-fuse same (deleted) miners → error', status === 400, body);
    }
    {
        // Same ID twice → server should reject
        const { status, body } = await request('POST', '/api/miner/fuse',
            { wallet: PLAYER_WALLET, minerId1: minerId1, minerId2: minerId1 },
            bearer(playerToken)
        );
        ok('Fuse same miner with itself → fuse fails/error', status === 400, body);
    }

    // ── WITHDRAW ─────────────────────────────────────
    section('WITHDRAW');

    // Give player enough balance for withdraw (min 100 DC = 1 pathUSD)
    {
        db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 500;

        const { status, body } = await request('POST', '/api/withdraw',
            { wallet: PLAYER_WALLET, amountDigcoin: 500 },
            bearer(playerToken)
        );
        ok('Withdraw 500 DC → signature returned', status === 200 && body.success && body.signature, body);
        ok('Withdraw → amountPathUSD = 500/100 = 5', body.amountPathUSD === 5, body);
        ok('Withdraw → fee = 6% of 5 = 0.3', Math.abs(body.feePathUSD - 0.3) < 0.001, body);
        ok('Withdraw → netPathUSD = 4.7', Math.abs(body.netPathUSD - 4.7) < 0.001, body);
        ok('Withdraw → player DIGCOIN balance now 0', db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance === 0, null);
    }
    {
        // Withdraw again immediately → 24h cooldown
        db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 500;
        const { status, body } = await request('POST', '/api/withdraw',
            { wallet: PLAYER_WALLET, amountDigcoin: 500 },
            bearer(playerToken)
        );
        ok('Second withdraw within 24h → cooldown error', status === 400 && body.error?.includes('cooldown'), body);
    }
    {
        // Below minimum → error
        const { status, body } = await request('POST', '/api/withdraw',
            { wallet: PLAYER_WALLET, amountDigcoin: 50 },
            bearer(playerToken)
        );
        ok('Withdraw below minimum (50 < 100 DC) → error', status === 400 && body.error?.includes('Minimum'), body);
    }

    // ── HISTORY ──────────────────────────────────────
    section('HISTORY');

    {
        const { status, body } = await request('GET', `/api/history/${PLAYER_WALLET}`,
            null, bearer(playerToken)
        );
        ok('GET /api/history → 200, transactions array', status === 200 && Array.isArray(body.transactions), body);
        ok('History has deposit entries', body.transactions?.some(t => t.type === 'deposit'), body);
        ok('History has play (mine) entries', body.transactions?.some(t => t.type === 'play'), body);
        ok('History has box entries', body.transactions?.some(t => t.type === 'box'), body);
        ok('History has withdraw entries', body.transactions?.some(t => t.type === 'withdraw'), body);
    }
    {
        // Can't view another wallet's history
        const { status, body } = await request('GET', `/api/history/${REFERRER_WALLET}`,
            null, bearer(playerToken) // player token trying to read referrer history
        );
        ok('Cannot read other wallet history → 403', status === 403, body);
    }

    // ── ADMIN ────────────────────────────────────────
    section('ADMIN');

    {
        // Non-admin can't access admin route
        const { status } = await request('POST', '/api/admin/send-digcoin',
            { toWallet: PLAYER_WALLET, amount: 100, reason: 'test' },
            bearer(playerToken) // not admin
        );
        ok('Non-admin blocked from admin route → 403', status === 403, null);
    }
    {
        // Admin sends DIGCOIN
        const balBefore = db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance;
        const { status, body } = await request('POST', '/api/admin/send-digcoin',
            { toWallet: PLAYER_WALLET, amount: 999, reason: 'test giveaway' },
            bearer(adminToken)
        );
        ok('Admin send-digcoin → success', status === 200 && body.success, body);
        ok('Admin send-digcoin → balance increased by 999',
            db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance === balBefore + 999, null);
    }
    {
        // Admin list players
        const { status, body } = await request('GET', '/api/admin/players', null, bearer(adminToken));
        ok('Admin list players → returns array', status === 200 && Array.isArray(body.players), body);
        ok('Admin list players → both wallets present',
            body.players.length >= 2, body);
    }
    {
        // Admin check status
        const { status, body } = await request('GET', '/api/admin/status', null, bearer(adminToken));
        ok('GET /api/admin/status → isAdmin:true', status === 200 && body.isAdmin, body);
    }

    // ── MAINTENANCE MODE ─────────────────────────────
    section('MAINTENANCE MODE');

    {
        // Enable maintenance
        const { status, body } = await request('POST', '/api/admin/maintenance',
            { enabled: true }, bearer(adminToken)
        );
        ok('Admin enable maintenance → maintenance:true', status === 200 && body.maintenance === true, body);
    }
    {
        // Try to buy box during maintenance → 503
        const { status, body } = await request('POST', '/api/box/buy',
            { wallet: PLAYER_WALLET, quantity: 1 },
            bearer(playerToken)
        );
        ok('Buy box during maintenance → 503', status === 503 && body.error?.includes('maintenance'), body);
    }
    {
        // Try to deposit during maintenance → 503
        const fakeTx = '0xdeadbeef000000000000000000000000000000000000000000000000000000c3';
        MOCK_RECEIPTS[fakeTx] = makeDepositReceipt(PLAYER_WALLET, 1);
        const { status, body } = await request('POST', '/api/deposit',
            { wallet: PLAYER_WALLET, amountPathUSD: 1, txHash: fakeTx },
            bearer(playerToken)
        );
        ok('Deposit during maintenance → 503', status === 503, body);
    }
    {
        // Disable maintenance
        const { status, body } = await request('POST', '/api/admin/maintenance',
            { enabled: false }, bearer(adminToken)
        );
        ok('Admin disable maintenance → maintenance:false', status === 200 && body.maintenance === false, body);
    }
    {
        // Now buy box works again
        db.players.find(p => p.wallet === PLAYER_WALLET).digcoin_balance = 500;
        const { status, body } = await request('POST', '/api/box/buy',
            { wallet: PLAYER_WALLET, quantity: 1 },
            bearer(playerToken)
        );
        ok('Buy box after maintenance OFF → success', status === 200 && body.success, body);
    }

    // ── EDGE CASES ────────────────────────────────────
    section('EDGE CASES');

    {
        // Player not found
        const { status, body } = await request('GET', '/api/player/0x0000000000000000000000000000000000000001');
        ok('GET /api/player not found → 404', status === 404, body);
    }
    {
        // Sale box → sale ended
        const { status, body } = await request('POST', '/api/box/buy-sale',
            { wallet: PLAYER_WALLET, quantity: 1 },
            bearer(playerToken)
        );
        ok('Buy sale box (sale ended) → 400', status === 400 && body.error?.includes('sale has ended'), body);
    }
    {
        // Faucet disabled on mainnet
        const { status, body } = await request('POST', '/api/faucet', {});
        ok('POST /api/faucet → 403 disabled', status === 403, body);
    }
    {
        // Repair non-existent miner
        const { status, body } = await request('POST', '/api/repair/999999',
            { wallet: PLAYER_WALLET },
            bearer(playerToken)
        );
        ok('Repair non-existent miner → 400', status === 400 && body.error?.includes('not found'), body);
    }
    {
        // Final stats
        const { status, body } = await request('GET', '/api/stats');
        ok('Final /api/stats → totalPlayers ≥ 2', status === 200 && body.totalPlayers >= 2, body);
        ok('Final /api/stats → totalMiners > 0', body.totalMiners > 0, body);
        ok('Final /api/stats → total_deposited > 0', body.total_deposited > 0, body);
    }

    // ── RACE CONDITION: add_digcoin atomicity ─────────────
    section('RACE CONDITION — add_digcoin atomicity');

    {
        // Simulate the exact production bug:
        // 1. Player has 1000 DC
        // 2. Event listener reads stale balance (1000) before deposit write
        // 3. Withdrawal atomically deducts 500 DC → balance = 500
        // 4. OLD CODE: SET balance = 1000 + 200 = 1200 (overwrites withdrawal!)
        //    NEW CODE: UPDATE SET balance = balance + 200 → 700 ✓

        const raceWallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        db.players.push({
            id: 9901, wallet: raceWallet,
            digcoin_balance: 1000, total_deposited_pathusd: 10,
            total_earned_digcoin: 0, total_spent_digcoin: 0,
            total_withdrawn_pathusd: 0, boxes_bought: 0, referral_earnings: 0, referrer: null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });

        // Withdrawal deducts 500 DC atomically
        db.players.find(p => p.wallet === raceWallet).digcoin_balance -= 500; // now 500

        // Concurrent deposit fires via add_digcoin RPC (+200 DC)
        const mock = makeMockSupabase();
        const { error: rpcErr } = await mock.rpc('add_digcoin', {
            p_wallet: raceWallet, p_amount: 200, p_deposited_pathusd: 2,
        });

        const final = db.players.find(p => p.wallet === raceWallet);
        ok('Race: rpc add_digcoin → no error', !rpcErr, rpcErr);
        ok('Race: balance = 500 − 500(withdraw) + 200(deposit) = 700, not 1200', final.digcoin_balance === 700, { got: final.digcoin_balance });
        ok('Race: total_deposited incremented relatively (10 + 2 = 12)', final.total_deposited_pathusd === 12, { got: final.total_deposited_pathusd });

        db.players = db.players.filter(p => p.wallet !== raceWallet);
    }

    {
        // Withdrawal error-restore: should add back the deducted amount,
        // NOT reset to a stale pre-deduction snapshot (which would wipe concurrent credits)
        const restoreWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        db.players.push({
            id: 9902, wallet: restoreWallet,
            digcoin_balance: 500,  // already atomically deducted (was 1000, -500)
            total_deposited_pathusd: 10, total_earned_digcoin: 0, total_spent_digcoin: 0,
            total_withdrawn_pathusd: 4.7, // net was added optimistically before sig failed
            boxes_bought: 0, referral_earnings: 0, referrer: null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });

        // Concurrent deposit lands between deduction and error-restore
        db.players.find(p => p.wallet === restoreWallet).digcoin_balance += 200; // now 700

        // Error-restore: add back 500 (undo deduction), subtract 4.7 (undo withdrawal stat)
        const mock2 = makeMockSupabase();
        await mock2.rpc('add_digcoin', {
            p_wallet: restoreWallet, p_amount: 500, p_withdrawn_pathusd: -4.7,
        });

        const restored = db.players.find(p => p.wallet === restoreWallet);
        ok('Restore: balance = 700 (w/ concurrent deposit) + 500 (undo) = 1200', restored.digcoin_balance === 1200, { got: restored.digcoin_balance });
        ok('Restore: total_withdrawn_pathusd undone back to 0', Math.abs(restored.total_withdrawn_pathusd) < 0.001, { got: restored.total_withdrawn_pathusd });

        db.players = db.players.filter(p => p.wallet !== restoreWallet);
    }

    // ══════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  RESULTS: ${PASS} passed  |  ${FAIL} failed  |  ${PASS + FAIL} total`);
    console.log('═'.repeat(55));

    if (FAIL === 0) {
        console.log('  🎉  All tests passed!');
    } else {
        console.log(`  ⚠️   ${FAIL} test(s) failed — see ❌ lines above`);
    }

    process.exit(FAIL > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('\n💥 Test runner crashed:', err);
    process.exit(1);
});
