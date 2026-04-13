/**
 * DigMiner — Full Game Test
 * Tests: faucet, deposit (on-chain), buy boxes, farm, play-all, withdraw, fee verification
 */
require('dotenv').config();
const { ethers } = require('ethers');

const API = 'http://localhost:3000';
const RPC = process.env.RPC_URL;
const POOL_ADDR = process.env.POOL_CONTRACT;
const PATHUSD_ADDR = '0x20C0000000000000000000000000000000000000';
const PRIVATE_KEY = '0x' + process.env.SIGNER_PRIVATE_KEY;

const POOL_ABI = [
    'function deposit(uint256 amount) external',
    'function withdraw(uint256 amount, uint256 deadline, bytes signature) external',
    'function poolBalance() external view returns (uint256)',
    'function getNonce(address) view returns (uint256)',
];
const TOKEN_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
const pool     = new ethers.Contract(POOL_ADDR, POOL_ABI, signer);
const token    = new ethers.Contract(PATHUSD_ADDR, TOKEN_ABI, signer);
const WALLET   = signer.address;

const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
};

const log  = (msg) => console.log(`\n✅ ${msg}`);
const warn = (msg) => console.log(`\n⚠️  ${msg}`);
const err  = (msg) => console.log(`\n❌ ${msg}`);
const sep  = ()    => console.log('\n' + '─'.repeat(60));

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    console.log('⛏️  DigMiner Full Test\n' + '═'.repeat(60));
    console.log(`Wallet : ${WALLET}`);
    console.log(`Pool   : ${POOL_ADDR}`);

    const decimals = Number(await token.decimals());

    // ── 1. Faucet ─────────────────────────────────────────────
    sep();
    console.log('1️⃣  FAUCET');
    const faucetRes = await api('POST', '/api/faucet', { wallet: WALLET });
    if (faucetRes.success) log('Faucet called — waiting 8s for txs to confirm...');
    else warn('Faucet: ' + JSON.stringify(faucetRes));
    await sleep(8000);

    const pathUSDStart = parseFloat(ethers.formatUnits(await token.balanceOf(WALLET), decimals));
    console.log(`   pathUSD balance: ${pathUSDStart.toFixed(4)}`);

    // ── 2. Register ───────────────────────────────────────────
    sep();
    console.log('2️⃣  REGISTER');
    const reg = await api('POST', '/api/register', { wallet: WALLET });
    log('Player: ' + JSON.stringify(reg.player ?? reg));

    // ── 3. On-chain Deposit ────────────────────────────────────
    sep();
    console.log('3️⃣  ON-CHAIN DEPOSIT (10 pathUSD = 1000 DIGCOIN)');
    const depositAmt = 10;
    const depositWei = ethers.parseUnits(depositAmt.toString(), decimals);

    const poolBefore = parseFloat(ethers.formatUnits(await pool.poolBalance(), decimals));
    console.log(`   Pool before: ${poolBefore.toFixed(4)} pathUSD`);

    console.log('   Approving...');
    const approveTx = await token.approve(POOL_ADDR, depositWei);
    await approveTx.wait();
    log(`Approved — tx: ${approveTx.hash}`);

    console.log('   Depositing...');
    const depositTx = await pool.deposit(depositWei);
    const depositReceipt = await depositTx.wait();
    log(`Deposited — tx: ${depositTx.hash}`);

    // Notify backend manually (backup)
    const depRes = await api('POST', '/api/deposit', { wallet: WALLET, amountPathUSD: depositAmt, txHash: depositTx.hash });
    console.log(`   Backend deposit: ${JSON.stringify(depRes)}`);

    const poolAfterDeposit = parseFloat(ethers.formatUnits(await pool.poolBalance(), decimals));
    console.log(`   Pool after deposit: ${poolAfterDeposit.toFixed(4)} pathUSD`);
    if (Math.abs((poolAfterDeposit - poolBefore) - depositAmt) < 0.01) log('Pool funded correctly (+10 pathUSD)');
    else warn(`Pool delta unexpected: ${(poolAfterDeposit - poolBefore).toFixed(4)}`);

    // ── 4. Check DIGCOIN balance ───────────────────────────────
    sep();
    console.log('4️⃣  CHECK DIGCOIN BALANCE');
    const playerData = await api('GET', `/api/player/${WALLET}`);
    const digcoin = playerData.player.digcoinBalance;
    console.log(`   DIGCOIN: ${digcoin}`);
    if (digcoin >= 1000) log('DIGCOIN credited correctly');
    else err(`Expected ≥1000 DIGCOIN, got ${digcoin}`);

    // ── 5. Buy 1 Box ──────────────────────────────────────────
    sep();
    console.log('5️⃣  BUY 1 BOX (300 DC)');
    const box1 = await api('POST', '/api/box/buy', { wallet: WALLET, quantity: 1 });
    if (box1.success) {
        const m = box1.miners[0];
        log(`Miner revealed: #${m.id} ${m.rarityName} — ${m.dailyDigcoin} DC/day, ROI ~${m.roi} days`);
    } else err('Buy box: ' + JSON.stringify(box1));

    // ── 6. Buy 10 Boxes (bulk discount) ───────────────────────
    sep();
    console.log('6️⃣  BUY 10 BOXES (2850 DC, 5% discount)');
    const box10 = await api('POST', '/api/box/buy', { wallet: WALLET, quantity: 10 });
    if (box10.success) {
        const rarities = box10.miners.map(m => m.rarityName);
        const counts = rarities.reduce((a, r) => { a[r] = (a[r]||0)+1; return a; }, {});
        log(`10 miners: ${JSON.stringify(counts)} — cost: ${box10.cost} DC, discount: ${box10.discount}`);
        if (box10.cost === 2850) log('5% bulk discount applied correctly');
        else err(`Expected 2850 DC, got ${box10.cost}`);
    } else err('Buy 10 boxes: ' + JSON.stringify(box10));

    // ── 7. Play single miner ──────────────────────────────────
    sep();
    console.log('7️⃣  PLAY SINGLE MINER');
    const player2 = await api('GET', `/api/player/${WALLET}`);
    const firstMiner = player2.miners.find(m => m.isAlive && m.canPlay && !m.needsRepair);
    if (!firstMiner) { warn('No playable miner found'); }
    else {
        const playRes = await api('POST', `/api/play/${firstMiner.id}`, { wallet: WALLET });
        if (playRes.success) {
            log(`Played miner #${firstMiner.id} (${firstMiner.rarityName}) — reward: ${playRes.reward} DC, age left: ${playRes.nftAgeRemaining}`);
        } else err('Play: ' + JSON.stringify(playRes));

        // Try playing again immediately — should get cooldown
        console.log('   Testing cooldown (play same miner again)...');
        const play2 = await api('POST', `/api/play/${firstMiner.id}`, { wallet: WALLET });
        if (play2.error && play2.cooldown) log(`Cooldown working: "${play2.error}"`);
        else err('Cooldown not working: ' + JSON.stringify(play2));
    }

    // ── 8. Play All ───────────────────────────────────────────
    sep();
    console.log('8️⃣  PLAY ALL');
    const playAll = await api('POST', '/api/play-all', { wallet: WALLET });
    if (playAll.played !== undefined) {
        log(`Play All: ${playAll.played} miners played, net reward: ${playAll.netReward} DC (fee: ${playAll.playAllFee} DC), ${playAll.died} died`);
        if (playAll.playAllFee === playAll.played * 2) log('Play All fee (2 DC/miner) correct');
        else err(`Fee mismatch: expected ${playAll.played * 2}, got ${playAll.playAllFee}`);
    } else err('Play All: ' + JSON.stringify(playAll));

    // ── 9. Balance after farming ──────────────────────────────
    sep();
    console.log('9️⃣  BALANCE AFTER FARMING');
    const player3 = await api('GET', `/api/player/${WALLET}`);
    console.log(`   DIGCOIN: ${player3.player.digcoinBalance.toFixed(2)} DC`);
    console.log(`   Miners: ${player3.stats.totalMiners} total, ${player3.stats.aliveMiners} alive`);
    console.log(`   Daily income: ${player3.stats.dailyIncome.toFixed(2)} DC/day`);

    // ── 10. Withdraw — check 6% fee stays in pool ─────────────
    sep();
    console.log('🔟  WITHDRAW (on-chain — 100 DC = 1 pathUSD, 6% fee)');
    const poolBeforeWithdraw = parseFloat(ethers.formatUnits(await pool.poolBalance(), decimals));
    const walletBefore = parseFloat(ethers.formatUnits(await token.balanceOf(WALLET), decimals));
    console.log(`   Pool before withdraw: ${poolBeforeWithdraw.toFixed(4)} pathUSD`);
    console.log(`   Wallet before:        ${walletBefore.toFixed(4)} pathUSD`);

    const withdrawDC  = 100; // 1 pathUSD
    const withdrawRes = await api('POST', '/api/withdraw', { wallet: WALLET, amountDigcoin: withdrawDC });

    if (withdrawRes.error) {
        err('Withdraw backend: ' + withdrawRes.error);
    } else {
        console.log(`   Signature received — amount: ${withdrawRes.amountPathUSD} pathUSD, fee: ${withdrawRes.feePathUSD}, net: ${withdrawRes.netPathUSD}`);

        // Verify fee calculation
        const expectedFee = withdrawRes.amountPathUSD * 0.06;
        if (Math.abs(withdrawRes.feePathUSD - expectedFee) < 0.0001) log('6% fee calculated correctly');
        else err(`Fee wrong: expected ${expectedFee.toFixed(6)}, got ${withdrawRes.feePathUSD}`);

        // Call pool.withdraw on-chain
        const sig = withdrawRes.signature;
        try {
            console.log('   Sending on-chain withdraw...');
            const wtx = await pool.withdraw(sig.amount, sig.deadline, sig.signature);
            await wtx.wait();
            log(`Withdrawn on-chain — tx: ${wtx.hash}`);

            await sleep(4000);
            const poolAfterWithdraw  = parseFloat(ethers.formatUnits(await pool.poolBalance(), decimals));
            const walletAfter        = parseFloat(ethers.formatUnits(await token.balanceOf(WALLET), decimals));
            const poolDelta  = poolAfterWithdraw - poolBeforeWithdraw;
            const walletDelta = walletAfter - walletBefore;

            console.log(`\n   Pool after withdraw:   ${poolAfterWithdraw.toFixed(6)} pathUSD`);
            console.log(`   Wallet after:          ${walletAfter.toFixed(6)} pathUSD`);
            console.log(`   Pool delta:            ${poolDelta.toFixed(6)} pathUSD (fee stayed in pool)`);
            console.log(`   Wallet delta:          ${walletDelta.toFixed(6)} pathUSD (received by player)`);

            const expectedNet = withdrawRes.amountPathUSD * 0.94;
            const expectedFeeInPool = withdrawRes.amountPathUSD * 0.06;

            if (Math.abs(walletDelta - expectedNet) < 0.001) log(`Player received correct net: ${walletDelta.toFixed(6)} pathUSD`);
            else err(`Net mismatch: expected ~${expectedNet.toFixed(6)}, got ${walletDelta.toFixed(6)}`);

            if (poolDelta > -0.001) log(`Pool retained fee: ${poolDelta.toFixed(6)} pathUSD (expected ~${(depositAmt - expectedNet).toFixed(6)})`);
            else err(`Pool lost more than expected: delta ${poolDelta.toFixed(6)}`);

        } catch(e) {
            err('On-chain withdraw failed: ' + (e.reason || e.message));
        }
    }

    // ── 11. Withdraw cooldown ─────────────────────────────────
    sep();
    console.log('1️⃣1️⃣  WITHDRAW COOLDOWN (try withdrawing again immediately)');
    const cooldownTest = await api('POST', '/api/withdraw', { wallet: WALLET, amountDigcoin: 100 });
    if (cooldownTest.error && cooldownTest.cooldownMs) {
        const h = Math.floor(cooldownTest.cooldownMs / 3600000);
        const m = Math.floor((cooldownTest.cooldownMs % 3600000) / 60000);
        log(`Cooldown working: ${h}h ${m}m remaining`);
    } else err('Cooldown not enforced: ' + JSON.stringify(cooldownTest));

    // ── 12. Repair test ───────────────────────────────────────
    sep();
    console.log('1️⃣2️⃣  REPAIR TEST (healthy miner should return error)');
    const player4 = await api('GET', `/api/player/${WALLET}`);
    const aliveMiner = player4.miners.find(m => m.isAlive && !m.needsRepair);
    if (aliveMiner) {
        const repairAlive = await api('POST', `/api/repair/${aliveMiner.id}`, { wallet: WALLET });
        if (repairAlive.error === 'Miner does not need repair') log('Repair guard working correctly');
        else err('Repair guard: ' + JSON.stringify(repairAlive));
    }

    // ── Final Summary ─────────────────────────────────────────
    sep();
    console.log('📊  FINAL SUMMARY');
    const finalPlayer = await api('GET', `/api/player/${WALLET}`);
    const fp = finalPlayer.player;
    console.log(`   DIGCOIN balance:       ${fp.digcoinBalance.toFixed(2)} DC`);
    console.log(`   Total deposited:       ${fp.totalDepositedPathUSD} pathUSD`);
    console.log(`   Total withdrawn:       ${fp.totalWithdrawnPathUSD?.toFixed(4) ?? 0} pathUSD`);
    console.log(`   Boxes bought:          ${fp.boxesBought}`);
    console.log(`   Total miners:          ${finalPlayer.stats.totalMiners}`);
    console.log(`   Alive miners:          ${finalPlayer.stats.aliveMiners}`);
    console.log(`   Daily income:          ${finalPlayer.stats.dailyIncome.toFixed(2)} DC/day`);

    const finalPool = parseFloat(ethers.formatUnits(await pool.poolBalance(), decimals));
    console.log(`\n   Pool balance:          ${finalPool.toFixed(6)} pathUSD`);

    sep();
    console.log('✅  ALL TESTS COMPLETE\n');
}

run().catch(e => { console.error('\n💥 FATAL:', e.message); process.exit(1); });
