#!/usr/bin/env node
/**
 * DigMiner — Sale Box Full Test Suite
 * ════════════════════════════════════
 * Cobre todos os cenários da Sale Box limitada:
 *   • Info endpoint (global/wallet counts)
 *   • Compra unitária (150 DC, miner criado)
 *   • Compra múltipla
 *   • Miner da sale box funciona: mine → claim → repair
 *   • Limite por wallet (max 50)
 *   • Limite global (max 2000 → sold out)
 *   • Histórico inclui compras da sale box
 *   • Config público expõe campos da sale box
 *   • Segurança: sem auth, wallet errada
 *
 * Run: node test_sale_box.js
 */

'use strict';

const Module = require('module');
const http   = require('http');

// ─── Real ethers ANTES do patch ──────────────────────────────────────────────
const realEthers = require('ethers');

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testWallet       = new realEthers.Wallet(TEST_PRIVATE_KEY);
const TEST_ADDRESS     = testWallet.address.toLowerCase();

const PORT = 3098;
const POOL  = '0x0000000000000000000000000000000000000001';

// ─── Mock de depósito ────────────────────────────────────────────────────────
let _mockReceiptLogs = [];
function prepareMockDeposit(wallet, amountPathUSD) {
    const iface = new realEthers.Interface([
        'event Deposited(address indexed player, uint256 amount, uint256 timestamp)',
    ]);
    const amountWei = realEthers.parseUnits(amountPathUSD.toFixed(6), 6);
    const ts        = BigInt(Math.floor(Date.now() / 1000));
    const encoded   = iface.encodeEventLog(iface.getEvent('Deposited'), [wallet, amountWei, ts]);
    _mockReceiptLogs = [{ address: POOL, ...encoded }];
}

// ─── Provider e Contract mockados ────────────────────────────────────────────
class MockProvider {
    async getTransactionReceipt() {
        return { status: 1, blockNumber: 9999, logs: _mockReceiptLogs };
    }
    async getBlockNumber() { return 9999; }
    async getLogs()        { return [];    }
}
class MockContract {
    async getNonce() { return BigInt(1); }
}

// ─── Patch do module loader ───────────────────────────────────────────────────
const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
        return { createClient: () => mockSupabase };
    }
    if (request === 'express-rate-limit') {
        return { rateLimit: () => (_req, _res, next) => next() };
    }
    if (request === 'ethers') {
        const makeProxy = (target) => new Proxy(target, {
            get(t, prop) {
                if (prop === 'JsonRpcProvider') return MockProvider;
                if (prop === 'Contract')        return MockContract;
                if (prop === 'ethers')          return makeProxy(t[prop] ?? t);
                const val = t[prop];
                if (typeof val === 'function') return val.bind(t);
                return val;
            },
        });
        return makeProxy(realEthers);
    }
    return origLoad(request, parent, isMain);
};

// ─── Banco em memória ─────────────────────────────────────────────────────────
let _idCounter = 1;
function nextId() { return _idCounter++; }

const DB = {
    players:      [],
    miners:       [],
    deposits:     [],
    withdrawals:  [],
    play_history: [],
    box_purchases:[],
    referrals:    [],
    repairs:      [],
};

const TABLE_DEFAULTS = {
    players: {
        digcoin_balance: 0, total_deposited_pathusd: 0, total_withdrawn_pathusd: 0,
        total_earned_digcoin: 0, total_spent_digcoin: 0,
        boxes_bought: 0, referral_earnings: 0, referrer: null,
    },
    miners: {
        is_alive: true, needs_repair: false, last_play_at: null,
        exp: 0, level: 1,
    },
};

// ─── Query Builder ────────────────────────────────────────────────────────────
class QB {
    constructor(table) {
        this.t   = table;
        this._f  = [];
        this._upd = null;
        this._ins = null;
        this._del = false;
        this._single     = false;
        this._countMode  = false;
    }

    _clone() {
        const q = new QB(this.t);
        q._f    = [...this._f];
        q._upd  = this._upd;
        q._ins  = this._ins;
        q._del  = this._del;
        q._single    = this._single;
        q._countMode = this._countMode;
        return q;
    }

    select(_fields, opts = {}) { const q = this._clone(); if (opts.count) q._countMode = true; return q; }
    eq(col, val)   { const q = this._clone(); q._f.push(r => r[col] === val);              return q; }
    neq(col, val)  { const q = this._clone(); q._f.push(r => r[col] !== val);              return q; }
    gte(col, val)  { const q = this._clone(); q._f.push(r => r[col] >= val);               return q; }
    in(col, vals)  { const q = this._clone(); q._f.push(r => vals.includes(r[col]));       return q; }
    order()        { return this._clone(); }
    limit(n)       { const q = this._clone(); q._lim = n; return q; }
    single()       { const q = this._clone(); q._single = true; return q; }

    is(col, val) {
        const q = this._clone();
        q._f.push(val === null ? r => r[col] === null || r[col] === undefined : r => r[col] === val);
        return q;
    }
    not(col, op, val) {
        const q = this._clone();
        if (op === 'is' && val === null) q._f.push(r => r[col] !== null && r[col] !== undefined);
        else                             q._f.push(r => r[col] !== val);
        return q;
    }

    update(upd) { const q = this._clone(); q._upd = upd; return q; }

    insert(rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        const defs = TABLE_DEFAULTS[this.t] || {};
        const inserted = arr.map(r => ({
            id: nextId(), created_at: new Date().toISOString(),
            ...defs, ...r,
        }));
        if (!DB[this.t]) DB[this.t] = [];
        DB[this.t].push(...inserted);
        const q = this._clone(); q._ins = inserted; return q;
    }

    delete() { const q = this._clone(); q._del = true; return q; }

    _rows() {
        let rows = (DB[this.t] || []);
        for (const f of this._f) rows = rows.filter(f);
        if (this._lim) rows = rows.slice(0, this._lim);
        return rows;
    }

    then(resolve, reject) {
        try {
            if (this._ins) {
                if (this._single) return resolve({ data: this._ins[0] || null, error: null });
                return resolve({ data: this._ins, error: null });
            }
            if (this._del) {
                DB[this.t] = (DB[this.t] || []).filter(r => !this._f.every(f => f(r)));
                return resolve({ data: null, error: null });
            }
            if (this._upd !== null) {
                const matched = [];
                for (const r of (DB[this.t] || [])) {
                    if (this._f.every(f => f(r))) {
                        Object.assign(r, this._upd);
                        matched.push(r);
                    }
                }
                return resolve({ data: matched.length ? matched : null, error: null });
            }
            if (this._countMode) return resolve({ count: this._rows().length, error: null });
            const rows = this._rows();
            if (this._single) {
                return resolve({
                    data:  rows[0] || null,
                    error: rows[0] ? null : { message: 'No rows found', code: 'PGRST116' },
                });
            }
            resolve({ data: rows, error: null });
        } catch (err) { reject(err); }
    }
}

const mockSupabase = {
    from: (table) => new QB(table),
    rpc:  (name)  => {
        if (name === 'get_global_stats') {
            const deps  = DB.deposits.reduce((s, d) => s + (d.amount_pathusd || 0), 0);
            const withs = DB.withdrawals.filter(w => w.status === 'ready').reduce((s, w) => s + (w.net_pathusd || 0), 0);
            return Promise.resolve({ data: [{ total_deposited: deps, total_withdrawn: withs }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
    },
};

// ─── ENV ──────────────────────────────────────────────────────────────────────
process.env.PORT               = String(PORT);
process.env.SUPABASE_URL       = 'http://mock-supabase';
process.env.SUPABASE_SERVICE_KEY = 'mock-key';
process.env.RPC_URL            = 'http://mock-rpc';
process.env.CHAIN_ID           = '4217';
process.env.POOL_CONTRACT      = POOL;
process.env.SIGNER_PRIVATE_KEY = TEST_PRIVATE_KEY.replace('0x', '');
process.env.ADMIN_WALLET       = '';

console.log('\n[TEST] Iniciando servidor de teste (porta ' + PORT + ')...');
require('./server.js');

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function apiReq(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'localhost', port: PORT, path, method,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        };
        const r = http.request(opts, res => {
            let buf = '';
            res.on('data', c => (buf += c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
                catch { resolve({ status: res.statusCode, body: buf }); }
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getAuthToken() {
    const { body: ch } = await apiReq('GET', `/api/nonce/${TEST_ADDRESS}`);
    if (!ch.message) throw new Error('Nonce inválido: ' + JSON.stringify(ch));
    const sig = await testWallet.signMessage(ch.message);
    const { body: auth } = await apiReq('POST', '/api/auth', { wallet: TEST_ADDRESS, signature: sig });
    if (!auth.token) throw new Error('Auth falhou: ' + JSON.stringify(auth));
    return auth.token;
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const log = [];

function check(name, ok, detail = '') {
    if (ok) { passed++; log.push(`  ✅ ${name}`); }
    else     { failed++; log.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) {
    log.push(`\n── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
    await new Promise(r => setTimeout(r, 700));

    let token, H, saleMiner1Id;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   DigMiner — Sale Box Full Test Suite            ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // ── AUTH + SETUP ─────────────────────────────────────────────────────────
    section('AUTH + REGISTRO + DEPÓSITO');
    try {
        token = await getAuthToken();
        check('Auth token recebido', !!token);
    } catch (e) {
        check('Auth flow', false, e.message);
        printReport(); return;
    }
    H = { Authorization: `Bearer ${token}` };

    const reg = await apiReq('POST', '/api/register', { wallet: TEST_ADDRESS }, H);
    check('Registro → 200', reg.status === 200, JSON.stringify(reg.body));

    // Depositar 30 pathUSD = 3000 DC (suficiente para vários testes)
    prepareMockDeposit(TEST_ADDRESS, 30);
    const dep = await apiReq('POST', '/api/deposit',
        { wallet: TEST_ADDRESS, amountPathUSD: 30, txHash: '0xSALE_SETUP_TX' }, H);
    check('Depósito 30 pathUSD → 200', dep.status === 200, JSON.stringify(dep.body));
    check('3000 DC creditados', dep.body?.digcoinCredited === 3000,
        `credited=${dep.body?.digcoinCredited}`);

    // ── CONFIG PÚBLICO — campos da sale box ──────────────────────────────────
    section('CONFIG PÚBLICO — campos da Sale Box');
    const cfg = await apiReq('GET', '/api/config');
    check('GET /api/config → 200', cfg.status === 200);
    check('saleBoxPriceDigcoin = 150', cfg.body?.saleBoxPriceDigcoin === 150,
        `price=${cfg.body?.saleBoxPriceDigcoin}`);
    check('saleBoxMaxTotal = 2000', cfg.body?.saleBoxMaxTotal === 2000,
        `maxTotal=${cfg.body?.saleBoxMaxTotal}`);
    check('saleBoxMaxPerWallet = 50', cfg.body?.saleBoxMaxPerWallet === 50,
        `maxWallet=${cfg.body?.saleBoxMaxPerWallet}`);

    // ── SALE BOX INFO — estado inicial ───────────────────────────────────────
    section('SALE BOX INFO — estado inicial (0 vendidas)');
    const info0 = await apiReq('GET', `/api/box/sale-info?wallet=${TEST_ADDRESS}`);
    check('GET /api/box/sale-info → 200', info0.status === 200, JSON.stringify(info0.body));
    check('totalSold = 0', info0.body?.totalSold === 0,
        `totalSold=${info0.body?.totalSold}`);
    check('walletBought = 0', info0.body?.walletBought === 0,
        `walletBought=${info0.body?.walletBought}`);
    check('globalRemaining = 2000', info0.body?.globalRemaining === 2000,
        `globalRemaining=${info0.body?.globalRemaining}`);
    check('walletRemaining = 50', info0.body?.walletRemaining === 50,
        `walletRemaining=${info0.body?.walletRemaining}`);
    check('price = 150', info0.body?.price === 150,
        `price=${info0.body?.price}`);

    // ── COMPRA — 1 SALE BOX ──────────────────────────────────────────────────
    section('COMPRA — 1 Sale Box (150 DC)');
    const balBefore1 = (await apiReq('GET', `/api/player/${TEST_ADDRESS}`)).body?.player?.digcoinBalance;
    const sale1 = await apiReq('POST', '/api/box/buy-sale', { wallet: TEST_ADDRESS, quantity: 1 }, H);
    check('POST /api/box/buy-sale qty=1 → 200', sale1.status === 200, JSON.stringify(sale1.body));
    check('Retornou 1 minerador', sale1.body?.miners?.length === 1,
        `miners=${sale1.body?.miners?.length}`);
    check('saleBox=true na resposta', sale1.body?.saleBox === true,
        JSON.stringify(sale1.body));
    check('Custo = 150 DC', sale1.body?.cost === 150,
        `cost=${sale1.body?.cost}`);
    if (sale1.body?.miners?.[0]) {
        saleMiner1Id = sale1.body.miners[0].id;
        check('Minerador tem ID', Number.isInteger(saleMiner1Id), `id=${saleMiner1Id}`);
        check('Minerador tem raridade válida', !!sale1.body.miners[0].rarityName);
        check('Minerador tem dailyDigcoin > 0', (sale1.body.miners[0].dailyDigcoin || 0) > 0);
        check('ROI calculado com base em 150 DC',
            (sale1.body.miners[0].roi || 0) <= 9,  // 150/18 ≈ 8.3 dias (melhor caso)
            `roi=${sale1.body.miners[0].roi}`);
    }

    // Saldo debitado corretamente
    const gp1 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    const balAfter1 = gp1.body?.player?.digcoinBalance;
    check('Saldo debitado em 150 DC', Math.abs((balBefore1 - balAfter1) - 150) < 0.01,
        `antes=${balBefore1} depois=${balAfter1}`);

    // ── SALE BOX INFO — após 1 compra ────────────────────────────────────────
    section('SALE BOX INFO — após 1 compra');
    const info1 = await apiReq('GET', `/api/box/sale-info?wallet=${TEST_ADDRESS}`);
    check('totalSold = 1', info1.body?.totalSold === 1,
        `totalSold=${info1.body?.totalSold}`);
    check('walletBought = 1', info1.body?.walletBought === 1,
        `walletBought=${info1.body?.walletBought}`);
    check('globalRemaining = 1999', info1.body?.globalRemaining === 1999,
        `globalRemaining=${info1.body?.globalRemaining}`);
    check('walletRemaining = 49', info1.body?.walletRemaining === 49,
        `walletRemaining=${info1.body?.walletRemaining}`);

    // ── COMPRA — 3 SALE BOXES DE UMA VEZ ────────────────────────────────────
    section('COMPRA — 3 Sale Boxes (450 DC total)');
    const balBefore3 = (await apiReq('GET', `/api/player/${TEST_ADDRESS}`)).body?.player?.digcoinBalance;
    const sale3 = await apiReq('POST', '/api/box/buy-sale', { wallet: TEST_ADDRESS, quantity: 3 }, H);
    check('POST /api/box/buy-sale qty=3 → 200', sale3.status === 200, JSON.stringify(sale3.body));
    check('Retornou 3 mineradores', sale3.body?.miners?.length === 3,
        `miners=${sale3.body?.miners?.length}`);
    check('Custo total = 450 DC', sale3.body?.cost === 450,
        `cost=${sale3.body?.cost}`);

    const balAfter3 = (await apiReq('GET', `/api/player/${TEST_ADDRESS}`)).body?.player?.digcoinBalance;
    check('Saldo debitado em 450 DC', Math.abs((balBefore3 - balAfter3) - 450) < 0.01,
        `antes=${balBefore3} depois=${balAfter3}`);

    // Info atualizada: 4 compradas no total
    const info4 = await apiReq('GET', `/api/box/sale-info?wallet=${TEST_ADDRESS}`);
    check('totalSold = 4 após as 3 compras', info4.body?.totalSold === 4,
        `totalSold=${info4.body?.totalSold}`);
    check('walletBought = 4', info4.body?.walletBought === 4,
        `walletBought=${info4.body?.walletBought}`);

    // ── GAMEPLAY DO MINER DA SALE BOX ────────────────────────────────────────
    section('GAMEPLAY — Miner da Sale Box funciona normalmente');

    // Iniciar mineração
    const play = await apiReq('POST', `/api/play/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('Mine → 200 (miner da sale box)', play.status === 200, JSON.stringify(play.body));
    check('miningStarted = true', play.body?.miningStarted === true);

    // Tentar minerar de novo (já em progresso)
    const playDup = await apiReq('POST', `/api/play/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('Mine duplo → 400 (já minerando)', playDup.status === 400, JSON.stringify(playDup.body));

    // Claim antecipado deve falhar
    const earlyC = await apiReq('POST', `/api/claim/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('Claim < 24h → 400', earlyC.status === 400, JSON.stringify(earlyC.body));

    // Avançar tempo 25h para esse miner
    const ago25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const minerInDB = DB.miners.find(m => m.id === saleMiner1Id);
    if (minerInDB) minerInDB.last_play_at = ago25h;

    // Claim após 25h
    const claim = await apiReq('POST', `/api/claim/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('Claim após 25h → 200', claim.status === 200, JSON.stringify(claim.body));
    check('reward > 0 DC', (claim.body?.reward || 0) > 0, `reward=${claim.body?.reward}`);
    check('nftAgeRemaining diminuiu', Number.isInteger(claim.body?.nftAgeRemaining),
        `age=${claim.body?.nftAgeRemaining}`);

    // Minerar e claimar de novo (ciclo completo)
    const play2 = await apiReq('POST', `/api/play/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('Mine novamente após claim → 200', play2.status === 200);
    if (minerInDB) minerInDB.last_play_at = ago25h;
    const claim2 = await apiReq('POST', `/api/claim/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
    check('2º Claim → 200', claim2.status === 200, JSON.stringify(claim2.body));
    check('2º Reward > 0', (claim2.body?.reward || 0) > 0);

    // ── REPAIR DO MINER DA SALE BOX ──────────────────────────────────────────
    section('REPAIR — Miner da Sale Box');
    if (minerInDB) {
        const balBeforeRep = (await apiReq('GET', `/api/player/${TEST_ADDRESS}`)).body?.player?.digcoinBalance;
        minerInDB.is_alive    = false;
        minerInDB.needs_repair = true;

        const rep = await apiReq('POST', `/api/repair/${saleMiner1Id}`, { wallet: TEST_ADDRESS }, H);
        check('Repair miner da sale box → 200', rep.status === 200, JSON.stringify(rep.body));
        check('costDigcoin > 0', (rep.body?.costDigcoin || 0) > 0,
            `cost=${rep.body?.costDigcoin}`);
        check('Miner voltou à vida (is_alive=true)', minerInDB.is_alive === true);
        check('needs_repair=false', minerInDB.needs_repair === false);
        check('nft_age_remaining restaurado ao total',
            minerInDB.nft_age_remaining === minerInDB.nft_age_total,
            `rem=${minerInDB.nft_age_remaining} total=${minerInDB.nft_age_total}`);

        const balAfterRep = (await apiReq('GET', `/api/player/${TEST_ADDRESS}`)).body?.player?.digcoinBalance;
        check('Saldo debitado pelo repair', balAfterRep < balBeforeRep,
            `antes=${balBeforeRep} depois=${balAfterRep}`);
    }

    // ── MINE ALL com miners da sale box ──────────────────────────────────────
    section('MINE ALL / CLAIM ALL — inclui miners da sale box');
    const idleCount = DB.miners.filter(m => m.wallet === TEST_ADDRESS && m.is_alive && !m.needs_repair && m.last_play_at === null).length;
    if (idleCount > 0) {
        const gpPreMineAll = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
        const balPreMineAll = gpPreMineAll.body?.player?.digcoinBalance;
        const playAll = await apiReq('POST', '/api/play-all', { wallet: TEST_ADDRESS }, H);
        check('Mine All → 200', playAll.status === 200, JSON.stringify(playAll.body));
        check(`Mine All iniciou ${idleCount} miners`, playAll.body?.started === idleCount,
            `started=${playAll.body?.started} expected=${idleCount}`);

        // Avançar tempo para todos
        for (const m of DB.miners) {
            if (m.wallet === TEST_ADDRESS && m.last_play_at !== null) m.last_play_at = ago25h;
        }

        const claimAll = await apiReq('POST', '/api/claim-all', { wallet: TEST_ADDRESS }, H);
        check('Claim All → 200', claimAll.status === 200, JSON.stringify(claimAll.body));
        check('Claimed ≥ 1', (claimAll.body?.claimed || 0) >= 1,
            `claimed=${claimAll.body?.claimed}`);
        check('totalReward > 0', (claimAll.body?.totalReward || 0) > 0);
    } else {
        check('Mine All / Claim All (sem ociosos — SKIP)', true);
    }

    // ── LIMITE POR WALLET (max 50) ────────────────────────────────────────────
    section('LIMITE POR WALLET — max 50 sale boxes');
    // Quantas já foram compradas por essa wallet?
    const alreadyBought = DB.box_purchases.filter(b => b.wallet === TEST_ADDRESS && b.box_type === 'sale').length;
    const toInject = 50 - alreadyBought;

    if (toInject > 0) {
        // Injeta diretamente no DB para simular que a wallet já comprou 50
        for (let i = 0; i < toInject; i++) {
            DB.box_purchases.push({
                id: nextId(), wallet: TEST_ADDRESS, miner_id: null,
                cost_digcoin: 150, box_type: 'sale',
                created_at: new Date().toISOString(),
            });
        }
    }

    // Verificar que info reflete o limite atingido
    const infoLimit = await apiReq('GET', `/api/box/sale-info?wallet=${TEST_ADDRESS}`);
    check('walletBought = 50 após injeção', infoLimit.body?.walletBought === 50,
        `walletBought=${infoLimit.body?.walletBought}`);
    check('walletRemaining = 0', infoLimit.body?.walletRemaining === 0,
        `walletRemaining=${infoLimit.body?.walletRemaining}`);

    // Tentar comprar mais deve falhar com erro de wallet limit
    const overWallet = await apiReq('POST', '/api/box/buy-sale', { wallet: TEST_ADDRESS, quantity: 1 }, H);
    check('Compra além do limite por wallet → 400', overWallet.status === 400,
        JSON.stringify(overWallet.body));
    check('Mensagem menciona limite da wallet',
        typeof overWallet.body?.error === 'string' &&
        (overWallet.body.error.toLowerCase().includes('limit') || overWallet.body.error.toLowerCase().includes('wallet')),
        overWallet.body?.error);

    // ── LIMITE GLOBAL (max 2000 → sold out) ──────────────────────────────────
    section('LIMITE GLOBAL — sold out (2000 boxes)');
    // Zera wallet desse player para poder tentar comprar (senão bate no wallet limit primeiro)
    // Usa uma segunda wallet diferente para o teste de sold-out
    const TEST_PRIVATE_KEY_2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const wallet2 = new realEthers.Wallet(TEST_PRIVATE_KEY_2);
    const ADDR2   = wallet2.address.toLowerCase();

    // Auth para wallet2
    let token2;
    try {
        const { body: ch2 } = await apiReq('GET', `/api/nonce/${ADDR2}`);
        const sig2 = await wallet2.signMessage(ch2.message);
        const { body: auth2 } = await apiReq('POST', '/api/auth', { wallet: ADDR2, signature: sig2 });
        token2 = auth2.token;
        check('Auth wallet2 → ok', !!token2);
    } catch (e) {
        check('Auth wallet2', false, e.message);
        token2 = null;
    }

    if (token2) {
        const H2 = { Authorization: `Bearer ${token2}` };
        await apiReq('POST', '/api/register', { wallet: ADDR2 }, H2);

        // Depositar para wallet2
        prepareMockDeposit(ADDR2, 5);
        await apiReq('POST', '/api/deposit', { wallet: ADDR2, amountPathUSD: 5, txHash: '0xSOLDOUT_TX' }, H2);

        // Injetar no DB o suficiente para que o total global chegue a 2000
        const currentTotal = DB.box_purchases.filter(b => b.box_type === 'sale').length;
        const toFill = 2000 - currentTotal;
        if (toFill > 0) {
            for (let i = 0; i < toFill; i++) {
                DB.box_purchases.push({
                    id: nextId(), wallet: '0xfiller', miner_id: null,
                    cost_digcoin: 150, box_type: 'sale',
                    created_at: new Date().toISOString(),
                });
            }
        }

        // Verificar que info global diz sold out
        const infoSO = await apiReq('GET', `/api/box/sale-info?wallet=${ADDR2}`);
        check('globalRemaining = 0 (sold out)', infoSO.body?.globalRemaining === 0,
            `globalRemaining=${infoSO.body?.globalRemaining}`);
        check('totalSold = 2000', infoSO.body?.totalSold === 2000,
            `totalSold=${infoSO.body?.totalSold}`);

        // Tentar comprar deve falhar com sold out
        const soldOut = await apiReq('POST', '/api/box/buy-sale', { wallet: ADDR2, quantity: 1 }, H2);
        check('Compra após sold out → 400', soldOut.status === 400,
            JSON.stringify(soldOut.body));
        check('Mensagem menciona sold out',
            typeof soldOut.body?.error === 'string' &&
            soldOut.body.error.toLowerCase().includes('sold out'),
            soldOut.body?.error);

        // Saldo da wallet2 NÃO deve ter sido debitado
        const gp2Check = await apiReq('GET', `/api/player/${ADDR2}`);
        check('Saldo wallet2 intacto (nenhum débito no sold out)',
            (gp2Check.body?.player?.digcoinBalance || 0) === 500,
            `balance=${gp2Check.body?.player?.digcoinBalance}`);
    }

    // ── HISTÓRICO — compras da sale box aparecem ─────────────────────────────
    section('HISTÓRICO — compras da Sale Box aparecem');
    const hist = await apiReq('GET', `/api/history/${TEST_ADDRESS}`, null, H);
    check('GET /api/history → 200', hist.status === 200);
    const txTypes = new Set((hist.body?.transactions || []).map(t => t.type));
    check('Histórico contém compras de box (sale box usa tipo box)', txTypes.has('box'),
        `tipos=${[...txTypes].join(',')}`);
    // Sale box entries têm custo 150 DC
    const saleBoxTx = (hist.body?.transactions || []).filter(
        t => t.type === 'box' && Math.abs(Math.abs(t.amount) - 150) < 1
    );
    check('Histórico tem transações com custo 150 DC', saleBoxTx.length >= 1,
        `encontradas=${saleBoxTx.length}`);

    // ── SEGURANÇA ─────────────────────────────────────────────────────────────
    section('SEGURANÇA — Sale Box endpoints');

    // Sem token → 401
    const noAuth = await apiReq('POST', '/api/box/buy-sale', { wallet: TEST_ADDRESS, quantity: 1 });
    check('buy-sale sem token → 401', noAuth.status === 401, JSON.stringify(noAuth.body));

    // Wallet no body ≠ token → 403
    const wrongW = await apiReq('POST', '/api/box/buy-sale',
        { wallet: '0x0000000000000000000000000000000000000099', quantity: 1 }, H);
    check('Wallet no body ≠ token → 403', wrongW.status === 403, JSON.stringify(wrongW.body));

    // sale-info sem wallet → não deve quebrar (wallet vazia = padrão)
    const infoNoWallet = await apiReq('GET', '/api/box/sale-info');
    check('GET /api/box/sale-info sem wallet → 200 (não quebra)', infoNoWallet.status === 200,
        JSON.stringify(infoNoWallet.body));

    // ── INTEGRIDADE — regular box não afeta contagem da sale box ─────────────
    section('INTEGRIDADE — compra de box regular não afeta sale-info');
    // Re-injetar saldo para poder comprar uma box regular
    const playerReg = DB.players.find(p => p.wallet === TEST_ADDRESS);
    if (playerReg) playerReg.digcoin_balance += 300;

    // Resetar o sold-out para poder testar a caixa regular sem problemas
    // (A wallet já está no limite, mas o endpoint regular /api/box/buy não tem essa restrição)
    const totalBeforeSaleInfo = DB.box_purchases.filter(b => b.box_type === 'sale').length;
    const boxReg = await apiReq('POST', '/api/box/buy', { wallet: TEST_ADDRESS, quantity: 1 }, H);
    check('Box regular → 200', boxReg.status === 200, JSON.stringify(boxReg.body));
    const totalAfterSaleInfo = DB.box_purchases.filter(b => b.box_type === 'sale').length;
    check('Contagem de sale boxes NÃO aumentou com compra regular',
        totalBeforeSaleInfo === totalAfterSaleInfo,
        `antes=${totalBeforeSaleInfo} depois=${totalAfterSaleInfo}`);

    // box_purchases da box regular não tem box_type='sale'
    const lastPurchase = DB.box_purchases[DB.box_purchases.length - 1];
    check('box_type da compra regular ≠ sale',
        lastPurchase?.box_type !== 'sale',
        `box_type=${lastPurchase?.box_type}`);

    printReport();
}

function printReport() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║                   RESULTADO                     ║');
    console.log('╚══════════════════════════════════════════════════╝');
    for (const line of log) console.log(line);
    const total = passed + failed;
    console.log('\n' + '═'.repeat(52));
    console.log(`  Total: ${total}  |  ✅ Passou: ${passed}  |  ❌ Falhou: ${failed}`);
    console.log('═'.repeat(52) + '\n');
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('\n💥 Erro fatal:', err.message, err.stack);
    process.exit(1);
});
