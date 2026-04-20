# WA Bulk Sender Pro — Chrome Extension

A bulk WhatsApp message sender operating on `web.whatsapp.com`.
Built with Vanilla JS (ES6), Manifest V3.

---

## Directory Structure

```
whatsapp-bulk-sender/
├── manifest.json        ← Extension manifest (MV3)
├── popup.html           ← Extension popup UI
├── popup.js             ← Popup logic: file parsing, UI state, progress
├── background.js        ← Service worker: campaign orchestration, delays, batching
├── content.js           ← DOM automation on web.whatsapp.com
├── icons/
│   ├── icon16.png       ← You must supply these (16×16 px)
│   ├── icon48.png       ← (48×48 px)
│   └── icon128.png      ← (128×128 px)
└── README.md
```

---

## Setup Instructions

### 1. Add Icons
Place three PNG icon files in the `icons/` folder:
- `icon16.png`  (16×16)
- `icon48.png`  (48×48)
- `icon128.png` (128×128)

You can use any WhatsApp-style green icon, or generate free ones at https://favicon.io

### 2. Load the Extension in Chrome
1. Open Chrome → `chrome://extensions/`
2. Toggle **Developer mode** ON (top-right)
3. Click **"Load unpacked"**
4. Select the `whatsapp-bulk-sender/` folder
5. The extension icon will appear in your toolbar

### 3. Prepare Your Contacts CSV
Create a CSV with **exactly** these two columns:

```csv
Name,Phone
Alice,919876543210
Bob,14155551234
Charlie,447911123456
```

> **Phone Format:** Include the country code digits (no + or spaces).
> e.g., India: `919876543210`, US: `14155551234`, UK: `447911123456`

Excel (.xlsx) is also supported — same column names required.

### 4. Use the Extension
1. Open **https://web.whatsapp.com** and scan QR to log in
2. Click the extension icon to open the popup
3. Upload your CSV/Excel file
4. Type your message (use `{{Name}}` for personalization)
5. Adjust anti-ban settings if needed
6. Click **▶ Start**

---

## Anti-Ban Settings Explained

| Setting      | Default | Description |
|-------------|---------|-------------|
| Min Delay    | 15 sec  | Minimum wait between messages |
| Max Delay    | 30 sec  | Maximum wait (random between min–max) |
| Batch Size   | 50      | Messages per batch |
| Batch Pause  | 10 min  | Auto-pause duration after each batch |

> ⚠️ **Use responsibly.** WhatsApp may restrict or ban accounts that send
> bulk messages. These delays reduce but do not eliminate that risk.

---

## Message Variables

| Variable   | Replaced With |
|-----------|---------------|
| `{{Name}}`  | Contact's name from the CSV |
| `{{Phone}}` | Contact's phone number |

**Example:**
```
Hi {{Name}}! We have a special offer just for you. Reply to this message to claim it.
```

---

## Report Download

After the campaign finishes (or is stopped), click **⬇ Download Report CSV**.

The report includes:
- Name
- Phone
- Status (`sent` / `failed`)
- Reason (for failures)

---

## How It Works (Technical)

```
Popup → background.js → chrome.tabs.update (navigate to wa.me URL)
                      → content.js detects URL change
                      → Waits for React DOM to render
                      → Injects text via execCommand (React-safe)
                      → Clicks Send button
                      → Reports SEND_RESULT back to background.js
                      → background.js applies random delay
                      → Moves to next contact
```

### Why `execCommand` for text injection?
WhatsApp Web is a React app. React tracks input state via synthetic events.
Setting `element.textContent = text` directly bypasses React's event system —
the Send button stays disabled. Using `document.execCommand('insertText')`
fires a native browser input event that React intercepts, updating its
internal state and enabling the Send button.

---

## Limitations & Known Issues

- **QR Login Required:** WhatsApp Web must be logged in before starting.
- **Phone Format:** Numbers must include country code (no `+`).
- **Rate Limits:** WhatsApp may still flag accounts. Use conservatively.
- **DOM Changes:** If WhatsApp updates their DOM structure, selectors
  in `content.js` may need updating (see the `INPUT_SELECTORS` array).
- **Single Tab:** Only operates on the first open WhatsApp Web tab.
