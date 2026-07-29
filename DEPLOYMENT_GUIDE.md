# ForMalli Deployment Guide

## Root cause of the mobile error

`localhost:5000` on a phone points to the phone, not the computer. The new frontend:

- Automatically uses `http://YOUR-PC-IP:5000` during LAN testing.
- Uses the Render HTTPS URL supplied through the Vercel `BACKEND_URL` environment variable in production.
- Uses Socket.IO polling first and upgrades to WebSocket, which is more reliable on mobile networks and Render.

## Local test

Backend:

```powershell
cd backend
npm install
npm start
```

Frontend (no dependency installation required):

```powershell
cd frontend
npm start
```

- Computer: `http://localhost:3000`
- Phone on the same Wi-Fi: `http://YOUR-PC-IP:3000`

The frontend automatically calls `http://YOUR-PC-IP:5000`.
Allow inbound TCP ports 3000 and 5000 in Windows Firewall.

### Local notification limitation

Chrome notifications require a secure context. They will not work from `http://10.x.x.x:3000` on a phone. Test notifications using the deployed Vercel `https://` URL. Localhost on the same device is the browser exception.

## Deploy backend to Render

Push this folder to a private GitHub repository. In Render, use the included `render.yaml`, or manually create a Web Service:

- Root Directory: `backend`
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/healthz`

Render environment variables:

```env
NODE_ENV=production
GREEN_PASSWORD=<new-green-password>
MALLI_PASSWORD=<new-malli-password>
SESSION_SECRET=<long-random-secret>
ALLOWED_ORIGINS=https://formalli.vercel.app
GOOGLE_MEET_URL=https://meet.google.com/crj-cusk-uds
ALLOW_VERCEL_PREVIEWS=false
```

After deployment, verify:

```text
https://YOUR-RENDER-SERVICE.onrender.com/healthz
```

It must return `status: ok`.

## Deploy frontend to Vercel

Import the same GitHub repository:

- Root Directory: `frontend`
- Build Command: `npm run build`
- Output Directory: `public`
- Framework Preset: Other

Add this Vercel Production environment variable:

```env
BACKEND_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

Never enter `localhost` in Vercel. Redeploy after adding the variable.

After Vercel gives the final domain, update Render:

```env
ALLOWED_ORIGINS=https://formalli.vercel.app
```

Then redeploy Render.

## Enable notifications on Android Chrome

On both phones:

1. Open the Vercel HTTPS URL in normal Chrome, not Incognito.
2. Log in.
3. Tap **Enable Notifications**.
4. Tap **Allow** in Chrome.
5. Confirm the immediate test notification.
6. Keep ForMalli open or running in the background.
7. From the other device, tap **I am online**.

If permission was blocked previously: Chrome -> Site settings -> Notifications -> select the Vercel site -> Allow.

### Notification scope

This build uses Socket.IO plus `ServiceWorkerRegistration.showNotification()`, which is the correct mobile notification API. It works while the ForMalli page is connected in the foreground or background. Receiving notifications after the browser/app is fully terminated requires a separate Web Push service with persistent push subscriptions.

## Video-call flow

1. Both users must show `Partner: Online`.
2. User A taps **Request Video**.
3. User B receives the Chrome/in-app notification and taps **Admit** or **Reject**.
4. After Admit, both see **Join Meet**.
5. Join opens `https://meet.google.com/crj-cusk-uds`.

## Final validation

- Both devices show `Chat: Connected`.
- Messages work in both directions.
- New messages always scroll above the input bar.
- Notifications are enabled on both devices from the Vercel HTTPS URL.
- Request Video -> Admit -> Join Meet works.

Rotate the passwords shown in earlier screenshots before production and keep the repository private.
