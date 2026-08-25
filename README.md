# Supermarket Price Matcher

Compares live product prices across Woolworths, Coles, and Aldi (Australia) for a
search term, matching equivalent products and highlighting the cheapest by unit
price (not just sticker price).

There are two ways to run it: as a **Chrome extension** (recommended, no Python
needed) or as a **local Python server**.

## Option 1: Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. Click the extension's icon in the toolbar to open the popup.
5. Type a product name (e.g. `milk 2l`) and press Enter or click **Search**.

The extension calls each retailer's site directly from your browser (using your
existing session/cookies), so results only work while you're online and the
retailer isn't blocking requests.

After changing any file, go back to `chrome://extensions` and click the refresh
icon on the extension's card to pick up the changes.

## Option 2: Local Python server

Use this if you'd rather browse to a page instead of installing the extension.

1. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
2. Start the server:
   ```
   python server.py
   ```
3. Open the printed URL: `http://127.0.0.1:8765/compare.html`
4. Type a product name and press Enter or click **Search**.

The server proxies requests to each retailer using `curl_cffi` (browser TLS
impersonation) to get past bot protection that would otherwise block plain
requests.

## Configuration

Edit `config.js` to enable/disable a retailer, e.g. if one is being blocked
by bot protection and you want to hide it from results:

```js
const RETAILER_CONFIG = {
    woolworths: { enabled: true, label: 'Woolworths' },
    coles: { enabled: true, label: 'Coles' },
    aldi: { enabled: true, label: 'Aldi' },
};
```

## Troubleshooting

- **A retailer shows a warning icon instead of a price**: that retailer's bot
  protection blocked the request. Try again later, or disable it in
  `config.js`.
- **"Fetching live supermarket data..." doesn't go away**: open the browser
  console (right-click the popup → Inspect → Console) to see the underlying
  error.
- **Extension changes don't seem to apply**: reload the extension from
  `chrome://extensions` after editing any file.

## Project files

| File | Purpose |
|---|---|
| `compare.html` | Main UI page (extension popup or server-served page) |
| `app.js` | Search logic, fetching, matching, and rendering |
| `config.js` | Per-retailer enable/disable toggles |
| `styles.css` | Styling |
| `manifest.json` | Chrome extension (Manifest V3) configuration |
| `server.py` | Optional local proxy server (bypasses CORS/bot protection) |
| `requirements.txt` | Python dependencies for `server.py` |
