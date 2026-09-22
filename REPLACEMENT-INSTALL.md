# Ripon Offline App — Complete Replacement Package

This ZIP is a replacement package for the existing `ripon-offline-app` architecture.

## 1. GitHub replacement

Replace/add these files in the repository:

- `.github/workflows/pages.yml`
- `package-lock.json`
- `package.json`
- `build.mjs`
- `tests/`
- `web/`
- `apps-script/`

Do not delete the repository's `.git` directory.

## 2. GitHub Pages

Repository → Settings → Pages → Source: **GitHub Actions**.

Then commit the replacement files to the `main` branch.

The workflow uses Node.js 24 and an actual `package-lock.json`, so `setup-node` can safely use npm caching and `npm ci`.

## 3. Google Apps Script

Open the Apps Script project connected to the Google Sheet.

Replace/add:

- `Code.gs`
- `Barcode.gs`
- `Api.gs`
- `Index.html`
- `appsscript.json` (manifest; if Apps Script UI does not allow direct replacement, copy the settings manually)

Then run `setupDatabase()` once from the Apps Script editor.

For existing products, run `generateBarcodes()` once. It creates PNG barcode files in Drive and records their IDs/URLs in the Products sheet.

## 4. Deploy Apps Script Web App

Deploy → New deployment → Web app.

Recommended access for a private store should be restricted where possible. If the frontend is intended to call the web app without Google login, use the access setting required by your deployment/security model.

After deployment, put the Web App `/exec` URL into the app's API/settings configuration if your current configuration requires it.

## 5. Important

The GitHub Pages workflow and the Apps Script backend are separate deployments:

- GitHub Pages = frontend/offline PWA build.
- Apps Script = Google Sheets/Drive backend and online synchronization.

The automated test suite must pass before Pages deployment proceeds.
