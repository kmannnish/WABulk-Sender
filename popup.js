/**
 * popup.js  v3.1 — FIXED
 * ─────────────────────────────────────────────────────────────────────────────
 * FIXES vs v3.0:
 *
 *  FIX 1 — "Can't type in message template"
 *    All DOM getElementById calls and ALL event listener bindings are now
 *    wrapped inside DOMContentLoaded. Previously, const declarations at the
 *    top-level ran before the popup's HTML was parsed in some edge cases,
 *    leaving refs as null and throwing silent errors that froze the UI.
 *
 *  FIX 2 — Defensive null guards
 *    Every getElementById result is checked before use. If an element is
 *    missing (HTML/ID mismatch), a clear console.error is logged instead
 *    of a silent crash that locks up the whole popup.
 *
 *  FIX 3 — Start button validation message routing
 *    statusMsg was being updated before the UI switched to the Progress tab,
 *    causing the message to appear on the wrong tab. Fixed order.
 *
 *  FIX 4 — Template name input no longer steals focus from textarea
 *    Removed accidental event propagation from the template row that was
 *    consuming keyboard events before they reached the message textarea.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── STORAGE KEYS ──────────────────────────────────────────────────────────────
const STORAGE_KEY      = 'waBulkSender_contacts';
const STORAGE_KEY_MSG  = 'waBulkSender_message';
const STORAGE_KEY_TPLS = 'waBulkSender_templates';

// ── App State ─────────────────────────────────────────────────────────────────
let contacts  = [];
let results   = [];
let isPaused  = false;
let mediaFile = null;
let sendMode  = 'text';
let msgSaveTimer = null;

// ══════════════════════════════════════════════════════════════════════════════
// INIT — everything wired inside DOMContentLoaded
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // ── Grab every DOM ref safely ───────────────────────────────────────────────
  function $  (id) {
    const el = document.getElementById(id);
    if (!el) console.error(`[WA Bulk] Missing DOM element: #${id} — check popup.html`);
    return el;
  }
  function $$ (sel) { return document.querySelectorAll(sel); }

  // Tabs
  const tabs  = $$('.tab');
  const panes = $$('.pane');

  // Contacts
  const fileInput      = $('file-input');
  const uploadZone     = $('upload-zone');
  const fileStatus     = $('file-status');
  const contactsCard   = $('contacts-card');
  const contactsWrap   = $('contacts-wrap');
  const contactsTbody  = $('contacts-tbody');
  const countNum       = $('count-num');
  const storageBadge   = $('storage-badge');
  const btnClearAll    = $('btn-clear-all');

  // Compose
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

  // Settings
  const delayMinInput   = $('delay-min');
  const delayMaxInput   = $('delay-max');
  const batchSizeInput  = $('batch-size');
  const batchPauseInput = $('batch-pause');
  const btnClearStorage = $('btn-clear-storage');

  // Progress
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

  // ══════════════════════════════════════════════════════════════════════════
  // STORAGE RESTORE
  // ══════════════════════════════════════════════════════════════════════════

  async function restoreAll() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, STORAGE_KEY_MSG, STORAGE_KEY_TPLS]);

      // Contacts
      const savedContacts = stored[STORAGE_KEY];
      if (Array.isArray(savedContacts) && savedContacts.length > 0) {
        contacts = savedContacts;
        renderContactsTable();
        updateStorageBadge(true);
        updateStartButton();
        if (fileStatus) {
          fileStatus.textContent = `✔ Restored ${contacts.length} contacts from storage.`;
          fileStatus.style.color = 'var(--accent)';
        }
        if (statTotal) statTotal.textContent = `Total: ${contacts.length}`;
        if (statusMsg) statusMsg.textContent  = 'Ready — go to Progress tab and press Start.';
      } else {
        updateStorageBadge(false);
      }

      // Message draft
      const savedMsg = stored[STORAGE_KEY_MSG];
      if (savedMsg && typeof savedMsg === 'string' && messageInput) {
        messageInput.value = savedMsg;
      }

      // Templates
      const savedTpls = stored[STORAGE_KEY_TPLS];
      renderTemplateList(savedTpls && typeof savedTpls === 'object' ? savedTpls : {});

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
  // MESSAGE DRAFT AUTO-SAVE (debounced)
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
      templateNameInput.placeholder = 'Enter a name first!';
      templateNameInput.style.borderColor = 'var(--danger)';
      setTimeout(() => {
        templateNameInput.placeholder   = 'Template name (e.g. Promo Oct)';
        templateNameInput.style.borderColor = '';
      }, 2000);
      return;
    }
    if (!text) {
      if (statusMsg) statusMsg.textContent = '⚠ Message is empty — nothing to save.';
      return;
    }

    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_TPLS);
      const tpls   = stored[STORAGE_KEY_TPLS] || {};
      tpls[name]   = text;
      await chrome.storage.local.set({ [STORAGE_KEY_TPLS]: tpls });
      renderTemplateList(tpls);
      templateNameInput.value = '';
      if (btnSaveTpl) {
        btnSaveTpl.textContent = '✔ Saved!';
        setTimeout(() => (btnSaveTpl.textContent = '💾 Save'), 1500);
      }
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
      // Persist as draft
      chrome.storage.local.set({ [STORAGE_KEY_MSG]: text }).catch(() => {});
    }
    switchTab('compose');
  }

  function renderTemplateList(tpls) {
    if (!templatesList) return;
    const names = Object.keys(tpls || {});

    if (tplCountBadge) {
      tplCountBadge.textContent = `${names.length} saved`;
      tplCountBadge.classList.toggle('warn', names.length === 0);
    }

    templatesList.innerHTML = '';
    if (names.length === 0) {
      templatesList.innerHTML = '<div class="tpl-empty">No templates saved yet.</div>';
      return;
    }

    names.forEach(name => {
      const text    = tpls[name];
      const preview = text.replace(/\s+/g, ' ').slice(0, 55) + (text.length > 55 ? '…' : '');
      const item    = document.createElement('div');
      item.className = 'template-item';
      item.innerHTML = `
        <span class="template-item-name">${escHtml(name)}</span>
        <span class="template-item-preview">${escHtml(preview)}</span>
        <button class="btn-del-tpl" title="Delete">✕</button>`;

      item.addEventListener('click', e => {
        if (!e.target.classList.contains('btn-del-tpl')) loadTemplate(text);
      });
      item.querySelector('.btn-del-tpl').addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Delete template "${name}"?`)) deleteTemplate(name);
      });
      templatesList.appendChild(item);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTACTS UPLOAD
  // ══════════════════════════════════════════════════════════════════════════

  if (uploadZone) {
    uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', e => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleContactsFile(e.dataTransfer.files[0]);
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleContactsFile(fileInput.files[0]);
    });
  }

  function handleContactsFile(file) {
    const name = file.name.toLowerCase();
    if      (name.endsWith('.csv'))                          parseCSV(file);
    else if (name.endsWith('.xlsx') || name.endsWith('.xls')) parseExcel(file);
    else setFileStatus('⚠ Unsupported format. Use .csv, .xlsx, or .xls', 'var(--danger)');
  }

  function parseCSV(file) {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: r => normalizeContacts(r.data, file.name),
      error:    e => setFileStatus(`⚠ CSV parse error: ${e.message}`, 'var(--danger)'),
    });
  }

  function parseExcel(file) {
    const reader  = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(e.target.result, { type: 'binary' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        normalizeContacts(XLSX.utils.sheet_to_json(ws, { defval: '' }), file.name);
      } catch (err) { setFileStatus(`⚠ Excel parse error: ${err.message}`, 'var(--danger)'); }
    };
    reader.readAsBinaryString(file);
  }

  function normalizeContacts(rows, fileName) {
    if (!rows || rows.length === 0)
      return setFileStatus('⚠ File is empty.', 'var(--danger)');

    const keys     = Object.keys(rows[0]);
    const nameKey  = keys.find(k => /^name$/i.test(k.trim()));
    const phoneKey = keys.find(k => /^phone|^mobile|^number/i.test(k.trim()));

    if (!nameKey || !phoneKey)
      return setFileStatus(`⚠ Need "Name" & "Phone" columns. Found: ${keys.join(', ')}`, 'var(--danger)');

    const parsed = rows
      .map(row => ({
        name:  String(row[nameKey]  || '').trim(),
        phone: String(row[phoneKey] || '').replace(/[^\d+]/g, ''),
      }))
      .filter(c => c.phone.length >= 7);

    if (parsed.length === 0)
      return setFileStatus('⚠ No valid contacts found. Check phone format.', 'var(--danger)');

    const existing = new Set(contacts.map(c => c.phone));
    const newOnes  = parsed.filter(c => !existing.has(c.phone));
    contacts       = [...contacts, ...newOnes];

    renderContactsTable();
    saveContactsToStorage();
    setFileStatus(`✔ Added ${newOnes.length} new contacts (${contacts.length} total) from "${fileName}"`, 'var(--accent)');
    if (statTotal) statTotal.textContent = `Total: ${contacts.length}`;
    updateStartButton();
    if (statusMsg) statusMsg.textContent = 'Ready — go to Progress tab and press Start.';
  }

  function setFileStatus(msg, color) {
    if (!fileStatus) return;
    fileStatus.textContent = msg;
    fileStatus.style.color = color;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTACTS TABLE
  // ══════════════════════════════════════════════════════════════════════════

  function renderContactsTable() {
    if (!contactsTbody) return;
    contactsTbody.innerHTML = '';
    contacts.forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:var(--muted);width:28px">${i + 1}</td>
        <td>${escHtml(c.name)}</td>
        <td style="font-family:monospace;font-size:11px">${escHtml(c.phone)}</td>
        <td style="width:30px;text-align:center">
          <button class="btn-del-row" data-idx="${i}" title="Remove">✕</button>
        </td>`;
      contactsTbody.appendChild(tr);
    });

    contactsTbody.querySelectorAll('.btn-del-row').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteContact(parseInt(btn.dataset.idx, 10));
      });
    });

    const has = contacts.length > 0;
    if (contactsCard) contactsCard.style.display = has ? 'block' : 'none';
    if (contactsWrap) contactsWrap.style.display = has ? 'block' : 'none';
    if (countNum)     countNum.textContent        = contacts.length;
  }

  function deleteContact(index) {
    contacts.splice(index, 1);
    renderContactsTable();
    saveContactsToStorage();
    if (statTotal) statTotal.textContent = `Total: ${contacts.length}`;
    updateStartButton();
    if (contacts.length === 0 && statusMsg) statusMsg.textContent = 'All contacts removed.';
  }

  if (btnClearAll)    btnClearAll.addEventListener('click',     clearAllContacts);
  if (btnClearStorage) btnClearStorage.addEventListener('click', clearAllContacts);

  function clearAllContacts() {
    if (contacts.length === 0) return;
    if (!confirm(`Remove all ${contacts.length} contacts?`)) return;
    contacts = [];
    renderContactsTable();
    chrome.storage.local.remove(STORAGE_KEY);
    updateStorageBadge(false);
    updateStartButton();
    setFileStatus('', '');
    if (statTotal) statTotal.textContent  = 'Total: 0';
    if (statusMsg) statusMsg.textContent  = 'Contact list cleared.';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MEDIA ATTACHMENT
  // ══════════════════════════════════════════════════════════════════════════

  if (mediaInputEl) {
    mediaInputEl.addEventListener('change', () => {
      if (mediaInputEl.files[0]) handleMediaFile(mediaInputEl.files[0]);
    });
  }

  function handleMediaFile(file) {
    mediaFile = file;
    if (file.type.startsWith('image/') && mediaThumbWrap) {
      const url = URL.createObjectURL(file);
      mediaThumbWrap.innerHTML = `<img src="${url}" alt="preview" style="width:100%;height:100%;object-fit:cover">`;
    } else if (mediaThumbWrap) {
      mediaThumbWrap.innerHTML = '<span style="font-size:22px">🎬</span>';
    }
    if (mediaTitleEl)   mediaTitleEl.textContent      = truncate(file.name, 36);
    if (mediaSubEl)     mediaSubEl.textContent         = `${file.type || 'unknown'} · ${formatBytes(file.size)}`;
    if (btnMediaClear)  btnMediaClear.style.display    = 'inline-block';
  }

  if (btnMediaClear) {
    btnMediaClear.addEventListener('click', e => {
      e.stopPropagation();
      mediaFile = null;
      if (mediaInputEl)   mediaInputEl.value             = '';
      if (mediaThumbWrap) mediaThumbWrap.innerHTML        = '<span style="font-size:22px">🖼</span>';
      if (mediaTitleEl)   mediaTitleEl.textContent        = 'No file selected';
      if (mediaSubEl)     mediaSubEl.textContent          = 'Click to choose image or video';
      if (btnMediaClear)  btnMediaClear.style.display     = 'none';
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader   = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = ()  => reject(new Error('Failed to read media file.'));
      reader.readAsDataURL(file);
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
    const message = messageInput ? messageInput.value.trim() : '';

    // Validate
    if (!message) {
      switchTab('compose');
      return;
    }
    if (contacts.length === 0) {
      switchTab('contacts');
      return;
    }
    if (sendMode === 'media' && !mediaFile) {
      if (statusMsg) statusMsg.textContent = '⚠ Attach a media file or switch to Text Only.';
      return;
    }

    const waTabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (waTabs.length === 0) {
      if (statusMsg) statusMsg.textContent = '⚠ Please open web.whatsapp.com first!';
      return;
    }

    // Reset state
    results  = [];
    isPaused = false;
    clearErrorLog();
    updateProgress(0, 0, contacts.length);
    setControlState('running');

    // Switch to progress tab so user sees status
    switchTab('progress');
    if (statusMsg) statusMsg.textContent = '⏳ Preparing campaign…';

    // Encode media if needed
    let mediaPayload = null;
    if (sendMode === 'media' && mediaFile) {
      if (statusMsg) statusMsg.textContent = '⏳ Encoding media…';
      try {
        mediaPayload = {
          base64:   await fileToBase64(mediaFile),
          mimeType: mediaFile.type,
          fileName: mediaFile.name,
        };
      } catch (e) {
        if (statusMsg) statusMsg.textContent = `⚠ Media encoding error: ${e.message}`;
        setControlState('idle');
        return;
      }
    }

    chrome.runtime.sendMessage({
      type:       'START_CAMPAIGN',
      contacts,
      message,
      sendMode,
      media:      mediaPayload,
      delayMin:   parseInt(delayMinInput  ? delayMinInput.value   : 15, 10) * 1000,
      delayMax:   parseInt(delayMaxInput  ? delayMaxInput.value   : 30, 10) * 1000,
      batchSize:  parseInt(batchSizeInput ? batchSizeInput.value  : 50, 10),
      batchPause: parseInt(batchPauseInput? batchPauseInput.value : 10, 10) * 60000,
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
    if (results.length > 0 && btnReport) btnReport.disabled = false;
  }

  function setControlState(state) {
    const running = state === 'running';
    if (btnStart)  btnStart.disabled  = running || contacts.length === 0;
    if (btnPause)  btnPause.disabled  = !running;
    if (btnStop)   btnStop.disabled   = !running;
    if (btnReport) btnReport.disabled = running ? true : btnReport.disabled;
    if (!running && btnPause) btnPause.textContent = '⏸ Pause';
  }

  function updateStartButton() {
    if (btnStart) btnStart.disabled = contacts.length === 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROGRESS LISTENER
  // ══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'PROGRESS':
        updateProgress(msg.sent, msg.failed, msg.total);
        if (statusMsg) statusMsg.textContent = `📤 Sending to ${escHtml(msg.currentName)} (${msg.currentPhone})…`;
        if (msg.lastResult) {
          results.push(msg.lastResult);
          if (msg.lastResult.status === 'failed') appendErrorLog(msg.lastResult);
        }
        break;

      case 'BATCH_PAUSE': {
        const mins = Math.round(msg.waitMs / 60000);
        if (statusMsg) statusMsg.textContent = `⏱ Batch done. Auto-pausing ${mins} min…`;
        break;
      }

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

  // ══════════════════════════════════════════════════════════════════════════
  // ERROR LOG
  // ══════════════════════════════════════════════════════════════════════════

  function appendErrorLog(result) {
    if (!errorLogWrap || !errorLogBody) return;
    errorLogWrap.style.display = 'block';
    const code = result.errorCode || 'SEND_FAILED';
    const row  = document.createElement('div');
    row.className = 'error-log-row';
    row.innerHTML = `
      <span class="error-pill pill-${escHtml(code)}">${escHtml(code)}</span>
      <span class="error-log-phone">${escHtml(result.phone)}</span>
      <span class="error-log-reason">${escHtml(result.reason || '—')}</span>`;
    errorLogBody.appendChild(row);
  }

  function clearErrorLog() {
    if (errorLogWrap) errorLogWrap.style.display = 'none';
    if (errorLogBody) errorLogBody.innerHTML      = '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROGRESS BAR
  // ══════════════════════════════════════════════════════════════════════════

  function updateProgress(sent, failed, total) {
    const pct = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (statSent)    statSent.textContent    = `Sent: ${sent}`;
    if (statFailed)  statFailed.textContent  = `Failed: ${failed}`;
    if (statTotal)   statTotal.textContent   = `Total: ${total}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REPORT DOWNLOAD
  // ══════════════════════════════════════════════════════════════════════════

  function downloadReport() {
    if (results.length === 0) {
      if (statusMsg) statusMsg.textContent = 'No results to export yet.';
      return;
    }
    const rows = [
      ['Name', 'Phone', 'Status', 'Error Code', 'Reason'],
      ...results.map(r => [r.name, r.phone, r.status, r.errorCode || '', r.reason || '']),
    ];
    const csv  = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `wa_report_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KICK OFF — restore saved state
  // ══════════════════════════════════════════════════════════════════════════

  restoreAll();

}); // end DOMContentLoaded

// ── Utilities (module-level so they're available in template callbacks) ────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
function formatBytes(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
