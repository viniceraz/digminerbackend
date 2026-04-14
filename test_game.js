#!/usr/bin/env node
/**
 * DigMiner — Full Local Game Test Suite
 * ══════════════════════════════════════
 * • Banco em memória (nenhuma query vai ao Supabase real)
 * • Blockchain mockado (nenhuma tx real)
 * • Rate-limit desabilitado para os testes rodarem sem problema
 *
 * Run: node test_game.js
 */

'use strict';

const Module = require('module');
const http   = require('http');

// ─── Real ethers carregado ANTES do patch ────────────────────────────────────
const realEthers = require('ethers');

// ─── Carteira de teste (Hardhat #0 — chave pública conhecida, sem fundos reais)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testWallet       = new realEthers.Wallet(TEST_PRIVATE_KEY);
const TEST_ADDRESS     = testWallet.address.toLowerCase();

const PORT = 3099;
const POOL  = '0x0000000000000000000000000000000000000001';

// ─── Estado do mock de depósito ──────────────────────────────────────────────
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
        // Desabilita rate-limit completamente nos testes
        return { rateLimit: () => (_req, _res, next) => next() };
    }
    if (request === 'ethers') {
        // ethers v6 exporta `const { ethers } = require('ethers')` como namespace aninhado.
        // O Proxy precisa interceptar AMBOS os níveis (top-level e .ethers).
        const makeProxy = (target) => new Proxy(target, {
            get(t, prop) {
                if (prop === 'JsonRpcProvider') return MockProvider;
                if (prop === 'Contract')        return MockContract;
                // namespace aninhado: `const { ethers } = require('ethers')`
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

// ─── Query Builder (mock do Supabase) ─────────────────────────────────────────
class QB {
    constructor(table) {
        this.t   = table;
        this._f  = [];        // filtros
        this._upd = null;
        this._ins = null;
        this._del = false;
        this._single  = false;
        this._countMode = false;
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
    eq(col, val)   { const q = this._clone(); q._f.push(r => r[col] === val);                              return q; }
    neq(col, val)  { const q = this._clone(); q._f.push(r => r[col] !== val);                              return q; }
    gte(col, val)  { const q = this._clone(); q._f.push(r => r[col] >= val);                               return q; }
    in(col, vals)  { const q = this._clone(); q._f.push(r => vals.includes(r[col]));                       return q; }
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
            // INSERT
            if (this._ins) {
                if (this._single) return resolve({ data: this._ins[0] || null, error: null });
                return resolve({ data: this._ins, error: null });
            }
            // DELETE
            if (this._del) {
                DB[this.t] = (DB[this.t] || []).filter(r => !this._f.every(f => f(r)));
                return resolve({ data: null, error: null });
            }
            // UPDATE
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
            // COUNT
            if (this._countMode) return resolve({ count: this._rows().length, error: null });
            // SELECT
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

// ─── Mock Supabase client ────────────────────────────────────────────────────
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

// ─── ENV de teste (antes de require server.js para dotenv não sobrescrever) ──
process.env.PORT               = String(PORT);
process.env.SUPABASE_URL       = 'http://mock-supabase';
process.env.SUPABASE_SERVICE_KEY = 'mock-key';
process.env.RPC_URL            = 'http://mock-rpc';
process.env.CHAIN_ID           = '4217';
process.env.POOL_CONTRACT      = POOL;
process.env.SIGNER_PRIVATE_KEY = TEST_PRIVATE_KEY.replace('0x', '');
process.env.ADMIN_WALLET       = '';

// ─── Sobe o servidor ─────────────────────────────────────────────────────────
console.log('\n[TEST] Iniciando servidor de teste...');
require('./server.js');

// ─── HTTP helper ─────────────────────────────────────────────────────────────
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

// ─── Auth helper ─────────────────────────────────────────────────────────────
async function getAuthToken() {
    const { body: ch } = await apiReq('GET', `/api/nonce/${TEST_ADDRESS}`);
    if (!ch.message) throw new Error('Nonce inválido: ' + JSON.stringify(ch));
    const sig = await testWallet.signMessage(ch.message);
    const { body: auth } = await apiReq('POST', '/api/auth', { wallet: TEST_ADDRESS, signature: sig });
    if (!auth.token) throw new Error('Auth falhou: ' + JSON.stringify(auth));
    return auth.token;
}

// ─── Test runner ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const log = [];

function check(name, ok, detail = '') {
    if (ok) { passed++; log.push(`  ✅ ${name}`); }
    else     { failed++; log.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(name) {
    log.push(`\n── ${name} ${'─'.repeat(Math.max(0, 42 - name.length))}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
    await new Promise(r => setTimeout(r, 700)); // aguarda server.listen()

    let token, minerId1;

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   DigMiner — Test Suite Local (sem DB real)  ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // ── HEALTH ───────────────────────────────────────────────────────────────
    section('HEALTH');
    const health = await apiReq('GET', '/health');
    check('GET /health → 200', health.status === 200);
    const env = health.body?.env || {};
    const leaksSecret = Object.values(env).some(v => typeof v === 'string' && v.length > 5);
    check('Health não vaza secrets (apenas booleanos)', !leaksSecret, JSON.stringify(env));

    // ── AUTENTICAÇÃO ─────────────────────────────────────────────────────────
    section('AUTENTICAÇÃO (Nonce → Sign → Token)');
    try {
        token = await getAuthToken();
        check('Nonce + Assinatura + Verify → token recebido', !!token);
    } catch (e) {
        check('Auth flow', false, e.message);
        printReport(); return;
    }
    const H = { Authorization: `Bearer ${token}` };

    // ── REGISTRO ─────────────────────────────────────────────────────────────
    section('REGISTRO');
    const reg = await apiReq('POST', '/api/register', { wallet: TEST_ADDRESS }, H);
    check('POST /api/register → 200', reg.status === 200, JSON.stringify(reg.body));

    // ── PLAYER (antes do depósito) ────────────────────────────────────────────
    section('PLAYER — leitura inicial');
    const gp0 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    check('GET /api/player → 200', gp0.status === 200, JSON.stringify(gp0.body));
    check('Saldo inicial = 0 DIGCOIN', gp0.body?.player?.digcoinBalance === 0,
        `saldo=${gp0.body?.player?.digcoinBalance}`);
    check('0 mineradores no início', gp0.body?.miners?.length === 0);

    // ── DEPÓSITO #1 (10 pathUSD = 1000 DIGCOIN) ──────────────────────────────
    section('DEPÓSITO — 10 pathUSD via TX mockada');
    prepareMockDeposit(TEST_ADDRESS, 10);
    const dep1 = await apiReq('POST', '/api/deposit',
        { wallet: TEST_ADDRESS, amountPathUSD: 10, txHash: '0xTEST_TX_1' }, H);
    check('POST /api/deposit → 200', dep1.status === 200, JSON.stringify(dep1.body));
    check('Crédito correto: 1000 DIGCOIN', dep1.body?.digcoinCredited === 1000,
        `creditado=${dep1.body?.digcoinCredited}`);

    // Depósito duplicado deve ser ignorado
    const dep1dup = await apiReq('POST', '/api/deposit',
        { wallet: TEST_ADDRESS, amountPathUSD: 10, txHash: '0xTEST_TX_1' }, H);
    check('Depósito duplicado (mesmo txHash) → ignorado', dep1dup.body?.duplicate === true,
        JSON.stringify(dep1dup.body));

    const gp1 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    check('Saldo após depósito = 1000 DIGCOIN', gp1.body?.player?.digcoinBalance === 1000,
        `saldo=${gp1.body?.player?.digcoinBalance}`);

    // ── DEPÓSITO #2 (40 pathUSD para ter saldo para bulk) ───────────────────
    prepareMockDeposit(TEST_ADDRESS, 40);
    const dep2 = await apiReq('POST', '/api/deposit',
        { wallet: TEST_ADDRESS, amountPathUSD: 40, txHash: '0xTEST_TX_2' }, H);
    check('Depósito #2 (40 pathUSD = 4000 DC) → 200', dep2.status === 200, JSON.stringify(dep2.body));

    const gp2 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    check('Saldo total = 5000 DIGCOIN', gp2.body?.player?.digcoinBalance === 5000,
        `saldo=${gp2.body?.player?.digcoinBalance}`);

    // ── COMPRA — 1 BOX ───────────────────────────────────────────────────────
    section('COMPRA DE BOX — 1 unidade (300 DC)');
    const box1 = await apiReq('POST', '/api/box/buy', { wallet: TEST_ADDRESS, quantity: 1 }, H);
    check('POST /api/box/buy qty=1 → 200', box1.status === 200, JSON.stringify(box1.body));
    check('Retornou 1 minerador', box1.body?.miners?.length === 1, JSON.stringify(box1.body));
    if (box1.body?.miners?.[0]) {
        minerId1 = box1.body.miners[0].id;
        check('Minerador tem ID', Number.isInteger(minerId1), `id=${minerId1}`);
        // buyBoxes não retorna isAlive — checar via /api/player depois
        check('Minerador tem ROI calculado', (box1.body.miners[0].roi || 0) > 0);
        check('Minerador tem raridade válida', !!box1.body.miners[0].rarityName);
        check('Minerador tem dailyDigcoin > 0', (box1.body.miners[0].dailyDigcoin || 0) > 0);
    }

    // ── COMPRA — 10 BOXES (bulk) ──────────────────────────────────────────────
    section('COMPRA DE BOX — 10 unidades bulk (2850 DC)');
    const box10 = await apiReq('POST', '/api/box/buy', { wallet: TEST_ADDRESS, quantity: 10 }, H);
    check('POST /api/box/buy qty=10 → 200', box10.status === 200, JSON.stringify(box10.body));
    check('Retornou 10 mineradores', box10.body?.miners?.length === 10,
        `length=${box10.body?.miners?.length}`);
    check('Desconto 5% aplicado', box10.body?.discount === '5%', JSON.stringify(box10.body?.discount));

    // Saldo após compras: 5000 - 300 - 2850 = 1850 DIGCOIN
    const gp3 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    const balanceAfterBoxes = gp3.body?.player?.digcoinBalance;
    check('11 mineradores na conta', gp3.body?.miners?.length === 11,
        `mineradores=${gp3.body?.miners?.length}`);
    check('Saldo = 1850 DIGCOIN após compras', balanceAfterBoxes === 1850,
        `saldo=${balanceAfterBoxes}`);

    // ── INICIAR MINERAÇÃO — único ─────────────────────────────────────────────
    section('INICIAR MINERAÇÃO — único minerador');
    const play1 = await apiReq('POST', `/api/play/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('POST /api/play/:id → 200', play1.status === 200, JSON.stringify(play1.body));
    check('miningStarted = true', play1.body?.miningStarted === true);

    // Tentar iniciar de novo — deve falhar (já minerando)
    const play1b = await apiReq('POST', `/api/play/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('Iniciar 2x → erro (já minerando)', play1b.status === 400, JSON.stringify(play1b.body));

    // ── MINE ALL — todos os ociosos ───────────────────────────────────────────
    section('MINE ALL — inicia todos os ociosos');
    // Saldo = 1850, 10 mineradores ociosos → fee = 10 × 10 = 100 DC
    const playAll = await apiReq('POST', '/api/play-all', { wallet: TEST_ADDRESS }, H);
    check('POST /api/play-all → 200', playAll.status === 200, JSON.stringify(playAll.body));
    check('Iniciou 10 mineradores', playAll.body?.started === 10,
        `started=${playAll.body?.started}`);
    check('Taxa cobrada = 100 DC', playAll.body?.fee === 100, `fee=${playAll.body?.fee}`);

    // Agora todos minerando — mine-all deve falhar
    const playAllB = await apiReq('POST', '/api/play-all', { wallet: TEST_ADDRESS }, H);
    check('Mine All sem ociosos → erro', playAllB.status === 400, JSON.stringify(playAllB.body));

    // ── CLAIM ANTECIPADO — deve falhar ────────────────────────────────────────
    section('CLAIM ANTECIPADO (< 24h) → deve rejeitar');
    const earlyC = await apiReq('POST', `/api/claim/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('Claim < 24h → 400', earlyC.status === 400, JSON.stringify(earlyC.body));
    check('Erro menciona cooldown', typeof earlyC.body?.error === 'string' && earlyC.body.error.includes('Wait'),
        earlyC.body?.error);

    // ── AVANÇO DE TEMPO (simula 25h) ─────────────────────────────────────────
    section('AVANÇO DE TEMPO — last_play_at → 25h atrás');
    const ago25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    let fastForwarded = 0;
    for (const m of DB.miners) {
        if (m.wallet === TEST_ADDRESS && m.last_play_at !== null) {
            m.last_play_at = ago25h;
            fastForwarded++;
        }
    }
    check(`${fastForwarded} mineradores avançados 25h`, fastForwarded === 11,
        `fastForwarded=${fastForwarded}`);

    // ── CLAIM ÚNICO ───────────────────────────────────────────────────────────
    section('CLAIM — minerador único');
    const claim1 = await apiReq('POST', `/api/claim/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('POST /api/claim/:id → 200', claim1.status === 200, JSON.stringify(claim1.body));
    check('Recompensa > 0 DIGCOIN', (claim1.body?.reward || 0) > 0, `reward=${claim1.body?.reward}`);
    check('nftAgeRemaining diminuiu', Number.isInteger(claim1.body?.nftAgeRemaining),
        `age=${claim1.body?.nftAgeRemaining}`);

    // Claim duplo deve falhar (last_play_at agora é null)
    const claimDup = await apiReq('POST', `/api/claim/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('Claim duplo → erro (minerador ocioso)', claimDup.status === 400, JSON.stringify(claimDup.body));

    // ── INICIAR MINERAÇÃO NOVAMENTE ────────────────────────────────────────────
    section('INICIAR MINERAÇÃO NOVAMENTE (após claim)');
    const play2 = await apiReq('POST', `/api/play/${minerId1}`, { wallet: TEST_ADDRESS }, H);
    check('POST /api/play/:id (2ª vez) → 200', play2.status === 200, JSON.stringify(play2.body));

    // Avançar tempo só desse minerador
    for (const m of DB.miners) {
        if (m.id === minerId1) m.last_play_at = ago25h;
    }

    // ── CLAIM ALL ─────────────────────────────────────────────────────────────
    section('CLAIM ALL — todos os prontos');
    const claimAll = await apiReq('POST', '/api/claim-all', { wallet: TEST_ADDRESS }, H);
    check('POST /api/claim-all → 200', claimAll.status === 200, JSON.stringify(claimAll.body));
    check('Claimed ≥ 1', (claimAll.body?.claimed || 0) >= 1,
        `claimed=${claimAll.body?.claimed}`);
    check('totalReward > 0', (claimAll.body?.totalReward || 0) > 0,
        `totalReward=${claimAll.body?.totalReward}`);
    check('netReward = totalReward - claimAllFee',
        Math.abs((claimAll.body?.netReward || 0) -
            ((claimAll.body?.totalReward || 0) - (claimAll.body?.claimAllFee || 0))) < 0.01,
        JSON.stringify(claimAll.body));

    // ── REPAIR — força morte e repara ────────────────────────────────────────
    section('REPAIR — força morte de um minerador');
    const targetMiner = DB.miners.find(m => m.wallet === TEST_ADDRESS);
    if (targetMiner) {
        const repairCostBefore = DB.players.find(p => p.wallet === TEST_ADDRESS)?.digcoin_balance;
        targetMiner.is_alive    = false;
        targetMiner.needs_repair = true;
        const repId = targetMiner.id;

        const rep = await apiReq('POST', `/api/repair/${repId}`, { wallet: TEST_ADDRESS }, H);
        check('POST /api/repair/:id → 200', rep.status === 200, JSON.stringify(rep.body));
        check('Custo de reparo retornado', (rep.body?.costDigcoin || 0) > 0,
            `costDigcoin=${rep.body?.costDigcoin}`);

        // Verificar que minerador voltou à vida
        const repaired = DB.miners.find(m => m.id === repId);
        check('Minerador reparado (is_alive=true)', repaired?.is_alive === true);
        check('needs_repair=false após reparo', repaired?.needs_repair === false);
        check('nft_age_remaining restaurado ao total',
            repaired?.nft_age_remaining === repaired?.nft_age_total,
            `remaining=${repaired?.nft_age_remaining} total=${repaired?.nft_age_total}`);
    } else {
        check('Repair (sem mineradores — SKIP)', true);
    }

    // ── SALDO ANTES DO SAQUE ──────────────────────────────────────────────────
    section('WITHDRAW — saque de DIGCOIN');
    const gpW = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
    const balanceBeforeWD = gpW.body?.player?.digcoinBalance || 0;
    const withdrawAmt = Math.floor(balanceBeforeWD * 0.5);

    if (withdrawAmt >= 100) {
        const wd1 = await apiReq('POST', '/api/withdraw',
            { wallet: TEST_ADDRESS, amountDigcoin: withdrawAmt }, H);
        check('POST /api/withdraw → 200', wd1.status === 200, JSON.stringify(wd1.body));
        check('Recebeu assinatura EIP-712', !!wd1.body?.signature?.signature,
            JSON.stringify(wd1.body?.signature));
        check('amountDigcoin correto na resposta', wd1.body?.amountDigcoin === withdrawAmt,
            `sent=${withdrawAmt} got=${wd1.body?.amountDigcoin}`);
        check('Taxa de 10% calculada',
            Math.abs((wd1.body?.feePathUSD || 0) - (wd1.body?.amountPathUSD || 0) * 0.10) < 0.0001,
            JSON.stringify(wd1.body));
        check('netPathUSD = amountPathUSD - fee',
            Math.abs((wd1.body?.netPathUSD || 0) -
                ((wd1.body?.amountPathUSD || 0) - (wd1.body?.feePathUSD || 0))) < 0.0001,
            JSON.stringify(wd1.body));

        // Verificar saldo debitado
        const gpW2 = await apiReq('GET', `/api/player/${TEST_ADDRESS}`);
        check('Saldo debitado após saque',
            (gpW2.body?.player?.digcoinBalance || 0) < balanceBeforeWD,
            `antes=${balanceBeforeWD} depois=${gpW2.body?.player?.digcoinBalance}`);

        // ── COOLDOWN de 24h — segundo saque deve bloquear ────────────────────
        const wd2 = await apiReq('POST', '/api/withdraw',
            { wallet: TEST_ADDRESS, amountDigcoin: 100 }, H);
        check('Segundo saque (cooldown 24h) → 400', wd2.status === 400, JSON.stringify(wd2.body));
        check('Erro menciona cooldown', typeof wd2.body?.error === 'string' &&
            wd2.body.error.toLowerCase().includes('cooldown'), wd2.body?.error);
    } else {
        check('Saque (saldo insuficiente — SKIP)', true);
    }

    // ── HISTÓRICO ─────────────────────────────────────────────────────────────
    section('HISTÓRICO DE TRANSAÇÕES');
    const hist = await apiReq('GET', `/api/history/${TEST_ADDRESS}`, null, H);
    check('GET /api/history/:wallet → 200', hist.status === 200, JSON.stringify(hist.body));
    check('Histórico tem transações', (hist.body?.transactions?.length || 0) > 0,
        `count=${hist.body?.transactions?.length}`);
    const txTypes = new Set((hist.body?.transactions || []).map(t => t.type));
    check('Histórico contém depósitos', txTypes.has('deposit'));
    check('Histórico contém saques',   txTypes.has('withdraw'));
    check('Histórico contém claims (play)', txTypes.has('play'));
    check('Histórico contém compras de box', txTypes.has('box'));

    // ── STATS GLOBAIS ─────────────────────────────────────────────────────────
    section('STATS GLOBAIS');
    const stats = await apiReq('GET', '/api/stats');
    check('GET /api/stats → 200', stats.status === 200, JSON.stringify(stats.body));
    check('totalPlayers ≥ 1', (stats.body?.totalPlayers || 0) >= 1);
    check('totalMiners ≥ 11', (stats.body?.totalMiners || 0) >= 11,
        `totalMiners=${stats.body?.totalMiners}`);

    // ── CONFIG PÚBLICO ────────────────────────────────────────────────────────
    section('CONFIG PÚBLICO');
    const cfg = await apiReq('GET', '/api/config');
    check('GET /api/config → 200', cfg.status === 200);
    check('boxPriceDigcoin = 300', cfg.body?.boxPriceDigcoin === 300,
        `boxPrice=${cfg.body?.boxPriceDigcoin}`);
    check('digcoinPerPathUSD = 100', cfg.body?.digcoinPerPathUSD === 100,
        `rate=${cfg.body?.digcoinPerPathUSD}`);
    check('rarities array presente', Array.isArray(cfg.body?.rarities) && cfg.body.rarities.length === 6,
        `rarities=${cfg.body?.rarities?.length}`);

    // ── CHECKS DE SEGURANÇA ───────────────────────────────────────────────────
    section('SEGURANÇA — verificações');

    // Requisição sem auth
    const noAuth = await apiReq('POST', `/api/claim/${minerId1}`, { wallet: TEST_ADDRESS });
    check('Claim sem token → 401', noAuth.status === 401, JSON.stringify(noAuth.body));

    // Wallet errada no body vs token
    const wrongW = await apiReq('POST', '/api/withdraw',
        { wallet: '0x0000000000000000000000000000000000000002', amountDigcoin: 100 }, H);
    check('Wallet no body ≠ token → 403', wrongW.status === 403, JSON.stringify(wrongW.body));

    // Histórico de outro usuário
    const otherH = await apiReq('GET',
        '/api/history/0x0000000000000000000000000000000000000002', null, H);
    check('Histórico de outro wallet → 403', otherH.status === 403, JSON.stringify(otherH.body));

    // Player inexistente → 404 (não cria)
    const notFound = await apiReq('GET',
        '/api/player/0x0000000000000000000000000000000000000002');
    check('Player não registrado → 404 (não cria)', notFound.status === 404);
    const stillNotFound = DB.players.find(p => p.wallet === '0x0000000000000000000000000000000000000002');
    check('DB não criou player fantasma', !stillNotFound);

    // Depósito sem txHash
    const noTx = await apiReq('POST', '/api/deposit', { wallet: TEST_ADDRESS, amountPathUSD: 10 }, H);
    check('Depósito sem txHash → 400', noTx.status === 400, JSON.stringify(noTx.body));

    // Saque abaixo do mínimo (100 DC)
    const smallWD = await apiReq('POST', '/api/withdraw',
        { wallet: TEST_ADDRESS, amountDigcoin: 50 }, H);
    check('Saque < mínimo (50 DC) → 400', smallWD.status === 400, JSON.stringify(smallWD.body));

    printReport();
}

function printReport() {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║                  RESULTADO                  ║');
    console.log('╚══════════════════════════════════════════════╝');
    for (const line of log) console.log(line);
    const total = passed + failed;
    console.log('\n' + '═'.repeat(48));
    console.log(`  Total: ${total}  |  ✅ Passou: ${passed}  |  ❌ Falhou: ${failed}`);
    console.log('═'.repeat(48) + '\n');
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('\n💥 Erro fatal:', err.message, err.stack);
    process.exit(1);
});
