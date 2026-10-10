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
          const matchR = (chuffedRaised.innerText || '').match(/[0-9,.]+/);
          const matchG = (chuffedTarget.innerText || '').match(/[0-9,.]+/);
          const r = matchR ? parseFloat(matchR[0].replace(/,/g, '')) : NaN;
          const g = matchG ? parseFloat(matchG[0].replace(/,/g, '')) : NaN;
          if (!isNaN(r) && !isNaN(g) && g > 0) {
            return { raised: Math.round(r), goal: Math.round(g), method: 'chuffed_dom' };
          }
        }

        for (const script of document.querySelectorAll('script')) {
          const txt = script.textContent || '';
          if (txt.includes('target_amount') || txt.includes('donation_total') || txt.
