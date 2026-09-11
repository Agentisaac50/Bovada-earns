# Bovada Earns

A modern web application for smart earnings, bike rental packages, and investments.

## Features

- User registration & login (phone + password)
- Bike rental packages with daily returns
- **Automatic deposits via MarzPay (MTN & Airtel Mobile Money)**
- Deposit fee: **5%** · Minimum deposit: **10,000 UGX**
- Withdrawal system
- Referral system
- Admin dashboard
- Real-time data sync with Supabase (optional)
- LocalStorage fallback for offline use

## Requirements

- Node.js 18 or higher (no extra packages needed)

## Installation

```bash
cd bovada-earns
```

No `npm install` required – the server uses only built-in Node.js modules.

## Running the App

```bash
npm start
# or simply:
node server.js
```

Then open your browser at: **http://localhost:3000**

## MarzPay Integration

Payments are fully automatic:

1. User enters amount (≥ 10,000 UGX) and Mobile Money number.
2. Server calls MarzPay `/collect-money` → customer receives USSD/prompt.
3. After approval, webhook (or status polling) marks the deposit completed.
4. **Net amount (after 5% fee) is credited to the user’s balance automatically.**

### API Endpoints (server)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/deposit/initiate` | Start a collection |
| GET | `/api/deposit/status/:reference` | Poll status |
| POST | `/api/marz/webhook` | MarzPay callback |

Credentials are stored server-side only (never exposed to the browser).

For production webhooks, expose the server publicly (or use a tunnel such as ngrok) so MarzPay can reach `/api/marz/webhook`.

## Default Admin Account

- **Phone:** `707256946`
- **Password:** `2005`

## Project Structure

```
bovada-earns/
├── package.json
├── server.js          # Native Node.js HTTP server + MarzPay
├── data/              # Pending deposits store (created at runtime)
├── public/
│   └── index.html     # Full frontend application (SPA)
└── README.md
```

## Notes

- The app primarily uses **localStorage** for data persistence.
- Supabase integration is included for cloud sync.
- All bike images and styles are loaded from external CDNs.
- Zero external npm dependencies – pure Node.js.

## Scripts

| Command       | Description                |
|---------------|----------------------------|
| `npm start`   | Start the server           |
| `node server.js` | Same as above           |

## License

MIT
