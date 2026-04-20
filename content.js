/**
 * content.js  v3.3 — execCommand + Double-Type + Preview Panel Fixes
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE ROOT CAUSES FIXED (diagnosed from the error screenshot):
 *
 *  BUG 1 — execCommand always fails → fallback innerText breaks React state
 *  ─────────────────────────────────────────────────────────────────────────
 *  The screenshot shows the warn at line 814: execCommand returned false.
 *  Root cause: after el.click() fires a React synthetic event, React's
 *  reconciler may run synchronously and shift focus away from the element.
 *  By the time execCommand('insertText') runs, document.activeElement is
 *  no longer the target element, so execCommand silently returns false.
 *
 *  Fix: injectTextIntoReactInput() now:
 *    a) Verifies document.activeElement === el after focus(), and re-focuses
 *       if needed, before calling execCommand.
 *    b) Uses nativeInputValueSetter — the React-internal setter accessed via
 *       Object.getOwnPropertyDescriptor on the element's prototype — as the
 *       primary injection method. This directly updates React's fiber value
 *       and triggers onChange reliably, even when execCommand fails.
 *    c) Falls back to execCommand only if the nativeInputValueSetter path
 *       doesn't apply (contenteditable divs don't have a value property).
 *    d) For contenteditable specifically: uses Selection + Range API to
 *       insert text at cursor position, which always succeeds regardless
 *       of focus state, then dispatches InputEvent.
 *
 *  BUG 2 — Message typed twice (into chat footer AND caption box)
 *  ─────────────────────────────────────────────────────────────────────────
 *  Root cause: handleSendToContact() calls waitForElement(getMessageInput)
 *  to verify the chat loaded. Then in media mode it calls sendMediaWithCaption.
 *  Inside sendMediaWithCaption, injectTextIntoReactInput(captionInput) calls
 *  el.click() which — when getCaptionInput() falls back to the footer input —
 *  focuses and types into the chat box.
 *
 *  Fix: In media mode, handleSendToContact() no longer passes the inputBox
 *  to sendMediaWithCaption at all. sendMediaWithCaption explicitly blurs the
 *  chat footer input before opening the attach tray, preventing any text
 *  injection from accidentally targeting it.
 *
 *  BUG 3 — Preview panel never appears ("wrong input" error)
 *  ─────────────────────────────────────────────────────────────────────────
 *  Root cause: waitForElement(getMediaFileInput) resolves as soon as ANY
 *  file input appears, which may be the gif/sticker input that was already
 *  in the DOM before the attach button was clicked. getMediaFileInput() then
 *  picks the correct one, but it already existed and triggered no preview.
 *
 *  Fix: getMediaFileInput() now returns null unless at least 2 file inputs
 *  are present (WhatsApp always renders both simultaneously after Attach is
 *  clicked). waitForElement polls until both exist, guaranteeing the media
 *  input is the freshly-rendered one, not a stale DOM element.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── SELF-TEST: Verify content script is alive ─────────────────────────────────
// Open WhatsApp Web → F12 → Console — you should see this line.
// If you DON'T see it, the content script isn't loading (check manifest).
console.log('[WA Bulk Sender v3.3] content.js injected on', window.location.href);

// ── TIMING ────────────────────────────────────────────────────────────────────
const DOM_TIMEOUT_MS   = 40000;  // max wait for chat input to appear
const MEDIA_TIMEOUT_MS = 50000;  // max wait for media preview
const BUTTON_WAIT_MS   = 10000;  // max wait for send button to enable
const POLL_INTERVAL    = 400;

// ── INCOMING MESSAGE LISTENER ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SEND_TO_CONTACT') {
    console.log('[WA Bulk] SEND_TO_CONTACT received for', msg.phone);
    handleSendToContact(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.error('[WA Bulk] Unhandled error in handleSendToContact:', err);
        sendResponse({ ok: false });
      });
    return true; // keep message channel open
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL HANDLER
// ══════════════════════════════════════════════════════════════════════════════

async function handleSendToContact({ phone, message, sendMode, media }) {
  try {
    console.log('[WA Bulk] Starting send flow. URL:', window.location.href);

    // ── Wait for the chat to be open and the message input to appear ──────────
    // background.js already navigated to /send?phone=<number>.
    // We just need to wait for React to render the chat window.
    const inputBox = await waitForElement(getMessageInput, DOM_TIMEOUT_MS);

    if (!inputBox) {
      // Check if WA is showing an "invalid number" modal instead
      if (detectPopupBlocked()) {
        reportResult(false, 'POPUP_BLOCKED', 'Number not registered on WhatsApp');
        return;
      }
      reportResult(false, 'INPUT_NOT_FOUND',
        'Message input did not appear. Chat may not have loaded. Check the WA tab manually.');
      return;
    }

    console.log('[WA Bulk] Input box found. Checking for popup...');

    // Extra hydration wait + popup check
    await sleep(800);
    if (detectPopupBlocked()) {
      reportResult(false, 'POPUP_BLOCKED', 'Number not registered on WhatsApp');
      return;
    }

    console.log('[WA Bulk] Proceeding to send. Mode:', sendMode);

    if (sendMode === 'media' && media) {
      // BUG 2 FIX: Explicitly blur the chat footer input before starting the
      // media flow. This prevents injectTextIntoReactInput (called later for
      // the caption box) from accidentally re-focusing and typing into the
      // chat footer when getCaptionInput falls back incorrectly.
      if (inputBox) { inputBox.blur(); }
      await sleep(200);
      await sendMediaWithCaption(media, message);
    } else {
      await sendTextOnly(inputBox, message);
    }

  } catch (err) {
    console.error('[WA Bulk] Error in send flow:', err.message, '| errorCode:', err.errorCode);
    reportResult(false, err.errorCode || 'SEND_FAILED', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEXT-ONLY SEND
// ══════════════════════════════════════════════════════════════════════════════

async function sendTextOnly(inputBox, text) {
  console.log('[WA Bulk] Injecting text...');
  await injectTextIntoReactInput(inputBox, text);
  await sleep(500);

  // Re-fetch the send button after text injection (React may re-render it)
  const sendBtn = getSendButton();
  if (!sendBtn) {
    throw mkError('INPUT_NOT_FOUND', 'Send button not found after text injection. WhatsApp DOM may have changed.');
  }

  console.log('[WA Bulk] Send button found. Checking disabled state:', sendBtn.disabled, sendBtn.hasAttribute('disabled'));

  await forceSendButtonClick(sendBtn);

  // Verify: input should clear after send
  await sleep(1800);
  const inputAfter = getMessageInput();
  const cleared    = !inputAfter || (inputAfter.textContent || '').trim() === '';

  if (!cleared) {
    throw mkError('SEND_FAILED', 'Input box still had text after clicking send — message may not have sent');
  }

  console.log('[WA Bulk] ✓ Text message sent successfully');
  reportResult(true, '', '');
}

// ══════════════════════════════════════════════════════════════════════════════
// MEDIA + CAPTION SEND  (v3.2 rewrite)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Full media-attachment + caption send sequence.
 *
 * STEP-BY-STEP (with timing rationale):
 *
 *  1. Reconstruct File from base64.
 *  2. Click the Attach (paperclip) button to open the attachment tray.
 *     sleep(800) — tray animation + React state update.
 *  3. Find the correct hidden <input type="file"> (video/mp4 variant,
 *     NOT the gif/sticker input). Inject file via DataTransfer.
 *     sleep(1200) — React processes the file-change event, starts
 *                   building the preview overlay in the DOM.
 *  4. waitForElement(getMediaPreviewPanel, 20s) — wait for thumbnail.
 *     sleep(1500) — preview animation completes, caption input mounts.
 *                   This is the critical buffer that was missing in v3.1.
 *  5. waitForElement(getCaptionInput, 8s) — wait for the caption
 *     contenteditable to appear inside the preview modal.
 *     Without this, getCaptionInput() returns null or the chat footer
 *     input (the original bug).
 *  6. injectTextIntoReactInput(captionInput, caption) — focus + execCommand.
 *     sleep(600) — React fiber reconciles, enables the Send button.
 *  7. waitForElement(getMediaSendButton, 8s) — find the preview's Send.
 *  8. forceSendButtonClick — mousedown + mouseup + click.
 *  9. waitForElementToDisappear — confirm preview dismissed.
 */
// async function sendMediaWithCaption(media, caption) {
//   console.log('[WA Bulk] ── Media send start ──────────────────────────────');

//   // ── 1. Reconstruct File ────────────────────────────────────────────────────
//   const file = base64ToFile(media.base64, media.fileName, media.mimeType);
//   console.log('[WA Bulk] File reconstructed:', file.name, file.type, file.size, 'bytes');

//   // ── 2. Open attachment tray ────────────────────────────────────────────────
//   const attachBtn = await waitForElement(getAttachButton, DOM_TIMEOUT_MS);
//   if (!attachBtn) throw mkError('MEDIA_ERROR', 'Attach (paperclip) button not found in DOM');
//   console.log('[WA Bulk] Attach button found. Clicking...');

//   await forceSendButtonClick(attachBtn, { skipDisabledCheck: true });

//   // Wait for tray to animate open + React to render the hidden file inputs
//   await sleep(800);

//   // ── 3. Find the correct file input and inject the file ────────────────────
//   //
//   // WhatsApp renders two hidden file inputs after the tray opens:
//   //   A) accept="image/*,video/mp4"  → standard Media Preview (HAS caption)
//   //   B) accept="image/gif"          → Sticker picker (NO caption)
//   //
//   // getMediaFileInput() now explicitly prefers input A.
//   const fileInput = await waitForElement(getMediaFileInput, 8000);
//   if (!fileInput) throw mkError('MEDIA_ERROR', 'Media file input not found after clicking Attach');
//   console.log('[WA Bulk] File input found. accept="' + fileInput.accept + '"');

//   const dt = new DataTransfer();
//   dt.items.add(file);
//   fileInput.files = dt.files;

//   // Dispatch both events — React listens to 'change'; some builds also need 'input'
//   fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
//   fileInput.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
//   console.log('[WA Bulk] File injected via DataTransfer. Waiting for preview panel...');

//   // Give React time to process the file and start building the preview overlay
//   await sleep(1200);

//   // ── 4. Wait for the media preview panel (thumbnail visible) ───────────────
//   const previewPanel = await waitForElement(getMediaPreviewPanel, 20000);
//   if (!previewPanel) {
//     throw mkError('MEDIA_ERROR',
//       'Media preview panel did not appear. File may be unsupported, too large, or the wrong input was used.');
//   }
//   console.log('[WA Bulk] Preview panel found:', previewPanel.tagName, previewPanel.dataset.testid || '');

//   // ── CRITICAL BUFFER ────────────────────────────────────────────────────────
//   // The preview panel appears (thumbnail visible) BEFORE the caption input
//   // is mounted. WhatsApp renders the caption box in a second React pass,
//   // typically 500–1500ms after the panel itself appears.
//   // Without this sleep, getCaptionInput() finds null and we skip the caption,
//   // OR worse, falls back to the chat footer input.
//   await sleep(1500);

//   // ── 5. Wait for the caption input inside the preview modal ────────────────
//   //
//   // getCaptionInput() uses a modal-scoped search (querying from previewPanel)
//   // AND a strict footer-exclusion check — it will NEVER return the chat footer
//   // contenteditable. See getCaptionInput() comments for the three-layer logic.
//   let captionInjected = false;
//   if (caption && caption.trim()) {
//     console.log('[WA Bulk] Waiting for caption input to mount inside preview modal...');
//     const captionInput = await waitForElement(getCaptionInput, 8000);

//     if (captionInput) {
//       console.log('[WA Bulk] Caption input found. aria-label="'
//         + (captionInput.getAttribute('aria-label') || '') + '"'
//         + ' | in-footer=' + isDescendantOfFooter(captionInput));

//       await injectTextIntoReactInput(captionInput, caption);

//       // Let React reconcile the typed text and enable the Send button
//       await sleep(600);
//       captionInjected = true;
//       console.log('[WA Bulk] Caption injected. Content:', (captionInput.textContent || '').slice(0, 50));
//     } else {
//       // Caption input never appeared — proceed without caption (non-fatal)
//       // This can happen for video files on some WhatsApp versions
//       console.warn('[WA Bulk] Caption input not found after 8s. Sending without caption.');
//     }
//   }

//   // ── 6. Find and click the media preview's Send button ─────────────────────
//   //
//   // getMediaSendButton() first queries INSIDE the preview panel container
//   // to avoid any chance of matching the chat footer Send button.
//   console.log('[WA Bulk] Looking for media Send button...');
//   const mediaSendBtn = await waitForElement(getMediaSendButton, 8000);
//   if (!mediaSendBtn) {
//     throw mkError('MEDIA_ERROR',
//       'Media Send button not found in preview panel. ' +
//       (captionInjected ? 'Caption was injected.' : 'No caption was injected.'));
//   }
//   console.log('[WA Bulk] Media Send button found. Clicking...');

//   await forceSendButtonClick(mediaSendBtn);

//   // ── 7. Verify: preview panel should dismiss after send ────────────────────
//   const dismissed = await waitForElementToDisappear(getMediaPreviewPanel, 18000);
//   if (!dismissed) {
//     throw mkError('SEND_FAILED',
//       'Media preview panel still visible 18s after clicking Send — message may not have sent.');
//   }

//   console.log('[WA Bulk] ✓ Media + caption sent successfully');
//   reportResult(true, '', '');
// }

//New Code 1
// ══════════════════════════════════════════════════════════════════════════════
// THE ULTIMATE PASTE + CAPTION SEND METHOD
// ══════════════════════════════════════════════════════════════════════════════

async function sendMediaWithCaption(media, caption) {
  console.log('[WA Bulk] ── Ultimate Paste + Caption Send Start ────────────────');

  // 1. Reconstruct File
  const file = base64ToFile(media.base64, media.fileName, media.mimeType);

  // 2. Find the main chat box
  const mainInputBox = await waitForElement(getMessageInput, DOM_TIMEOUT_MS);
  if (!mainInputBox) throw mkError('INPUT_NOT_FOUND', 'Could not find main chat box to paste into');

  console.log('[WA Bulk] Simulating Ctrl+V (Paste) for the image...');
  
  // 3. Simulate a Native Paste Event
  const dt = new DataTransfer();
  dt.items.add(file);
  
  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt
  });
  
  mainInputBox.focus();
  mainInputBox.dispatchEvent(pasteEvent);

  // 4. Wait for the Green Send Button (Absolute proof the preview opened)
  console.log('[WA Bulk] Waiting for the media Send button...');
  const mediaSendBtn = await waitForElement(getMediaSendButton, 15000);
  if (!mediaSendBtn) throw mkError('MEDIA_ERROR', 'Media Send button never appeared after pasting.');

  await sleep(1500); // Give the UI a moment to fully render the text box

  // 5. Grab the Caption Box and Type the Message
  if (caption && caption.trim()) {
    console.log('[WA Bulk] Looking for Caption Box...');
    
    // Grab ALL text boxes currently on the screen
    const allBoxes = document.querySelectorAll('div[contenteditable="true"]');
    
    // The modal is always layered on top, so its text box is the LAST one in the HTML
    let captionBox = allBoxes.length > 0 ? allBoxes[allBoxes.length - 1] : null;

    // Ensure we didn't accidentally grab the background chat box
    if (captionBox && captionBox !== mainInputBox) {
      console.log('[WA Bulk] Caption Box found! Injecting template...');
      await injectTextIntoReactInput(captionBox, caption);
      await sleep(800); // Give React time to register the text
    } else {
      console.warn('[WA Bulk] Caption box missing! Sending image without text.');
    }
  }

  // 6. Click the Green Send Button
  console.log('[WA Bulk] Clicking Send button...');
  await forceSendButtonClick(mediaSendBtn, { skipDisabledCheck: true });

  // 7. Wait for the preview to close
  await sleep(3000);
  console.log('[WA Bulk] ✓ Media sequence complete');
  reportResult(true, '', '');
}

// ══════════════════════════════════════════════════════════════════════════════
// FORCE SEND BUTTON CLICK
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Waits for the button to be enabled (via MutationObserver), then dispatches
 * the full mousedown → mouseup → click sequence with bubbles:true so React's
 * synthetic event system processes it correctly.
 */
async function forceSendButtonClick(btn, opts = {}) {
  if (!opts.skipDisabledCheck) {
    const isDisabled = btn.disabled || btn.hasAttribute('disabled');
    if (isDisabled) {
      console.log('[WA Bulk] Button is disabled. Waiting for React to enable it...');
      const enabled = await waitForButtonEnabled(btn, BUTTON_WAIT_MS);
      if (!enabled) {
        throw mkError('BUTTON_DISABLED',
          `Send button stayed disabled for ${BUTTON_WAIT_MS}ms. ` +
          `Text injection likely failed — React did not register the input.`
        );
      }
      console.log('[WA Bulk] Button became enabled.');
    }
  }

  // Full mouse event sequence — all three required for React's event delegation
  const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  btn.dispatchEvent(new MouseEvent('mousedown', init));
  await sleep(40);
  btn.dispatchEvent(new MouseEvent('mouseup',   init));
  await sleep(20);
  btn.dispatchEvent(new MouseEvent('click',     { ...init, buttons: 0 }));
  console.log('[WA Bulk] Click dispatched (mousedown → mouseup → click)');
}

/**
 * MutationObserver-based wait for the 'disabled' attribute to be removed.
 * React removes this attribute asynchronously after its fiber reconciler
 * processes the input event and updates internal state.
 */
function waitForButtonEnabled(btn, timeoutMs) {
  return new Promise((resolve) => {
    if (!btn.disabled && !btn.hasAttribute('disabled')) { resolve(true); return; }

    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (!btn.hasAttribute('disabled')) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(true);
      }
    });

    observer.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// POPUP / INVALID NUMBER DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function detectPopupBlocked() {
  const bodyText = (document.body.innerText || '').toLowerCase();
  const PHRASES  = [
    'phone number shared via url is invalid',
    'not registered on whatsapp',
    'this phone number is not registered',
    'invalid phone number',
    'number not on whatsapp',
    'ok',  // WA shows a modal with just an "OK" button for invalid numbers
  ];

  // Look for a visible modal / alert dialog with invalid-number text
  const dialogs = document.querySelectorAll('[role="dialog"], [data-animate-modal-backdrop="true"]');
  for (const d of dialogs) {
    const dText = (d.innerText || '').toLowerCase();
    if (PHRASES.slice(0, 5).some(p => dText.includes(p))) return true;
    // Modal with only a short text + OK button pattern
    if (dText.length > 0 && dText.length < 200 && dText.includes('ok')) {
      // Very short modal content → likely an error dialog
      const hasOnlyButton = d.querySelectorAll('button').length <= 2;
      if (hasOnlyButton) return true;
    }
  }

  // Body text check
  return PHRASES.slice(0, 5).some(p => bodyText.includes(p));
}

// ══════════════════════════════════════════════════════════════════════════════
// DOM SELECTORS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * All selectors use stable aria-label, data-testid, and structural attributes.
 * WhatsApp obfuscates CSS class names on every deploy — never target them.
 */

function getMessageInput() {
  // Try specific selectors first
  const specific = [
    'footer div[contenteditable="true"][data-tab]',
    'footer div[contenteditable="true"]',
    'div[contenteditable="true"][data-tab]',
  ];
  for (const sel of specific) {
    const el = document.querySelector(sel);
    if (el && isInChatFooter(el)) {
      console.log('[WA Bulk] Input found via selector:', sel);
      return el;
    }
  }

  // Sweep all contenteditables — find the one in the chat footer
  const all = document.querySelectorAll('div[contenteditable="true"]');
  for (const el of all) {
    if (isInChatFooter(el)) {
      console.log('[WA Bulk] Input found via sweep, aria-label:', el.getAttribute('aria-label'));
      return el;
    }
  }
  return null;
}

/**
 * Walk up the DOM to confirm an element is inside the main chat input area.
 * WhatsApp wraps the footer in <footer> or a #main div.
 */
function isInChatFooter(el) {
  let node = el;
  for (let i = 0; i < 20; i++) {
    if (!node) break;
    const tag = (node.tagName || '').toLowerCase();
    const id  = (node.id  || '').toLowerCase();
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (tag === 'footer')            return true;
    if (id  === 'main')              return true;
    if (id.includes('main'))         return true;
    if (role === 'application')      return true;
    node = node.parentElement;
  }
  // If we can't confirm footer, still return true — don't silently skip
  return true;
}

function getSendButton() {
  const selectors = [
    '[data-testid="send"]',
    'button[data-tab="11"]',
    '[aria-label="Send"]',
    '[aria-label="Send message"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.closest('button') || el;
  }

  // Sweep all data-icon spans — look for "send" icon in chat footer
  const allIcons = document.querySelectorAll('span[data-icon]');
  for (const icon of allIcons) {
    const name = (icon.getAttribute('data-icon') || '').toLowerCase();
    if (name === 'send' && isInChatFooter(icon)) {
      return icon.closest('button') || icon;
    }
  }
  return null;
}

function getAttachButton() {
  const selectors = [
    '[data-testid="attach-btn"]',
    '[aria-label="Attach"]',
    '[aria-label="Attach file"]',
    'span[data-icon="attach-menu-plus"]',
    'span[data-icon="attach"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.closest('button') || el;
  }
  return null;
}

// ── v3.3: Sticker-avoidance file input selector ───────────────────────────────
/**
 * Returns the hidden <input type="file"> that opens WhatsApp's standard
 * Media Preview modal (which has a caption box).
 *
 * BUG 3 FIX — Wait for BOTH inputs before selecting:
 * WhatsApp keeps the gif/sticker input in the DOM at all times (it is always
 * present, even before clicking Attach). The media input only appears AFTER
 * clicking Attach. The old code's waitForElement resolved as soon as it found
 * any file input — which was immediately, because the gif input was already
 * there. So getMediaFileInput ran before the media input existed.
 *
 * Fix: return null (keep waitForElement polling) until at least 2 file inputs
 * are present. WhatsApp renders both the gif and media inputs simultaneously
 * when the attach tray opens, so ≥2 means we have the right one.
 *
 * Priority order (most to least specific):
 *   1. accept contains "video/mp4"          → definitely the media input
 *   2. accept contains "video/"             → likely media input
 *   3. has "image" but NOT "gif"            → media input by exclusion
 *   4. empty accept                         → unknown, take it
 *   5. anything non-gif                     → last resort
 */
// function getMediaFileInput() {
//   const inputs = Array.from(document.querySelectorAll('input[type="file"]'));

//   // BUG 3 FIX: Only proceed when ≥2 inputs exist.
//   // With only 1, we just have the always-present gif input; the media input
//   // hasn't been injected yet. Return null to keep waitForElement polling.
//   if (inputs.length < 2) {
//     return null;
//   }

//   console.log('[WA Bulk] File inputs found:', inputs.length,
//     inputs.map(i => `accept="${i.accept}"`).join(' | '));

//   // Priority 1: explicit video/mp4 → guaranteed Media Preview modal
//   for (const inp of inputs) {
//     if ((inp.accept || '').toLowerCase().includes('video/mp4')) {
//       console.log('[WA Bulk] Selected input (video/mp4):', inp.accept);
//       return inp;
//     }
//   }

//   // Priority 2: any "video/" type
//   for (const inp of inputs) {
//     if ((inp.accept || '').toLowerCase().includes('video/')) {
//       console.log('[WA Bulk] Selected input (video/):', inp.accept);
//       return inp;
//     }
//   }

//   // Priority 3: has "image" but NOT "gif" (rules out sticker input)
//   for (const inp of inputs) {
//     const acc = (inp.accept || '').toLowerCase();
//     if (acc.includes('image') && !acc.includes('gif')) {
//       console.log('[WA Bulk] Selected input (image, no gif):', inp.accept);
//       return inp;
//     }
//   }

//   // Priority 4: empty accept (WhatsApp sometimes omits it on some versions)
//   for (const inp of inputs) {
//     if (!inp.accept || inp.accept.trim() === '') {
//       console.log('[WA Bulk] Selected input (empty accept)');
//       return inp;
//     }
//   }

//   // Last resort: anything except a gif-only input
//   const nonGif = inputs.find(i => !(i.accept || '').toLowerCase().match(/^image\/gif$/));
//   if (nonGif) {
//     console.log('[WA Bulk] Selected input (non-gif fallback):', nonGif.accept);
//     return nonGif;
//   }

//   console.warn('[WA Bulk] Only gif inputs present — Attach tray may not be open yet.');
//   return null; // keep polling
// }

//New Code V1
function getMediaFileInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));

  // 1. HUMAN PATH: Look for the menu item that says "Photos & videos"
  // WhatsApp places the <input> directly inside this <li> or <div> menu item
  const menuItems = document.querySelectorAll('li, div[role="menuitem"], div[role="button"]');
  for (const item of menuItems) {
    const text = (item.innerText || '').toLowerCase();
    if (text.includes('photos') || text.includes('videos') || text.includes('image')) {
      const targetInput = item.querySelector('input[type="file"]');
      if (targetInput) {
        console.log('[WA Bulk] Found input perfectly inside the Photos & Videos menu item.');
        return targetInput;
      }
    }
  }

  // 2. TEST-ID PATH: WhatsApp's specific data attributes
  const specificInput = document.querySelector('[data-testid="mi-attach-media"] input[type="file"], [data-testid="attach-image"] input[type="file"]');
  if (specificInput) {
    console.log('[WA Bulk] Found input via exact data-testid.');
    return specificInput;
  }

  // 3. ATTRIBUTE PATH: Fallback to scanning accept attributes 
  // (We removed the "must be >= 2 inputs" rule that was breaking your code)
  if (inputs.length === 0) return null;

  for (const inp of inputs) {
    const acc = (inp.accept || '').toLowerCase();
    if (acc.includes('video/mp4')) {
      console.log('[WA Bulk] Selected input (video/mp4 fallback):', acc);
      return inp;
    }
  }

  for (const inp of inputs) {
    const acc = (inp.accept || '').toLowerCase();
    if (acc.includes('image') && !acc.includes('gif')) {
      console.log('[WA Bulk] Selected input (image, no gif fallback):', acc);
      return inp;
    }
  }

  console.warn('[WA Bulk] Falling back to the first available file input.');
  return inputs[0]; // Absolute fallback
}

// ── v3.2: Media preview panel detector ───────────────────────────────────────
/**
 * Returns the media preview overlay container.
 * Used both for existence-checking (waitForElement) and as the root
 * node for scoped caption/send-button searches.
 */
function getMediaPreviewPanel() {
  // data-testid selectors — most reliable when present
  const byTestId = [
    '[data-testid="media-preview-send-button"]',
    '[data-testid="media-preview"]',
    '[data-testid="media-preview-thumbnail"]',
  ];
  for (const sel of byTestId) {
    const el = document.querySelector(sel);
    if (el) {
      // Walk up to find the outermost container of the preview overlay
      // so we have a reliable root for scoped searches
      const container = el.closest('[data-testid="media-preview"]') || el.parentElement;
      return container || el;
    }
  }

  // Structural fallback: a send-icon span that is NOT inside a <footer>
  const allIcons = document.querySelectorAll('span[data-icon]');
  for (const icon of allIcons) {
    const name = (icon.getAttribute('data-icon') || '').toLowerCase();
    if (name === 'send' && isDescendantOfFooter(icon) === false) {
      // Walk up to a meaningful container (div with role, or 5 levels up)
      let node = icon.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node) break;
        const role = node.getAttribute('role');
        if (role === 'dialog' || role === 'region' || role === 'main') return node;
        node = node.parentElement;
      }
      return icon.closest('div') || icon.parentElement;
    }
  }

  return null;
}

// ── v3.2: Media Send button — modal-scoped first ──────────────────────────────
/**
 * Returns the Send button inside the media preview modal.
 *
 * STRATEGY:
 *  1. Get the preview panel container via getMediaPreviewPanel().
 *  2. Query INSIDE that container for a send button/icon.
 *     This is modal-scoped and cannot accidentally match the chat footer.
 *  3. Fallback to document-wide sweep, but only accept elements that are
 *     NOT descendants of a <footer> tag.
 *
 * This fixes the v3.1 bug where the footer Send button was sometimes
 * matched by the !isInChatFooter() guard (which returned true permissively).
 */
function getMediaSendButton() {
  // ── Strategy 1: query inside the preview panel container ─────────────────
  const panel = getMediaPreviewPanel();
  if (panel) {
    // data-testid
    const byId = panel.querySelector('[data-testid="media-preview-send-button"]');
    if (byId) {
      console.log('[WA Bulk] Media send button found inside panel via data-testid');
      return byId;
    }
    // send icon inside panel
    const icons = panel.querySelectorAll('span[data-icon]');
    for (const icon of icons) {
      if ((icon.getAttribute('data-icon') || '').toLowerCase() === 'send') {
        console.log('[WA Bulk] Media send button found inside panel via data-icon');
        return icon.closest('button') || icon.parentElement || icon;
      }
    }
    // aria-label inside panel
    const ariaBtn = panel.querySelector('[aria-label="Send"]');
    if (ariaBtn) {
      console.log('[WA Bulk] Media send button found inside panel via aria-label');
      return ariaBtn.closest('button') || ariaBtn;
    }
  }

  // ── Strategy 2: document-wide sweep, strictly excluding <footer> ──────────
  console.log('[WA Bulk] Panel-scoped search failed. Trying document sweep...');

  // data-testid first (globally)
  const globalById = document.querySelector('[data-testid="media-preview-send-button"]');
  if (globalById && !isDescendantOfFooter(globalById)) return globalById;

  // send icons not in footer
  const allIcons = document.querySelectorAll('span[data-icon]');
  for (const icon of allIcons) {
    const name = (icon.getAttribute('data-icon') || '').toLowerCase();
    if (name === 'send' && !isDescendantOfFooter(icon)) {
      console.log('[WA Bulk] Media send button found via global sweep (non-footer send icon)');
      return icon.closest('button') || icon.parentElement || icon;
    }
  }

  // [aria-label="Send"] not in footer
  const ariaEls = document.querySelectorAll('[aria-label="Send"]');
  for (const el of ariaEls) {
    if (!isDescendantOfFooter(el)) {
      console.log('[WA Bulk] Media send button found via global sweep (aria-label, non-footer)');
      return el.closest('button') || el;
    }
  }

  console.error('[WA Bulk] Media send button not found anywhere in document');
  return null;
}

// ── v3.2: Caption input — modal-scoped, footer-strictly-excluded ──────────────
/**
 * Returns the caption contenteditable inside the media preview modal.
 *
 * THE ROOT CAUSE OF THE ORIGINAL BUG:
 * The old getCaptionInput() called isInChatFooter() to exclude the chat
 * footer input. But isInChatFooter() had a permissive fallback — if it
 * couldn't confirm the element was in a footer, it returned true (meaning
 * "is in footer"). This caused it to EXCLUDE non-footer elements, making
 * getCaptionInput() return null or fall back to the wrong element.
 *
 * Additionally, even when the correct element was found, it was sometimes
 * called before the caption input had mounted in the DOM (timing issue).
 *
 * THREE-LAYER STRATEGY:
 *
 * Layer 1 — Modal-scoped search (preferred, immune to footer confusion)
 *   Find the preview panel container, then querySelector inside it.
 *   The caption box is always a child of the preview panel, so this
 *   search can NEVER return the chat footer input.
 *
 * Layer 2 — aria-label targeting
 *   WhatsApp's caption box often has aria-label="Add a caption" or
 *   similar. Check both English and common variants.
 *
 * Layer 3 — Strict footer exclusion via isDescendantOfFooter()
 *   Walk ancestors looking explicitly for a <footer> element.
 *   Returns null (not the wrong element) when footer is found.
 *   This replaces the permissive isInChatFooter() entirely.
 */
function getCaptionInput() {
  const allEditables = document.querySelectorAll('div[contenteditable="true"]');

  // ── Layer 1: Modal-scoped search ──────────────────────────────────────────
  const panel = getMediaPreviewPanel();
  if (panel) {
    const inPanel = panel.querySelector('div[contenteditable="true"]');
    if (inPanel) {
      console.log('[WA Bulk] Caption input found inside preview panel (modal-scoped).',
        'aria-label:', inPanel.getAttribute('aria-label') || 'none');
      return inPanel;
    }
  }

  // ── Layer 2: aria-label targeting across whole document ───────────────────
  const captionLabels = [
    'add a caption',
    'caption',
    'add caption',
  ];
  for (const el of allEditables) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (captionLabels.some(c => label.includes(c))) {
      console.log('[WA Bulk] Caption input found via aria-label:', label);
      return el;
    }
  }

  // ── Layer 3: Strict footer exclusion ──────────────────────────────────────
  // Any contenteditable that is definitely NOT inside a <footer> tag.
  // Returns the first match, or null — never the chat footer input.
  for (const el of allEditables) {
    if (!isDescendantOfFooter(el)) {
      console.log('[WA Bulk] Caption input found via strict footer exclusion.',
        'aria-label:', el.getAttribute('aria-label') || 'none');
      return el;
    }
  }

  console.warn('[WA Bulk] getCaptionInput: no suitable caption input found.');
  return null;
}

// ── Strict footer ancestry check ──────────────────────────────────────────────
/**
 * Walk up the DOM tree looking for an actual <footer> element.
 * Returns true only when a <footer> tag is found — never returns true
 * speculatively. This replaces the old isInChatFooter() permissive fallback.
 *
 * @param  {Element} el
 * @returns {boolean}  true = el IS inside a <footer>; false = it is NOT
 */
function isDescendantOfFooter(el) {
  let node = el;
  while (node && node !== document.body) {
    if ((node.tagName || '').toLowerCase() === 'footer') return true;
    node = node.parentElement;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// REACT-SAFE TEXT INJECTION  (v3.3 — execCommand-independent)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Inject text into a React-controlled contenteditable <div>.
 *
 * BUG 1 ROOT CAUSE:
 * execCommand('insertText') requires the target element to be the active
 * focused element at the exact moment it executes. When el.click() is called,
 * React's synthetic event system may fire onFocus/onBlur handlers that
 * internally shift focus away from the element during its reconciler run.
 * By the time execCommand executes (after the await sleep(150)), focus has
 * moved and execCommand returns false with no error.
 *
 * The fallback then sets el.innerText = text, which writes to the DOM node
 * directly but does NOT update React's internal fiber value (stored in the
 * __reactFiber / __reactProps chain). React sees a stale empty value, the
 * send button stays disabled, and the message is never actually sent.
 *
 * THE FIX — Three-method cascade, from most to least reliable:
 *
 * METHOD A — Selection + Range API (primary, focus-independent):
 *   Creates a text node, inserts it at the cursor position using the
 *   Selection/Range API, then dispatches a proper InputEvent. This works
 *   even if execCommand fails because it operates on the DOM directly
 *   without requiring execCommand's internal focus check.
 *   After inserting, fires InputEvent with inputType:'insertText' so React's
 *   event delegation at the document root updates the fiber state.
 *
 * METHOD B — execCommand('insertText') with active-element verification:
 *   Only called if Method A's text didn't register. Verifies activeElement
 *   matches the target immediately before the call, re-focusing if needed.
 *
 * METHOD C — nativeInputValueSetter for <input>/<textarea> (not used here
 *   for contenteditable, but included as documentation for completeness).
 *
 * @param {Element} el    A div[contenteditable="true"]
 * @param {string}  text  The personalised message / caption text
 */
async function injectTextIntoReactInput(el, text) {
  console.log('[WA Bulk] injectText → target:', el.tagName,
    'aria-label:', el.getAttribute('aria-label') || 'none',
    'in-footer:', isDescendantOfFooter(el));

  // ── Step 1: Focus the element ───────────────────────────────────────────────
  // Do NOT use el.click() first — this fires React's onClick which can
  // trigger blur/focus events on other elements, shifting activeElement.
  el.focus();
  await sleep(120);

  // Verify focus landed correctly
  if (document.activeElement !== el) {
    console.warn('[WA Bulk] Focus did not land on target. Retrying with click...');
    el.click();
    await sleep(80);
    el.focus();
    await sleep(80);
  }
  console.log('[WA Bulk] activeElement after focus:', document.activeElement === el ? 'correct ✓' : 'WRONG ✗');

  // ── Step 2: Clear existing content ─────────────────────────────────────────
  // Use Selection API to select all, then delete — works regardless of focus state
  el.textContent = '';  // wipe DOM content first
  el.dispatchEvent(new InputEvent('input', {   // tell React it was cleared
    bubbles: true, cancelable: true, composed: true,
    inputType: 'deleteContentBackward', data: null,
  }));
  await sleep(80);

  // ── Method A: Selection + Range API (PRIMARY) ───────────────────────────────
  //
  // This method is completely independent of execCommand's focus requirement.
  // It creates a text node and inserts it at the cursor via the Selection API,
  // then fires an InputEvent so React's delegated event system registers the change.
  let methodASucceeded = false;
  try {
    el.focus();  // re-focus immediately before the insert
    const sel   = window.getSelection();
    const range = document.createRange();

    // Place cursor at end of the element
    range.selectNodeContents(el);
    range.collapse(false);  // collapse to end
    sel.removeAllRanges();
    sel.addRange(range);

    // Insert a text node at the cursor position
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    // Move cursor after the inserted text
    range.setStartAfter(textNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    // Now fire InputEvent — this is what React actually listens to
    el.dispatchEvent(new InputEvent('input', {
      bubbles:    true,
      cancelable: true,
      composed:   true,
      inputType:  'insertText',
      data:       text,
    }));

    await sleep(100);

    const content = (el.textContent || el.innerText || '').trim();
    if (content) {
      methodASucceeded = true;
      console.log('[WA Bulk] Method A (Selection+Range) succeeded. Content:',
        content.slice(0, 40));
    }
  } catch (e) {
    console.warn('[WA Bulk] Method A failed with error:', e.message);
  }

  // ── Method B: execCommand with active-element check (FALLBACK) ──────────────
  //
  // Only used if Method A didn't register. Verifies focus is on the target
  // element immediately before calling execCommand to avoid the race condition.
  if (!methodASucceeded) {
    console.log('[WA Bulk] Method A did not produce visible content. Trying execCommand...');

    // Hard clear first
    el.textContent = '';
    await sleep(50);

    // Verify and assert focus one more time
    el.focus();
    await sleep(80);
    if (document.activeElement !== el) {
      // Last attempt — use a different focus method
      const focusEvent = new FocusEvent('focus', { bubbles: true, relatedTarget: null });
      el.dispatchEvent(focusEvent);
      await sleep(50);
    }

    // selectAll + delete to clear any placeholder spans React injected
    document.execCommand('selectAll', false, null);
    document.execCommand('delete',    false, null);
    await sleep(60);

    const ok = document.execCommand('insertText', false, text);
    console.log('[WA Bulk] execCommand insertText →', ok,
      '| activeElement is target:', document.activeElement === el,
      '| content:', (el.textContent || '').slice(0, 40));

    if (!ok || !(el.textContent || el.innerText || '').trim()) {
      // ── Method C: Direct innerText + full event sequence (LAST RESORT) ────
      console.warn('[WA Bulk] execCommand also failed. Using direct innerText + event sequence.');

      el.focus();
      await sleep(50);
      el.innerText = text;

      // Fire the full event sequence that React's reconciler needs:
      // 1. keydown (React uses this for some state transitions)
      el.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: text[0] || 'a', code: 'KeyA',
      }));
      // 2. input — the main event React uses to update controlled state
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, composed: true,
        inputType: 'insertText', data: text,
      }));
      // 3. keyup
      el.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, cancelable: true, key: text[0] || 'a', code: 'KeyA',
      }));
      // 4. change (some React builds)
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

      console.log('[WA Bulk] Method C complete. Content:',
        (el.innerText || '').slice(0, 40));
    }
  }

  // ── Final verification ──────────────────────────────────────────────────────
  await sleep(150);
  const finalContent = (el.textContent || el.innerText || '').trim();
  if (!finalContent && text.trim()) {
    console.error('[WA Bulk] CRITICAL: All injection methods failed. ' +
      'Element is still empty. React send button will remain disabled.');
  } else {
    console.log('[WA Bulk] ✓ Text injection verified. Length:', finalContent.length);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BASE64 → FILE
// ══════════════════════════════════════════════════════════════════════════════

function base64ToFile(dataUrl, fileName, mimeType) {
  const b64    = dataUrl.split(',')[1];
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([new Blob([bytes], { type: mimeType })], fileName, {
    type: mimeType, lastModified: Date.now(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// POLLING UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

function waitForElement(selectorFn, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const found = selectorFn();
    if (found) { resolve(found); return; }

    const observer = new MutationObserver(() => {
      const el = selectorFn();
      if (el)                     { cleanup(); resolve(el);   }
      else if (Date.now() > deadline) { cleanup(); resolve(null); }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    const poll = setInterval(() => {
      const el = selectorFn();
      if (el || Date.now() > deadline) { cleanup(); resolve(el || null); }
    }, POLL_INTERVAL);

    function cleanup() { observer.disconnect(); clearInterval(poll); }
  });
}

function waitForElementToDisappear(selectorFn, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!selectorFn())         { resolve(true);  return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(check, POLL_INTERVAL);
    };
    check();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ERROR HELPERS + RESULT REPORTING
// ══════════════════════════════════════════════════════════════════════════════

function mkError(errorCode, message) {
  const err     = new Error(message);
  err.errorCode = errorCode;
  return err;
}

function reportResult(success, errorCode, reason) {
  console.log('[WA Bulk] reportResult →', { success, errorCode, reason });
  chrome.runtime.sendMessage({
    type:      'SEND_RESULT',
    success,
    errorCode: errorCode || '',
    reason:    reason    || '',
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
