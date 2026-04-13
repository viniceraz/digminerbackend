require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const WALLET = '0x8174db20bdc835c35f70a0a536c019c89c783d8c';
const API    = 'http://localhost:3000';
const api    = (method, path, body) =>
    fetch(API + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json());

const log  = msg => console.log('   ✅', msg);
const fail = msg => console.log('   ❌', msg);

async function main() {
    console.log('━'.repeat(58));
    console.log('⛏️   CLAIM / FARM TEST (simulated 24h cooldown)');
    console.log('━'.repeat(58));

    // 1. Estado atual
    const playerData = await api('GET', '/api/player/' + WALLET);
    const miners = playerData.miners;
    const alive  = miners.filter(m => m.isAlive && !m.needsRepair);
    console.log('Total miners:', miners.length, '| Alive:', alive.length);

    // 2. Forçar last_play_at = 25h atrás para todos os miners vivos
    const ago25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const ids    = alive.map(m => m.id);
    console.log('\n🕐 Setting last_play_at = 25h ago for', ids.length, 'miners...');
    const { error } = await supabase.from('miners').update({ last_play_at: ago25h }).in('id', ids);
    if (error) { console.error('Update error:', error); return; }
    log('Done — all miners now ready to play');

    // 3. Confirmar canPlay = true
    const refreshed = await api('GET', '/api/player/' + WALLET);
    const canPlay   = refreshed.miners.filter(m => m.canPlay && m.isAlive && !m.needsRepair);
    console.log('   Miners ready to play:', canPlay.length);

    // ── 4. PLAY INDIVIDUAL ───────────────────────────────────
    console.log('\n⛏️  TEST 1: Play single miner');
    const miner    = canPlay[0];
    const dcBefore = refreshed.player.digcoinBalance;
    console.log('   Miner #' + miner.id + ' (' + miner.rarityName + ') — ' + miner.dailyDigcoin + ' DC/day | age: ' + miner.nftAgeRemaining + '/' + miner.nftAgeTotal);
    console.log('   DIGCOIN before:', dcBefore.toFixed(2));

    const playRes = await api('POST', '/api/play/' + miner.id, { wallet: WALLET });
    if (!playRes.success) { fail('Play failed: ' + playRes.error); return; }
    log('Reward: ' + playRes.reward + ' DC | Age remaining: ' + playRes.nftAgeRemaining);

    if (Math.abs(playRes.reward - miner.dailyDigcoin) < 0.01)
        log('Reward matches daily_digcoin exactly');
    else
        fail('Reward mismatch! expected ' + miner.dailyDigcoin + ' got ' + playRes.reward);

    if (playRes.nftAgeRemaining === miner.nftAgeRemaining - 1)
        log('Age decremented correctly (' + miner.nftAgeRemaining + ' → ' + playRes.nftAgeRemaining + ')');
    else
        fail('Age wrong: expected ' + (miner.nftAgeRemaining - 1) + ' got ' + playRes.nftAgeRemaining);

    // 5. Verificar DIGCOIN no balance
    const afterPlay = await api('GET', '/api/player/' + WALLET);
    const delta     = afterPlay.player.digcoinBalance - dcBefore;
    console.log('   DIGCOIN after:', afterPlay.player.digcoinBalance.toFixed(2), '| delta:', delta.toFixed(2));
    if (Math.abs(delta - miner.dailyDigcoin) < 0.01)
        log('DIGCOIN credited correctly to player balance');
    else
        fail('Balance mismatch! delta ' + delta.toFixed(2) + ' expected ' + miner.dailyDigcoin);

    // ── 6. COOLDOWN APÓS CLAIM ───────────────────────────────
    console.log('\n⏳ TEST 2: Cooldown after claim (play same miner again)');
    const cooldownTest = await api('POST', '/api/play/' + miner.id, { wallet: WALLET });
    if (cooldownTest.error && cooldownTest.cooldown > 0) {
        const h  = Math.floor(cooldownTest.cooldown / 3600000);
        const m2 = Math.floor((cooldownTest.cooldown % 3600000) / 60000);
        log('Cooldown active: ' + h + 'h ' + m2 + 'm remaining');
    } else {
        fail('Cooldown NOT active after play! ' + JSON.stringify(cooldownTest));
    }

    // ── 7. PLAY ALL ──────────────────────────────────────────
    console.log('\n⛏️  TEST 3: Play All (' + (canPlay.length - 1) + ' remaining miners)');
    const playAllRes = await api('POST', '/api/play-all', { wallet: WALLET });
    if (playAllRes.played === undefined) { fail('Play All failed: ' + JSON.stringify(playAllRes)); }
    else {
        log('Played: ' + playAllRes.played + ' miners | net: ' + playAllRes.netReward + ' DC | fee: ' + playAllRes.playAllFee + ' DC | died: ' + playAllRes.died);
        if (playAllRes.playAllFee === playAllRes.played * 2)
            log('Play All fee correct (' + playAllRes.played + ' × 2 DC = ' + playAllRes.playAllFee + ' DC)');
        else
            fail('Fee wrong: expected ' + (playAllRes.played * 2) + ' got ' + playAllRes.playAllFee);
        if (playAllRes.netReward > 0)
            log('Net reward positive after fee deduction');
        if (playAllRes.died > 0)
            console.log('   ⚠️  ' + playAllRes.died + ' miner(s) died (age reached 0)');
        if (playAllRes.skipped > 0)
            log('Skipped ' + playAllRes.skipped + ' miners already on cooldown');
    }

    // ── 8. MINER DEATH ───────────────────────────────────────
    console.log('\n💀 TEST 4: Miner death (age = 1 → play → dies)');
    const freshData  = await api('GET', '/api/player/' + WALLET);
    const testMiner  = freshData.miners.find(m => m.isAlive && !m.needsRepair);
    if (!testMiner) { fail('No alive miner to test death'); }
    else {
        await supabase.from('miners').update({ nft_age_remaining: 1, last_play_at: ago25h }).eq('id', testMiner.id);
        const deathPlay = await api('POST', '/api/play/' + testMiner.id, { wallet: WALLET });

        if (deathPlay.success && deathPlay.minerDead) {
            log('Miner #' + testMiner.id + ' died after last play — reward: ' + deathPlay.reward + ' DC | age: ' + deathPlay.nftAgeRemaining);

            const postDeath  = await api('GET', '/api/player/' + WALLET);
            const deadMiner  = postDeath.miners.find(m => m.id === testMiner.id);
            if (deadMiner && deadMiner.needsRepair && !deadMiner.isAlive)
                log('Dead miner correctly → needsRepair=true, isAlive=false');
            else
                fail('Dead miner state wrong: ' + JSON.stringify(deadMiner));

            // Tentar jogar miner morto — deve bloquear
            const playDead = await api('POST', '/api/play/' + testMiner.id, { wallet: WALLET });
            if (playDead.error)
                log('Playing dead miner blocked: "' + playDead.error + '"');
            else
                fail('Dead miner allowed to play!');

            // ── 9. REPAIR ────────────────────────────────────
            console.log('\n🔧 TEST 5: Repair dead miner');
            const repairRes = await api('POST', '/api/repair/' + testMiner.id, { wallet: WALLET });
            if (repairRes.success) {
                log('Repaired! Cost: ' + repairRes.costDigcoin + ' DC (' + repairRes.costPathUSD + ' pathUSD)');
                const postRepair = await api('GET', '/api/player/' + WALLET);
                const fixed      = postRepair.miners.find(m => m.id === testMiner.id);
                if (fixed && fixed.isAlive && !fixed.needsRepair && fixed.nftAgeRemaining === fixed.nftAgeTotal)
                    log('Miner fully restored: age ' + fixed.nftAgeRemaining + '/' + fixed.nftAgeTotal + ', alive: ' + fixed.isAlive);
                else
                    fail('State after repair wrong: ' + JSON.stringify(fixed));

                // Repair de um miner saudável deve falhar
                const repairHealthy = await api('POST', '/api/repair/' + testMiner.id, { wallet: WALLET });
                if (repairHealthy.error === 'Miner does not need repair')
                    log('Repair guard working (healthy miner rejected)');
                else
                    fail('Healthy miner allowed repair: ' + JSON.stringify(repairHealthy));
            } else {
                fail('Repair failed: ' + repairRes.error);
            }
        } else {
            fail('Death play failed: ' + JSON.stringify(deathPlay));
        }
    }

    // ── 10. FINAL STATE ──────────────────────────────────────
    const final = await api('GET', '/api/player/' + WALLET);
    console.log('\n━'.repeat(58));
    console.log('📊  FINAL STATE');
    console.log('━'.repeat(58));
    console.log('DIGCOIN balance :', final.player.digcoinBalance.toFixed(2), 'DC');
    console.log('Total earned    :', (final.player.totalEarnedDigcoin || 0).toFixed(2), 'DC');
    console.log('Total miners    :', final.stats.totalMiners);
    console.log('Alive miners    :', final.stats.aliveMiners);
    console.log('Daily income    :', final.stats.dailyIncome.toFixed(2), 'DC/day');
    console.log('\n✅  CLAIM/FARM TEST COMPLETE');
    console.log('━'.repeat(58));
}

main().catch(console.error);
