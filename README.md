# Steam Multi-Account Management & Automation Tool

> A robust, professional-grade automation suite for Steam & C5Game asset management. Designed for high-frequency inventory synchronization, market automation, and multi-account security.

---

## 🌟 Core Features

- **Multi-Account Security**: Seamlessly manage hundreds of Steam accounts via `.maFile` (2FA/TOTP), session auto-refresh (LoginSecure), and password-secured API.
- **Inventory Transfer (Full-Auto)**: One-click "Store Transfer" logic. Automatically generates trade offers, confirms via sender's TOTP, accepts via recipient's session, and performs final TOTP acceptance.
- **High-Concurrency Confirmation**: Parallelized Steam trade/listing confirmation (Up to 10 threads) with **automatic password re-login self-healing** on token expiration.
- **Market Intelligence**: Precision price tracking using Steam Histogram (ItemNameID), C5 API integration, and real-time USD/CNY exchange rate synchronization.
- **Auto-Buy Engine**: Automated Steam market / C5 purchase orchestration with rule-based filtering and DingTalk ranking notifications (Ranking/Balance monitoring).
- **Enterprise-Grade Infrastructure**:
  - **MySQL 8.0+** Persistent storage with idempotent schema migration.
  - **Webshare Residential Proxies**: Smart routing per target (Steam/C5) + automatic IP rotation per request to bypass 429 rate limits.
  - **Puppeteer Integration**: Headless browser automation for red-flag (account ban) detection.

---

## 🛠️ Technology Stack

- **Frontend**: React 19 + Vite 8 (Vanilla CSS, No heavy UI frameworks)
- **Backend**: Node.js 22 (Express 5, MySQL2/Promise)
- **Security**: Steam-Session (LoginSession), Steam-TOTP, bcrypt-based auth
- **Automation**: Axios (with HTTPS Proxy Injection), Puppeteer-Core (Edge/Chrome)

---

## 🚀 Quick Start (Developers)

### 1. Prerequisites

- **Node.js**: Version 22+
- **MySQL**: 8.0 or 9.5 (Recommended)
- **Proxy Service**: A **Webshare** (Rotating Residential) account is highly recommended for stable Steam API access.
- **Python**: (Optional) 3.10+ for `steam_buy.py` logic.

### 2. Installation

Clone the repository and install dependencies for both backend and frontend:

```bash
# Install server dependencies
npm install

# Install client dependencies
cd client
npm install
cd ..
```

### 3. Configuration

#### a. Environment Variables
Copy `.env.example` to `.env` and configure your MySQL credentials:

```bash
cp .env.example .env
```

#### b. Application Settings
Copy `server/settings.example.json` to `server/settings.json` and configure your API keys, DingTalk Webhook, and Proxy details:

```bash
cp server/settings.example.json server/settings.json
```

**Key Configuration Items:**
- `adminPassword`: Used for the web interface and API calls (Bearer Auth).
- `webshare`: Your residential proxy credentials for bypassing Steam 429s.
- `youpinAuth`: Required for advanced fuzzy item search.

### 4. Running the Application

**One-click start (Windows):**
Execute `START_TOOL.ps1` via PowerShell. This will launch:
- The backend server (Port 3001)
- The frontend dev server (Port 5173 - Auto opens in browser)
- The watchdog process (Auto-restart on crash)

**Manual start:**
```bash
# Terminal 1: Backend
node server/index.js

# Terminal 2: Frontend
cd client
npm run dev
```

---

## 📁 Directory Structure

```text
├── client/                 # React SPA (Vite)
├── server/                 # Express Backend
│   ├── index.js            # Main API Controller (65+ routes)
│   ├── db.js               # MySQL Abstraction Layer
│   ├── fetchers.js         # Steam/C5 Business Logic
│   ├── python/             # Python-based automation scripts
│   └── scripts/            # CLI utilities (Migration, Auth)
├── START_TOOL.ps1          # Master Launcher
└── .gitignore              # Pre-configured for data multi-account safety
```

---

## 🔒 Security & Privacy

This tool handles sensitive Steam credentials. 
- **maFiles**: Store them in your local directory. They are explicitly ignored by `.gitignore` and never leave your machine.
- **Database**: All account session tokens (`steam_cookie`) and passwords are stored in your local MySQL instance.
- **脱敏 (Neutralization)**: Hardcoded secrets have been removed from the public codebase. Always use `settings.json` for private tokens.

---

## ⚠️ Common Pitfalls

1. **MySQL Initialization**: On first run, the app will automatically create tables in your database. Ensure the user in `.env` has `CREATE` permissions.
2. **Steam 429 (Rate Limit)**: If calls fail, verify your Webshare proxy configuration. Steam is extremely aggressive against data-center IPs.
3. **Puppeteer Path**: If browser automation fails, update `acc.browserPath` in the database or UI to match your local Edge/Chrome installation path.

---

## 📄 License
MIT License. **For educational and security research purposes only.** Use of this tool for automated trading must comply with Steam Subscriber Agreement.

---
*Last Updated: 2026-04-16*
