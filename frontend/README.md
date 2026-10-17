# DayCast frontend

React + Vite frontend for DayCast.

```bash
npm ci
npm run dev
```

## Production PWA

```bash
npm run build
npm run preview
```

Deploy `dist/` at the site root over HTTPS. `vite-plugin-pwa` generates
`manifest.webmanifest`, registers `/sw.js`, and precaches the app shell. The
manifest uses standalone mode, DayCast naming, and root start URL/scope. Opaque
192px/512px PNG icons, a maskable Android icon, and a 180px Apple touch icon ship
in `public/`. iOS standalone metadata is in `index.html`.

On iPhone, open the deployed site in **Safari**, tap **Share → Add to Home
Screen**, then open DayCast from its icon. iOS does not offer Chrome's automatic
installation prompt. On Android Chrome, use **Install app / Add to Home screen**
from the browser menu when available. Browser installation UI varies by version.

Use a production build to verify installation; the service worker is not enabled
in the Vite development server. In browser developer tools, check the manifest,
icons, and active service worker; reload once and test the cached shell offline.
Weather fetching and Daily Plan requests remain network-only and require the
backend to be online. Offline app-shell availability does not provide offline
forecasts or advice. No push notifications are registered.

Updates wait until existing DayCast windows are closed and the app is reopened,
so they do not automatically reload an activity form in progress. For a deploy
check, close all tabs and standalone windows before reopening. Physical iPhone
and Android installation should be checked on the deployed HTTPS site.
