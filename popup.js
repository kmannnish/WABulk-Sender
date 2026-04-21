/**
 * popup.js  v3.5
 * ─────────────────────────────────────────────────────────────────────────────
 * NEW in v3.5 — Admin Panel integration:
 *
 *  1. Role-Based UI
 *     On load, reads waBulkSender_authRole from chrome.storage.local.
 *     If role === 'admin', the Admin tab is revealed and the user list
 *     is fetched automatically when the tab is opened.
 *
 *  2. Admin Tab — Add User
 *     addUser form POSTs { action:'addUser', adminPassword, username,
 *     password, role } to GAS_URL. Requires admin password confirmation
 *     via the overlay modal before the request is sent.
 *
 *  3. Admin Tab — List Users
 *     listUsers POSTs { action:'listUsers', adminPassword } and renders
 *     the result table: Username | Role | Status | Last Login | Actions.
 *     Auto-triggered when switching to the Admin tab (after pw confirmation).
 *
 *  4. Toggle Active / Delete
 *     Each user row has ⏸ Toggle and 🗑 Delete buttons.
 *     Both require admin password confirmation (re-uses the same overlay).
 *     toggleActive POSTs { action:'toggleActive', adminPassword, username }
 *     deleteUser   POSTs { action:'deleteUser',   adminPassword, username }
 *
 *  5. Admin Password Overlay
 *     A modal asks for the admin password before any mutating GAS call.
 *     The password is NOT stored anywhere — it is captured fresh per action
 *     and sent directly to GAS, which verifies it against the hashed value
 *     in the sheet. This satisfies the verifyAdmin() requirement in Code.gs.
 *
 *  6. fetchWithTimeout — identical to login.js
 *     All GAS calls use AbortController + 15-second timeout.
 *     Error codes from Code.gs are mapped to user-friendly messages.
 *
 * ── GAS_URL ───────────────────────────────────────────────────────────────────
 *  Must match the URL in login.js exactly.
 *  Both files must point to the same deployed Google Apps Script.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — paste your GAS URL here (must match login.js)
// ══════════════════════════════════════════════════════════════════════════════

const GAS_URL          = 'https://script.google.com/macros/s/AKfycbzYZ6QiUuTykLF0sQ3TUYSsvrVdPxCZs2drM7lsQRLPqJ0ij_XWfmiaoscsv4_cbGjT/exec';
const FETCH_TIMEOUT_MS = 15000;

// ── STORAGE KEYS ──────────────────────────────────────────────────────────────
const STORAGE_KEY      = 'waBulkSender_contacts';
const STORAGE_KEY_MSG  = 'waBulkSender_message';
const STORAGE_KEY_TPLS = 'waBulkSender_templates';
const KEY_LOGGED_IN    = 'waBulkSender_loggedIn';
const KEY_USERNAME     = 'waBulkSender_authUsername';
const KEY_ROLE         = 'waBulkSender_authRole';
const KEY_EXPIRY       = 'waBulkSender_authExpiry';

// ── App State ─────────────────────────────────────────────────────────────────
let contacts     = [];
let results      = [];
let isPaused     = false;
let mediaFile    = null;
let sendMode     = 'text';
let msgSaveTimer = null;
let currentRole  = 'user';    // updated after auth guard reads storage

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

  // ── AUTH GUARD ─────────────────────────────────────────────────────────────
  console.log('[WA Bulk] popup.js v3.5: checking auth session...');
  try {
    const auth = await chrome.storage.local.get([KEY_LOGGED_IN, KEY_EXPIRY, KEY_USERNAME, KEY_ROLE]);

    if (!auth[KEY_LOGGED_IN]) {
      console.log('[WA Bulk] Not logged in → redirecting to login.html');
      window.location.href = 'login.html';
      return;
    }
    if (auth[KEY_EXPIRY] && Date.now() > auth[KEY_EXPIRY]) {
      console.log('[WA Bulk] Session expired → clearing and redirecting');
      await chrome.storage.local.remove([KEY_LOGGED_IN, KEY_USERNAME, KEY_ROLE, KEY_EXPIRY]);
      window.location.href = 'login.html';
      return;
    }

    currentRole = (auth[KEY_ROLE] || 'user').toLowerCase().trim();
    console.log('[WA Bulk] Auth OK. User:', auth[KEY_USERNAME], '| Role:', currentRole);

  } catch (e) {
    console.warn('[WA Bulk] Auth guard error (proceeding):', e.message);
  }
  // ── END AUTH GUARD ──────────────────────────────────────────────────────────

  // ── DOM helpers ─────────────────────────────────────────────────────────────
  function $(id) {
    const el = document.getElementById(id);
    if (!el) console.error(`[WA Bulk] Missing DOM element #${id}`);
    return el;
  }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ── DOM refs — Tabs / Panes ──────────────────────────────────────────────
  const tabs  = $$('.tab');
  const panes = $$('.pane');

  // ── DOM refs — Contacts ──────────────────────────────────────────────────
  const fileInput      = $('file-input');
  const uploadZone     = $('upload-zone');
  const fileStatus     = $('file-status');
  const contactsCard   = $('contacts-card');
  const contactsWrap   = $('contacts-wrap');
  const contactsTbody  = $('contacts-tbody');
  const countNum       = $('count-num');
  const storageBadge   = $('storage-badge');
  const btnClearAll    = $('btn-clear-all');

  // ── DOM refs — Compose ───────────────────────────────────────────────────
  const messageInput      = $('message-input');
  const modeBtnText       = $('mode-text');
  const modeBtnMedia      = $('mode-media');
  const mediaCard         = $('media-card');
  const mediaInputEl      = $('media-input');
  const mediaThumbWrap    = $('media-thumb-wrap');
  const mediaTitleEl      = $('media-title');
  const mediaSubEl        = $('media-sub');
  const btnMediaClear     = $('btn-media-clear');
  const templateNameInput = $('template-name-input');
  const btnSaveTpl        = $('btn-save-tpl');
  const templatesList     = $('templates-list');
  const tplCountBadge     = $('tpl-count-badge');

  // ── DOM refs — Settings ──────────────────────────────────────────────────
  const delayMinInput   = $('delay-min');
  const delayMaxInput   = $('delay-max');
  const batchSizeInput  = $('batch-size');
  const batchPauseInput = $('batch-pause');
  const btnClearStorage = $('btn-clear-storage');
  const btnLogout       = $('btn-logout');
  const displayUsername = $('display-username');
  const displayRole     = $('display-role');

  // ── DOM refs — Progress ──────────────────────────────────────────────────
  const progressBar  = $('progress-bar');
  const statSent     = $('stat-sent');
  const statFailed   = $('stat-failed');
  const statTotal    = $('stat-total');
  const statusMsg    = $('status-msg');
  const btnStart     = $('btn-start');
  const btnPause     = $('btn-pause');
  const btnStop      = $('btn-stop');
  const btnReport    = $('btn-report');
  const errorLogWrap = $('error-log-wrap');
  const errorLogBody = $('error-log-body');

  // ── DOM refs — Admin pane ────────────────────────────────────────────────
  const adminNewUsername = $('admin-new-username');
  const adminNewPassword = $('admin-new-password');
  const adminNewRole     = $('admin-new-role');
  const adminStatus      = $('admin-status');
  const btnAddUser       = $('btn-add-user');
  const btnRefreshUsers  = $('btn-refresh-users');
  const usersTbody       = $('users-tbody');

  // ── DOM refs — Admin password overlay ────────────────────────────────────
  const adminPwOverlay = $('admin-pw-overlay');
  const adminPwDesc    = $('admin-pw-desc');
  const adminPwInput   = $('admin-pw-input');
  const adminPwConfirm = $('admin-pw-confirm');
  const adminPwCancel  = $('admin-pw-cancel');

  // ══════════════════════════════════════════════════════════════════════════
  // ROLE-BASED UI — show Admin tab only for admins
  // ══════════════════════════════════════════════════════════════════════════

  if (currentRole === 'admin') {
    // Reveal the Admin tab button
    const adminTab = document.querySelector('.tab[data-tab="admin"]');
    if (adminTab) {
      // adminTab.style.display = '';
      adminTab.style.setProperty('display', 'block', 'important');
      console.log('[WA Bulk] Admin tab revealed for role=admin');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STORAGE RESTORE
  // ══════════════════════════════════════════════════════════════════════════

  async function restoreAll() {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_KEY, STORAGE_KEY_MSG, STORAGE_KEY_TPLS, KEY_USERNAME, KEY_ROLE,
      ]);

      // Show username + role in Settings tab
      if (displayUsername) displayUsername.textContent = stored[KEY_USERNAME] || '—';
      if (displayRole)     displayRole.textContent     = stored[KEY_ROLE]     || '—';
      console.log('[WA Bulk] Logged in as:', stored[KEY_USERNAME], '| role:', stored[KEY_ROLE]);

      // Contacts
      const saved = stored[STORAGE_KEY];
      if (Array.isArray(saved) && saved.length > 0) {
        contacts = saved;
        renderContactsTable();
        updateStorageBadge(true);
        updateStartButton();
        if (fileStatus) { fileStatus.textContent = `✔ Restored ${contacts.length} contacts.`; fileStatus.style.color = 'var(--accent)'; }
        if (statTotal)  statTotal.textContent = `Total: ${contacts.length}`;
        if (statusMsg)  statusMsg.textContent  = 'Ready — go to Progress tab and press Start.';
      } else {
        updateStorageBadge(false);
      }

      // Message draft
      const savedMsg = stored[STORAGE_KEY_MSG];
      if (savedMsg && messageInput) messageInput.value = savedMsg;

      // Templates
      renderTemplateList(stored[STORAGE_KEY_TPLS] || {});

    } catch (e) {
      console.warn('[WA Bulk] restoreAll failed:', e);
      updateStorageBadge(false);
    }
  }

  async function saveContactsToStorage() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: contacts });
      updateStorageBadge(contacts.length > 0);
    } catch (e) { console.warn('[WA Bulk] saveContacts failed:', e); }
  }

  function updateStorageBadge(has) {
    if (!storageBadge) return;
    storageBadge.textContent = has ? `💾 ${contacts.length} saved` : 'No data saved';
    storageBadge.classList.toggle('warn', !has);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TAB NAVIGATION
  // ══════════════════════════════════════════════════════════════════════════

  tabs.forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  function switchTab(name) {
    tabs.forEach(t  => t.classList.toggle('active', t.dataset.tab === name));
    panes.forEach(p => p.classList.toggle('active', p.id === `pane-${name}`));

    // Auto-fetch user list when admin tab is opened
    if (name === 'admin' && currentRole === 'admin') {
      console.log('[WA Bulk] Admin tab opened — triggering listUsers');
      loadUserList();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOGOUT
  // ══════════════════════════════════════════════════════════════════════════

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (!confirm('Sign out? Your contacts and templates will be kept.')) return;
      console.log('[WA Bulk] Signing out...');
      try { await chrome.storage.local.remove([KEY_LOGGED_IN, KEY_USERNAME, KEY_ROLE, KEY_EXPIRY]); }
      catch (e) { console.warn('[WA Bulk] Logout storage clear failed:', e.message); }
      window.location.href = 'login.html';
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN PASSWORD OVERLAY
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Show the password overlay and return a Promise that resolves with the
   * entered password string, or rejects if the user cancels.
   *
   * WHY AN OVERLAY INSTEAD OF window.prompt()?
   * Chrome extension popups block window.prompt() — it either throws or
   * silently fails. We use a styled in-page modal instead.
   *
   * @param {string} description - Context shown to the user (e.g. "Delete user X")
   * @returns {Promise<string>}  Resolves with password, rejects on cancel
   */
  function requestAdminPassword(description) {
    return new Promise((resolve, reject) => {
      if (!adminPwOverlay) { reject(new Error('Overlay element missing')); return; }

      // Set context message and reset input
      if (adminPwDesc)  adminPwDesc.textContent = description || 'Enter your admin password.';
      if (adminPwInput) { adminPwInput.value = ''; }

      adminPwOverlay.classList.add('visible');
      if (adminPwInput) adminPwInput.focus();

      function onConfirm() {
        const pw = (adminPwInput ? adminPwInput.value : '').trim();
        if (!pw) {
          if (adminPwInput) adminPwInput.style.borderColor = 'var(--danger)';
          setTimeout(() => { if (adminPwInput) adminPwInput.style.borderColor = ''; }, 1500);
          return;
        }
        cleanup();
        resolve(pw);
      }

      function onCancel() {
        cleanup();
        reject(new Error('CANCELLED'));
      }

      // Enter key in the overlay input confirms
      function onKeydown(e) {
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
        if (e.key === 'Escape') { onCancel(); }
      }

      function cleanup() {
        adminPwOverlay.classList.remove('visible');
        if (adminPwInput)   adminPwInput.value = '';
        if (adminPwConfirm) adminPwConfirm.removeEventListener('click', onConfirm);
        if (adminPwCancel)  adminPwCancel.removeEventListener('click', onCancel);
        if (adminPwInput)   adminPwInput.removeEventListener('keydown', onKeydown);
      }

      if (adminPwConfirm) adminPwConfirm.addEventListener('click', onConfirm);
      if (adminPwCancel)  adminPwCancel.addEventListener('click',  onCancel);
      if (adminPwInput)   adminPwInput.addEventListener('keydown', onKeydown);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — ADD USER
  // ══════════════════════════════════════════════════════════════════════════

  if (btnAddUser) {
    btnAddUser.addEventListener('click', addUser);
  }

  async function addUser() {
    const newUsername = (adminNewUsername ? adminNewUsername.value : '').trim();
    const newPassword = (adminNewPassword ? adminNewPassword.value : '').trim();
    const newRole     = (adminNewRole     ? adminNewRole.value     : 'user').trim();

    // Client-side validation
    if (!newUsername) {
      setAdminStatus('⚠ Username is required.', 'error');
      adminNewUsername?.focus();
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setAdminStatus('⚠ Password must be at least 6 characters.', 'error');
      adminNewPassword?.focus();
      return;
    }
    if (!gasUrlConfigured()) return;

    console.log('[WA Bulk] addUser: requesting admin password confirmation...');

    // Request admin password via overlay before making the GAS call
    let adminPassword;
    try {
      adminPassword = await requestAdminPassword(
        `Authorise creating user "${newUsername}" with role "${newRole}".`
      );
    } catch (e) {
      if (e.message === 'CANCELLED') {
        console.log('[WA Bulk] addUser: cancelled by user.');
        setAdminStatus('', '');
        return;
      }
      throw e;
    }

    setAdminStatus('⏳ Creating user…', '');
    if (btnAddUser) btnAddUser.disabled = true;

    console.log('[WA Bulk] POSTing addUser to GAS. New user:', newUsername, '| role:', newRole);

    let data;
    try {
      data = await fetchWithTimeout(GAS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:        'addUser',
          adminPassword,
          username:      newUsername,
          password:      newPassword,
          role:          newRole,
        }),
      }, FETCH_TIMEOUT_MS);
    } catch (err) {
      console.error('[WA Bulk] addUser fetch error:', err.message);
      setAdminStatus(`⚠ ${gasErrorMessage(err)}`, 'error');
      if (btnAddUser) btnAddUser.disabled = false;
      return;
    }

    if (btnAddUser) btnAddUser.disabled = false;
    console.log('[WA Bulk] addUser GAS response:', JSON.stringify(data));

    if (data.status === 'success') {
      setAdminStatus(`✅ User "${newUsername}" created.`, 'success');
      // Clear the form
      if (adminNewUsername) adminNewUsername.value = '';
      if (adminNewPassword) adminNewPassword.value = '';
      if (adminNewRole)     adminNewRole.value     = 'user';
      // Refresh the user list to show the new entry
      loadUserList();
    } else {
      const msg = gasCodeToMessage(data.code) || data.message || 'Failed to create user.';
      setAdminStatus(`⚠ ${msg}`, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — LIST USERS
  // ══════════════════════════════════════════════════════════════════════════

  if (btnRefreshUsers) {
    btnRefreshUsers.addEventListener('click', loadUserList);
  }

  /**
   * Fetch all users from GAS and render them in the users table.
   * Called automatically when the Admin tab is opened, and manually
   * via the Refresh button.
   *
   * Requires admin password — uses the overlay modal.
   */
  async function loadUserList() {
    if (!gasUrlConfigured()) return;

    setUserTablePlaceholder('⏳ Loading users…');
    console.log('[WA Bulk] listUsers: requesting admin password...');

    let adminPassword;
    try {
      adminPassword = await requestAdminPassword('Enter admin password to view user list.');
    } catch (e) {
      if (e.message === 'CANCELLED') {
        setUserTablePlaceholder('User list not loaded. Click ↻ Refresh to try again.');
        return;
      }
      throw e;
    }

    setUserTablePlaceholder('⏳ Fetching users from Google Sheets…');

    let data;
    try {
      data = await fetchWithTimeout(GAS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'listUsers', adminPassword }),
      }, FETCH_TIMEOUT_MS);
    } catch (err) {
      console.error('[WA Bulk] listUsers fetch error:', err.message);
      setUserTablePlaceholder(`⚠ ${gasErrorMessage(err)}`);
      return;
    }

    console.log('[WA Bulk] listUsers response: status=', data.status, '| count=', data.users?.length);

    if (data.status !== 'success') {
      const msg = gasCodeToMessage(data.code) || data.message || 'Failed to load users.';
      setUserTablePlaceholder(`⚠ ${msg}`);
      return;
    }

    renderUsersTable(data.users || [], adminPassword);
  }

  /**
   * Build the users table from the array returned by GAS listUsers.
   * Columns match Code.gs: Username (1), Role (3), IsActive (4), LastLogin (5).
   * Password (2) is intentionally excluded — GAS never returns it in listUsers.
   *
   * @param {Array}  users          - [{ username, role, isActive, lastLogin }]
   * @param {string} adminPassword  - Stored in closure for toggle/delete calls
   */
  function renderUsersTable(users, adminPassword) {
    if (!usersTbody) return;

    if (users.length === 0) {
      setUserTablePlaceholder('No users found in the sheet.');
      return;
    }

    usersTbody.innerHTML = '';

    users.forEach(user => {
      const tr = document.createElement('tr');

      // Format last login date compactly
      let lastLogin = '—';
      if (user.lastLogin) {
        try {
          const d = new Date(user.lastLogin);
          lastLogin = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch { lastLogin = user.lastLogin; }
      }

      const activeBadge = user.isActive
        ? '<span class="badge-active">Active</span>'
        : '<span class="badge-inactive">Inactive</span>';

      const roleBadge = `<span class="badge-role">${escHtml(user.role)}</span>`;

      // Toggle button label reflects the inverse of current state
      const toggleLabel = user.isActive ? '⏸ Disable' : '▶ Enable';

      tr.innerHTML = `
        <td style="font-weight:600">${escHtml(user.username)}</td>
        <td>${roleBadge}</td>
        <td>${activeBadge}</td>
        <td style="font-size:11px;color:var(--muted)">${escHtml(lastLogin)}</td>
        <td>
          <div class="user-actions">
            <button class="btn-user-action btn-user-toggle"
                    data-username="${escHtml(user.username)}"
                    title="${user.isActive ? 'Deactivate account' : 'Activate account'}">
              ${toggleLabel}
            </button>
            <button class="btn-user-action btn-user-delete"
                    data-username="${escHtml(user.username)}"
                    title="Permanently delete user">
              🗑
            </button>
          </div>
        </td>`;

      // Wire Toggle button
      tr.querySelector('.btn-user-toggle').addEventListener('click', async () => {
        await toggleUserActive(user.username, adminPassword);
      });

      // Wire Delete button
      tr.querySelector('.btn-user-delete').addEventListener('click', async () => {
        await deleteUser(user.username, adminPassword);
      });

      usersTbody.appendChild(tr);
    });

    console.log('[WA Bulk] Users table rendered with', users.length, 'rows');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — TOGGLE ACTIVE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Toggle a user's IsActive status in the sheet.
   * Uses the adminPassword already captured during loadUserList — no second
   * overlay prompt needed unless the session password was wrong on first use.
   *
   * @param {string} username
   * @param {string} adminPassword  — from the loadUserList closure
   */
  async function toggleUserActive(username, adminPassword) {
    if (!gasUrlConfigured()) return;
    if (!confirm(`Toggle active status for "${username}"?`)) return;

    console.log('[WA Bulk] toggleActive for:', username);
    setAdminStatus(`⏳ Updating ${username}…`, '');

    let data;
    try {
      data = await fetchWithTimeout(GAS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'toggleActive', adminPassword, username }),
      }, FETCH_TIMEOUT_MS);
    } catch (err) {
      console.error('[WA Bulk] toggleActive fetch error:', err.message);
      setAdminStatus(`⚠ ${gasErrorMessage(err)}`, 'error');
      return;
    }

    console.log('[WA Bulk] toggleActive response:', JSON.stringify(data));

    if (data.status === 'success') {
      const newState = data.isActive ? 'Active' : 'Inactive';
      setAdminStatus(`✅ "${username}" is now ${newState}.`, 'success');
      // Refresh the list to show the updated badge
      loadUserList();
    } else {
      const msg = gasCodeToMessage(data.code) || data.message || 'Toggle failed.';
      setAdminStatus(`⚠ ${msg}`, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — DELETE USER
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Permanently delete a user row from the sheet.
   *
   * @param {string} username
   * @param {string} adminPassword
   */
  async function deleteUser(username, adminPassword) {
    if (!gasUrlConfigured()) return;

    // Double-confirm destructive action
    if (!confirm(`Permanently delete user "${username}"?\nThis cannot be undone.`)) return;

    console.log('[WA Bulk] deleteUser:', username);
    setAdminStatus(`⏳ Deleting ${username}…`, '');

    let data;
    try {
      data = await fetchWithTimeout(GAS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'deleteUser', adminPassword, username }),
      }, FETCH_TIMEOUT_MS);
    } catch (err) {
      console.error('[WA Bulk] deleteUser fetch error:', err.message);
      setAdminStatus(`⚠ ${gasErrorMessage(err)}`, 'error');
      return;
    }

    console.log('[WA Bulk] deleteUser response:', JSON.stringify(data));

    if (data.status === 'success') {
      setAdminStatus(`✅ User "${username}" deleted.`, 'success');
      loadUserList();
    } else {
      const msg = gasCodeToMessage(data.code) || data.message || 'Delete failed.';
      setAdminStatus(`⚠ ${msg}`, 'error');
    }
  }

  // ── Admin UI helpers ──────────────────────────────────────────────────────

  function setAdminStatus(msg, type) {
    if (!adminStatus) return;
    adminStatus.textContent = msg;
    adminStatus.className   = type || '';
  }

  function setUserTablePlaceholder(msg) {
    if (!usersTbody) return;
    usersTbody.innerHTML = `<tr><td colspan="5" class="users-placeholder">${escHtml(msg)}</td></tr>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SEND MODE TOGGLE
  // ══════════════════════════════════════════════════════════════════════════

  if (modeBtnText)  modeBtnText.addEventListener('click',  () => setMode('text'));
  if (modeBtnMedia) modeBtnMedia.addEventListener('click', () => setMode('media'));

  function setMode(mode) {
    sendMode = mode;
    if (modeBtnText)  modeBtnText.classList.toggle('active',  mode === 'text');
    if (modeBtnMedia) modeBtnMedia.classList.toggle('active', mode === 'media');
    if (mediaCard)    mediaCard.style.display = mode === 'media' ? 'block' : 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE DRAFT AUTO-SAVE
  // ══════════════════════════════════════════════════════════════════════════

  if (messageInput) {
    messageInput.addEventListener('input', () => {
      clearTimeout(msgSaveTimer);
      msgSaveTimer = setTimeout(() => {
        chrome.storage.local
          .set({ [STORAGE_KEY_MSG]: messageInput.value })
          .catch(e => console.warn('[WA Bulk] msg draft save failed:', e));
      }, 300);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE SAVE / LOAD / DELETE
  // ══════════════════════════════════════════════════════════════════════════

  if (btnSaveTpl) btnSaveTpl.addEventListener('click', saveTemplate);

  async function saveTemplate() {
    if (!templateNameInput || !messageInput) return;
    const name = templateNameInput.value.trim();
    const text = messageInput.value.trim();

    if (!name) {
      templateNameInput.placeholder   = 'Enter a name first!';
      templateNameInput.style.borderColor = 'var(--danger)';
      setTimeout(() => { templateNameInput.placeholder = 'Template name (e.g. Promo Oct)'; templateNameInput.style.borderColor = ''; }, 2000);
      return;
    }
    if (!text) { if (statusMsg) statusMsg.textContent = '⚠ Message is empty.'; return; }

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_TPLS);
      const tpls   = stored[STORAGE_KEY_TPLS] || {};
      tpls[name]   = text;
      await chrome.storage.local.set({ [STORAGE_KEY_TPLS]: tpls });
      renderTemplateList(tpls);
      templateNameInput.value = '';
      if (btnSaveTpl) { btnSaveTpl.textContent = '✔ Saved!'; setTimeout(() => (btnSaveTpl.textContent = '💾 Save'), 1500); }
    } catch (e) { console.warn('[WA Bulk] saveTemplate failed:', e); }
  }

  async function deleteTemplate(name) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_TPLS);
      const tpls   = stored[STORAGE_KEY_TPLS] || {};
      delete tpls[name];
      await chrome.storage.local.set({ [STORAGE_KEY_TPLS]: tpls });
      renderTemplateList(tpls);
    } catch (e) { console.warn('[WA Bulk] deleteTemplate failed:', e); }
  }

  function loadTemplate(text) {
    if (messageInput) {
      messageInput.value = text;
      chrome.storage.local.set({ [STORAGE_KEY_MSG]: text }).catch(() => {});
    }
    switchTab('compose');
  }

  function renderTemplateList(tpls) {
    if (!templatesList) return;
    const names = Object.keys(tpls || {});
    if (tplCountBadge) { tplCountBadge.textContent = `${names.length} saved`; tplCountBadge.classList.toggle('warn', names.length === 0); }
    templatesList.innerHTML = '';
    if (names.length === 0) { templatesList.innerHTML = '<div class="tpl-empty">No templates saved yet.</div>'; return; }
    names.forEach(name => {
      const text    = tpls[name];
      const preview = text.replace(/\s+/g, ' ').slice(0, 55) + (text.length > 55 ? '…' : '');
      const item    = document.createElement('div');
      item.className = 'template-item';
      item.innerHTML = `<span class="template-item-name">${escHtml(name)}</span><span class="template-item-preview">${escHtml(preview)}</span><button class="btn-del-tpl" title="Delete">✕</button>`;
      item.addEventListener('click', e => { if (!e.target.classList.contains('btn-del-tpl')) loadTemplate(text); });
      item.querySelector('.btn-del-tpl').addEventListener('click', e => { e.stopPropagation(); if (confirm(`Delete template "${name}"?`)) deleteTemplate(name); });
      templatesList.appendChild(item);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTACTS UPLOAD
  // ══════════════════════════════════════════════════════════════════════════

  if (uploadZone) {
    uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleContactsFile(e.dataTransfer.files[0]); });
  }
  if (fileInput) fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleContactsFile(fileInput.files[0]); });

  function handleContactsFile(file) {
    const n = file.name.toLowerCase();
    if (n.endsWith('.csv')) parseCSV(file);
    else if (n.endsWith('.xlsx') || n.endsWith('.xls')) parseExcel(file);
    else setFileStatus('⚠ Unsupported format.', 'var(--danger)');
  }

  function parseCSV(file) {
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: r => normalizeContacts(r.data, file.name), error: e => setFileStatus(`⚠ ${e.message}`, 'var(--danger)') });
  }

  function parseExcel(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try { const wb = XLSX.read(e.target.result, { type: 'binary' }); normalizeContacts(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }), file.name); }
      catch (err) { setFileStatus(`⚠ ${err.message}`, 'var(--danger)'); }
    };
    reader.readAsBinaryString(file);
  }

  function normalizeContacts(rows, fileName) {
    if (!rows?.length) return setFileStatus('⚠ File is empty.', 'var(--danger)');
    const keys     = Object.keys(rows[0]);
    const nameKey  = keys.find(k => /^name$/i.test(k.trim()));
    const phoneKey = keys.find(k => /^phone|^mobile|^number/i.test(k.trim()));
    if (!nameKey || !phoneKey) return setFileStatus(`⚠ Need "Name" & "Phone". Found: ${keys.join(', ')}`, 'var(--danger)');
    const parsed   = rows.map(r => ({ name: String(r[nameKey] || '').trim(), phone: String(r[phoneKey] || '').replace(/[^\d+]/g, '') })).filter(c => c.phone.length >= 7);
    if (!parsed.length) return setFileStatus('⚠ No valid contacts.', 'var(--danger)');
    const existing = new Set(contacts.map(c => c.phone));
    const newOnes  = parsed.filter(c => !existing.has(c.phone));
    contacts       = [...contacts, ...newOnes];
    renderContactsTable();
    saveContactsToStorage();
    setFileStatus(`✔ Added ${newOnes.length} new (${contacts.length} total) from "${fileName}"`, 'var(--accent)');
    if (statTotal) statTotal.textContent = `Total: ${contacts.length}`;
    updateStartButton();
    if (statusMsg) statusMsg.textContent = 'Ready — go to Progress tab and press Start.';
  }

  function setFileStatus(msg, color) { if (!fileStatus) return; fileStatus.textContent = msg; fileStatus.style.color = color; }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTACTS TABLE
  // ══════════════════════════════════════════════════════════════════════════

  function renderContactsTable() {
    if (!contactsTbody) return;
    contactsTbody.innerHTML = '';
    contacts.forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td style="color:var(--muted);width:28px">${i + 1}</td><td>${escHtml(c.name)}</td><td style="font-family:monospace;font-size:11px">${escHtml(c.phone)}</td><td style="width:30px;text-align:center"><button class="btn-del-row" data-idx="${i}" title="Remove">✕</button></td>`;
      contactsTbody.appendChild(tr);
    });
    contactsTbody.querySelectorAll('.btn-del-row').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); deleteContact(parseInt(btn.dataset.idx, 10)); });
    });
    const has = contacts.length > 0;
    if (contactsCard) contactsCard.style.display = has ? 'block' : 'none';
    if (contactsWrap) contactsWrap.style.display = has ? 'block' : 'none';
    if (countNum)     countNum.textContent = contacts.length;
  }

  function deleteContact(i) {
    contacts.splice(i, 1);
    renderContactsTable();
    saveContactsToStorage();
    if (statTotal) statTotal.textContent = `Total: ${contacts.length}`;
    updateStartButton();
    if (!contacts.length && statusMsg) statusMsg.textContent = 'All contacts removed.';
  }

  if (btnClearAll)     btnClearAll.addEventListener('click',     clearAllContacts);
  if (btnClearStorage) btnClearStorage.addEventListener('click', clearAllContacts);

  function clearAllContacts() {
    if (!contacts.length) return;
    if (!confirm(`Remove all ${contacts.length} contacts?`)) return;
    contacts = [];
    renderContactsTable();
    chrome.storage.local.remove(STORAGE_KEY);
    updateStorageBadge(false);
    updateStartButton();
    setFileStatus('', '');
    if (statTotal) statTotal.textContent = 'Total: 0';
    if (statusMsg) statusMsg.textContent = 'Contact list cleared.';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MEDIA ATTACHMENT
  // ══════════════════════════════════════════════════════════════════════════

  if (mediaInputEl) mediaInputEl.addEventListener('change', () => { if (mediaInputEl.files[0]) handleMediaFile(mediaInputEl.files[0]); });

  function handleMediaFile(file) {
    mediaFile = file;
    if (file.type.startsWith('image/') && mediaThumbWrap) {
      const url = URL.createObjectURL(file);
      mediaThumbWrap.innerHTML = `<img src="${url}" alt="preview" style="width:100%;height:100%;object-fit:cover">`;
    } else if (mediaThumbWrap) { mediaThumbWrap.innerHTML = '<span style="font-size:22px">🎬</span>'; }
    if (mediaTitleEl)  mediaTitleEl.textContent   = truncate(file.name, 36);
    if (mediaSubEl)    mediaSubEl.textContent      = `${file.type || 'unknown'} · ${formatBytes(file.size)}`;
    if (btnMediaClear) btnMediaClear.style.display = 'inline-block';
  }

  if (btnMediaClear) {
    btnMediaClear.addEventListener('click', e => {
      e.stopPropagation();
      mediaFile = null;
      if (mediaInputEl)   mediaInputEl.value           = '';
      if (mediaThumbWrap) mediaThumbWrap.innerHTML      = '<span style="font-size:22px">🖼</span>';
      if (mediaTitleEl)   mediaTitleEl.textContent      = 'No file selected';
      if (mediaSubEl)     mediaSubEl.textContent        = 'Click to choose image or video';
      if (btnMediaClear)  btnMediaClear.style.display   = 'none';
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = ()  => reject(new Error('Failed to read media file.'));
      r.readAsDataURL(file);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CAMPAIGN CONTROLS
  // ══════════════════════════════════════════════════════════════════════════

  if (btnStart)  btnStart.addEventListener('click',  startCampaign);
  if (btnPause)  btnPause.addEventListener('click',  togglePause);
  if (btnStop)   btnStop.addEventListener('click',   stopCampaign);
  if (btnReport) btnReport.addEventListener('click', downloadReport);

  async function startCampaign() {
    const message = messageInput?.value.trim() || '';
    if (!message)              { switchTab('compose');  return; }
    if (!contacts.length)      { switchTab('contacts'); return; }
    if (sendMode === 'media' && !mediaFile) { if (statusMsg) statusMsg.textContent = '⚠ Attach a media file or switch to Text Only.'; return; }

    const waTabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!waTabs.length) { if (statusMsg) statusMsg.textContent = '⚠ Please open web.whatsapp.com first!'; return; }

    results  = [];
    isPaused = false;
    clearErrorLog();
    updateProgress(0, 0, contacts.length);
    setControlState('running');
    switchTab('progress');
    if (statusMsg) statusMsg.textContent = '⏳ Preparing campaign…';

    let mediaPayload = null;
    if (sendMode === 'media' && mediaFile) {
      if (statusMsg) statusMsg.textContent = '⏳ Encoding media…';
      try { mediaPayload = { base64: await fileToBase64(mediaFile), mimeType: mediaFile.type, fileName: mediaFile.name }; }
      catch (e) { if (statusMsg) statusMsg.textContent = `⚠ Media error: ${e.message}`; setControlState('idle'); return; }
    }

    chrome.runtime.sendMessage({
      type:       'START_CAMPAIGN',
      contacts,
      message,
      sendMode,
      media:      mediaPayload,
      delayMin:   parseInt(delayMinInput?.value   || 15, 10) * 1000,
      delayMax:   parseInt(delayMaxInput?.value   || 30, 10) * 1000,
      batchSize:  parseInt(batchSizeInput?.value  || 50, 10),
      batchPause: parseInt(batchPauseInput?.value || 10, 10) * 60000,
    });
    if (statusMsg) statusMsg.textContent = '⏳ Campaign started…';
  }

  function togglePause() {
    isPaused = !isPaused;
    chrome.runtime.sendMessage({ type: isPaused ? 'PAUSE_CAMPAIGN' : 'RESUME_CAMPAIGN' });
    if (btnPause)  btnPause.textContent  = isPaused ? '▶ Resume' : '⏸ Pause';
    if (statusMsg) statusMsg.textContent = isPaused ? '⏸ Paused.' : '▶ Resumed.';
  }

  function stopCampaign() {
    chrome.runtime.sendMessage({ type: 'STOP_CAMPAIGN' });
    if (statusMsg) statusMsg.textContent = '■ Stopped.';
    setControlState('idle');
    if (results.length && btnReport) btnReport.disabled = false;
  }

  function setControlState(state) {
    const r = state === 'running';
    if (btnStart)  btnStart.disabled  = r || !contacts.length;
    if (btnPause)  btnPause.disabled  = !r;
    if (btnStop)   btnStop.disabled   = !r;
    if (btnReport && r) btnReport.disabled = true;
    if (!r && btnPause) btnPause.textContent = '⏸ Pause';
  }

  function updateStartButton() { if (btnStart) btnStart.disabled = !contacts.length; }

  // ══════════════════════════════════════════════════════════════════════════
  // PROGRESS LISTENER
  // ══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(msg => {
    switch (msg.type) {
      case 'PROGRESS':
        updateProgress(msg.sent, msg.failed, msg.total);
        if (statusMsg) statusMsg.textContent = `📤 Sending to ${escHtml(msg.currentName)} (${msg.currentPhone})…`;
        if (msg.lastResult) { results.push(msg.lastResult); if (msg.lastResult.status === 'failed') appendErrorLog(msg.lastResult); }
        break;
      case 'BATCH_PAUSE':
        if (statusMsg) statusMsg.textContent = `⏱ Batch done. Auto-pausing ${Math.round(msg.waitMs / 60000)} min…`;
        break;
      case 'COMPLETE':
        if (msg.results) results = msg.results;
        updateProgress(msg.sent, msg.failed, msg.total);
        if (statusMsg) statusMsg.textContent = `✅ Done! Sent: ${msg.sent} · Failed: ${msg.failed}`;
        setControlState('idle');
        if (btnReport) btnReport.disabled = false;
        break;
      case 'ERROR':
        if (statusMsg) statusMsg.textContent = `⚠ ${msg.message}`;
        break;
    }
  });

  // ── Error log ─────────────────────────────────────────────────────────────

  function appendErrorLog(result) {
    if (!errorLogWrap || !errorLogBody) return;
    errorLogWrap.style.display = 'block';
    const code = result.errorCode || 'SEND_FAILED';
    const row  = document.createElement('div');
    row.className = 'error-log-row';
    row.innerHTML = `<span class="error-pill pill-${escHtml(code)}">${escHtml(code)}</span><span class="error-log-phone">${escHtml(result.phone)}</span><span class="error-log-reason">${escHtml(result.reason || '—')}</span>`;
    errorLogBody.appendChild(row);
  }

  function clearErrorLog() {
    if (errorLogWrap) errorLogWrap.style.display = 'none';
    if (errorLogBody) errorLogBody.innerHTML = '';
  }

  function updateProgress(sent, failed, total) {
    const pct = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (statSent)    statSent.textContent    = `Sent: ${sent}`;
    if (statFailed)  statFailed.textContent  = `Failed: ${failed}`;
    if (statTotal)   statTotal.textContent   = `Total: ${total}`;
  }

  // ── Report download ───────────────────────────────────────────────────────

  function downloadReport() {
    if (!results.length) { if (statusMsg) statusMsg.textContent = 'No results yet.'; return; }
    const rows = [['Name','Phone','Status','Error Code','Reason'], ...results.map(r => [r.name, r.phone, r.status, r.errorCode||'', r.reason||''])];
    const csv  = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `wa_report_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KICK OFF
  // ══════════════════════════════════════════════════════════════════════════

  restoreAll();

}); // end DOMContentLoaded

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES  (module-level)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch with AbortController-based timeout.
 * Identical to login.js — same pattern, same error contract.
 *
 * @param  {string}      url
 * @param  {RequestInit} options
 * @param  {number}      timeoutMs
 * @returns {Promise<Object>} Parsed JSON body
 * @throws  {Error}  'TIMEOUT' | HTTP error | JSON parse error
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    console.warn('[WA Bulk] Fetch aborted — timeout after', timeoutMs, 'ms');
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);

    console.log('[WA Bulk] GAS HTTP', response.status, response.statusText);

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const raw = await response.text();
    try {
      return JSON.parse(raw);
    } catch {
      console.error('[WA Bulk] Non-JSON response (first 200 chars):', raw.slice(0, 200));
      throw new Error('GAS returned non-JSON. Check deployment and ContentService.MimeType.JSON.');
    }

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  }
}

/**
 * Check GAS_URL is configured. Shows an error status and returns false if not.
 * Called at the top of every admin action to give a clear developer message.
 */
function gasUrlConfigured() {
  if (
    typeof GAS_URL === 'undefined' ||
    GAS_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE' ||
    !GAS_URL.startsWith('https://')
  ) {
    console.error('[WA Bulk] GAS_URL is not configured in popup.js');
    const s = document.getElementById('admin-status');
    if (s) { s.textContent = '⚠ GAS_URL not set — edit popup.js line 1.'; s.className = 'error'; }
    return false;
  }
  return true;
}

/**
 * Map Code.gs error codes to user-friendly messages.
 * Mirrors the mapping in login.js for consistency.
 */
function gasCodeToMessage(code) {
  const MAP = {
    'INVALID_CREDENTIALS':         'Incorrect admin password.',
    'ADMIN_AUTH_FAILED':           'Incorrect admin password.',
    'ADMIN_NOT_FOUND':             'Admin account not found in sheet. Run setupAdminUser() first.',
    'ADMIN_PASSWORD_REQUIRED':     'Admin password is required.',
    'USER_EXISTS':                 'That username already exists.',
    'USER_NOT_FOUND':              'User not found.',
    'MISSING_FIELDS':              'Required fields are missing.',
    'CANNOT_DEACTIVATE_ADMIN':     'Cannot deactivate the admin account.',
    'CANNOT_DELETE_ADMIN':         'Cannot delete the admin account.',
    'SERVER_ERROR':                'Server error. Check the GAS execution log.',
    'TIMEOUT':                     'Request timed out. Check your internet connection.',
  };
  return MAP[code] || null;
}

/**
 * Convert a network/fetch error to a user-friendly string.
 */
function gasErrorMessage(err) {
  if (err.message === 'TIMEOUT') return 'Request timed out. Check your connection.';
  return err.message || 'Network error.';
}

// ── Utility helpers ────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(str, max) { return str.length > max ? str.slice(0, max - 1) + '…' : str; }
function formatBytes(b) {
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}