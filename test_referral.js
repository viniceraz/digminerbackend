'use strict';
const Module     = require('module');
const http       = require('http');
const realEthers = require('ethers');

const walletA = new realEthers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const walletB = new realEthers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const walletC = new realEthers.Wallet('0x0000000000000000000000000000000000000000000000000000000000000003');
const walletD = new realEthers.Wallet('0x0000000000000000000000000000000000000000000000000000000000000004');
const ADDR_A  = walletA.address.toLowerCase();
const ADDR_B  = walletB.address.toLowerCase();
const ADDR_C  = walletC.address.toLowerCase();
const ADDR_D  = walletD.address.toLowerCase();

const PORT = 3097;
const POOL = '0x0000000000000000000000000000000000000001';

let _mockLogs = [];
function mockDeposit(wallet, amt) {
    const iface = new realEthers.Interface(['event Deposited(address indexed player, uint256 amount, uint256 timestamp)']);
    const enc   = iface.encodeEventLog(iface.getEvent('Deposited'),
        [wallet, realEthers.parseUnits(amt.toFixed(6), 6), BigInt(Math.floor(Date.now() / 1000))]);
    _mockLogs = [{ address: POOL, ...enc }];
}

class MockProvider {
    async getTransactionReceipt() { return { status: 1, blockNumber: 9999, logs: _mockLogs }; }
    async getBlockNumber() { return 9999; }
    async getLogs() { return []; }
}
class MockContract {
    async getNonce() { return BigInt(1); }
}

let _idC = 1;
const DB = { players: [], miners: [], deposits: [], withdrawals: [], play_history: [], box_purchases: [], referrals: [], repairs: [] };
const DEFS = {
    players: { digcoin_balance: 0, total_deposited_pathusd: 0, total_withdrawn_pathusd: 0,
               total_earned_digcoin: 0, total_spent_digcoin: 0, boxes_bought: 0,
               referral_earnings: 0, referrer: null },
    miners: { is_alive: true, needs_repair: false, last_play_at: null, exp: 0, level: 1 },
};

class QB {
    constructor(t) { this.t=t; this._f=[]; this._upd=null; this._ins=null; this._del=false; this._single=false; this._countMode=false; }
    _clone() { const q=new QB(this.t); q._f=[...this._f]; q._upd=this._upd; q._ins=this._ins; q._del=this._del; q._single=this._single; q._countMode=this._countMode; return q; }
    select(_,o={}){ const q=this._clone(); if(o.count)q._countMode=true; return q; }
    eq(c,v)  { const q=this._clone(); q._f.push(r=>r[c]===v); return q; }
    neq(c,v) { const q=this._clone(); q._f.push(r=>r[c]!==v); return q; }
    gte(c,v) { const q=this._clone(); q._f.push(r=>r[c]>=v);  return q; }
    in(c,vs) { const q=this._clone(); q._f.push(r=>vs.includes(r[c])); return q; }
    order()  { return this._clone(); }
    limit(n) { const q=this._clone(); q._lim=n; return q; }
    single() { const q=this._clone(); q._single=true; return q; }
    is(c,v)  { const q=this._clone(); q._f.push(v===null ? r=>r[c]==null : r=>r[c]===v); return q; }
    not(c,op,v) { const q=this._clone(); q._f.push(op==='is'&&v===null ? r=>r[c]!=null : r=>r[c]!==v); return q; }
    update(u){ const q=this._clone(); q._upd=u; return q; }
    insert(rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        const ins = arr.map(r => ({ id: _idC++, created_at: new Date().toISOString(), ...(DEFS[this.t]||{}), ...r }));
        if (!DB[this.t]) DB[this.t] = [];
        DB[this.t].push(...ins);
        const q = this._clone(); q._ins = ins; return q;
    }
    delete() { const q=this._clone(); q._del=true; return q; }
    _rows()  { let r=(DB[this.t]||[]); for(const f of this._f) r=r.filter(f); if(this._lim) r=r.slice(0,this._lim); return r; }
    then(resolve, reject) {
        try {
            if (this._ins) return resolve({ data: this._single ? this._ins[0]||null : this._ins, error: null });
            if (this._del) { DB[this.t]=(DB[this.t]||[]).filter(r=>!this._f.every(f=>f(r))); return resolve({data:null,error:null}); }
            if (this._upd !== null) {
                const m = [];
                for (const r of (DB[this.t]||[])) { if (this._f.every(f=>f(r))) { Object.assign(r,this._upd); m.push(r); } }
                return resolve({ data: m.length ? m : null, error: null });
            }
            if (this._countMode) return resolve({ count: this._rows().length, error: null });
            const rows = this._rows();
            if (this._single) return resolve({ data: rows[0]||null, error: rows[0] ? null : { message:'No rows', code:'PGRST116' } });
            resolve({ data: rows, error: null });
        } catch(e) { reject(e); }
    }
}

const mockSupabase = {
    from: t => new QB(t),
    rpc:  () => Promise.resolve({ data: [{ total_deposited: 0, total_withdrawn: 0 }], error: null }),
};

const origLoad = Module._load.bind(Module);
Module._load = function(req, parent, isMain) {
    if (req === '@supabase/supabase-js') return { createClient: () => mockSupabase };
    if (req === 'express-rate-limit')    return { rateLimit: () => (_,__,next) => next() };
    if (req === 'ethers') {
        const mk = t => new Proxy(t, { get(t,p) {
            if (p === 'JsonRpcProvider') return MockProvider;
            if (p === 'Contract')        return MockContract;
            if (p === 'ethers')          return mk(t[p] ?? t);
            const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        }});
        return mk(realEthers);
    }
    return origLoad(req, parent, isMain);
};

process.env.PORT                = String(PORT);
process.env.SUPABASE_URL        = 'http://mock';
process.env.SUPABASE_SERVICE_KEY = 'mock';
process.env.RPC_URL             = 'http://mock-rpc';
process.env.CHAIN_ID            = '4217';
process.env.POOL_CONTRACT       = POOL;
process.env.SIGNER_PRIVATE_KEY  = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.ADMIN_WALLET        = '';

require('./server.js');

function apiReq(method, path, body, headers = {}) {
    return new Promise((res, rej) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({
            hostname: 'localhost', port: PORT, path, method,
            headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
        }, rsp => { let b = ''; rsp.on('data', c => b += c); rsp.on('end', () => { try { res({ s: rsp.statusCode, b: JSON.parse(b) }); } catch { res({ s: rsp.statusCode, b }); } }); });
        r.on('error', rej); if (data) r.write(data); r.end();
    });
}

async function getToken(wallet) {
    const { b: ch } = await apiReq('GET', `/api/nonce/${wallet.address.toLowerCase()}`);
    const sig = await wallet.signMessage(ch.message);
    const { b: auth } = await apiReq('POST', '/api/auth', { wallet: wallet.address.toLowerCase(), signature: sig });
    if (!auth.token) throw new Error('Auth falhou: ' + JSON.stringify(auth));
    return auth.token;
}

let p = 0, f = 0;
function chk(name, ok, detail = '') {
    if (ok) { p++; console.log(`  ✅ ${name}`); }
    else     { f++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function run() {
    await new Promise(r => setTimeout(r, 600));

    console.log('\n╔══════════════════════════════════╗');
    console.log('║   Teste Completo — Referral      ║');
    console.log('╚══════════════════════════════════╝\n');

    const [tokenA, tokenB, tokenC, tokenD] = await Promise.all([
        getToken(walletA), getToken(walletB), getToken(walletC), getToken(walletD),
    ]);
    const HA = { Authorization: `Bearer ${tokenA}` };
    const HB = { Authorization: `Bearer ${tokenB}` };
    const HC = { Authorization: `Bearer ${tokenC}` };
    const HD = { Authorization: `Bearer ${tokenD}` };

    // ── Registro ──────────────────────────────────────────────────────────────
    console.log('── Registro');

    const regA = await apiReq('POST', '/api/register', { wallet: ADDR_A }, HA);
    chk('Jogador A registrado (sem referrer)', regA.s === 200, JSON.stringify(regA.b));

    const regB = await apiReq('POST', '/api/register', { wallet: ADDR_B, referrer: ADDR_A }, HB);
    chk('Jogador B registrado com referrer = A', regB.s === 200, JSON.stringify(regB.b));

    const rowB = DB.players.find(r => r.wallet === ADDR_B);
    chk('DB confirma: B.referrer = A', rowB?.referrer === ADDR_A, `referrer=${rowB?.referrer}`);

    // Segundo registro de B não deve sobrescrever referrer
    const regB2 = await apiReq('POST', '/api/register', { wallet: ADDR_B, referrer: '0x0000000000000000000000000000000000000099' }, HB);
    const rowB2 = DB.players.find(r => r.wallet === ADDR_B);
    chk('Re-registro não altera referrer existente', rowB2?.referrer === ADDR_A, `referrer=${rowB2?.referrer}`);

    // ── Auto-indicação deve ser bloqueada ─────────────────────────────────────
    console.log('\n── Casos de borda');

    const regD = await apiReq('POST', '/api/register', { wallet: ADDR_D, referrer: ADDR_D }, HD);
    chk('Auto-indicação → 200 (referrer ignorado)', regD.s === 200);
    const rowD = DB.players.find(r => r.wallet === ADDR_D);
    chk('D.referrer = null (bloqueado pelo server)', rowD?.referrer === null, `referrer=${rowD?.referrer}`);

    // Referrer que não existe no DB → deve ser ignorado
    const regC = await apiReq('POST', '/api/register',
        { wallet: ADDR_C, referrer: '0x0000000000000000000000000000000000000099' }, HC);
    chk('Referrer inexistente → 200 (referrer ignorado)', regC.s === 200);
    const rowC = DB.players.find(r => r.wallet === ADDR_C);
    chk('C.referrer = null (referrer não existe)', rowC?.referrer === null, `referrer=${rowC?.referrer}`);

    // ── Depósito #1 de B (10 pathUSD = 1000 DC) → A deve receber 4% = 40 DC ──
    console.log('\n── Depósito do Referee → Bônus do Referrer');

    mockDeposit(ADDR_B, 10);
    const dep1 = await apiReq('POST', '/api/deposit',
        { wallet: ADDR_B, amountPathUSD: 10, txHash: '0xREF_TX_1' }, HB);
    chk('Depósito de B (10 pathUSD) → 200', dep1.s === 200, JSON.stringify(dep1.b));
    chk('B creditado com 1000 DC', dep1.b?.digcoinCredited === 1000, `credited=${dep1.b?.digcoinCredited}`);

    const gpA1 = await apiReq('GET', `/api/player/${ADDR_A}`);
    const balA1    = gpA1.b?.player?.digcoinBalance;
    const earnA1   = gpA1.b?.player?.referralEarnings;
    const bonus1   = 1000 * 0.04; // 40 DC
    chk(`A recebeu bônus de referral: ${bonus1} DC`, balA1 === bonus1, `saldo A=${balA1} esperado=${bonus1}`);
    chk(`referralEarnings de A = ${bonus1}`, earnA1 === bonus1, `earnings=${earnA1}`);

    // ── Depósito #2 de B (5 pathUSD = 500 DC) → A acumula mais 20 DC ─────────
    mockDeposit(ADDR_B, 5);
    const dep2 = await apiReq('POST', '/api/deposit',
        { wallet: ADDR_B, amountPathUSD: 5, txHash: '0xREF_TX_2' }, HB);
    chk('Depósito de B (5 pathUSD) → 200', dep2.s === 200, JSON.stringify(dep2.b));

    const gpA2  = await apiReq('GET', `/api/player/${ADDR_A}`);
    const balA2  = gpA2.b?.player?.digcoinBalance;
    const earnA2 = gpA2.b?.player?.referralEarnings;
    const bonus2 = 40 + 500 * 0.04; // 40 + 20 = 60 DC
    chk(`A acumulou ${bonus2} DC total`, balA2 === bonus2, `saldo A=${balA2} esperado=${bonus2}`);
    chk(`referralEarnings acumulado = ${bonus2}`, earnA2 === bonus2, `earn=${earnA2}`);

    // ── B deposita mais, C não tem referrer → C não gera bônus ────────────────
    console.log('\n── Depósito de C (sem referrer) → ninguém recebe bônus extra');
    mockDeposit(ADDR_C, 10);
    await apiReq('POST', '/api/deposit',
        { wallet: ADDR_C, amountPathUSD: 10, txHash: '0xREF_TX_3' }, HC);

    const gpA3 = await apiReq('GET', `/api/player/${ADDR_A}`);
    chk('Saldo de A não mudou (C não tem referrer A)', gpA3.b?.player?.digcoinBalance === bonus2,
        `saldo=${gpA3.b?.player?.digcoinBalance} esperado=${bonus2}`);

    // ── Verifica que B também pode ver seu referrer na conta ──────────────────
    console.log('\n── Dados exibidos na conta do jogador B');
    const gpB = await apiReq('GET', `/api/player/${ADDR_B}`, null, HB);
    chk('GET /api/player de B → 200', gpB.s === 200);
    chk('B.referrer = A visível na resposta', gpB.b?.player?.referrer === ADDR_A,
        `referrer=${gpB.b?.player?.referrer}`);
    chk('B.referralEarnings = 0 (B não indicou ninguém)', gpB.b?.player?.referralEarnings === 0,
        `earn=${gpB.b?.player?.referralEarnings}`);
    chk('B.referralLink contém endereço de B', (gpB.b?.player?.referralLink || '').includes(ADDR_B),
        `link=${gpB.b?.player?.referralLink}`);

    // ── Resultado final ───────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(40));
    console.log(`  Total: ${p+f}  |  ✅ Passou: ${p}  |  ❌ Falhou: ${f}`);
    console.log('═'.repeat(40) + '\n');
    process.exit(f > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
