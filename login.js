/**
 * login.js  v3.5
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. On DOMContentLoaded:
 *       a. Verify chrome.storage.local session → redirect to popup.html if valid.
 *       b. Wire all form interactions (click, Enter key, show/hide password).
 *  2. On login attempt:
 *       a. Client-side validation (non-empty fields, GAS_URL configured).
 *       b. POST { action:"login", username, password } to GAS_URL.
 *       c. Parse JSON response from Google Sheets backend (Code.gs).
 *       d. On { status:"success" } → save session to chrome.storage.local,
 *          redirect to popup.html.
 *       e. On { status:"error" } → display server message, shake password field.
 *       f. Network errors / timeouts → specific user-facing messages.
 *  3. Retry lockout: 5 consecutive failures → 30-second form disable.
 *
 * ── GAS Response Contract (from Code.gs) ─────────────────────────────────────
 *   Success: { status:"success", username, role, expiresAt }
 *   Failure: { status:"error",   message,  code }
 *
 *   Error codes returned by Code.gs:
 *     MISSING_FIELDS        — username or password not sent
 *     INVALID_CREDENTIALS   — wrong username or wrong password
 *     ACCOUNT_INACTIVE      — user exists but isActive = FALSE in sheet
 *     SERVER_ERROR          — unhandled exception in Code.gs
 *
 * ── Storage Keys written here (read by popup.js auth guard) ──────────────────
 *   waBulkSender_loggedIn     : true
 *   waBulkSender_authUsername : string
 *   waBulkSender_authRole     : string
 *   waBulkSender_authExpiry   : number  (Unix ms — set by GAS)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION  — edit these two constants only
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Paste your deployed Google Apps Script Web App URL here.
 * Deploy settings: Execute as → Me | Who has access → Anyone
 *
 * Steps:
 *   1. Open script.google.com → your project
 *   2. Deploy → New Deployment → Web App
 *   3. Copy the URL that ends with /exec
 *   4. Paste it below (replace the placeholder string)
 */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzYZ6QiUuTykLF0sQ3TUYSsvrVdPxCZs2drM7lsQRLPqJ0ij_XWfmiaoscsv4_cbGjT/exec';

/** How long (ms) to wait for the GAS server before showing a timeout error. */
const FETCH_TIMEOUT_MS = 15000;

// ══════════════════════════════════════════════════════════════════════════════
// STORAGE KEYS  — must match popup.js exactly
// ══════════════════════════════════════════════════════════════════════════════

const KEY_LOGGED_IN = 'waBulkSender_loggedIn';
const KEY_USERNAME  = 'waBulkSender_authUsername';
const KEY_ROLE      = 'waBulkSender_authRole';
const KEY_EXPIRY    = 'waBulkSender_authExpiry';

// ══════════════════════════════════════════════════════════════════════════════
// LOCKOUT STATE
// ══════════════════════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 5;    // consecutive failures before lockout
const LOCKOUT_SEC  = 30;   // seconds to lock the form

let failureCount = 0;
let lockoutTimer = null;

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[WA Bulk] login.js v3.5 loaded');

  // ── Grab DOM refs ─────────────────────────────────────────────────────────
  function $(id) {
    const el = document.getElementById(id);
    if (!el) console.error(`[WA Bulk] Login: missing DOM element #${id} — check login.html`);
    return el;
  }

  const inputUsername = $('input-username');
  const inputPassword = $('input-password');
  const btnLogin      = $('btn-login');
  const btnTogglePw   = $('btn-toggle-pw');
  const loginStatus   = $('login-status');

  // ── STEP 1: Check for an existing valid session ───────────────────────────
  // If already logged in (and session has not expired), skip the login form
  // entirely and redirect straight to the main tool.
  console.log('[WA Bulk] Checking existing session in chrome.storage.local...');
  try {
    const stored     = await chrome.storage.local.get([KEY_LOGGED_IN, KEY_EXPIRY, KEY_USERNAME]);
    const isLoggedIn = stored[KEY_LOGGED_IN] === true;
    const expiry     = stored[KEY_EXPIRY];

    if (isLoggedIn) {
      const isExpired = expiry && Date.now() > expiry;

      if (isExpired) {
        console.log('[WA Bulk] Session found but expired. Clearing and showing login.');
        await chrome.storage.local.remove([KEY_LOGGED_IN, KEY_USERNAME, KEY_ROLE, KEY_EXPIRY]);
      } else {
        console.log('[WA Bulk] Valid session found for:', stored[KEY_USERNAME] || 'unknown');
        console.log('[WA Bulk] Redirecting to popup.html...');
        window.location.href = 'popup.html';
        return;  // stop — no need to wire any events
      }
    } else {
      console.log('[WA Bulk] No active session. Showing login form.');
    }
  } catch (storageErr) {
    // chrome.storage failure is non-fatal — show the login form normally
    console.warn('[WA Bulk] Session check error (storage):', storageErr.message);
  }

  // ── STEP 2: Wire UI events ────────────────────────────────────────────────

  // Enter key in either field triggers login
  [inputUsername, inputPassword].forEach(input => {
    if (!input) return;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); attemptLogin(); }
    });
  });

  // Login button
  if (btnLogin) btnLogin.addEventListener('click', attemptLogin);

  // Show / hide password
  if (btnTogglePw && inputPassword) {
    btnTogglePw.addEventListener('click', () => {
      const nowHidden    = inputPassword.type === 'password';
      inputPassword.type = nowHidden ? 'text' : 'password';
      btnTogglePw.textContent = nowHidden ? '🙈' : '👁';
      console.log('[WA Bulk] Password field:', nowHidden ? 'visible' : 'hidden');
    });
  }

  // Auto-focus username field on open
  if (inputUsername) inputUsername.focus();

  // ══════════════════════════════════════════════════════════════════════════
  // CORE LOGIN LOGIC
  // ══════════════════════════════════════════════════════════════════════════

  async function attemptLogin() {
    // Block if locked out or already loading
    if (btnLogin && btnLogin.disabled) {
      console.log('[WA Bulk] Login attempt suppressed — form is disabled.');
      return;
    }

    const username = (inputUsername?.value || '').trim();
    const password = (inputPassword?.value || '').trim();

    // ── Client-side validation ────────────────────────────────────────────
    if (!username) {
      setStatus('⚠ Please enter your username.', 'error');
      inputUsername?.focus();
      return;
    }
    if (!password) {
      setStatus('⚠ Please enter your password.', 'error');
      inputPassword?.focus();
      return;
    }

    // Guard: catch unconfigured GAS URL early with a developer-friendly message
    if (
      GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE' ||
      !GAS_URL.startsWith('https://')
    ) {
      setStatus('⚠ GAS_URL not set — open login.js and paste your script URL.', 'error');
      console.error('[WA Bulk] GAS_URL is not configured. Edit the constant at the top of login.js.');
      return;
    }

    // ── Show loading state ────────────────────────────────────────────────
    setLoading(true);
    setStatus('⏳ Verifying credentials…', '');
    console.log('[WA Bulk] Sending login request to GAS. Username:', username);

    // ── POST to Google Apps Script ─────────────────────────────────────────
    // action:"login" tells Code.gs which handler to invoke.
    // Passwords travel over HTTPS; Code.gs hashes them server-side before
    // comparing against the SHA-256 hash stored in the sheet.
    let responseData;
    try {
      responseData = await fetchWithTimeout(
        GAS_URL,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'login', username, password }),
        },
        FETCH_TIMEOUT_MS
      );
    } catch (netErr) {
      setLoading(false);

      if (netErr.message === 'TIMEOUT') {
        console.error('[WA Bulk] Request timed out after', FETCH_TIMEOUT_MS, 'ms');
        setStatus('⚠ Request timed out. Check your internet connection and try again.', 'error');
      } else {
        console.error('[WA Bulk] Network error:', netErr.message);
        setStatus(`⚠ Network error: ${netErr.message}`, 'error');
      }

      recordFailure();
      return;
    }

    // ── Handle GAS response ───────────────────────────────────────────────
    console.log('[WA Bulk] GAS response received:', JSON.stringify(responseData));

    if (responseData.status === 'success') {
      await onLoginSuccess(responseData, username);
    } else {
      onLoginFailure(responseData);
    }

    setLoading(false);
  }

  // ── Success ───────────────────────────────────────────────────────────────

  async function onLoginSuccess(data, fallbackUsername) {
    const storedUsername = data.username || fallbackUsername;
    console.log('[WA Bulk] ✓ Login success. User:', storedUsername, '| Role:', data.role || 'user');

    setStatus('✅ Login successful! Opening app…', 'success');

    // Persist session data — popup.js reads these on every open
    const toStore = {
      [KEY_LOGGED_IN]: true,
      [KEY_USERNAME]:  storedUsername,
      [KEY_ROLE]:      data.role      || 'user',
      [KEY_EXPIRY]:    data.expiresAt || null,
    };

    try {
      await chrome.storage.local.set(toStore);
      console.log('[WA Bulk] Session saved. Keys:', Object.keys(toStore).join(', '));
      console.log('[WA Bulk] Session expires at:', data.expiresAt
        ? new Date(data.expiresAt).toLocaleString()
        : 'never (no expiry set)');
    } catch (storageErr) {
      // Non-fatal — redirect anyway; popup.js auth guard will handle any edge case
      console.error('[WA Bulk] Failed to write session to storage:', storageErr.message);
    }

    // Reset failure counter on success
    failureCount = 0;

    // Brief delay so user sees the success message before page changes
    await sleep(700);
    console.log('[WA Bulk] Redirecting to popup.html...');
    window.location.href = 'popup.html';
  }

  // ── Failure ───────────────────────────────────────────────────────────────

  function onLoginFailure(data) {
    // Map Code.gs error codes to friendly messages
    const friendlyMessages = {
      'INVALID_CREDENTIALS': 'Invalid username or password.',
      'ACCOUNT_INACTIVE':    'Your account is deactivated. Contact your admin.',
      'MISSING_FIELDS':      'Username and password are both required.',
      'SERVER_ERROR':        'Server error. Please try again in a moment.',
    };

    const code = data.code || '';
    const msg  = friendlyMessages[code] || data.message || 'Login failed. Please try again.';

    console.warn('[WA Bulk] Login failed. Code:', code, '| Message:', data.message);
    setStatus(`⚠ ${msg}`, 'error');

    // Shake the password field for visual feedback
    shakeElement(inputPassword);

    // Clear password on failure — never leave credentials in a failed field
    if (inputPassword) {
      inputPassword.value = '';
      inputPassword.focus();
    }

    recordFailure();
  }

  // ── Retry lockout ─────────────────────────────────────────────────────────

  function recordFailure() {
    failureCount++;
    console.log(`[WA Bulk] Failure count: ${failureCount} / ${MAX_ATTEMPTS}`);

    if (failureCount >= MAX_ATTEMPTS) {
      startLockout();
    }
  }

  function startLockout() {
    console.warn(`[WA Bulk] ${MAX_ATTEMPTS} consecutive failures — locking form for ${LOCKOUT_SEC}s`);
    let remaining = LOCKOUT_SEC;

    setStatus(`🔒 Too many attempts. Please wait ${remaining}s.`, 'error');
    setFormEnabled(false);

    lockoutTimer = setInterval(() => {
      remaining--;
      setStatus(`🔒 Too many attempts. Please wait ${remaining}s.`, 'error');

      if (remaining <= 0) {
        clearInterval(lockoutTimer);
        lockoutTimer  = null;
        failureCount  = 0;
        setFormEnabled(true);
        setStatus('You may try again.', '');
        inputUsername?.focus();
        console.log('[WA Bulk] Lockout ended. Form re-enabled.');
      }
    }, 1000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  function setLoading(on) {
    if (!btnLogin) return;
    btnLogin.disabled = on;
    btnLogin.classList.toggle('loading', on);
    const txt = btnLogin.querySelector('.btn-text');
    if (txt) txt.textContent = on ? 'Verifying…' : '🔓 Sign In';
  }

  function setFormEnabled(enabled) {
    [inputUsername, inputPassword, btnLogin, btnTogglePw].forEach(el => {
      if (el) el.disabled = !enabled;
    });
  }

  /**
   * @param {string} msg
   * @param {'error'|'success'|''} type
   */
  function setStatus(msg, type) {
    if (!loginStatus) return;
    loginStatus.textContent = msg;
    loginStatus.className   = type || '';
  }

  /** Web Animations API shake — no external CSS dependency */
  function shakeElement(el) {
    if (!el) return;
    el.animate(
      [
        { transform: 'translateX(0px)'  },
        { transform: 'translateX(-8px)' },
        { transform: 'translateX( 8px)' },
        { transform: 'translateX(-6px)' },
        { transform: 'translateX( 6px)' },
        { transform: 'translateX(-3px)' },
        { transform: 'translateX( 3px)' },
        { transform: 'translateX(0px)'  },
      ],
      { duration: 400, easing: 'ease-in-out' }
    );
  }

}); // end DOMContentLoaded

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES  (module-level — usable before DOMContentLoaded)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch with AbortController-based timeout.
 *
 * Chrome extension fetch() calls can hang indefinitely when the network is
 * unavailable or the GAS script doesn't respond. AbortController gives us a
 * clean, deterministic failure path.
 *
 * @param  {string} url
 * @param  {RequestInit} options
 * @param  {number} timeoutMs
 * @returns {Promise<Object>}  Parsed JSON response body
 * @throws  {Error}  message='TIMEOUT' | network error message | parse error
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    console.warn('[WA Bulk] Aborting fetch — exceeded', timeoutMs, 'ms');
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);

    console.log('[WA Bulk] HTTP response:', response.status, response.statusText);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Read as text first — allows a helpful error if GAS returns HTML
    const raw = await response.text();
    console.log('[WA Bulk] Raw response (first 120 chars):', raw.slice(0, 120));

    try {
      return JSON.parse(raw);
    } catch {
      console.error('[WA Bulk] Response is not valid JSON:', raw.slice(0, 300));
      throw new Error(
        'Server returned non-JSON. ' +
        'Ensure Code.gs uses ContentService.MimeType.JSON and is deployed correctly.'
      );
    }

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  }
}

/** sleep — identical to content.js / popup.js for consistency */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}