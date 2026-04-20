/**
 * background.js  v3.1 — FIXED
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE FIX #1 — "Instant Failed" bug
 * ──────────────────────────────────────────
 * The v3 architecture used chrome.tabs.sendMessage() to deliver
 * SEND_TO_CONTACT to the content script, then immediately navigated
 * the tab via window.location.href inside content.js.
 *
 * THE BUG: window.location.href navigation DESTROYS the current page
 * context and all its JavaScript. The content script dies mid-execution.
 * Chrome throws "Could not establish connection. Receiving end does not
 * exist." on the sendMessage call, which falls into the background's
 * catch block → instant TIMEOUT failure for every contact.
 *
 * THE FIX: Navigation is now owned by background.js via chrome.tabs.update().
 * Background navigates the tab, then waits for the tab to finish loading
 * (chrome.tabs.onUpdated), THEN sends SEND_TO_CONTACT to the freshly
 * loaded content script. The content script no longer navigates at all —
 * it receives the message, finds the already-open chat, and sends.
 *
 * ROOT CAUSE FIX #2 — content script not injected on fresh page load
 * ───────────────────────────────────────────────────────────────────
 * After chrome.tabs.update navigates to a new URL, Chrome re-injects
 * the content script declared in manifest.json automatically.
 * But there's a race: sendMessage can arrive before the script is ready.
 * We add a 2-second grace period after onUpdated fires before sending.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

let campaign = null;

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_CAMPAIGN':
      startCampaign(msg);
      break;
    case 'PAUSE_CAMPAIGN':
      if (campaign) campaign.paused = true;
      break;
    case 'RESUME_CAMPAIGN':
      if (campaign) { campaign.paused = false; runNext(); }
      break;
    case 'STOP_CAMPAIGN':
      if (campaign) campaign.stopped = true;
      break;
    case 'SEND_RESULT':
      handleSendResult(msg.success, msg.errorCode || '', msg.reason || '');
      break;
  }
  return true;
});

// ── Campaign Setup ────────────────────────────────────────────────────────────

async function startCampaign(config) {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) {
    notifyPopup({ type: 'ERROR', message: 'No WhatsApp Web tab found. Please open web.whatsapp.com first.' });
    return;
  }

  campaign = {
    contacts:       config.contacts,
    message:        config.message,
    sendMode:       config.sendMode || 'text',
    media:          config.media    || null,
    delayMin:       config.delayMin,
    delayMax:       config.delayMax,
    batchSize:      config.batchSize,
    batchPause:     config.batchPause,
    index:          0,
    sent:           0,
    failed:         0,
    results:        [],
    paused:         false,
    stopped:        false,
    whatsappTabId:  tabs[0].id,
    _resolveResult: null,
  };

  runNext();
}

// ── Campaign Loop ─────────────────────────────────────────────────────────────

async function runNext() {
  if (!campaign)          return;
  if (campaign.stopped)   return finishCampaign();
  if (campaign.paused)    return;

  const { contacts, index } = campaign;
  if (index >= contacts.length) return finishCampaign();

  // Batch pause
  if (index > 0 && index % campaign.batchSize === 0) {
    notifyPopup({ type: 'BATCH_PAUSE', waitMs: campaign.batchPause });
    await sleep(campaign.batchPause);
    if (campaign.stopped) return finishCampaign();
    if (campaign.paused)  return;
  }

  const contact = contacts[index];

  notifyPopup({
    type:        'PROGRESS',
    sent:         campaign.sent,
    failed:       campaign.failed,
    total:        contacts.length,
    currentName:  contact.name,
    currentPhone: contact.phone,
  });

  try {
    const personalizedMsg = personalizeMessage(campaign.message, contact);

    // ── FIXED: Background owns navigation. Content script does NOT navigate. ──
    //
    // Step 1: Navigate the WA tab to the contact's chat URL.
    //         chrome.tabs.update is safe — it doesn't destroy background.js.
    // const chatUrl = `https://web.whatsapp.com/send?phone=${encodeURIComponent(contact.phone)}`;
    // const chatUrl = `https://web.whatsapp.com/send?phone=${contact.phone}`;
    // The &t= parameter forces Chrome to treat this as a new navigation event
    const chatUrl = `https://web.whatsapp.com/send?phone=${contact.phone}&t=${Date.now()}`;
    await chrome.tabs.update(campaign.whatsappTabId, { url: chatUrl });

    // Step 2: Wait for the tab to finish loading the new page.
    //         This is when Chrome re-injects the content script.
    await waitForTabLoad(campaign.whatsappTabId, 30000);

    // Step 3: Give the content script a moment to initialise after injection.
    //         Without this grace period, sendMessage arrives before the
    //         content script's listener is registered.
    await sleep(2000);

    if (campaign.stopped) return finishCampaign();
    if (campaign.paused)  return;

    // // Step 4: Now send the work order to the freshly loaded content script.
    // await chrome.tabs.sendMessage(campaign.whatsappTabId, {
    //   type:     'SEND_TO_CONTACT',
    //   phone:    contact.phone,
    //   message:  personalizedMsg,
    //   sendMode: campaign.sendMode,
    //   media:    campaign.media,
    // });

    // // Step 5: Wait for SEND_RESULT back from content.js
    // const result = await waitForSendResult(contact, 65000);

    // Step 4: Start the listener PROMISE first (so we don't miss the fast response)
const resultPromise = waitForSendResult(contact, 65000);

// Step 5: Fire the command to the content script (Remove the 'await')
chrome.tabs.sendMessage(campaign.whatsappTabId, {
  type:     'SEND_TO_CONTACT',
  phone:    contact.phone,
  message:  personalizedMsg,
  sendMode: campaign.sendMode,
  media:    campaign.media,
}).catch(err => console.log("Connection check:", err.message)); 

// Step 6: Now wait for the result to resolve
const result = await resultPromise;

    campaign.results.push(result);
    if (result.status === 'sent') campaign.sent++;
    else                          campaign.failed++;

    const delay = randomBetween(campaign.delayMin, campaign.delayMax);

    notifyPopup({
      type:        'PROGRESS',
      sent:         campaign.sent,
      failed:       campaign.failed,
      total:        contacts.length,
      currentName:  contact.name,
      currentPhone: contact.phone,
      lastResult:   result,
    });

    await sleep(delay);
    campaign.index++;
    runNext();

  } catch (err) {
    console.error('[WA Bulk] runNext error:', err.message);
    campaign.results.push({
      name:      contact.name,
      phone:     contact.phone,
      status:    'failed',
      errorCode: 'TIMEOUT',
      reason:    err.message,
    });
    campaign.failed++;
    campaign.index++;
    runNext();
  }
}

// ── Tab Load Waiter ───────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves when the specified tab reaches
 * status === 'complete', or rejects after timeoutMs.
 *
 * This is the KEY fix: we know the page (and content script) is ready
 * only after this resolves.
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Result Handling ───────────────────────────────────────────────────────────

function waitForSendResult(contact, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      campaign._resolveResult = null;
      reject(new Error(`TIMEOUT waiting for SEND_RESULT (${contact.phone})`));
    }, timeoutMs);

    campaign._resolveResult = (success, errorCode, reason) => {
      clearTimeout(timer);
      campaign._resolveResult = null;
      resolve({
        name:      contact.name,
        phone:     contact.phone,
        status:    success ? 'sent' : 'failed',
        errorCode: errorCode || '',
        reason:    reason    || '',
      });
    };
  });
}

function handleSendResult(success, errorCode, reason) {
  if (campaign && campaign._resolveResult) {
    campaign._resolveResult(success, errorCode, reason);
  }
}

function finishCampaign() {
  const c  = campaign;
  campaign = null;
  notifyPopup({
    type:    'COMPLETE',
    sent:     c.sent,
    failed:   c.failed,
    total:    c.contacts.length,
    results:  c.results,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function personalizeMessage(template, contact) {
  return template
    .replace(/\{\{Name\}\}/gi,  contact.name)
    .replace(/\{\{Phone\}\}/gi, contact.phone);
}

function notifyPopup(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
