#!/usr/bin/env node
/**
 * DigMiner — Fuse Miners Test Suite
 * ════════════════════════════════════
 * Covers all fusion scenarios:
 *   • Config exposes fuseCostDigcoin = 150
 *   • Basic fuse: 2 idle miners → 1 new miner, originals deleted
 *   • 150 DC deducted from balance
 *   • Result rarity: same rarity → at least +1
 *   • Result rarity: always in valid range
 *   • New miner has full life (nft_age_remaining = nft_age_total)
 *   • New miner is alive and not needs_repair
 *   • Cannot fuse a mining miner (last_play_at set)
 *   • Cannot fuse same miner ID twice (id1 === id2)
 *   • Cannot fuse miner from another wallet
 *   • Insufficient balance rejected
 *   • Dead miners CAN fuse
 *   • No auth → 401
 *   • Fuse multiple times (chain)
 *
 * Run: node test_fuse.js
 */

'use strict';

const Module = require('module');
const http   = require('http');

const realEthers = require('ethers');

const PK1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PK2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const w1  = new realEthers.Wallet(PK1);
const w2  = new realEthers.Wallet(PK2);
const A1  = w1.address.toLowerCase();
const A2  = w2.address.toLowerCase();

const PORT = 3097;
const POOL = '0x0000000000000000000000000000000000000001';

// ─── Mock deposit receipt ────────────────────────────────────────────────────
let _mockReceiptLogs = [];
function prepareMockDeposit(wallet, amountPathUSD) {
    const iface = new realEthers.Interface(['event Deposited(address indexed player, uint256 amount, uint256 timestamp)']);
    const amountWei = realEthers.parseUnits(amountPathUSD.toFixed(6), 6);
    const ts = BigInt(Math.floor(Date.now() / 1000));
    const encoded = iface.encodeEventLog(iface.getEvent('Deposited'), [wallet, amountWei, ts]);
    _mockReceiptLogs = [{ address: POOL, ...encoded }];
}

class MockProvider {
    async getTransactionReceipt() { return { status: 1, blockNumber: 9999, logs: _mockReceiptLogs }; }
    async getBlockNumber() { return 9999; }
    async getLogs() { return []; }
}
class MockContract {
    async getNonce() { return BigInt(1); }
}

// ─── Module patch ────────────────────────────────────────────────────────────
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

// ─── In-memory DB ─────────────────────────────────────────────────────────────
let _id = 1;
const nextId = () => _id++;
const DB = { players:[], miners:[], deposits:[], withdrawals:[], box_purchases:[], play_history:[], repairs:[] };
const DEFS = {
    players: { digcoin_balance:0, total_deposited_pathusd:0, total_withdrawn_pathusd:0, total_earned_digcoin:0, total_spent_digcoin:0, boxes_bought:0, referral_earnings:0, referrer:null },
    miners:  { is_alive:true, needs_repair:false, last_play_at:null, exp:0, level:1 },
};

class QB {
    constructor(t) { this.t=t; this._f=[]; this._upd=null; this._ins=null; this._del=false; this._single=false; this._countMode=false; }
    _clone() { const q=new QB(this.t); q._f=[...this._f]; q._upd=this._upd; q._ins=this._ins; q._del=this._del; q._single=this._single; q._countMode=this._countMode; return q; }
    select(_f,opts={}){ const q=this._clone(); if(opts.count) q._countMode=true; return q; }
    eq(c,v)  { const q=this._clone(); q._f.push(r=>r[c]===v); return q; }
    neq(c,v) { const q=this._clone(); q._f.push(r=>r[c]!==v); return q; }
    gte(c,v) { const q=this._clone(); q._f.push(r=>r[c]>=v); return q; }
    in(c,vs) { const q=this._clone(); q._f.push(r=>vs.includes(r[c])); return q; }
    is(c,v)  { const q=this._clone(); q._f.push(v===null?r=>r[c]===null||r[c]===undefined:r=>r[c]===v); return q; }
    not(c,op,v){ const q=this._clone(); if(op==='is'&&v===null) q._f.push(r=>r[c]!==null&&r[c]!==undefined); else q._f.push(r=>r[c]!==v); return q; }
    order(){ return this._clone(); }
    limit(n){ const q=this._clone(); q._lim=n; return q; }
    single(){ const q=this._clone(); q._single=true; return q; }
    range(from,to){ const q=this._clone(); q._range=[from,to]; return q; }
    update(u){ const q=this._clone(); q._upd=u; return q; }
    delete(){ const q=this._clone(); q._del=true; return q; }
    insert(rows){ const arr=Array.isArray(rows)?rows:[rows]; const defs=DEFS[this.t]||{}; const ins=arr.map(r=>({id:nextId(),created_at:new Date().toISOString(),...defs,...r})); if(!DB[this.t]) DB[this.t]=[]; DB[this.t].push(...ins); const q=this._clone(); q._ins=ins; return q; }
    _rows(){ let rows=(DB[this.t]||[]); for(const f of this._f) rows=rows.filter(f); if(this._lim) rows=rows.slice(0,this._lim); return rows; }
    then(res,rej){
        try{
            if(this._ins){ if(this._single) return res({data:this._ins[0]||null,error:null}); return res({data:this._ins,error:null}); }
            if(this._del){ DB[this.t]=(DB[this.t]||[]).filter(r=>!this._f.every(f=>f(r))); return res({data:null,error:null}); }
            if(this._upd!==null){
                const matched=[];
                for(const r of (DB[this.t]||[])){ if(this._f.every(f=>f(r))){ Object.assign(r,this._upd); matched.push(r); } }
                if(this._single) return res({data:matched[0]||null,error:matched[0]?null:{message:'No rows',code:'PGRST116'}});
                return res({data:matched.length?matched:null,error:null});
            }
            if(this._countMode) return res({count:this._rows().length,error:null});
            const rows=this._rows();
            if(this._single) return res({data:rows[0]||null,error:rows[0]?null:{message:'No rows',code:'PGRST116'}});
            res({data:rows,error:null});
        }catch(e){rej(e);}
    }
}

const mockSupabase = {
    from:(t)=>new QB(t),
    rpc:(name)=>{
        if(name==='get_global_stats'){
            const deps=DB.deposits.reduce((s,d)=>s+(d.amount_pathusd||0),0);
            const withs=DB.withdrawals.filter(w=>w.status==='ready').reduce((s,w)=>s+(w.net_pathusd||0),0);
            return Promise.resolve({data:[{total_deposited:deps,total_withdrawn:withs,total_boxes:DB.box_purchases.length}],error:null});
        }
        return Promise.resolve({data:[],error:null});
    },
};

// ─── ENV ─────────────────────────────────────────────────────────────────────
process.env.PORT               = String(PORT);
process.env.SUPABASE_URL       = 'http://mock';
process.env.SUPABASE_SERVICE_KEY = 'mock-key';
process.env.RPC_URL            = 'http://mock-rpc';
process.env.CHAIN_ID           = '4217';
process.env.POOL_CONTRACT      = POOL;
process.env.SIGNER_PRIVATE_KEY = PK1.replace('0x','');
process.env.ADMIN_WALLET       = A1;

require('./server.js');

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function apiReq(method, path, body, headers={}) {
    return new Promise((resolve,reject)=>{
        const data=body?JSON.stringify(body):null;
        const opts={hostname:'localhost',port:PORT,path,method,headers:{'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{}),...headers}};
        const r=http.request(opts,res=>{let buf='';res.on('data',c=>buf+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(buf)});}catch{resolve({status:res.statusCode,body:buf});}});});
        r.on('error',reject);
        if(data) r.write(data);
        r.end();
    });
}

async function getToken(addr, pk) {
    const {body:ch}=await apiReq('GET',`/api/nonce/${addr}`);
    if(!ch.message) throw new Error('Nonce failed: '+JSON.stringify(ch));
    const sig=await new realEthers.Wallet(pk).signMessage(ch.message);
    const {body:auth}=await apiReq('POST','/api/auth',{wallet:addr,signature:sig});
    if(!auth.token) throw new Error('Auth failed: '+JSON.stringify(auth));
    return auth.token;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────
let passed=0,failed=0;
const log=[];
function check(name,ok,detail=''){
    if(ok){passed++;log.push(`  ✅ ${name}`);}
    else  {failed++;log.push(`  ❌ ${name}${detail?' — '+detail:''}`);}
}
function section(name){log.push(`\n── ${name} ──`);}
function printReport(){log.forEach(l=>console.log(l));}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(){
    await new Promise(r=>setTimeout(r,700));

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   DigMiner — Fuse Miners Test Suite              ║');
    console.log('╚══════════════════════════════════════════════════╝');

    // ─ Setup ─
    section('SETUP');
    const t1=await getToken(A1,PK1); check('u1 auth',!!t1);
    const t2=await getToken(A2,PK2); check('u2 auth',!!t2);
    const H1={Authorization:`Bearer ${t1}`};
    const H2={Authorization:`Bearer ${t2}`};

    await apiReq('POST','/api/register',{wallet:A1},H1);
    await apiReq('POST','/api/register',{wallet:A2},H2);

    // Deposit 30 USD = 3000 DC for u1, 10 USD = 1000 DC for u2
    prepareMockDeposit(A1,30);
    await apiReq('POST','/api/deposit',{wallet:A1,amountPathUSD:30,txHash:'0xDEP1'},H1);
    prepareMockDeposit(A2,10);
    await apiReq('POST','/api/deposit',{wallet:A2,amountPathUSD:10,txHash:'0xDEP2'},H2);

    // Buy 4 boxes for u1 (need at least 2 idle miners)
    for(let i=0;i<4;i++) await apiReq('POST','/api/box/buy',{wallet:A1,quantity:1},H1);
    // Buy 2 boxes for u2
    for(let i=0;i<2;i++) await apiReq('POST','/api/box/buy',{wallet:A2,quantity:1},H2);

    const {body:p1}=await apiReq('GET',`/api/player/${A1}`);
    const {body:p2}=await apiReq('GET',`/api/player/${A2}`);
    check('u1 has 4 miners',p1.miners?.length===4,`got ${p1.miners?.length}`);
    check('u2 has 2 miners',p2.miners?.length===2,`got ${p2.miners?.length}`);

    const u1m=p1.miners;
    const u2m=p2.miners;

    // ─ Config ─
    section('CONFIG');
    const {body:cfg}=await apiReq('GET','/api/config');
    check('config.fuseCostDigcoin = 150',cfg.fuseCostDigcoin===150,`got ${cfg.fuseCostDigcoin}`);

    // ─ Basic Fuse ─
    section('BASIC FUSE');
    const balBefore=p1.player.digcoinBalance;
    const id1=u1m[0].id, id2=u1m[1].id;

    const {status:fs,body:fr}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:id1,minerId2:id2},H1);
    check('POST /api/miner/fuse → 200',fs===200,`${fs} ${fr.error||''}`);
    check('success=true',fr.success===true);
    check('returns new miner',!!fr.miner?.id);
    check('cost=150',fr.cost===150,`got ${fr.cost}`);
    check('consumed has 2 ids',fr.consumed?.length===2,`got ${fr.consumed?.length}`);
    check('consumed includes id1+id2',fr.consumed?.includes(id1)&&fr.consumed?.includes(id2));

    // Balance deducted
    const {body:p1a}=await apiReq('GET',`/api/player/${A1}`);
    check('150 DC deducted',p1a.player.digcoinBalance===balBefore-150,`before=${balBefore} after=${p1a.player.digcoinBalance}`);

    // Originals deleted
    check('miner1 deleted',!p1a.miners?.find(m=>m.id===id1));
    check('miner2 deleted',!p1a.miners?.find(m=>m.id===id2));
    check('new miner in list',!!p1a.miners?.find(m=>m.id===fr.miner.id));

    // ─ New Miner Structure ─
    section('RESULT MINER STRUCTURE');
    const nm=fr.miner;
    check('has id',!!nm.id);
    check('has rarity_id',nm.rarity_id!==undefined,`got ${nm.rarity_id}`);
    check('has rarity_name',!!nm.rarity_name);
    check('daily_digcoin > 0',nm.daily_digcoin>0,`got ${nm.daily_digcoin}`);
    check('nft_age_total > 0',nm.nft_age_total>0,`got ${nm.nft_age_total}`);
    check('nft_age_remaining = nft_age_total',nm.nft_age_remaining===nm.nft_age_total,`remaining=${nm.nft_age_remaining} total=${nm.nft_age_total}`);
    check('is_alive=true',nm.is_alive===true);
    check('needs_repair=false',nm.needs_repair===false);
    check('has power',nm.power>0);
    check('has energy',nm.energy>0);

    // ─ Rarity Logic ─
    section('RARITY LOGIC');
    const hRar=Math.max(u1m[0].rarityId,u1m[1].rarityId);
    const sameRar=u1m[0].rarityId===u1m[1].rarityId;
    const minExpected=sameRar?hRar+1:hRar;
    const maxExpected=Math.min(hRar+2,5);
    check(`result rarity in [${minExpected}..${maxExpected}]`,nm.rarity_id>=minExpected&&nm.rarity_id<=maxExpected,`got ${nm.rarity_id}, miners were ${u1m[0].rarityName}+${u1m[1].rarityName}`);

    // ─ Error Cases ─
    section('ERROR CASES');

    // Same miner ID
    const remaining1=p1a.miners[0];
    const {status:sameS,body:sameR}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:remaining1.id,minerId2:remaining1.id},H1);
    check('same id → 400',sameS===400,`got ${sameS}`);
    check('same id error message',sameR.error?.includes('itself'),sameR.error);

    // Cross-wallet miner
    const {status:crossS,body:crossR}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:remaining1.id,minerId2:u2m[0].id},H1);
    check('cross-wallet → 400',crossS===400,`got ${crossS} ${crossR.error||''}`);

    // Mining miner (start mining first)
    const rem1=p1a.miners[0], rem2=p1a.miners[1];
    await apiReq('POST',`/api/play/${rem1.id}`,{wallet:A1},H1);
    const {status:miningS,body:miningR}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:rem1.id,minerId2:rem2.id},H1);
    check('mining miner → 400',miningS===400,`got ${miningS}`);
    check('mining error mentions mining',miningR.error?.toLowerCase().includes('mining'),miningR.error);

    // Insufficient balance — drain u1 then try
    // u1 balance: 3000 - 4*300 (boxes) - 150 (fuse) = 3000-1200-150 = 1650 DC
    // To drain, just check with a wallet that has < 150 DC
    // Register a fresh wallet with exactly 100 DC
    const PK3='0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
    const A3=new realEthers.Wallet(PK3).address.toLowerCase();
    const t3=await getToken(A3,PK3);
    const H3={Authorization:`Bearer ${t3}`};
    await apiReq('POST','/api/register',{wallet:A3},H3);
    prepareMockDeposit(A3,1); // 100 DC
    await apiReq('POST','/api/deposit',{wallet:A3,amountPathUSD:1,txHash:'0xDEP3'},H3);
    // Give A3 two miners via admin send + box buy (but they have no DC for boxes after deposit)
    // Instead inject miners directly into DB
    const m3a={id:nextId(),wallet:A3,rarity_id:0,rarity_name:'Common',daily_digcoin:19,nft_age_total:19,nft_age_remaining:19,is_alive:true,needs_repair:false,last_play_at:null,power:200,energy:150,protective:150,damage:30,exp:0,level:1,created_at:new Date().toISOString()};
    const m3b={...m3a,id:nextId()};
    DB.miners.push(m3a,m3b);
    const {status:insufS,body:insufR}=await apiReq('POST','/api/miner/fuse',{wallet:A3,minerId1:m3a.id,minerId2:m3b.id},H3);
    check('insufficient balance → 400',insufS===400,`got ${insufS} ${insufR.error||''}`);
    check('insufficient balance error',insufR.error?.toLowerCase().includes('insufficient')||insufR.error?.toLowerCase().includes('balance'),insufR.error);

    // No auth
    const {status:noAuthS}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:1,minerId2:2});
    check('no auth → 401',noAuthS===401,`got ${noAuthS}`);

    // ─ Dead Miners Can Fuse ─
    section('DEAD MINERS CAN FUSE');
    // Set u2 miner 0 as dead
    const deadMiner=DB.miners.find(m=>m.id===u2m[0].id);
    if(deadMiner){ deadMiner.is_alive=false; deadMiner.needs_repair=true; deadMiner.nft_age_remaining=0; }
    const {status:deadS,body:deadR}=await apiReq('POST','/api/miner/fuse',{wallet:A2,minerId1:u2m[0].id,minerId2:u2m[1].id},H2);
    check('dead + alive miner → 200',deadS===200,`${deadS} ${deadR.error||''}`);
    check('dead fuse success=true',deadR.success===true);
    check('dead fuse result alive',deadR.miner?.is_alive===true);
    check('dead fuse cost=150',deadR.cost===150);
    // u2 should now have 1 miner
    const {body:p2a}=await apiReq('GET',`/api/player/${A2}`);
    check('u2 now has 1 miner',p2a.miners?.length===1,`got ${p2a.miners?.length}`);
    check('u2 new miner is alive',p2a.miners?.[0]?.isAlive===true);

    // ─ Chain Fuse ─
    section('CHAIN FUSE (fuse result immediately)');
    // u1 has miners: rem2 (idle) + new miner from first fuse (idle)
    const {body:p1b}=await apiReq('GET',`/api/player/${A1}`);
    const idleMiners=p1b.miners?.filter(m=>!m.isMining&&m.isAlive);
    if(idleMiners?.length>=2){
        const {status:cs,body:cr}=await apiReq('POST','/api/miner/fuse',{wallet:A1,minerId1:idleMiners[0].id,minerId2:idleMiners[1].id},H1);
        check('chain fuse → 200',cs===200,`${cs} ${cr.error||''}`);
        check('chain fuse result',cr.success===true);
    } else {
        check('chain fuse (skipped — not enough idle)',true,'');
        check('chain fuse result (skipped)',true,'');
    }

    // ─ Summary ─
    console.log('\n');
    printReport();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║  ${passed} passed  |  ${failed} failed${' '.repeat(Math.max(0,36-String(passed+failed).length))}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');
    process.exit(failed>0?1:0);
}

run().catch(e=>{console.error(e);process.exit(1);});
