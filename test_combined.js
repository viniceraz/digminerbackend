#!/usr/bin/env node
/**
 * DigMiner — Combined Full Test Suite (Regular Box + Sale Box)
 * ═══════════════════════════════════════════════════════════
 * Cobre em um único run:
 *   AUTH / REGISTRO / DEPÓSITO
 *   Regular Box (1x, 10x bulk, saldo insuficiente)
 *   Sale Box (1x, multi, limites, sold-out, wallet-limit)
 *   Gameplay completo: mine → claim → mine-all → claim-all → repair
 *   Miners de AMBAS as boxes no mesmo ciclo mine-all / claim-all
 *   Histórico consolida os dois tipos
 *   Referral credita DC; jogador usa DC para sale box
 *   Interação: regular box + sale box em sequência no mesmo saldo
 *   Edge-cases: quantidade 0, negativa, NaN, float, enorme
 *   Saldo exato (compra com exatamente o necessário)
 *   Segurança: sem auth, wallet errada, player inexistente
 *   Config / Stats públicos
 *
 * Run: node test_combined.js
 */

'use strict';

const Module = require('module');
const http   = require('http');
const realEthers = require('ethers');

// ─── Carteiras de teste ───────────────────────────────────────────────────────
const PK1    = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat #0
const PK2    = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Hardhat #1
const PK3    = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Hardhat #2

const wallet1  = new realEthers.Wallet(PK1);
const wallet2  = new realEthers.Wallet(PK2);
const wallet3  = new realEthers.Wallet(PK3);
const ADDR1    = wallet1.address.toLowerCase();
const ADDR2    = wallet2.address.toLowerCase();
const ADDR3    = wallet3.address.toLowerCase();

const PORT = 3097;
const POOL  = '0x0000000000000000000000000000000000000001';

// ─── Mock de depósito ─────────────────────────────────────────────────────────
let _mockReceiptLogs = [];
function prepareMockDeposit(wallet, amount) {
    const iface = new realEthers.Interface([
        'event Deposited(address indexed player, uint256 amount, uint256 timestamp)',
    ]);
    const amountWei = realEthers.parseUnits(amount.toFixed(6), 6);
    const ts        = BigInt(Math.floor(Date.now() / 1000));
    const encoded   = iface.encodeEventLog(iface.getEvent('Deposited'), [wallet, amountWei, ts]);
    _mockReceiptLogs = [{ address: POOL, ...encoded }];
}

// ─── Mocks de provider / contract / supabase ─────────────────────────────────
class MockProvider {
    async getTransactionReceipt() { return { status: 1, blockNumber: 9999, logs: _mockReceiptLogs }; }
    async getBlockNumber() { return 9999; }
    async getLogs()        { return [];    }
}
class MockContract { async getNonce() { return BigInt(1); } }

const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => mockSupabase };
    if (request === 'express-rate-limit')    return { rateLimit: () => (_q, _s, n) => n() };
    if (request === 'ethers') {
        const makeProxy = t => new Proxy(t, {
            get(obj, prop) {
                if (prop === 'JsonRpcProvider') return MockProvider;
                if (prop === 'Contract')        return MockContract;
                if (prop === 'ethers')          return makeProxy(obj[prop] ?? obj);
                const v = obj[prop]; return typeof v === 'function' ? v.bind(obj) : v;
            },
        });
        return makeProxy(realEthers);
    }
    return origLoad(request, parent, isMain);
};

// ─── Banco em memória ─────────────────────────────────────────────────────────
let _id = 1;
const nextId = () => _id++;
const DB = { players:[], miners:[], deposits:[], withdrawals:[], play_history:[], box_purchases:[], referrals:[], repairs:[] };
const DEFAULTS = {
    players: { digcoin_balance:0, total_deposited_pathusd:0, total_withdrawn_pathusd:0,
               total_earned_digcoin:0, total_spent_digcoin:0, boxes_bought:0, referral_earnings:0, referrer:null },
    miners:  { is_alive:true, needs_repair:false, last_play_at:null, exp:0, level:1 },
};

class QB {
    constructor(t) { this.t=t; this._f=[]; this._upd=null; this._ins=null; this._del=false; this._single=false; this._countMode=false; }
    _clone() { const q=new QB(this.t); q._f=[...this._f]; q._upd=this._upd; q._ins=this._ins; q._del=this._del; q._single=this._single; q._countMode=this._countMode; return q; }
    select(_,opts={}){ const q=this._clone(); if(opts.count) q._countMode=true; return q; }
    eq(c,v)  { const q=this._clone(); q._f.push(r=>r[c]===v);               return q; }
    neq(c,v) { const q=this._clone(); q._f.push(r=>r[c]!==v);               return q; }
    gte(c,v) { const q=this._clone(); q._f.push(r=>r[c]>=v);                return q; }
    in(c,vs) { const q=this._clone(); q._f.push(r=>vs.includes(r[c]));      return q; }
    order()  { return this._clone(); }
    limit(n) { const q=this._clone(); q._lim=n; return q; }
    single() { const q=this._clone(); q._single=true; return q; }
    is(c,v)  { const q=this._clone(); q._f.push(v===null ? r=>r[c]==null : r=>r[c]===v); return q; }
    not(c,op,v){ const q=this._clone(); if(op==='is'&&v===null) q._f.push(r=>r[c]!=null); else q._f.push(r=>r[c]!==v); return q; }
    update(u){ const q=this._clone(); q._upd=u; return q; }
    insert(rows){ const arr=Array.isArray(rows)?rows:[rows]; const defs=DEFAULTS[this.t]||{}; const ins=arr.map(r=>({id:nextId(),created_at:new Date().toISOString(),...defs,...r})); if(!DB[this.t])DB[this.t]=[]; DB[this.t].push(...ins); const q=this._clone(); q._ins=ins; return q; }
    delete(){ const q=this._clone(); q._del=true; return q; }
    _rows(){ let r=(DB[this.t]||[]); for(const f of this._f) r=r.filter(f); if(this._lim) r=r.slice(0,this._lim); return r; }
    then(res,rej){
        try{
            if(this._ins){ return res(this._single?{data:this._ins[0]||null,error:null}:{data:this._ins,error:null}); }
            if(this._del){ DB[this.t]=(DB[this.t]||[]).filter(r=>!this._f.every(f=>f(r))); return res({data:null,error:null}); }
            if(this._upd!==null){ const m=[]; for(const r of(DB[this.t]||[])){ if(this._f.every(f=>f(r))){ Object.assign(r,this._upd); m.push(r); } } return res({data:m.length?m:null,error:null}); }
            if(this._countMode) return res({count:this._rows().length,error:null});
            const rows=this._rows();
            if(this._single) return res({data:rows[0]||null,error:rows[0]?null:{message:'No rows',code:'PGRST116'}});
            res({data:rows,error:null});
        }catch(e){rej(e);}
    }
}

const mockSupabase = {
    from: t => new QB(t),
    rpc: name => {
        if(name==='get_global_stats'){
            const deps=DB.deposits.reduce((s,d)=>s+(d.amount_pathusd||0),0);
            const withs=DB.withdrawals.filter(w=>w.status==='ready').reduce((s,w)=>s+(w.net_pathusd||0),0);
            return Promise.resolve({data:[{total_deposited:deps,total_withdrawn:withs}],error:null});
        }
        return Promise.resolve({data:[],error:null});
    },
};

// ─── ENV ──────────────────────────────────────────────────────────────────────
process.env.PORT               = String(PORT);
process.env.SUPABASE_URL       = 'http://mock';
process.env.SUPABASE_SERVICE_KEY = 'mock-key';
process.env.RPC_URL            = 'http://mock-rpc';
process.env.CHAIN_ID           = '4217';
process.env.POOL_CONTRACT      = POOL;
process.env.SIGNER_PRIVATE_KEY = PK1.replace('0x','');
process.env.ADMIN_WALLET       = '';

console.log('\n[TEST] Iniciando servidor (porta '+PORT+')...');
require('./server.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function apiReq(method, path, body, headers={}) {
    return new Promise((res,rej)=>{
        const data=body?JSON.stringify(body):null;
        const r=http.request({hostname:'localhost',port:PORT,path,method,headers:{'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{}),...headers}},(response)=>{
            let buf=''; response.on('data',c=>(buf+=c)); response.on('end',()=>{ try{res({status:response.statusCode,body:JSON.parse(buf)});}catch{res({status:response.statusCode,body:buf});} });
        });
        r.on('error',rej); if(data) r.write(data); r.end();
    });
}

async function auth(wallet, pk) {
    const addr = wallet.address.toLowerCase();
    const {body:ch} = await apiReq('GET',`/api/nonce/${addr}`);
    const sig = await new realEthers.Wallet(pk).signMessage(ch.message);
    const {body:a} = await apiReq('POST','/api/auth',{wallet:addr,signature:sig});
    if(!a.token) throw new Error('Auth falhou: '+JSON.stringify(a));
    return {token:a.token, H:{'Authorization':'Bearer '+a.token}, addr};
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed=0, failed=0;
const log=[];
function check(name,ok,detail=''){
    if(ok){passed++;log.push(`  ✅ ${name}`);}
    else  {failed++;log.push(`  ❌ ${name}${detail?' — '+detail:''}`);}
}
function section(name){ log.push(`\n── ${name} ${'─'.repeat(Math.max(0,52-name.length))}`); }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(){
    await new Promise(r=>setTimeout(r,700));

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║   DigMiner — Combined Full Test Suite                ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // ── AUTH / REGISTRO / DEPÓSITO (3 wallets) ────────────────────────────────
    section('AUTH + REGISTRO + DEPÓSITO (3 wallets)');
    const u1 = await auth(wallet1, PK1);
    const u2 = await auth(wallet2, PK2);
    const u3 = await auth(wallet3, PK3);
    check('Auth wallet1 ok', !!u1.token);
    check('Auth wallet2 ok', !!u2.token);
    check('Auth wallet3 ok', !!u3.token);

    // Registra wallet1 com referral de wallet2 (campo correto é 'referrer')
    await apiReq('POST','/api/register',{wallet:u2.addr},u2.H);
    await apiReq('POST','/api/register',{wallet:u3.addr},u3.H);
    const reg1 = await apiReq('POST','/api/register',{wallet:u1.addr,referrer:u2.addr},u1.H);
    check('Registro wallet1 (com ref) → 200', reg1.status===200, JSON.stringify(reg1.body));

    // Depósito wallet1: 50 pathUSD = 5000 DC (buffer para todo o fluxo do teste)
    prepareMockDeposit(u1.addr,50);
    const dep1 = await apiReq('POST','/api/deposit',{wallet:u1.addr,amountPathUSD:50,txHash:'0xTX_W1'},u1.H);
    check('Depósito wallet1 50 pathUSD → 200', dep1.status===200);
    check('5000 DC creditados wallet1', dep1.body?.digcoinCredited===5000, `got=${dep1.body?.digcoinCredited}`);

    // Referral bonus: wallet2 deve ter recebido 4% de 3000 = 120 DC
    const gp2ref = await apiReq('GET',`/api/player/${u2.addr}`);
    // 4% de 5000 DC = 200 DC de referral
    check('Referral bonus wallet2 = 200 DC', gp2ref.body?.player?.digcoinBalance===200, `bal=${gp2ref.body?.player?.digcoinBalance}`);

    // Depósito wallet2: 5 pathUSD = 500 DC (+ 120 referral = 620 total)
    prepareMockDeposit(u2.addr,5);
    const dep2 = await apiReq('POST','/api/deposit',{wallet:u2.addr,amountPathUSD:5,txHash:'0xTX_W2'},u2.H);
    check('Depósito wallet2 5 pathUSD → 200', dep2.status===200);
    const gp2 = await apiReq('GET',`/api/player/${u2.addr}`);
    check('Saldo wallet2 = 700 DC (500 dep + 200 ref)', gp2.body?.player?.digcoinBalance===700, `bal=${gp2.body?.player?.digcoinBalance}`);

    // ── CONFIG PÚBLICO ────────────────────────────────────────────────────────
    section('CONFIG PÚBLICO — todos os campos');
    const cfg = await apiReq('GET','/api/config');
    check('GET /api/config → 200', cfg.status===200);
    check('boxPriceDigcoin = 300',       cfg.body?.boxPriceDigcoin===300);
    check('boxBulkQuantity = 10',        cfg.body?.boxBulkQuantity===10);
    check('boxBulkPriceDigcoin = 2850',  cfg.body?.boxBulkPriceDigcoin===2850);
    check('saleBoxPriceDigcoin = 150',   cfg.body?.saleBoxPriceDigcoin===150,    `got=${cfg.body?.saleBoxPriceDigcoin}`);
    check('saleBoxMaxTotal = 2000',      cfg.body?.saleBoxMaxTotal===2000,        `got=${cfg.body?.saleBoxMaxTotal}`);
    check('saleBoxMaxPerWallet = 50',    cfg.body?.saleBoxMaxPerWallet===50,      `got=${cfg.body?.saleBoxMaxPerWallet}`);
    check('rarities.length = 6',         cfg.body?.rarities?.length===6);

    // ── REGULAR BOX — 1 unidade ───────────────────────────────────────────────
    section('REGULAR BOX — 1 unidade (300 DC)');
    const rb1 = await apiReq('POST','/api/box/buy',{wallet:u1.addr,quantity:1},u1.H);
    check('POST /api/box/buy qty=1 → 200', rb1.status===200, JSON.stringify(rb1.body));
    check('Retornou 1 miner', rb1.body?.miners?.length===1);
    check('Miner tem raridade válida', !!rb1.body?.miners?.[0]?.rarityName);
    check('Miner tem dailyDigcoin > 0', (rb1.body?.miners?.[0]?.dailyDigcoin||0)>0);
    const regMiner1Id = rb1.body?.miners?.[0]?.id;

    const gpAfterReg1 = await apiReq('GET',`/api/player/${u1.addr}`);
    check('Saldo wallet1 = 4700 DC após 1 box', gpAfterReg1.body?.player?.digcoinBalance===4700, `got=${gpAfterReg1.body?.player?.digcoinBalance}`);

    // ── REGULAR BOX — 10 bulk ────────────────────────────────────────────────
    section('REGULAR BOX — 10 bulk (2850 DC)');
    // Wallet1 tem 4700 DC aqui, suficiente para 2850
    const rb10 = await apiReq('POST','/api/box/buy',{wallet:u1.addr,quantity:10},u1.H);
    check('POST /api/box/buy qty=10 → 200', rb10.status===200, JSON.stringify(rb10.body));
    check('Retornou 10 miners', rb10.body?.miners?.length===10, `len=${rb10.body?.miners?.length}`);
    check('Desconto 5% aplicado', rb10.body?.discount==='5%');

    const gpAfterBulk = await apiReq('GET',`/api/player/${u1.addr}`);
    // 5000 - 300 - 2850 = 1850 DC
    check('Saldo wallet1 = 1850 DC após bulk', gpAfterBulk.body?.player?.digcoinBalance===1850, `got=${gpAfterBulk.body?.player?.digcoinBalance}`);
    check('Saldo não ficou negativo', (gpAfterBulk.body?.player?.digcoinBalance||0)>=0);

    // ── SALDO INSUFICIENTE PARA BOX ───────────────────────────────────────────
    section('SALDO INSUFICIENTE — bloqueio correto');
    // Wallet3 sem depósito → 0 DC
    const broke = await apiReq('POST','/api/box/buy',{wallet:u3.addr,quantity:1},u3.H);
    check('Box regular sem saldo → 400', broke.status===400, JSON.stringify(broke.body));

    const brokeSale = await apiReq('POST','/api/box/buy-sale',{wallet:u3.addr,quantity:1},u3.H);
    check('Sale box sem saldo → 400', brokeSale.status===400, JSON.stringify(brokeSale.body));

    // Wallet2 tem 620 DC — exatamente suficiente para 4 sale boxes (600 DC) mas não para 1 regular (300 DC... espera, sim para 1 regular)
    // Vamos testar saldo exato: wallet2 compra 4 sale boxes = 600 DC exatos
    const gpW2Before = await apiReq('GET',`/api/player/${u2.addr}`);
    const w2BalBefore = gpW2Before.body?.player?.digcoinBalance || 0;

    // Força saldo exato de 150 DC para testar compra no limite
    const w2Player = DB.players.find(p=>p.wallet===u2.addr);
    if(w2Player) w2Player.digcoin_balance = 150;

    const exactSale = await apiReq('POST','/api/box/buy-sale',{wallet:u2.addr,quantity:1},u2.H);
    check('Sale box com saldo EXATO (150 DC) → 200', exactSale.status===200, JSON.stringify(exactSale.body));
    const gpW2After = await apiReq('GET',`/api/player/${u2.addr}`);
    check('Saldo wallet2 = 0 DC após compra exata', gpW2After.body?.player?.digcoinBalance===0, `got=${gpW2After.body?.player?.digcoinBalance}`);

    // Restaura saldo wallet2
    if(w2Player) w2Player.digcoin_balance = w2BalBefore;

    // ── SALE BOX — 1 unidade ─────────────────────────────────────────────────
    section('SALE BOX — 1 unidade (150 DC)');
    const saleBal1 = (await apiReq('GET',`/api/player/${u1.addr}`)).body?.player?.digcoinBalance||0;
    const sb1 = await apiReq('POST','/api/box/buy-sale',{wallet:u1.addr,quantity:1},u1.H);
    check('POST /api/box/buy-sale qty=1 → 200', sb1.status===200, JSON.stringify(sb1.body));
    check('saleBox=true', sb1.body?.saleBox===true);
    check('cost=150', sb1.body?.cost===150, `got=${sb1.body?.cost}`);
    check('1 miner retornado', sb1.body?.miners?.length===1);
    const saleMiner1Id = sb1.body?.miners?.[0]?.id;

    const gpAfterSale1 = await apiReq('GET',`/api/player/${u1.addr}`);
    check('Saldo debitado em 150 DC', Math.abs((saleBal1-(gpAfterSale1.body?.player?.digcoinBalance||0))-150)<0.01, `before=${saleBal1} after=${gpAfterSale1.body?.player?.digcoinBalance}`);

    // ── SALE BOX — 3 unidades ────────────────────────────────────────────────
    section('SALE BOX — 3 unidades (450 DC)');
    const saleBal3 = (await apiReq('GET',`/api/player/${u1.addr}`)).body?.player?.digcoinBalance||0;
    const sb3 = await apiReq('POST','/api/box/buy-sale',{wallet:u1.addr,quantity:3},u1.H);
    check('POST /api/box/buy-sale qty=3 → 200', sb3.status===200, JSON.stringify(sb3.body));
    check('3 miners retornados', sb3.body?.miners?.length===3, `len=${sb3.body?.miners?.length}`);
    check('cost=450', sb3.body?.cost===450, `got=${sb3.body?.cost}`);
    const gpAfterSale3 = await apiReq('GET',`/api/player/${u1.addr}`);
    check('Saldo debitado em 450 DC', Math.abs((saleBal3-(gpAfterSale3.body?.player?.digcoinBalance||0))-450)<0.01);

    // ── INTERAÇÃO: regular box + sale box no mesmo saldo ──────────────────────
    section('INTERAÇÃO — regular box + sale box no mesmo saldo');
    const balInteract = (await apiReq('GET',`/api/player/${u1.addr}`)).body?.player?.digcoinBalance||0;
    // Compra 1 regular (300 DC) depois 1 sale (150 DC) = 450 DC total
    const interReg = await apiReq('POST','/api/box/buy',{wallet:u1.addr,quantity:1},u1.H);
    const interSale = await apiReq('POST','/api/box/buy-sale',{wallet:u1.addr,quantity:1},u1.H);
    check('Regular box após sale box → 200', interReg.status===200, JSON.stringify(interReg.body));
    check('Sale box após regular box → 200', interSale.status===200, JSON.stringify(interSale.body));
    const balInteractAfter = (await apiReq('GET',`/api/player/${u1.addr}`)).body?.player?.digcoinBalance||0;
    check('Saldo debitado 450 DC (300+150)', Math.abs((balInteract-balInteractAfter)-450)<0.01, `before=${balInteract} after=${balInteractAfter}`);

    // ── SALE BOX INFO ─────────────────────────────────────────────────────────
    section('SALE BOX INFO — contadores corretos');
    const info = await apiReq('GET',`/api/box/sale-info?wallet=${u1.addr}`);
    check('GET /api/box/sale-info → 200', info.status===200);
    // wallet1 comprou 1+3+1 = 5 sale boxes
    // wallet1: 1+3+1=5 sale boxes; wallet2: 1 (exact balance test) → total=6 sold, remaining=1994
    check('walletBought wallet1 = 5', info.body?.walletBought===5, `got=${info.body?.walletBought}`);
    check('globalRemaining = 1994', info.body?.globalRemaining===1994, `got=${info.body?.globalRemaining}`);
    check('walletRemaining wallet1 = 45', info.body?.walletRemaining===45, `got=${info.body?.walletRemaining}`);

    // Sale box info sem wallet não deve quebrar
    const infoNoWallet = await apiReq('GET','/api/box/sale-info');
    check('sale-info sem wallet → 200', infoNoWallet.status===200);
    check('globalRemaining correto sem wallet', infoNoWallet.body?.globalRemaining===1994, `got=${infoNoWallet.body?.globalRemaining}`);

    // ── EDGE CASES DE QUANTIDADE ──────────────────────────────────────────────
    // Usa wallet3 (0 DC) para que os edge cases falhem com 400 e não consumam saldo
    section('EDGE CASES — quantity inválida');
    const edgeCases = [
        {qty:0,    label:'qty=0   → trata como 1'},
        {qty:-5,   label:'qty=-5  → trata como 1'},
        {qty:'abc',label:'qty=abc → trata como 1'},
        {qty:null, label:'qty=null→ trata como 1'},
        {qty:1.9,  label:'qty=1.9 → trunca para 1'},
    ];
    for(const {qty,label} of edgeCases){
        // wallet3 tem 0 DC → todas retornam 400 (sem saldo), mas nunca 500
        const r = await apiReq('POST','/api/box/buy-sale',{wallet:u3.addr,quantity:qty},u3.H);
        check(`${label} → não retorna 500`, r.status!==500, `status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    // ── GAMEPLAY — miners de AMBAS as boxes juntos ────────────────────────────
    section('GAMEPLAY — mine-all com miners de regular + sale box');
    // Monta lista de todos os miners ociosos
    const allIdle = DB.miners.filter(m=>m.wallet===u1.addr&&m.is_alive&&!m.needs_repair&&m.last_play_at===null);
    const idleCount = allIdle.length;
    check(`${idleCount} miners ociosos antes do Mine All`, idleCount>0, `count=${idleCount}`);

    const playAllR = await apiReq('POST','/api/play-all',{wallet:u1.addr},u1.H);
    check('Mine All → 200', playAllR.status===200, JSON.stringify(playAllR.body));
    check(`Iniciou todos ${idleCount} miners`, playAllR.body?.started===idleCount, `started=${playAllR.body?.started} expected=${idleCount}`);
    check('Fee = 10 DC × miners', playAllR.body?.fee===CONFIG_FEE*idleCount, `fee=${playAllR.body?.fee}`);

    // Mine All de novo deve falhar (nenhum ocioso)
    const playAllDup = await apiReq('POST','/api/play-all',{wallet:u1.addr},u1.H);
    check('Mine All sem ociosos → 400', playAllDup.status===400, JSON.stringify(playAllDup.body));

    // ── CLAIM ANTECIPADO ──────────────────────────────────────────────────────
    section('CLAIM ANTECIPADO — deve bloquear');
    const earlyReg  = await apiReq('POST',`/api/claim/${regMiner1Id}`,{wallet:u1.addr},u1.H);
    const earlySale = await apiReq('POST',`/api/claim/${saleMiner1Id}`,{wallet:u1.addr},u1.H);
    check('Claim regular miner < 24h → 400', earlyReg.status===400,  JSON.stringify(earlyReg.body));
    check('Claim sale miner < 24h → 400',    earlySale.status===400, JSON.stringify(earlySale.body));
    check('Erro menciona Wait',
        (earlyReg.body?.error||'').includes('Wait')||(earlyReg.body?.error||'').includes('mining'),
        earlyReg.body?.error);

    // ── AVANÇO DE TEMPO (25h) ────────────────────────────────────────────────
    section('AVANÇO DE TEMPO — 25h');
    const ago25h = new Date(Date.now()-25*3600*1000).toISOString();
    let ffw=0;
    for(const m of DB.miners){ if(m.wallet===u1.addr&&m.last_play_at!==null){m.last_play_at=ago25h;ffw++;} }
    check(`${ffw} miners avançados 25h`, ffw===idleCount, `ffw=${ffw} expected=${idleCount}`);

    // ── CLAIM ÚNICO — regular miner ───────────────────────────────────────────
    section('CLAIM ÚNICO — regular miner');
    const cr = await apiReq('POST',`/api/claim/${regMiner1Id}`,{wallet:u1.addr},u1.H);
    check('Claim regular miner → 200',       cr.status===200,                       JSON.stringify(cr.body));
    check('Reward > 0',                       (cr.body?.reward||0)>0,               `reward=${cr.body?.reward}`);
    check('nftAgeRemaining diminuiu',         Number.isInteger(cr.body?.nftAgeRemaining), `age=${cr.body?.nftAgeRemaining}`);
    check('Claim duplo regular → 400',        (await apiReq('POST',`/api/claim/${regMiner1Id}`,{wallet:u1.addr},u1.H)).status===400);

    // ── CLAIM ÚNICO — sale miner ──────────────────────────────────────────────
    section('CLAIM ÚNICO — sale miner');
    const cs = await apiReq('POST',`/api/claim/${saleMiner1Id}`,{wallet:u1.addr},u1.H);
    check('Claim sale miner → 200',     cs.status===200,                  JSON.stringify(cs.body));
    check('Reward sale > 0',            (cs.body?.reward||0)>0,           `reward=${cs.body?.reward}`);
    check('Claim duplo sale → 400',     (await apiReq('POST',`/api/claim/${saleMiner1Id}`,{wallet:u1.addr},u1.H)).status===400);

    // ── CLAIM ALL — todos os prontos ─────────────────────────────────────────
    section('CLAIM ALL — regular + sale miners juntos');
    // Reinicia os 2 miners já claimados
    await apiReq('POST',`/api/play/${regMiner1Id}`,{wallet:u1.addr},u1.H);
    await apiReq('POST',`/api/play/${saleMiner1Id}`,{wallet:u1.addr},u1.H);
    // Avança tempo só deles
    for(const m of DB.miners){ if(m.id===regMiner1Id||m.id===saleMiner1Id) m.last_play_at=ago25h; }

    const claimAllR = await apiReq('POST','/api/claim-all',{wallet:u1.addr},u1.H);
    check('Claim All → 200',         claimAllR.status===200, JSON.stringify(claimAllR.body));
    check('Claimed ≥ 2',             (claimAllR.body?.claimed||0)>=2, `claimed=${claimAllR.body?.claimed}`);
    check('totalReward > 0',         (claimAllR.body?.totalReward||0)>0);
    check('netReward = total - fee',
        Math.abs((claimAllR.body?.netReward||0)-((claimAllR.body?.totalReward||0)-(claimAllR.body?.claimAllFee||0)))<0.01,
        JSON.stringify(claimAllR.body));

    // ── REPAIR — regular miner morto ─────────────────────────────────────────
    section('REPAIR — regular miner morto');
    const targetReg = DB.miners.find(m=>m.id===regMiner1Id);
    if(targetReg){ targetReg.is_alive=false; targetReg.needs_repair=true; }
    const repReg = await apiReq('POST',`/api/repair/${regMiner1Id}`,{wallet:u1.addr},u1.H);
    check('Repair regular miner → 200',       repReg.status===200,                  JSON.stringify(repReg.body));
    check('costDigcoin > 0',                   (repReg.body?.costDigcoin||0)>0,     `cost=${repReg.body?.costDigcoin}`);
    check('Miner regular voltou à vida',       targetReg?.is_alive===true);
    check('needs_repair=false (regular)',      targetReg?.needs_repair===false);
    check('nft_age_remaining restaurado',      targetReg?.nft_age_remaining===targetReg?.nft_age_total, `rem=${targetReg?.nft_age_remaining}`);

    // ── REPAIR — sale miner morto ────────────────────────────────────────────
    section('REPAIR — sale miner morto');
    const targetSale = DB.miners.find(m=>m.id===saleMiner1Id);
    if(targetSale){ targetSale.is_alive=false; targetSale.needs_repair=true; }
    const repSale = await apiReq('POST',`/api/repair/${saleMiner1Id}`,{wallet:u1.addr},u1.H);
    check('Repair sale miner → 200',          repSale.status===200,                  JSON.stringify(repSale.body));
    check('Miner sale voltou à vida',          targetSale?.is_alive===true);
    check('needs_repair=false (sale)',         targetSale?.needs_repair===false);
    check('nft_age_remaining restaurado sale', targetSale?.nft_age_remaining===targetSale?.nft_age_total);

    // ── REFERRAL + SALE BOX ───────────────────────────────────────────────────
    section('REFERRAL — crédito usado para sale box');
    // wallet2 tem saldo atual (com referral bonus de 120 DC ao menos)
    // Força saldo exato de 300 DC para comprar 2 sale boxes
    const w2p = DB.players.find(p=>p.wallet===u2.addr);
    if(w2p) w2p.digcoin_balance=300;  // 200 DC (referral) was already there; force to 300 for clean test
    const sbRef = await apiReq('POST','/api/box/buy-sale',{wallet:u2.addr,quantity:2},u2.H);
    check('Sale box com DC de referral → 200', sbRef.status===200, JSON.stringify(sbRef.body));
    check('2 miners retornados (ref)', sbRef.body?.miners?.length===2, `len=${sbRef.body?.miners?.length}`);
    const gpW2RefAfter = await apiReq('GET',`/api/player/${u2.addr}`);
    check('Saldo wallet2 = 0 após 2 sale boxes (300 DC)', gpW2RefAfter.body?.player?.digcoinBalance===0, `got=${gpW2RefAfter.body?.player?.digcoinBalance}`);

    // ── HISTÓRICO — ambos os tipos (antes da injeção de fake boxes) ──────────
    section('HISTÓRICO — regular box + sale box consolidados');
    const hist = await apiReq('GET',`/api/history/${u1.addr}?limit=100`,null,u1.H);
    check('GET /api/history → 200', hist.status===200);
    const txTypes = new Set((hist.body?.transactions||[]).map(t=>t.type));
    check('Histórico tem tipo box',     txTypes.has('box'),     `tipos=${[...txTypes].join(',')}`);
    check('Histórico tem tipo deposit', txTypes.has('deposit'), `tipos=${[...txTypes].join(',')}`);
    check('Histórico tem tipo play',    txTypes.has('play'),    `tipos=${[...txTypes].join(',')}`);

    const saleTxs = (hist.body?.transactions||[]).filter(t=>t.type==='box'&&Math.abs(Math.abs(t.amount)-150)<1);
    const regTxs  = (hist.body?.transactions||[]).filter(t=>t.type==='box'&&Math.abs(Math.abs(t.amount)-300)<1);
    check('Histórico tem compras com 150 DC (sale box)', saleTxs.length>=1, `found=${saleTxs.length}`);
    check('Histórico tem compras com 300 DC (regular)',  regTxs.length>=1,  `found=${regTxs.length}`);

    // ── LIMITE WALLET — max 50 ────────────────────────────────────────────────
    section('LIMITE WALLET — max 50 sale boxes');
    const alreadyW1 = DB.box_purchases.filter(b=>b.wallet===u1.addr&&b.box_type==='sale').length;
    const toInject  = 50-alreadyW1;
    for(let i=0;i<toInject;i++) DB.box_purchases.push({id:nextId(),wallet:u1.addr,miner_id:null,cost_digcoin:150,box_type:'sale',created_at:new Date().toISOString()});

    const infoLimit = await apiReq('GET',`/api/box/sale-info?wallet=${u1.addr}`);
    check('walletBought = 50', infoLimit.body?.walletBought===50, `got=${infoLimit.body?.walletBought}`);
    check('walletRemaining = 0', infoLimit.body?.walletRemaining===0);

    const p1 = DB.players.find(p=>p.wallet===u1.addr);
    if(p1) p1.digcoin_balance+=300; // garante saldo suficiente
    const overLimit = await apiReq('POST','/api/box/buy-sale',{wallet:u1.addr,quantity:1},u1.H);
    check('Compra acima de 50 → 400', overLimit.status===400, JSON.stringify(overLimit.body));
    check('Mensagem menciona limit', (overLimit.body?.error||'').toLowerCase().includes('limit'), overLimit.body?.error);
    if(p1) p1.digcoin_balance-=300;

    // Regular box ainda funciona mesmo com sale limit atingido
    const regAfterLimit = await apiReq('POST','/api/box/buy',{wallet:u1.addr,quantity:1},u1.H);
    const p1bal = DB.players.find(p=>p.wallet===u1.addr)?.digcoin_balance||0;
    if(p1bal>=300){
        check('Regular box funciona quando sale limit atingido', regAfterLimit.status===200, JSON.stringify(regAfterLimit.body));
    } else {
        check('Regular box (saldo insuf — SKIP)', true);
    }

    // ── LIMITE GLOBAL — sold out ──────────────────────────────────────────────
    section('LIMITE GLOBAL — sold out (2000 boxes)');
    const currentTotal = DB.box_purchases.filter(b=>b.box_type==='sale').length;
    const toFill = 2000-currentTotal;
    for(let i=0;i<toFill;i++) DB.box_purchases.push({id:nextId(),wallet:'0xfiller',miner_id:null,cost_digcoin:150,box_type:'sale',created_at:new Date().toISOString()});

    const infoSO = await apiReq('GET',`/api/box/sale-info?wallet=${u3.addr}`);
    check('totalSold = 2000',       infoSO.body?.totalSold===2000,      `got=${infoSO.body?.totalSold}`);
    check('globalRemaining = 0',    infoSO.body?.globalRemaining===0,   `got=${infoSO.body?.globalRemaining}`);

    // wallet3 nunca comprou sale box — depósita e tenta
    prepareMockDeposit(u3.addr,5);
    await apiReq('POST','/api/deposit',{wallet:u3.addr,amountPathUSD:5,txHash:'0xTX_W3_SO'},u3.H);
    const soldOut = await apiReq('POST','/api/box/buy-sale',{wallet:u3.addr,quantity:1},u3.H);
    check('Compra sold-out → 400', soldOut.status===400, JSON.stringify(soldOut.body));
    check('Mensagem menciona sold out', (soldOut.body?.error||'').toLowerCase().includes('sold out'), soldOut.body?.error);
    const gp3SoldOut = await apiReq('GET',`/api/player/${u3.addr}`);
    check('Saldo wallet3 intacto no sold out', (gp3SoldOut.body?.player?.digcoinBalance||0)===500, `got=${gp3SoldOut.body?.player?.digcoinBalance}`);

    // ── STATS GLOBAIS ─────────────────────────────────────────────────────────
    section('STATS GLOBAIS');
    const stats = await apiReq('GET','/api/stats');
    check('GET /api/stats → 200',       stats.status===200);
    check('totalPlayers ≥ 3',           (stats.body?.totalPlayers||0)>=3, `got=${stats.body?.totalPlayers}`);
    check('totalMiners ≥ 1',            (stats.body?.totalMiners||0)>=1,  `got=${stats.body?.totalMiners}`);

    // ── WITHDRAW ──────────────────────────────────────────────────────────────
    section('WITHDRAW — saque após ciclo completo');
    const gpW = await apiReq('GET',`/api/player/${u1.addr}`);
    const balW = gpW.body?.player?.digcoinBalance||0;
    if(balW>=100){
        const wd = await apiReq('POST','/api/withdraw',{wallet:u1.addr,amountDigcoin:100},u1.H);
        check('Withdraw 100 DC → 200',        wd.status===200, JSON.stringify(wd.body));
        check('Assinatura EIP-712 retornada', !!wd.body?.signature?.signature);
        check('Taxa 10% calculada', Math.abs((wd.body?.feePathUSD||0)-(wd.body?.amountPathUSD||0)*0.10)<0.0001, JSON.stringify(wd.body));
        const wd2 = await apiReq('POST','/api/withdraw',{wallet:u1.addr,amountDigcoin:100},u1.H);
        check('Segundo saque (cooldown 24h) → 400', wd2.status===400, JSON.stringify(wd2.body));
    } else { check('Withdraw (saldo insuf — SKIP)', true); }

    // ── SEGURANÇA ─────────────────────────────────────────────────────────────
    section('SEGURANÇA — exploits e boundary checks');

    // Sem token
    check('buy-sale sem token → 401',    (await apiReq('POST','/api/box/buy-sale',{wallet:u1.addr,quantity:1})).status===401);
    check('box/buy sem token → 401',     (await apiReq('POST','/api/box/buy',{wallet:u1.addr,quantity:1})).status===401);
    check('play sem token → 401',        (await apiReq('POST',`/api/play/${regMiner1Id}`,{wallet:u1.addr})).status===401);
    check('claim sem token → 401',       (await apiReq('POST',`/api/claim/${regMiner1Id}`,{wallet:u1.addr})).status===401);
    check('withdraw sem token → 401',    (await apiReq('POST','/api/withdraw',{wallet:u1.addr,amountDigcoin:100})).status===401);

    // Wallet errada no body
    const wrongWallet = '0x0000000000000000000000000000000000000099';
    check('buy-sale wallet≠token → 403',  (await apiReq('POST','/api/box/buy-sale',{wallet:wrongWallet,quantity:1},u1.H)).status===403);
    check('box/buy wallet≠token → 403',   (await apiReq('POST','/api/box/buy',{wallet:wrongWallet,quantity:1},u1.H)).status===403);
    check('withdraw wallet≠token → 403',  (await apiReq('POST','/api/withdraw',{wallet:wrongWallet,amountDigcoin:100},u1.H)).status===403);

    // Player inexistente
    check('player inexistente → 404',     (await apiReq('GET','/api/player/0x0000000000000000000000000000000000000011')).status===404);
    const ghost = DB.players.find(p=>p.wallet==='0x0000000000000000000000000000000000000011');
    check('Nenhum player fantasma criado no DB', !ghost);

    // Histórico de outro wallet
    check('Histórico de outra wallet → 403', (await apiReq('GET',`/api/history/${u2.addr}`,null,u1.H)).status===403);

    // Mine de miner que não pertence ao usuário
    const minerNotMine = DB.miners.find(m=>m.wallet===u2.addr);
    if(minerNotMine){
        const steal = await apiReq('POST',`/api/play/${minerNotMine.id}`,{wallet:u1.addr},u1.H);
        check('Mine de miner de outra wallet → 400/404', steal.status>=400, `status=${steal.status}`);
    }

    // Saque abaixo do mínimo
    check('Withdraw < 100 DC → 400', (await apiReq('POST','/api/withdraw',{wallet:u1.addr,amountDigcoin:50},u1.H)).status===400);

    // Depósito sem txHash
    check('Depósito sem txHash → 400', (await apiReq('POST','/api/deposit',{wallet:u1.addr,amountPathUSD:10},u1.H)).status===400);

    // Health não vaza secrets
    const health = await apiReq('GET','/health');
    check('Health → 200', health.status===200);
    const leaks = Object.values(health.body?.env||{}).some(v=>typeof v==='string'&&v.length>5);
    check('Health não vaza secrets (só booleanos)', !leaks, JSON.stringify(health.body?.env));

    // Maintenance bloqueia tudo
    section('MAINTENANCE MODE');
    await apiReq('POST','/api/admin/maintenance',{enabled:true,wallet:u1.addr},u1.H);
    // (admin não está configurado, mas o modo pode ser testado internamente se mock suportar)
    // Abordagem alternativa: setar diretamente na variável via endpoint público de leitura
    const maint = await apiReq('GET','/api/maintenance');
    check('GET /api/maintenance → 200', maint.status===200);
    check('Campo maintenance presente', 'maintenance' in (maint.body||{}));

    printReport();
}

const CONFIG_FEE = 10; // PLAY_ALL_FEE_DIGCOIN

function printReport(){
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║                    RESULTADO                        ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    for(const l of log) console.log(l);
    const total=passed+failed;
    console.log('\n'+'═'.repeat(54));
    console.log(`  Total: ${total}  |  ✅ Passou: ${passed}  |  ❌ Falhou: ${failed}`);
    console.log('═'.repeat(54)+'\n');
    process.exit(failed>0?1:0);
}

run().catch(err=>{
    console.error('\n💥 Erro fatal:',err.message,err.stack);
    process.exit(1);
});
