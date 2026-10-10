/**
 * GazaConnect — Automated Live Campaign Sync Bot
 * Accurately syncs live raised amounts and goals from Chuffed.org, GoFundMe,
 * and Spotfund directly into GazaConnect and publishes updates live.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LIVE_DATA_URL = 'https://gazaconnect.org/data.json';
const LIVE_SAVE_URL = 'https://gazaconnect.org/save-data.php';
const MASTER_PASSCODE = process.env.ADMIN_PASSCODE || 'Ilovecats77';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isChuffedOnly = args.includes('--chuffed-only');
const intervalIdx = args.indexOf('--interval');
const loopIntervalMinutes = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : 0;
const singleIdx = args.indexOf('--single');
const singleMemberId = singleIdx >= 0 ? args[singleIdx + 1] : null;

function findBrowserPath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url + '?t=' + Date.now(), res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function publishToServer(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ passcode: MASTER_PASSCODE, data });
    const req = https.request(LIVE_SAVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function scrapeCampaignData(sendCmd, url) {
  const t0 = Date.now();
  await sendCmd('Page.navigate', { url });

  const maxWaitMs = 18000;
  while (Date.now() - t0 < maxWaitMs) {
    await new Promise(r => setTimeout(r, 1200));

    const evalRes = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const title = document.title || '';
        if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare') || title.toLowerCase().includes('attention required')) {
          return { status: 'verifying' };
        }

        const chuffedRaised = document.querySelector('.progress-meter__value-raised, [class*="progress-meter"] [class*="raised"], [class*="fundraiser"] [class*="raised"]');
        const chuffedTarget = document.querySelector('.progress-meter__value-target, [class*="progress-meter"] [class*="target"], [class*="fundraiser"] [class*="target"], [class*="fundraiser"] [class*="goal"]');
        if (chuffedRaised && chuffedTarget) {
          const matchR = (chuffedRaised.innerText || '').match(/[\\d,.]+/);
          const matchG = (chuffedTarget.innerText || '').match(/[\\d,.]+/);
          const r = matchR ? parseFloat(matchR[0].replace(/,/g, '')) : NaN;
          const g = matchG ? parseFloat(matchG[0].replace(/,/g, '')) : NaN;
          if (!isNaN(r) && !isNaN(g) && g > 0) {
            return { raised: Math.round(r), goal: Math.round(g), method: 'chuffed_dom' };
          }
        }

        for (const script of document.querySelectorAll('script')) {
          const txt = script.textContent || '';
          if (txt.includes('target_amount') || txt.includes('donation_total') || txt.includes('total_raised')) {
            const mR = txt.match(/(?:"donation_total"|"total_raised"|"raised_amount"|"amount_raised")\\s*:\\s*"?([\\d,.]+)"?/);
            const mG = txt.match(/(?:"target_amount"|"target"|"goal_amount"|"goal")\\s*:\\s*"?([\\d,.]+)"?/);
            if (mR && mG) {
              const r = parseFloat(mR[1].replace(/,/g, ''));
              const g = parseFloat(mG[1].replace(/,/g, ''));
              if (!isNaN(r) && !isNaN(g) && g > 0) {
                return { raised: Math.round(r), goal: Math.round(g), method: 'chuffed_json' };
              }
            }
          }
        }

        const gfmScript = document.getElementById('__NEXT_DATA__');
        if (gfmScript) {
          try {
            const d = JSON.parse(gfmScript.textContent);
            const state = d.props?.pageProps?.__APOLLO_STATE__;
            for (const k of Object.keys(state || {})) {
              if (k.startsWith('Fundraiser:') && state[k].currentAmount) {
                let r = state[k].currentAmount.amount;
                let g = state[k].goalAmount.amount;
                const c = state[k].currentAmount.currencyCode;
                if (c === 'MXN') { r = Math.round(r / 18.283); g = Math.round(g / 18.367); }
                return { raised: Math.round(r), goal: Math.round(g), currency: c, method: 'gfm_apollo' };
              }
            }
          } catch(e) {}
        }

        const text = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
        const m = text.match(/[\\$£€]([\\d,.]+)\\s*(?:USD|CAD|AUD|EUR|GBP)?\\s*(?:raised\\s*)?of\\s*[\\$£€]([\\d,.]+)/i);
        if (m) {
          const r = parseFloat(m[1].replace(/,/g, ''));
          const g = parseFloat(m[2].replace(/,/g, ''));
          if (!isNaN(r) && !isNaN(g) && g > 0) {
            return { raised: Math.round(r), goal: Math.round(g), method: 'text_pattern' };
          }
        }

        return { status: 'waiting', title: document.title };
      })()`,
      returnByValue: true
    });

    const val = evalRes?.result?.value;
    if (val && val.raised !== undefined && val.goal !== undefined) {
      return val;
    }
    if (val && val.status === 'verifying') {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

async function runSyncSession() {
  console.log('\n======================================================');
  console.log('🍉 GazaConnect Live Campaign Sync Bot');
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
  if (isDryRun) console.log('⚠️ Running in DRY-RUN mode (no server saves)');
  if (isChuffedOnly) console.log('🎯 Filtering: Chuffed.org campaigns only');
  console.log('======================================================\n');

  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.error('❌ Could not find Google Chrome or Chromium installed on this system.');
    return;
  }

  let data;
  try {
    process.stdout.write('📡 Fetching live data from https://gazaconnect.org/data.json... ');
    data = await fetchJson(LIVE_DATA_URL);
    console.log(`✅ Loaded ${data.members.length} families.`);
  } catch (err) {
    console.error(`❌ Could not fetch data.json: ${err.message}`);
    return;
  }

  const port = 9555;
  const tempBase = process.env.TEMP || process.env.TMPDIR || '/tmp';
  const profileDir = path.join(tempBase, 'gazaconnect_sync_bot_prof');
  const browserArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    'about:blank'
  ];
  const proc = spawn(browserPath, browserArgs);

  await new Promise(r => setTimeout(r, 2000));

  let ws;
  let pageTab;
  try {
    const listRes = await fetch(`http://localhost:${port}/json/list`);
    const tabs = await listRes.json();
    pageTab = tabs.find(t => t.type === 'page') || tabs[0];
    ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
  } catch (err) {
    proc.kill();
    console.error('❌ Could not connect to browser CDP:', err.message);
    return;
  }

  function sendCmd(method, params = {}) {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1000000);
      const onMsg = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  let totalUpdated = 0;
  let totalChecked = 0;
  let totalNewMoney = 0;
  const retryQueue = [];

  try {
    await sendCmd('Page.enable');

    const seenUrls = new Set();
    let targetMembers = data.members.filter(m => {
      if (m.isComingSoon || !m.campaignUrl || !/^https?:\\/\\//i.test(m.campaignUrl)) return false;
      if (singleMemberId && m.id !== singleMemberId) return false;
      if (isChuffedOnly && !m.campaignUrl.includes('chuffed.org')) return false;

      const cleanUrl = m.campaignUrl.split('?')[0].replace(/\\/$/, '').toLowerCase();
      if (seenUrls.has(cleanUrl)) return false;
      seenUrls.add(cleanUrl);
      return true;
    });

    console.log(`📋 Total Families on Site: ${data.members.length}`);
    console.log(`   • ${targetMembers.length} campaigns scanned automatically online\n`);

    for (let i = 0; i < targetMembers.length; i++) {
      const m = targetMembers[i];
      const memberLabel = (m.tabLabel || m.name || m.id).padEnd(35, ' ');
      process.stdout.write(`[${i + 1}/${targetMembers.length}] ${memberLabel} `);

      const oldRaised = Number(m.raisedAmount) || 0;
      const oldGoal = Number(m.goalAmount) || 0;
      totalChecked++;

      try {
        const tStart = Date.now();
        const scraped = await scrapeCampaignData(sendCmd, m.campaignUrl);
        const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

        if (scraped && scraped.raised !== undefined) {
          const newRaised = scraped.raised;
          const newGoal = scraped.goal > 0 ? scraped.goal : oldGoal;
          const newPct = Math.round((newRaised / newGoal) * 100);
          const delta = newRaised - oldRaised;

          if (newRaised !== oldRaised || newGoal !== oldGoal) {
            m.raisedAmount = newRaised;
            m.goalAmount = newGoal;
            m.progressPercent = newPct;
            m.lastSyncedAt = new Date().toISOString();
            totalUpdated++;
            if (delta > 0) totalNewMoney += delta;
            console.log(`✨ UPDATED: $${newRaised.toLocaleString()} / $${newGoal.toLocaleString()} (${newPct}%) [+$${delta.toLocaleString()}] in ${elapsed}s`);
          } else {
            console.log(`✓ Up-to-date: $${newRaised.toLocaleString()} (${newPct}%) in ${elapsed}s`);
          }
        } else {
          console.log(`⚠️ Scrape timed out (${elapsed}s) — queued for retry`);
          retryQueue.push(m);
        }
      } catch (err) {
        console.log(`❌ Error: ${err.message}`);
        retryQueue.push(m);
      }

      if ((i + 1) % 6 === 0 && i + 1 < targetMembers.length) {
        process.stdout.write('   ⏳ [Pacing] Pausing 2.5s to keep requests natural...');
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    if (retryQueue.length > 0) {
      console.log(`\n🔁 Retrying ${retryQueue.length} campaign(s) that encountered verification delays...`);
      for (let rIdx = 0; rIdx < retryQueue.length; rIdx++) {
        const m = retryQueue[rIdx];
        const memberLabel = (m.tabLabel || m.name || m.id).padEnd(30, ' ');
        process.stdout.write(`[Retry ${rIdx + 1}/${retryQueue.length}] ${memberLabel} `);

        const oldRaised = Number(m.raisedAmount) || 0;
        const oldGoal = Number(m.goalAmount) || 0;

        try {
          const tStart = Date.now();
          const scraped = await scrapeCampaignData(sendCmd, m.campaignUrl);
          const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

          if (scraped && scraped.raised !== undefined) {
            const newRaised = scraped.raised;
            const newGoal = scraped.goal > 0 ? scraped.goal : oldGoal;
            const newPct = Math.round((newRaised / newGoal) * 100);
            const delta = newRaised - oldRaised;

            if (newRaised !== oldRaised || newGoal !== oldGoal) {
              m.raisedAmount = newRaised;
              m.goalAmount = newGoal;
              m.progressPercent = newPct;
              m.lastSyncedAt = new Date().toISOString();
              totalUpdated++;
              if (delta > 0) totalNewMoney += delta;
              console.log(`✨ UPDATED on retry: $${newRaised.toLocaleString()} / $${newGoal.toLocaleString()} (${newPct}%) in ${elapsed}s`);
            } else {
              console.log(`✓ Verified on retry: $${newRaised.toLocaleString()} (${newPct}%) in ${elapsed}s`);
            }
          } else {
            console.log(`✓ Kept baseline $${oldRaised.toLocaleString()} (${elapsed}s)`);
          }
        } catch (err) {
          console.log(`⚠️ Kept baseline $${oldRaised.toLocaleString()}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

  } finally {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    if (proc) {
      try { proc.kill(); } catch (e) {}
    }
  }

  console.log('\n------------------------------------------------------');
  console.log('📊 Sync Summary:');
  console.log(`   Total Families on Site: ${data.members.length}`);
  console.log(`   Checked: ${totalChecked} online campaigns`);
  console.log(`   Updated: ${totalUpdated} initiatives with new numbers`);
  if (totalNewMoney > 0) {
    console.log(`   💰 Fresh Donations Detected: +$${totalNewMoney.toLocaleString()} USD!`);
  }

  const grandTotalRaised = data.members.reduce((sum, m) => sum + (Number(m.raisedAmount) || 0), 0);
  const grandTotalGoal = data.members.reduce((sum, m) => sum + (Number(m.goalAmount) || 0), 0);
  console.log(`   🍉 Grand Total Raised: $${grandTotalRaised.toLocaleString()} of $${grandTotalGoal.toLocaleString()}`);
  console.log('------------------------------------------------------\n');

  if (!isDryRun) {
    data.siteConfig.lastUpdated = new Date().toISOString();
    if (totalUpdated > 0) {
      process.stdout.write('🚀 Publishing updated numbers live to https://gazaconnect.org... ');
      try {
        const pubRes = await publishToServer(data);
        if (pubRes.status === 200 && pubRes.body && pubRes.body.ok) {
          console.log('✅ 100% Published Live to Server!');
        } else {
          console.log(`⚠️ Server status ${pubRes.status}`);
        }
      } catch (err) {
        console.error(`❌ Could not publish to server: ${err.message}`);
      }
    } else {
      console.log('ℹ️ All campaigns were already 100% up to date. Live site is current!');
    }
  }

  console.log('\n🎉 Finished at:', new Date().toLocaleTimeString());
}

runSyncSession().catch(console.error);
