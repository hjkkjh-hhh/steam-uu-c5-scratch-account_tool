const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');

// --- Global Timestamp Logger Overrides ---
const formatTimestamp = () => {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${h}时${m}分`;
};

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => originalLog(`[${formatTimestamp()}]`, ...args);
console.warn = (...args) => originalWarn(`[${formatTimestamp()}]`, ...args);
console.error = (...args) => originalError(`[${formatTimestamp()}]`, ...args);

// Expose original log without timestamp for subsequent search lines
console.directLog = originalLog;
const {
    fetchSteamPrice,
    fetchSteamItemPrice,
    fetchCheapestListing,
    executeSteamBuy,
    fetchSteamSeries,
    fetchYoupinSeries,
    translateChineseToEnglish,
    fetchMyActiveListings,
    removeSteamListing,
    fetchSteamItemImage,
    steamRequest,
    prepareCookieHeader,
    currencyConfig,
    updateGlobalExchangeRate,
    fetchC5GamePriceBatch,
    fetchC5GameSearch,
    // C5 Merchant Operation APIs
    fetchC5Balance,
    fetchC5Inventory,
    fetchC5Listings,
    c5ListItem,
    c5QuickBuy,
    c5ModifyPrice,
    c5Delist,
    fetchC5SteamInfo,
    bindC5SteamAccount,
    fetchTradeUrlFromCookie,
    parseMaFile,
    steamRefreshSession,
    logToAutoBuyFile,
    getProxyAgent,
} = require('./fetchers');

/**
 * 创建带代理的 LoginSession（用于 RefreshToken 刷新 Web Cookie）
 * steam-session 默认直连会被 TLS 环境阻断，必须通过代理
 */
function makeLoginSession() {
    const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
    const proxyUrl = getProxyAgent('https://steamcommunity.com');
    const opts = {};
    if (proxyUrl) opts.httpProxy = proxyUrl;
    return new LoginSession(EAuthTokenPlatformType.WebBrowser, opts);
}

/** 给任意 Promise 加超时保护（ms），超时抛出带 label 的 Error */
const withTimeout = (promise, ms, label) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 (${ms/1000}s)`)), ms))]);

const db = require('./db');
const puppeteer = require('puppeteer-core');

const app = express();
const BUILD_ID = "steam-uu-hjk-v1.0";
const PORT = process.env.PORT || 3001;

const LOGS_DIR = path.join(__dirname, 'logs');
const AUTO_BUY_LOG = path.join(LOGS_DIR, 'auto_buy.log');
const TRANSFER_LOG = path.join(LOGS_DIR, 'transfer.log');
const CONFIRM_LOG  = path.join(LOGS_DIR, 'confirm.log');

/** 
 * 通用日志写入函数
 * @param {string} logPath 文件路径
 * @param {string} message 消息内容
 */
async function writeLog(logPath, message) {
    try {
        if (!require('fs').existsSync(LOGS_DIR)) require('fs').mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        require('fs').appendFileSync(logPath, `[${ts}] ${message}\n`);
    } catch (err) {
        originalError(`[日志系统] 写入 ${logPath} 失败: ${err.message}`);
    }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
let isPurchaseInProgress = false;

// Startup: run migration if DB is new, then clean stale listings
(async () => {
    try {
        // Init MySQL schema (idempotent CREATE TABLE IF NOT EXISTS)
        await db.initSchema();

        // Seed C5Game API key from settings if not already in DB
        const existingKey = await db.getSetting('c5gameApiKey');

        if (!existingKey) {
            console.warn('⚠️ 警告: c5gameApiKey 和 c5gameAppSecret 尚未配置！请在环境或界面中配置。');
        }

        const cleaned = await db.cleanStaleListings();
        if (cleaned > 0) console.log(`[启动] 已清理 ${cleaned} 条过期失效挂单记录。`);
    } catch (e) {
        console.error('[启动] DB 初始化异常:', e.message);
    }
})();

// Initial Exchange Rate Sync
(async () => {
    console.log(`[启动] 正在进行初始汇率同步...`);
    await updateGlobalExchangeRate();
})();

// Daily Exchange Rate Sync Timer (24 hours)
setInterval(async () => {
    console.log(`[周期任务] 执行每日汇率同步...`);
    await updateGlobalExchangeRate();
}, 24 * 60 * 60 * 1000);

// All history is now loaded from SQLite by db.js on demand.

async function writeBoughtHistory() {
    // No-op: db writes are immediate in db.setBoughtHistoryEntry
}

async function markListingAsStale(listingId) {
    if (!listingId) return;
    await db.markListingAsStale(listingId);
}

// --- Persistent Logging Helper ---
// Moved to fetchers.js to resolve circular/module reference errors.

// --- Authentication Middleware ---
app.use(async (req, res, next) => {
    // Exclude specific public routes and preflight
    if (req.method === 'OPTIONS' || req.path.startsWith('/api/dingtalk') || req.path.startsWith('/api/auth/login')) {
        return next();
    }

    // Only protect /api routes, let static file serving pass
    if (!req.path.startsWith('/api/')) {
        return next();
    }

    try {
        const settings = await readSettings();
        const pwd = settings.adminPassword;
        // If password is not set in DB, allow all requests
        if (!pwd || pwd.trim() === "") return next();

        // Check for authorization header (case-insensitive keys handled by Express/Node)
        const authHeader = req.headers.authorization || req.headers['Authorization'];
        if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
            const headerKeys = Object.keys(req.headers).join(', ');
            console.warn(`[认证] 缺失 Authorization 头: ${req.method} ${req.path} (现有 Header: ${headerKeys})`);
            return res.status(401).json({ error: '未授权：需要身份标' });
        }

        const token = authHeader.split(' ')[1];
        if (token !== pwd) {
            console.warn(`[认证] 提供的密码不正确: ${req.path}`);
            return res.status(401).json({ error: '未授权：密码错误' });
        }

        next();
    } catch (e) {
        console.error('[认证] 错误:', e);
        res.status(500).json({ error: '认证过程中服务器内部错误' });
    }
});

// --- Global Shared Variables ---
let currentBackgroundCNYAccountName = '132'; // Sticky priority account for sampling

// --- Global Helpers for Item Grouping ---
const getItemBaseName = (item) => {
    if (!item) return '';
    let base = (item.name || item.hashName || '');

    // For Stickers/Patches/Agents, we want more precise grouping
    const isSticker = base.includes('印花') || base.includes('Sticker');

    base = base
        .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
        .replace(/\s*[（\(].*?[）\)]\s*$/, '');

    if (isSticker) {
        return base.trim();
    }

    // Improved tournament detection for other items: prioritize Chinese then English
    const tournamentMatch = base.match(/\d{4}年.*?锦标赛/);
    if (tournamentMatch) return tournamentMatch[0];
    const englishMatch = base.match(/[A-Z][a-z]+ \d{4}/);
    if (englishMatch) return englishMatch[0];

    // Handle cases/capsules
    if (base.toLowerCase().includes('case') || base.toLowerCase().includes('capsule')) {
        base = base.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
    }
    return base.trim();
};

const getGroupKey = getItemBaseName;

const getEnglishGroupKey = (hashName) => {
    if (!hashName) return '';
    let base = hashName;

    const isSticker = base.includes('Sticker');

    base = base
        .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
        .replace(/\s*[（\(].*?[）\)]\s*$/, '');

    if (isSticker) {
        return base.trim();
    }

    // Improved tournament detection: prioritize English then Chinese
    const englishMatch = base.match(/[A-Z][a-z]+ \d{4}/);
    if (englishMatch) return englishMatch[0];
    const tournamentMatch = base.match(/\d{4}年.*?锦标赛/);
    if (tournamentMatch) return tournamentMatch[0];
    if (base.toLowerCase().includes('case') || base.toLowerCase().includes('capsule')) {
        base = base.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
    }
    return base.trim();
};

// --- Robust Price Fetching Helper (Precise Search with account switching) ---
async function fetchSteamPriceRobust(marketHashName, currency = 23, preferredCookie = '') {
    const accounts = await readAccounts();
    const tryFetch = async (cookie) => {
        // Step 1: Try Cheapest Listing (Precise Search)
        let listing = await fetchCheapestListing(marketHashName, currency, cookie).catch(() => null);
        if (listing && listing.total > 0) return listing;

        // Step 2: Try Item Price Overview (Histogram)
        const stObj = await fetchSteamItemPrice(marketHashName, currency, cookie).catch(() => null);
        if (stObj && stObj.lowest_price) {
            return {
                priceText: stObj.lowest_price,
                total: Math.round(parseFloat(stObj.lowest_price.replace(/[^\d.]/g, '')) * 100)
            };
        }
        return null;
    };

    // 1. Try with preferred cookie (usually the active session's account)
    let result = await tryFetch(preferredCookie);
    if (result) return result;

    // 2. If CNY, try with background accounts
    if (currency === 23) {
        let accPrimary = accounts.find(a => a.name === currentBackgroundCNYAccountName);
        if (accPrimary && accPrimary.steamCookie && accPrimary.steamCookie !== preferredCookie) {
            result = await tryFetch(accPrimary.steamCookie);
            if (result) return result;
        }

        // 3. Switch account and retry
        const backupName = (currentBackgroundCNYAccountName === '132' ? '133' : '132');
        let accBackup = accounts.find(a => a.name === backupName);
        if (accBackup && accBackup.steamCookie) {
            console.warn(`[RobustFetch] 账户 ${currentBackgroundCNYAccountName} 采集失败，尝试切换至 ${backupName}...`);
            currentBackgroundCNYAccountName = backupName;
            await new Promise(r => setTimeout(r, 1000));
            result = await tryFetch(accBackup.steamCookie);
            if (result) return result;
        }
    }

    return null;
}

// --- Auth Routes ---
app.post('/api/auth/login', async (req, res) => {
    const { password } = req.body;
    try {
        const settings = await readSettings();
        if (!settings.adminPassword || password === settings.adminPassword) {
            res.json({ success: true });
        } else {
            res.status(401).json({ error: 'Incorrect password' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Account Helpers
 */
async function readAccounts() {
    return await db.readAccounts();
}

async function writeAccounts(accounts) {
    await db.writeAccounts(accounts);
}
/**
 * Concurrency & File Utilities
 */
const fileWriteQueues = new Map();

async function safeWrite(filePath, data) {
    if (!fileWriteQueues.has(filePath)) {
        fileWriteQueues.set(filePath, Promise.resolve());
    }

    // Chain the new write operation onto the existing promise for this file
    const nextWrite = fileWriteQueues.get(filePath).then(async () => {
        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[SafeWrite] Error writing to ${filePath}:`, e.message);
        }
    });

    fileWriteQueues.set(filePath, nextWrite);
    return nextWrite;
}

/**
 * Specialized helper to always use a China-region account (Account 132) 
 * for CNY price requests.
 */
async function getCNYCookie() {
    try {
        const settings = await readSettings();
        const accounts = await readAccounts();

        // 终极优先级：首先尝试当前已知的“工作状态（Sticky）”账号
        const preferredNames = [currentBackgroundCNYAccountName, (currentBackgroundCNYAccountName === '132' ? '133' : '132')];
        for (const name of preferredNames) {
            const acc = accounts.find(a => a.name === name);
            if (acc && acc.steamCookie) return acc.steamCookie;
        }

        // 备份：settings.json 里的 cookie
        if (settings.steamCookie) {
            return settings.steamCookie;
        }

        // 最后兜底：任何非美元余额的账号
        const accCNY = accounts.find(a => (a.steamCookie && !a.balance?.includes('$')));
        if (accCNY && accCNY.steamCookie) {
            return accCNY.steamCookie;
        }

        return '';
    } catch (e) {
        return '';
    }
}

/**
 * Specialized helper to find a USD-region account for USD price requests.
 */
async function getUSDCookie() {
    try {
        const settings = await readSettings();
        const accounts = await readAccounts();
        const accUSD = accounts.find(a => a.name === '134' || (a.steamCookie && a.balance?.includes('$')));
        if (accUSD && accUSD.steamCookie) {
            return accUSD.steamCookie;
        }
        // Fallback to any account with a cookie if no explicit USD account is found
        const anyAcc = accounts.find(a => a.steamCookie);
        return anyAcc ? anyAcc.steamCookie : (settings.steamCookie || '');
    } catch (e) {
        return '';
    }
}

/**
 * Settings Helpers
 */
async function readSettings() {
    return await db.readSettings();
}

async function writeSettings(settingsPartial) {
    // Read current, merge, write
    const current = await db.readSettings();
    await db.writeSettings({ ...current, ...settingsPartial });
}

/**
 * Translate Steam error messages to Chinese
 */
function translateSteamError(msg) {
    if (!msg) return '上架尝试失败，Steam 拒绝了请求';
    const s = msg.toLowerCase();

    if (s.includes('already on the market')) return '该饰品已在市场上架中';
    if (s.includes('mobile steam app') || s.includes('pending confirmation'))
        return '⚠️ 您在手机 Steam App 上对此饰品已有待处理的确认请求，请先前往确认或取消后再重试。';
    if (s.includes('higher than the maximum')) return '价格无效：超过了 Steam 允许的最高价格上限';
    if (s.includes('inventory has not yet rolled over')) return 'Steam 库存同步出现延迟，请稍后刷新重试';
    if (s.includes('exceeded the number of items') || s.includes('listing limit'))
        return '⚠️ 账号上架数量已达上限（或库存已满），请清理后再试。';
    if (s.includes('session') || s.includes('login')) return '❌ 登录会话已过期，请重新同步账号 Cookie';
    if (s.includes('rate limit') || s.includes('busy')) return '⏳ 操作过于频繁，Steam 正在限制请求，请稍候再试';
    if (s.includes('problem listing your item')) return '❌ 上架失败：Steam 响应异常。请尝试在“管理账号”页面点击“同步”刷新 Cookie 后重试。';

    return msg;
}

// --- Synchronization Locking & Helpers ---
let globalRateLimitEnd = 0; // Timestamp when rate limit cooling ends
const activeSyncs = new Set(); // Set of account IDs currently syncing

/**
 * Targeted Kill: Only kill browser processes using a specific profile/user-data-dir
 */
/**
 * Targeted Kill: Only kill browser processes using a specific profile/user-data-dir
 * Verifies lock release before returning.
 */
async function killProcessesUsingProfile(userDataDir, browserType, profileName, accountName) {
    if (!userDataDir) return 0;

    const isFirefox = browserType === 'firefox';
    const profileFolder = profileName || 'Default';

    // Stage 1: Robust process killing
    const performKill = async () => {
        return new Promise((resolve) => {
            // Using wmic /format:csv to guarantee full command lines without truncation
            exec('wmic process where "name=\'msedge.exe\' or name=\'chrome.exe\' or name=\'firefox.exe\'" get commandline,processid /format:csv', (err, stdout) => {
                if (err || !stdout) return resolve(0);

                const lines = stdout.split('\n');
                const toKill = [];
                const normalizedDir = userDataDir.toLowerCase().replace(/[\\\/]$/, '');

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    // Format: Node,CommandLine,ProcessId
                    const lowerLine = line.toLowerCase();
                    if (lowerLine.includes(normalizedDir)) {
                        const match = line.match(/,?(\d+)$/);
                        if (match) toKill.push(match[1]);
                    }
                }

                if (toKill.length === 0) return resolve(0);

                // Batch kill PIDs
                const killCmd = `taskkill /F ${toKill.map(pid => `/PID ${pid}`).join(' ')} /T`;
                exec(killCmd, () => resolve(toKill.length));
            });
        });
    };

    let killedCount = await performKill();

    // Stage 2: Lock File Cleanup
    try {
        if (!isFirefox) {
            const filesToClean = [
                'SingletonLock', 'lockfile', 'Web Data', 'Web Data-journal',
                path.join(profileFolder, 'LOCK'),
                path.join(profileFolder, 'Web Data'),
                path.join(profileFolder, 'Web Data-journal')
            ];
            for (const f of filesToClean) {
                await fs.unlink(path.join(userDataDir, f)).catch(() => { });
            }
        } else {
            await fs.unlink(path.join(userDataDir, 'parent.lock')).catch(() => { });
        }
    } catch (e) { }

    // Stage 3: Verification (Mandatory Lock Check)
    const verifyLock = async () => {
        if (isFirefox) return true; // Firefox is slightly different
        const cookieFile = path.join(userDataDir, profileFolder, 'Network', 'Cookies');
        try {
            // Check if file exists first
            await fs.access(cookieFile);
            // Try to open it with write access to verify lock is gone
            const fh = await fs.open(cookieFile, 'r+');
            await fh.close();
            return true;
        } catch (e) {
            // If file doesn't exist, it's "free"
            if (e.code === 'ENOENT') return true;
            return false;
        }
    };

    // Retry verification once if failed
    let isFree = await verifyLock();
    if (!isFree && killedCount > 0) {
        await new Promise(r => setTimeout(r, 500));
        killedCount += await performKill();
        isFree = await verifyLock();
    }

    if (killedCount > 0) {
        console.log(`[隔离环境] 已清理 ${accountName || userDataDir} 的占用进程 (${killedCount} 个)，锁定状态: ${isFree ? '已释放' : '未能完全释放'}`);
    }

    return killedCount;
}

/**
 * Helper to display USD balances with CNY conversion
 */
function enhanceWalletDisplay(balanceStr) {
    if (!balanceStr || !balanceStr.includes('$')) return balanceStr;

    try {
        const rate = currencyConfig.USD_TO_CNY || 7.25; // Fallback to a reasonable rate if not synced

        // Extract main balance and pending balance
        // Format: "$0.15 (待处理: $0.05)" or just "$0.15"
        const mainMatch = balanceStr.match(/\$([\d.]+)/);
        const pendingMatch = balanceStr.match(/(?:Pending|待处理|待入账)[:：]?\s*\$([\d.]+)/i);

        let result = balanceStr;

        if (mainMatch) {
            const usd = parseFloat(mainMatch[1]);
            const cnyValue = (usd * rate).toFixed(2);
            // Replace the first occurrence of the USD amount with USD(CNY)
            result = result.replace(mainMatch[0], `${mainMatch[0]}(￥${cnyValue})`);
        }

        if (pendingMatch) {
            const usdPending = parseFloat(pendingMatch[1]);
            const cnyPending = (usdPending * rate).toFixed(2);
            // Replace the pending part
            result = result.replace(pendingMatch[0], `待处理(￥${cnyPending})`);
        }

        return result;
    } catch (e) {
        return balanceStr;
    }
}

/**
 * DingTalk Notification
 */
// Server-side deduplication: hashName -> lastAlertedPrice (number)
const lastAlertedPrices = new Map(); // hashName -> last alerted youpin price
const lastAlertedRatios = new Map(); // hashName -> last alerted ratio

let globalPushRankingItems = null; // Store last pushed ranking ( {type: 'CASH'|'TOPUP', items: []} )
let lastPushInventoryMatches = []; // Store inventory matches for the last push ( {accId, accName, hashName, displayName, count, assetIds, priceText} )
let lastRankingPushType = 'TOPUP'; // For alternating pushes (initial 'TOPUP' means first push is 'CASH')
let pushRankingTimer = null;

/**
 * DingTalk Bot Instance
 */
const dingTalkBot = {
    send: async (payload) => {
        try {
            const settings = await readSettings();
            const webhook = settings.dingTalkWebhook;
            const secret = settings.dingTalkSecret;
            if (!webhook) return;

            let url = webhook;
            if (secret) {
                const timestamp = Date.now();
                const stringToSign = `${timestamp}\n${secret}`;
                const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
                url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
            }

            await axios.post(url, payload, { timeout: 15000 });
        } catch (e) {
            console.error('[钉钉机器人] 发送失败:', e.message);
        }
    }
};

async function pushRankingToDingTalk(forcedType = null) {
    console.log(`[排行榜推送] 正在从追踪物品中获取排行榜${forcedType ? ` (强制执行: ${forcedType})` : ''}...`);
    try {
        const settings = await readSettings();
        // If forced, we ignore the enabled flags for the check but still need settings for thresholds
        if (!forcedType && !settings.pushRankingEnabled && !settings.pushTopUpEnabled) return;

        const items = await readTracked();
        if (!items || items.length === 0) {
            console.log('[排行榜推送] 未找到需要推送的追踪物品。');
            return;
        }

        // Determine which ranking type to push now
        let targetType = forcedType;
        if (!targetType) {
            if (settings.pushRankingEnabled && settings.pushTopUpEnabled) {
                targetType = (lastRankingPushType === 'CASH') ? 'TOPUP' : 'CASH';
            } else if (settings.pushRankingEnabled) {
                targetType = 'CASH';
            } else if (settings.pushTopUpEnabled) {
                targetType = 'TOPUP';
            }
        }

        if (!targetType) return;

        console.log(`[排行榜推送] 本次推送选定类型: ${targetType}`);

        if (targetType === 'CASH') {
            // --- Step 1: Simulate Web UI Leaderboard (Simulation) ---
            const webSimulation = items.filter(i => {
                const cnyStr = i.steamPrices && i.steamPrices.CNY ? String(i.steamPrices.CNY) : '';
                const hasCny = cnyStr.includes('¥') && !cnyStr.includes('$');
                const hasYoupin = i.lastC5Price && i.lastC5Price !== 'N/A';
                if (!hasCny || !hasYoupin) return false;

                // Exclusion logic: skip if item or collection is excluded via Web UI
                if (i.excludeFromRanking) return false;

                // Price range filter (Synced with Web UI)
                const price = parseFloat(i.lastC5Price);
                if (settings.rankingMinPrice && price < parseFloat(settings.rankingMinPrice)) return false;
                if (settings.rankingMaxPrice && price > parseFloat(settings.rankingMaxPrice)) return false;

                const steamVal = parseFloat(cnyStr.replace(/[^\d.]/g, ''));
                if (isNaN(steamVal) || steamVal <= 0) return false; // Ghost listing filter

                return true;
            }).map(item => {
                const steamVal = parseFloat(String(item.steamPrices.CNY).replace(/[^\d.]/g, ''));
                const youpinVal = parseFloat(item.lastC5Price || 0);
                const ratio = (youpinVal / steamVal).toFixed(3);
                return {
                    ...item,
                    calculatedRatio: parseFloat(ratio),
                    ratioDisplay: ratio
                };
            });

            // Ranked according to Web UI CASH rules: Descending
            webSimulation.sort((a, b) => b.calculatedRatio - a.calculatedRatio);

            // --- Step 2: Take Web UI Top 5 and apply Push Ratio Threshold ---
            const top5FromWeb = webSimulation.slice(0, 5);
            const rankedItems = top5FromWeb.filter(item =>
                item.calculatedRatio >= (settings.pushRankingCashThreshold || 0.87)
            );

            if (rankedItems.length > 0) {
                // 现金榜 (Cash Ranking): Large to Small (Descending)
                rankedItems.sort((a, b) => b.calculatedRatio - a.calculatedRatio);
                const topItems = rankedItems.slice(0, 5);
                globalPushRankingItems = { type: 'CASH', items: topItems };

                let textLines = [];
                for (let idx = 0; idx < topItems.length; idx++) {
                    const item = topItems[idx];
                    textLines.push(`### ${idx + 1}. ${item.name || item.hashName}\n- **C5底价**: ¥ ${item.lastC5Price}\n- **Steam 价**: ${item.steamPrices.CNY}\n- **换现金比例**: ${item.ratioDisplay}`);
                }

                await dingTalkBot.send({
                    msgtype: "markdown",
                    markdown: {
                        title: "🚀 现金榜 (大→小) TOP 5",
                        text: `## 🚀 现金榜 (大→小) TOP 5\n\n---\n\n${textLines.join('\n\n---\n\n')}`
                    }
                });

                // --- AUTO BUY LOGIC ---
                if (settings.autoBuyEnabled && topItems.length > 0) {
                    (async () => {
                        try {
                            const bestItem = topItems[0];
                            const threshold = settings.autoBuyRatio || 0.87;
                            if (bestItem.calculatedRatio >= threshold) {
                                isPurchaseInProgress = true; // Set flag
                                logToAutoBuyFile(`🚀 触发购买: "${bestItem.name || bestItem.hashName}" (比例: ${bestItem.ratioDisplay} >= ${threshold})`);
                                try {
                                    const accounts = await readAccounts();
                                    const checkCookie = accounts.length > 0 ? accounts[0].steamCookie : '';

                                    const dedupeEnabled = settings.autoBuyDedupeEnabled !== false;
                                    const dedupeHours = settings.autoBuyDedupeHours || 6;

                                    const category = getItemBaseName(bestItem);
                                    const now = Date.now();
                                    const lockTime = dedupeHours * 60 * 60 * 1000;
                                    const boughtItemHistory = await db.getBoughtHistory();

                                    if (dedupeEnabled && boughtItemHistory[category]) {
                                        const lastBought = new Date(boughtItemHistory[category]).getTime();
                                        if (now - lastBought < lockTime) {
                                            const remaining = Math.round((lockTime - (now - lastBought)) / (60 * 60 * 1000));
                                            logToAutoBuyFile(`跳过 "${bestItem.hashName}" - 品类 "${category}" 近期已处理 (剩余锁定: ${remaining}h)。`);
                                            return;
                                        } else {
                                            delete boughtItemHistory[category];
                                        }
                                    }

                                    const failedIds = await db.getAllStaleListingIds();
                                    const cheapest = await fetchCheapestListing(bestItem.hashName, 23, checkCookie, failedIds);
                                    if (cheapest) {
                                        if (cheapest.currency !== 23 || (cheapest.priceText && cheapest.priceText.includes('$'))) {
                                            logToAutoBuyFile(`⚠️ 检测到非人民币挂单 (${cheapest.priceText})，已取消自动购买。`, 'warn');
                                            return;
                                        }

                                        const realSteamCNY = cheapest.total / 100;
                                        const youpinVal = parseFloat(bestItem.lastC5Price);
                                        const realTimeRatio = (realSteamCNY > 0) ? (youpinVal / realSteamCNY) : 999;

                                        logToAutoBuyFile(`实时校验: 悠悠 ¥${youpinVal} / Steam ¥${realSteamCNY.toFixed(2)} = 比例 ${realTimeRatio.toFixed(3)}`);

                                        if (realTimeRatio > 2.0) {
                                            logToAutoBuyFile(`❌ 严重异常: 检测到比例 ${realTimeRatio.toFixed(3)} (> 2.0)，饰品可能不匹配，已中止。`, 'error');
                                            return;
                                        }

                                        if (realTimeRatio >= threshold) {
                                            logToAutoBuyFile(`✅ 实时比例符合预期。正在寻找余额充足的账号... (挂单ID: ${cheapest.listingId})`);

                                            let stopConditionReached = false;
                                            let currentCheapest = cheapest; // Initial cheapest listing
                                            let itemRefreshCount = 0;
                                            const MAX_ITEM_REFRESHES = 15; // Total unique items to try for this sync cycle

                                            while (itemRefreshCount <= MAX_ITEM_REFRESHES && !stopConditionReached) {
                                                // Refresh item if this is a retry
                                                if (itemRefreshCount > 0) {
                                                    const next = await fetchCheapestListing(bestItem.hashName, 23, checkCookie, failedIds);
                                                    if (!next) {
                                                        logToAutoBuyFile(`[自动买] 无法获取 "${bestItem.hashName}" 的新挂单或已全部售罄，本轮中止。`);
                                                        break;
                                                    }
                                                    // Re-verify ratio
                                                    const rRatio = (youpinVal / (next.total / 100));
                                                    if (rRatio < threshold) {
                                                        logToAutoBuyFile(`[自动买] 新挂单 ${next.listingId} 比例 ${rRatio.toFixed(3)} 不足，跳过。`);
                                                        break;
                                                    }
                                                    currentCheapest = next;
                                                }

                                                logToAutoBuyFile(`[自动买] 针对挂单 ${currentCheapest.listingId} (¥ ${(currentCheapest.total / 100).toFixed(2)}) 开启全账号轮询尝试...`);
                                                let anyAccountConfirmedStale = false;
                                                let verifiedSuccess = false;
                                                let balanceDiff = 0;

                                                for (let acc of accounts) {
                                                    if (!acc.steamCookie || stopConditionReached) continue;

                                                    const balStr = acc.balance || '';
                                                    const isAccCNY = balStr.includes('¥');
                                                    const isAccUSD = balStr.includes('$');
                                                    if ((currentCheapest.currency === 23 && !isAccCNY) || (currentCheapest.currency === 1 && !isAccUSD)) continue;

                                                    const balNum = parseFloat((acc.balance || '0').replace(/[^\d.]/g, '')) || 0;
                                                    if (balNum < (currentCheapest.total / 100)) {
                                                        logToAutoBuyFile(`[轮询] 账户 "${acc.name}" 余额不足，跳过此账号。`);
                                                        continue;
                                                    }

                                                    logToAutoBuyFile(`[轮询] 正在尝试通过账户 "${acc.name}" 购买 (ID: ${currentCheapest.listingId})...`);
                                                    const buyRes = await executeSteamBuy(
                                                        currentCheapest.listingId, currentCheapest.currency,
                                                        currentCheapest.subtotal, currentCheapest.fee, currentCheapest.total,
                                                        acc.steamCookie, bestItem.hashName, acc.mafileContent
                                                    );

                                                    if (buyRes.success || buyRes.alreadyPurchased || buyRes.potentialSuccess) {
                                                        if (buyRes.success || buyRes.potentialSuccess) {
                                                            if (buyRes.potentialSuccess) {
                                                                logToAutoBuyFile(`[轮询] 账户 "${acc.name}" 收到 502/500，正在确认余额...`);
                                                            } else {
                                                                logToAutoBuyFile(`[轮询] 账户 "${acc.name}" 接口请求成功！正在验证余额变动...`);
                                                            }

                                                            const beforeBal = parseFloat((acc.balance || '0').replace(/[^\d.]/g, '')) || 0;
                                                            try {
                                                                const updatedAcc = await syncAccountInventory(acc.id, { force: true, isAuto: true });
                                                                const afterBal = parseFloat((updatedAcc.balance || '0').replace(/[^\d.]/g, '')) || 0;
                                                                balanceDiff = Math.abs(beforeBal - afterBal);
                                                                const expectedPrice = currentCheapest.total / 100;

                                                                if (balanceDiff >= expectedPrice * 0.95 || (balanceDiff > 0 && Math.abs(balanceDiff - expectedPrice) < 0.1)) {
                                                                    verifiedSuccess = true;
                                                                    logToAutoBuyFile(`✅ 验证成功 (余额扣款确认): 账号 "${acc.name}" 变动 ${balanceDiff.toFixed(2)}。`);
                                                                } else {
                                                                    logToAutoBuyFile(`❌ 验证失败: 账号 "${acc.name}" 余额未变化，此账号尝试失败。`, 'warn');
                                                                    if (buyRes.potentialSuccess) anyAccountConfirmedStale = true;
                                                                }
                                                            } catch (err) {
                                                                logToAutoBuyFile(`验证同步请求失败: ${err.message}`, 'error');
                                                            }
                                                        } else {
                                                            logToAutoBuyFile(`ℹ️ 重复购买: 挂单项已在账户 "${acc.name}" 中。`);
                                                            verifiedSuccess = true; // Still counts as "done" for this ID
                                                        }

                                                        if (verifiedSuccess || buyRes.alreadyPurchased) {
                                                            if (dedupeEnabled) {
                                                                const category = getItemBaseName(bestItem);
                                                                (await db.setBoughtHistoryEntry(category, new Date()).toISOString());
                                                            }
                                                            stopConditionReached = true;
                                                            // Temporarily disabled: markListingAsStale(currentCheapest.listingId); // Blacklist the ID we just bought (as requested)

                                                            // Success notification
                                                            const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                                                            await dingTalkBot.send({
                                                                msgtype: "markdown",
                                                                markdown: {
                                                                    title: "💰 自动购买成功",
                                                                    text: [
                                                                        `## 💰 自动购买成功`,
                                                                        `**饰品**: ${bestItem.name || bestItem.hashName}`,
                                                                        `- **时间**: ${timestamp}`,
                                                                        `- **执行账号**: ${acc.name}`,
                                                                        `- **购买价格**: ${currentCheapest.priceText}`,
                                                                        `- **余额扣款**: ¥ ${balanceDiff.toFixed(2)}`,
                                                                        `- **C5底价**: ¥${youpinVal.toFixed(2)}`,
                                                                        `- **当前比例**: ${(youpinVal / (currentCheapest.total / 100)).toFixed(3)}`,
                                                                        ``,
                                                                        `> 系统已确认余额变动。该挂单 ID 已被永久拉黑。`
                                                                    ].join('\n')
                                                                }
                                                            });
                                                            break; // Exit Account Loop
                                                        }
                                                    } else if (buyRes.isStale) {
                                                        logToAutoBuyFile(`[轮询] 账户 "${acc.name}" 确认该挂单已失效 (404/Stale)，立即跳过其余账号。`, 'warn');
                                                        anyAccountConfirmedStale = true;
                                                        break; // Immediately exit the account loop for a stale listing!
                                                    } else {
                                                        logToAutoBuyFile(`[轮询] 账户 "${acc.name}" 其他错误: ${buyRes.message}。`, 'error');
                                                    }
                                                }

                                                if (!stopConditionReached) {
                                                    // This ID failed for all eligible accounts
                                                    logToAutoBuyFile(`[失效确认] 挂单 ${currentCheapest.listingId} 在所有账号上均尝试失败，将其永久拉黑并寻找下一件...`, 'warn');
                                                    // Temporarily disabled: markListingAsStale(currentCheapest.listingId);
                                                    failedIds.push(currentCheapest.listingId);
                                                    itemRefreshCount++;
                                                    await new Promise(r => setTimeout(r, 2000));
                                                }
                                            }

                                            if (!stopConditionReached) {
                                                logToAutoBuyFile(`❌ 饰品 "${bestItem.hashName}" 本轮所有符合条件的尝试均告失败。`, 'error');
                                            }
                                        } else {
                                            logToAutoBuyFile(`⚠️ 实时比例 ${realTimeRatio.toFixed(3)} 低于阈值 ${threshold}。已跳过。`, 'warn');
                                        }
                                    } else {
                                        logToAutoBuyFile(`❌ 无法获取 "${bestItem.hashName}" 的实时底价。`, 'error');
                                    }
                                } finally {
                                    isPurchaseInProgress = false; // Always reset flag
                                }
                            }
                        } catch (e) {
                            logToAutoBuyFile(`严重错误: ${e.message}`, 'error');
                            if (e.message?.includes('429')) {
                                logToAutoBuyFile(`触发 429 限频。开启 10 分钟全局冷静。`, 'error');
                                globalRateLimitEnd = Date.now() + 10 * 60 * 1000;
                            }
                            isPurchaseInProgress = false; // Ensure reset on error
                        }
                    })();
                }

                lastRankingPushType = 'CASH';
                console.log(`[排行榜推送] 🚀 现金榜推送成功 (${topItems.length} 件)。`);
            } else {
                console.log(`[排行榜推送] ⚠️ CASH 榜：当前无饰品达到推送阈值 (${settings.pushRankingCashThreshold || 0.87})，跳过本轮推送。`);
            }
        } else {
            // --- Step 1: Simulate Web UI Leaderboard (Simulation) ---
            const webSimulationUp = items.filter(i => {
                const hasCny = i.steamPrices && i.steamPrices.CNY;
                const hasYoupin = i.lastC5Price && i.lastC5Price !== 'N/A';
                if (!hasCny || !hasYoupin) return false;

                if (i.excludeFromRanking) return false;

                const price = parseFloat(i.lastC5Price);
                if (settings.rankingMinPrice && price < parseFloat(settings.rankingMinPrice)) return false;
                if (settings.rankingMaxPrice && price > parseFloat(settings.rankingMaxPrice)) return false;

                const isStatTrak = (i.name || i.hashName || '').includes('StatTrak™');
                if (settings.showStatTrak === false && isStatTrak) return false;

                return true;
            }).map(item => {
                const steamVal = parseFloat(String(item.steamPrices.CNY).replace(/[^\d.]/g, ''));
                const youpinVal = parseFloat(item.lastC5Price);
                const ratio = (steamVal > 0) ? (youpinVal / steamVal).toFixed(3) : 999;
                return {
                    ...item,
                    calculatedRatio: parseFloat(ratio),
                    ratioDisplay: ratio
                };
            });

            // Ranked according to Web UI TOPUP rules: Ascending
            webSimulationUp.sort((a, b) => a.calculatedRatio - b.calculatedRatio);

            // --- Step 2: Take Web UI Top 5 and apply Push Ratio Threshold ---
            const top5FromWebUp = webSimulationUp.slice(0, 5);
            const topUpRanked = top5FromWebUp.filter(item =>
                item.calculatedRatio <= (settings.pushRankingTopUpThreshold || 0.65)
            );

            if (topUpRanked.length > 0) {
                // 余额榜 (Top-up Ranking): Small to Large (Ascending)
                topUpRanked.sort((a, b) => a.calculatedRatio - b.calculatedRatio);
                const top5Up = topUpRanked.slice(0, 5);
                globalPushRankingItems = { type: 'TOPUP', items: top5Up };

                let upTextLines = [];
                for (let idx = 0; idx < top5Up.length; idx++) {
                    const item = top5Up[idx];
                    upTextLines.push(`### ${idx + 1}. ${item.name || item.hashName}\n- **Steam价**: ${item.steamPrices.CNY}\n- **C5底价**: ¥ ${item.lastC5Price}\n- **换余额比例**: ${item.ratioDisplay}`);
                }

                // --- INVENTORY LINKAGE (TOPUP ONLY) ---
                let inventoryMatchText = "";
                let pushMatches = [];
                try {
                    const invDir = path.join(__dirname, 'inventories');
                    const invFiles = await fs.readdir(invDir).catch(() => []);
                    const accounts = await readAccounts();

                    for (const item of top5Up) {
                        const hashName = item.hashName || item.hash_name;
                        for (const file of invFiles) {
                            if (!file.endsWith('.json')) continue;
                            const accId = file.replace('.json', '');
                            const acc = accounts.find(a => String(a.id) === String(accId));
                            if (!acc) continue;

                            try {
                                const invData = JSON.parse(await fs.readFile(path.join(invDir, file), 'utf8'));
                                const matchingDescs = (invData.descriptions || []).filter(d => d.market_hash_name === hashName);
                                if (matchingDescs.length > 0) {
                                    const validClasses = new Set(matchingDescs.map(d => d.classid));
                                    const matchAssets = (invData.assets || []).filter(a => validClasses.has(a.classid));

                                    if (matchAssets.length > 0) {
                                        pushMatches.push({
                                            accId: acc.id,
                                            accName: acc.name || acc.id,
                                            isUSD: acc.balance && acc.balance.includes('$'),
                                            hashName: hashName,
                                            displayName: item.name || hashName,
                                            count: matchAssets.length,
                                            assetIds: matchAssets.map(a => a.assetid),
                                            priceText: item.steamPrices.CNY
                                        });
                                    }
                                }
                            } catch (e) { }
                        }
                    }

                    if (pushMatches.length > 0) {
                        inventoryMatchText = "\n\n---\n\n### 📦 库存匹配提醒\n" + pushMatches.map(m =>
                            `- 账号 **${m.accName}** 拥有 **${m.count}** 个 [${m.displayName}]\n  > 回复 \`${m.accName} ${m.count}\` 即可按 Steam 底价 -0.01 出售`
                        ).join('\n');
                    }
                    lastPushInventoryMatches = pushMatches;
                    // 持久化到文件，防止服务器重启（由于代码修改触发）导致匹配失效
                    await fs.writeFile(path.join(__dirname, 'last_push_matches.json'), JSON.stringify(pushMatches, null, 2)).catch(() => null);
                } catch (err) {
                    console.error('[排行榜推送] 库存扫描失败:', err.message);
                }

                await dingTalkBot.send({
                    msgtype: "markdown",
                    markdown: {
                        title: "💎 余额榜自动推送",
                        text: `## 💎 余额榜 (小→大) TOP 5\n\n---\n\n${upTextLines.join('\n\n---\n\n')}${inventoryMatchText}${inventoryMatchText ? "\n\n---\n\n💡 发送序号 (如 \`1\`) 可直接快速挂单" : ""}`
                    }
                });
                lastRankingPushType = 'TOPUP';
                console.log(`[排行榜推送] 💎 余额榜推送成功 (${top5Up.length} 件)。`);
            } else {
                console.log(`[排行榜推送] ⚠️ TOPUP 榜：当前无饰品达到推送阈值 (${settings.pushRankingTopUpThreshold || 0.65})，跳过本轮推送。`);
            }
        }

    } catch (err) {
        console.error('[排行榜推送] 错误:', err.message);
    }
}

async function startPushRanking(intervalMs, immediate = true) {
    if (pushRankingTimer) clearInterval(pushRankingTimer);

    const settings = await readSettings();
    if (!settings.pushRankingEnabled && !settings.pushTopUpEnabled) {
        console.log('[排行榜推送] 排行榜推送功能已禁用。');
        return;
    }

    if (!intervalMs || intervalMs < 60000) return; // Min 1 min

    pushRankingTimer = setInterval(pushRankingToDingTalk, intervalMs);

    if (immediate) {
        console.log(`[排行榜推送] 正在执行即时推送...`);
        pushRankingToDingTalk();
    } else {
        console.log(`[排行榜推送] 定时器已启动/重启 (间隔: ${intervalMs / 60000}分钟)。等待下一次触发。`);
    }
}

async function sendDingTalkAlert(webhook, secret, item, message, extraInfo = {}) {
    if (!webhook) return;
    try {
        let url = webhook;
        // HMAC-SHA256 signing if secret is provided
        if (secret) {
            const timestamp = Date.now();
            const strToSign = `${timestamp}\n${secret}`;
            const sign = crypto
                .createHmac('sha256', secret)
                .update(strToSign)
                .digest('base64');
            url = `${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
        }

        const currentPrice = extraInfo.c5Price || String(parseFloat(String(item.lastC5Price).replace(/[^\d.]/g, '')).toFixed(2));
        const steamInfo = extraInfo.steamInfo || (item.steamPrices
            ? Object.entries(item.steamPrices).map(([k, v]) => `${k}: ${v}`).join(' / ')
            : 'N/A');
        const ratioStr = extraInfo.ratio !== undefined ? extraInfo.ratio : null;

        const body = {
            msgtype: 'markdown',
            markdown: {
                title: '价格预警',
                text: [
                    `### 🔔 价格预警`,
                    `**${item.name || item.hashName}**`,
                    ``,
                    `> ${message}`,
                    ``,
                    `- **C5当前价**: ¥${currentPrice}`,
                    `- **Steam 价**: ${steamInfo}`,
                    `- **比例 (到手 / Steam)**: ${ratioStr !== null ? ratioStr : 'N/A'}`,
                    ``,
                    `*触发时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`
                ].join('\n')
            }
        };

        const res = await axios.post(url, body, { timeout: 8000 });
        if (res.data && res.data.errcode !== 0) {
            console.error(`[DingTalk] Push failed: errcode=${res.data.errcode}, errmsg=${res.data.errmsg}`);
        } else {
            console.log(`[DingTalk] ✅ Alert sent for "${item.name || item.hashName}"`);
        }
    } catch (e) {
        console.error(`[DingTalk] Request error:`, e.message);
    }
}

function checkAndFireAlert(item, settings) {
    if (!item.lastC5Price || item.lastC5Price === 'N/A') return;
    const currentPrice = parseFloat(String(item.lastC5Price).replace(/[^\d.]/g, ''));
    if (isNaN(currentPrice)) return;

    // Compute cash-out ratio (youpin / steam_CNY)
    let currentRatio = null;
    const cnyPriceStr = item.steamPrices?.CNY ? String(item.steamPrices.CNY) : null;
    if (cnyPriceStr && cnyPriceStr.includes('¥') && !cnyPriceStr.includes('$')) {
        const s = parseFloat(cnyPriceStr.replace(/[^\d.]/g, ''));
        if (!isNaN(s) && s > 0) currentRatio = parseFloat((currentPrice / s).toFixed(4));
    }

    const steamInfo = item.steamPrices
        ? Object.entries(item.steamPrices).map(([k, v]) => `${k}: ${v}`).join(' / ')
        : 'N/A';
    const extraInfo = {
        c5Price: currentPrice.toFixed(2),
        steamInfo,
        ratio: currentRatio !== null ? currentRatio.toFixed(3) : null
    };

    const lastPrice = lastAlertedPrices.get(item.hashName);
    const lastRatio = lastAlertedRatios.get(item.hashName);

    // --- Price alerts ---
    if (item.minAlert && currentPrice <= parseFloat(item.minAlert)) {
        if (lastPrice === undefined || lastPrice > parseFloat(item.minAlert)) {
            sendDingTalkAlert(settings.dingTalkWebhook, settings.dingTalkSecret, item,
                `C5价格已跌破预警值 ¥${item.minAlert}`, extraInfo);
        }
    } else if (item.maxAlert && currentPrice >= parseFloat(item.maxAlert)) {
        if (lastPrice === undefined || lastPrice < parseFloat(item.maxAlert)) {
            sendDingTalkAlert(settings.dingTalkWebhook, settings.dingTalkSecret, item,
                `C5价格已涨超预警值 ¥${item.maxAlert}`, extraInfo);
        }
    }

    // --- Ratio alerts (比例) ---
    if (currentRatio !== null) {
        if (item.minRatioAlert && currentRatio <= parseFloat(item.minRatioAlert)) {
            if (lastRatio === undefined || lastRatio > parseFloat(item.minRatioAlert)) {
                sendDingTalkAlert(settings.dingTalkWebhook, settings.dingTalkSecret, item,
                    `比例已降至 ${currentRatio.toFixed(3)}，低于预警值 ${item.minRatioAlert}`, extraInfo);
            }
        } else if (item.maxRatioAlert && currentRatio >= parseFloat(item.maxRatioAlert)) {
            if (lastRatio === undefined || lastRatio < parseFloat(item.maxRatioAlert)) {
                sendDingTalkAlert(settings.dingTalkWebhook, settings.dingTalkSecret, item,
                    `比例已升至 ${currentRatio.toFixed(3)}，超过预警值 ${item.maxRatioAlert}`, extraInfo);
            }
        }
        lastAlertedRatios.set(item.hashName, currentRatio);
    }

    // Always update the last known price for dedup
    lastAlertedPrices.set(item.hashName, currentPrice);
}

// Simple memory cache for search results
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Persistence Helpers
 */
async function readTracked() {
    return await db.readTracked();
}

async function writeTracked(items) {
    await db.writeTracked(items);
}

/**
 * Core Price Update Logic (Extracted for use by both Scheduler and API)
 * @param {string} groupKey The series/group name to update
 * @param {Array} allItems The full list of tracked items (modified in-place)
 * @param {Array} cookiePool Pool of Steam cookies for fuzzy searches
 */
async function performPriceUpdate(groupKey, allItems, cookiePool) {
    const groupItems = allItems.filter(i => getGroupKey(i) === groupKey);
    if (groupItems.length === 0) return;

    const someItem = groupItems[0];
    const hashBase = someItem.hashName
        .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
        .replace(/\s*[（\(].*?[）\)]\s*$/, '');

    const steamSearchTerm = hashBase.includes(' | ')
        ? hashBase
        : getEnglishGroupKey(someItem.hashName);

    // Classification: Special Items (Cases, Capsules, Stickers) vs Regular Items
    const isSpecial = (groupKey.includes('武器箱') || groupKey.includes('胶囊') || groupKey.includes('印花')) && !groupKey.includes('印花集');

    try {
        const currencyId = 23; // CNY
        const priceMap = new Map();
        const imageMap = new Map();

        if (isSpecial) {
            console.log(`[同步采集] 特殊项检测: "${groupKey}" -> 进入直方图精确搜索模式 (CNY)`);
            const cnyCookie = await getCNYCookie();

            for (const gItem of groupItems) {
                if (Date.now() < globalRateLimitEnd) break;
                const delay = 4000 + Math.floor(Math.random() * 1000);
                await new Promise(r => setTimeout(r, delay));

                const res = await fetchSteamItemPrice(gItem.hashName, currencyId, cnyCookie);
                if (res && res.price) priceMap.set(gItem.hashName, res.price);
                if (res && res.image) imageMap.set(gItem.hashName, res.image);
            }
        } else {
            console.log(`[同步采集] 常规项检测: "${groupKey}" -> 英文名 "${steamSearchTerm}" 模糊搜索模式 (CNY)`);

            const randomCookie = cookiePool.length > 0
                ? cookiePool[Math.floor(Math.random() * cookiePool.length)]
                : '';

            // Step 1: Iterative Fuzzy Search (up to 3 pages) with early exit
            for (let p = 0; p < 3; p++) {
                // Fetch one page at a time, silent mode
                const pageResults = await fetchSteamSeries(steamSearchTerm, currencyId, randomCookie, 1, p * 10, true);
                if (!pageResults || pageResults.length === 0) break;

                pageResults.forEach(r => {
                    priceMap.set(r.hash_name, r.price);
                    if (r.image) imageMap.set(r.hash_name, r.image);
                    if (groupItems.some(i => i.hashName === r.hash_name || i.name === r.name || i.name === r.hash_name)) {
                        console.log(`获取到匹配项: ${r.name || r.hash_name} (${r.price})`);
                    }
                });

                // Check if all indexed items in this group already have a price in priceMap
                const stillMissing = groupItems.some(i => !priceMap.has(i.hashName) || !priceMap.get(i.hashName));
                if (!stillMissing) {
                    // console.log(`[同步采集] "${groupKey}" 所有项已在前 ${p + 1} 页找齐，提前结束系列搜索。`);
                    break;
                }

                // Brief delay between pages if continuing
                if (p < 2) await new Promise(r => setTimeout(r, 1000));
            }

            // Step 2: Fallback for missing items
            const missingItems = groupItems.filter(i => !priceMap.has(i.hashName) || !priceMap.get(i.hashName));
            if (missingItems.length > 0) {
                console.log(`[同步采集] "${groupKey}" 有 ${missingItems.length} 个项未在模糊搜索中找到，执行精确补全...`);
                for (let mItem of missingItems) {
                    if (Date.now() < globalRateLimitEnd) break;
                    await new Promise(r => setTimeout(r, 4500));
                    const res = await fetchSteamItemPrice(mItem.hashName, currencyId, randomCookie);
                    if (res && res.price) priceMap.set(mItem.hashName, res.price);
                    if (res && res.image) imageMap.set(mItem.hashName, res.image);
                }
            }
        }

        // 2. Fetch C5Game batch prices (replaces Youpin)
        const hashNames = groupItems.map(i => i.hashName);
        const c5PriceMap = await fetchC5GamePriceBatch(hashNames);

        // 3. Update ALL items in this group
        // Find a shared image fallback from the group or imageMap
        let sharedImageFallback = null;
        for (const [hash, img] of imageMap.entries()) {
            if (img && !sharedImageFallback) sharedImageFallback = img;
        }
        if (!sharedImageFallback) {
            const existingWithImage = groupItems.find(i => i.image && i.image.startsWith('http'));
            if (existingWithImage) sharedImageFallback = existingWithImage.image;
        }

        for (let item of groupItems) {
            let hasNewData = false;
            if (!item.steamPrices) item.steamPrices = {};

            const rawPrice = priceMap.get(item.hashName) || priceMap.get(item.name);
            if (rawPrice) {
                item.steamPrices.CNY = rawPrice;
                hasNewData = true;
            }

            const newImage = imageMap.get(item.hashName) || sharedImageFallback;
            if (!item.image && newImage) {
                item.image = newImage;
                hasNewData = true;
            }

            const c5Data = c5PriceMap.get(item.hashName);
            if (c5Data && c5Data.sellPrice != null) {
                item.lastC5Price = String(c5Data.sellPrice.toFixed(2)); // keep field name for UI compat
                item.lastC5Price = String(c5Data.sellPrice.toFixed(2));
                hasNewData = true;
            }

            if (hasNewData) {
                item.lastUpdated = new Date().toISOString();
                const minutes = item.interval || 30;
                item.nextUpdate = new Date(Date.now() + minutes * 60000).toISOString();
            } else {
                const retryMs = Math.min((item.interval || 30) * 60000, 5 * 60000);
                item.nextUpdate = new Date(Date.now() + retryMs).toISOString();
            }
        }
    } catch (error) {
        console.error(`[同步采集] 采集失败 "${groupKey}":`, error.message);
        throw error;
    }
}

/**
 * Background Scheduler (Every Minute Tick)
 */
async function schedulerTick() {
    const now = Date.now();
    const items = await readTracked();
    const settings = await readSettings();
    // const activeCurrencies = settings.activeCurrencies || ['CNY', 'USD'];
    // const currencyMap = { 'USD': 1, 'CNY': 23 };

    // Grouping helpers are now global

    // Find items due for update
    const dueItems = items.filter(item => {
        const nextTime = new Date(item.nextUpdate || 0).getTime();
        return now >= nextTime;
    });

    if (dueItems.length === 0) return;

    console.log(`[调度器] 检测到 ${dueItems.length} 个饰品需要更新价格...`);

    const updatedItems = [...items];
    const processedGroups = new Set(); // each visual group is processed only once

    // --- Cookie Pool for Fuzzy Search ---
    const allAccs = await readAccounts();
    const cookiePool = allAccs.filter(a => a.steamCookie && (a.name === '132' || a.name === '133' || a.name === '134')).map(a => a.steamCookie);
    console.log(`[调度器] 模糊搜索 Cookie 池已就绪: ${cookiePool.length} 个账号可用 (仅限 132/133/134)。`);

    for (let dueItem of dueItems) {
        if (Date.now() < globalRateLimitEnd) break;
        const groupKey = getGroupKey(dueItem);
        if (processedGroups.has(groupKey)) continue;
        processedGroups.add(groupKey);

        try {
            await performPriceUpdate(groupKey, updatedItems, cookiePool);
        } catch (e) {
            console.error(`[调度器] 更新分组 "${groupKey}" 失败:`, e.message);
        }
    }

    await writeTracked(updatedItems);

    // Check alerts and push DingTalk notifications
    const alertSettings = await readSettings();
    if (alertSettings.dingTalkWebhook) {
        for (const item of updatedItems) {
            if (item.minAlert || item.maxAlert || item.minRatioAlert || item.maxRatioAlert) {
                checkAndFireAlert(item, alertSettings);
            }
        }
    }

    console.log('[调度器] 本轮采集完成。');
}

// Use recursive setTimeout instead of setInterval to prevent overlapping runs
async function runSchedulerLoop() {
    const now = Date.now();
    if (now < globalRateLimitEnd) {
        console.warn(`[调度循环] 触发 429 冷静期，跳过本轮执行 (剩余 ${Math.round((globalRateLimitEnd - now) / 1000)}秒)`);
        setTimeout(runSchedulerLoop, 5 * 60 * 1000); // Check again in 5 mins
        return;
    }

    try {
        await schedulerTick();
    } catch (e) {
        if (e.response && e.response.status === 429) {
            console.error(`[调度循环] 执行中检测到 429 限频！进入 30 分钟深度冷却。`);
            globalRateLimitEnd = Date.now() + 30 * 60 * 1000;
        } else {
            console.error(`[调度循环] 严重错误:`, e.message);
        }
    }
    // Next tick in 5 mins (standard)
    setTimeout(runSchedulerLoop, 5 * 60 * 1000);
}

runSchedulerLoop();

/**
 * Session Cleanup (Every 10 minutes)
 */
setInterval(() => {
    const now = Date.now();
    const TTL = 30 * 60 * 1000; // 30 minutes
    const beforeCount = dingTalkSessions.size;

    for (const [key, session] of dingTalkSessions.entries()) {
        // If session hasn't been updated in 30 mins, delete it
        if (session.lastActivity && (now - session.lastActivity > TTL)) {
            dingTalkSessions.delete(key);
        } else if (!session.lastActivity) {
            // Initialize lastActivity if not present
            session.lastActivity = now;
        }
    }

    if (dingTalkSessions.size < beforeCount) {
        console.log(`[会话清理] 已移除 ${beforeCount - dingTalkSessions.size} 个过期会话。`);
    }
}, 10 * 60 * 1000);


/**
 * Search API
 */
app.get('/api/prices', async (req, res) => {
    const itemName = req.query.item;
    if (!itemName) return res.status(400).json({ error: 'Item name is required' });

    if (cache.has(itemName)) {
        const cached = cache.get(itemName);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }
    }

    try {
        // Use Steam search directly (C5Game handles price enrichment on tracked items)
        const steam = await fetchSteamPrice(itemName);
        const steamHashName = itemName;

        const result = {
            item: itemName,
            hashName: steamHashName,
            steam: steam || { error: 'Failed' },
            youpin: youpin || { error: 'Failed' },
            timestamp: new Date().toISOString()
        };

        cache.set(itemName, { data: result, timestamp: Date.now() });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Tracked Items APIs
 */
app.get('/api/tracked', async (req, res) => {
    const items = await readTracked();
    res.json(items);
});

app.post('/api/tracked/exclude', async (req, res) => {
    const { hashName, exclude } = req.body;
    if (!hashName) return res.status(400).json({ error: 'hashName is required' });

    let items = await readTracked();
    const idx = items.findIndex(i => i.hashName === hashName);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });

    items[idx].excludeFromRanking = !!exclude;
    await writeTracked(items);
    res.json(items[idx]);
});

app.post('/api/tracked/exclude-series', async (req, res) => {
    const { groupKey, exclude } = req.body;
    if (!groupKey) return res.status(400).json({ error: 'groupKey is required' });

    let items = await readTracked();
    const getGroupMatch = (item) => {
        let base = (item.name || item.hashName)
            .replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '')
            .replace(/\s*[（\(].*?[）\)]\s*$/, '');
        const tournamentMatch = base.match(/^(\d{4}年.*?锦标赛|.*? \d{4})/);
        if (tournamentMatch) return tournamentMatch[1];
        if (base.toLowerCase().includes('case') || base.toLowerCase().includes('capsule')) {
            base = base.replace(/\s\d+(?=\sCase|\sCapsule|$)/i, '');
        }
        return base;
    };

    let updatedCount = 0;
    items.forEach(item => {
        if (getGroupMatch(item) === groupKey) {
            item.excludeFromRanking = !!exclude;
            updatedCount++;
        }
    });

    await writeTracked(items);
    res.json({ success: true, updatedCount });
});

app.post('/api/tracked', async (req, res) => {
    const { name, hashName, steamPrice, c5Price, interval = 15, image } = req.body;
    if (!hashName) return res.status(400).json({ error: 'hashName is required' });

    let items = await readTracked();
    const settings = await readSettings();
    const activeCurrencies = settings.activeCurrencies || ['CNY', 'USD'];

    // Check if already exists
    if (items.find(i => i.hashName === hashName)) {
        return res.status(400).json({ error: 'Item already tracked' });
    }

    const newItem = {
        name: name || hashName,
        hashName,
        steamPrices: {},
        lastC5Price: c5Price || 'N/A',
        interval: parseInt(interval),
        image,
        lastUpdated: new Date().toISOString(),
        nextUpdate: new Date(Date.now() + parseInt(interval) * 60 * 1000).toISOString()
    };

    // Store the price in the appropriate currency field
    // Detect currently provided price currency (simplistic)
    if (steamPrice) {
        if (steamPrice.includes('$')) newItem.steamPrices.USD = steamPrice;
        else newItem.steamPrices.CNY = steamPrice;
    }

    items.unshift(newItem);
    await writeTracked(items);
    res.json(newItem);
});

app.post('/api/tracked/batch', async (req, res) => {
    const { items: newItems, interval = 30 } = req.body;
    if (!Array.isArray(newItems)) return res.status(400).json({ error: 'Items array required' });

    let items = await readTracked();
    const settings = await readSettings();
    const activeCurrencies = settings.activeCurrencies || ['CNY', 'USD'];
    const added = [];

    for (const item of newItems) {
        if (!items.find(i => i.hashName === item.hashName)) {
            const newItem = {
                name: item.name || item.hashName,
                hashName: item.hashName,
                steamPrices: {},
                lastC5Price: item.c5Price || 'N/A',
                interval: parseInt(interval),
                image: item.image,
                lastUpdated: new Date().toISOString(),
                nextUpdate: new Date(Date.now() + parseInt(interval) * 60 * 1000).toISOString()
            };

            items.unshift(newItem);
            added.push(newItem);
        }
    }

    await writeTracked(items);
    res.json({ addedCount: added.length, added });
});

app.post('/api/tracked/reorder', async (req, res) => {
    const { groupKey, direction } = req.body;
    if (!groupKey || !direction) return res.status(400).json({ error: 'groupKey and direction required' });

    let items = await readTracked();

    // Group helper
    const getGroup = (item) => (item.name || item.hashName).replace(/^StatTrak™\s+|（StatTrak™）\s*\|\s*/, '').replace(/\s*[（\(].*?[）\)]\s*$/, '');

    // Find all distinct groups in order
    const groupsInOrder = [];
    const seenGroups = new Set();
    items.forEach(item => {
        const g = getGroup(item);
        if (!seenGroups.has(g)) {
            groupsInOrder.push(g);
            seenGroups.add(g);
        }
    });

    const currentIndex = groupsInOrder.indexOf(groupKey);
    if (currentIndex === -1) return res.status(404).json({ error: 'Group not found' });

    let targetIndex = -1;
    if (direction === 'up' && currentIndex > 0) targetIndex = currentIndex - 1;
    if (direction === 'down' && currentIndex < groupsInOrder.length - 1) targetIndex = currentIndex + 1;

    if (targetIndex === -1) return res.json({ success: true, message: 'No move needed' });

    // Swap groups in the groupsInOrder array
    const [movedGroup] = groupsInOrder.splice(currentIndex, 1);
    groupsInOrder.splice(targetIndex, 0, movedGroup);

    // Reconstruct items array according to new group order
    const reorderedItems = [];
    groupsInOrder.forEach(gName => {
        const groupItems = items.filter(item => getGroup(item) === gName);
        reorderedItems.push(...groupItems);
    });

    await writeTracked(reorderedItems);
    res.json({ success: true });
});

// Settings API
app.get('/api/settings', async (req, res) => {
    const settings = await readSettings();
    res.json(settings);
});

app.post('/api/settings', async (req, res) => {
    const {
        activeCurrencies, showCashOut, showTopUp,
        dingTalkWebhook, dingTalkSecret, steamCookie,
        pushRankingEnabled, pushTopUpEnabled, pushRankingInterval,
        rankingMinPrice, rankingMaxPrice, showTrackedTopUp,
        pushRankingCashThreshold, pushRankingTopUpThreshold,
        autoBuyEnabled, autoBuyRatio,
        autoBuyDedupeEnabled, autoBuyDedupeHours,
        showStatTrak,
        webshare, clashProxyPort, clashAutoRotate
    } = req.body;

    const settings = await readSettings();
    const oldPushRanking = settings.pushRankingEnabled;
    const oldPushTopUp = settings.pushTopUpEnabled;

    if (activeCurrencies && Array.isArray(activeCurrencies)) {
        settings.activeCurrencies = activeCurrencies;
    }
    if (showCashOut !== undefined) settings.showCashOut = showCashOut;
    if (showTopUp !== undefined) settings.showTopUp = showTopUp;
    if (dingTalkWebhook !== undefined) settings.dingTalkWebhook = dingTalkWebhook;
    if (dingTalkSecret !== undefined) settings.dingTalkSecret = dingTalkSecret;
    if (steamCookie !== undefined) settings.steamCookie = steamCookie;

    if (pushRankingEnabled !== undefined) settings.pushRankingEnabled = pushRankingEnabled;
    if (pushTopUpEnabled !== undefined) settings.pushTopUpEnabled = pushTopUpEnabled;
    if (pushRankingInterval !== undefined) settings.pushRankingInterval = parseInt(pushRankingInterval);
    if (showStatTrak !== undefined) settings.showStatTrak = showStatTrak;

    if (rankingMinPrice !== undefined) settings.rankingMinPrice = rankingMinPrice;
    if (rankingMaxPrice !== undefined) settings.rankingMaxPrice = rankingMaxPrice;
    if (showTrackedTopUp !== undefined) settings.showTrackedTopUp = showTrackedTopUp;

    if (pushRankingCashThreshold !== undefined) settings.pushRankingCashThreshold = parseFloat(pushRankingCashThreshold);
    if (pushRankingTopUpThreshold !== undefined) settings.pushRankingTopUpThreshold = parseFloat(pushRankingTopUpThreshold);

    if (autoBuyEnabled !== undefined) settings.autoBuyEnabled = autoBuyEnabled;
    if (autoBuyRatio !== undefined) settings.autoBuyRatio = parseFloat(autoBuyRatio);
    if (autoBuyDedupeEnabled !== undefined) settings.autoBuyDedupeEnabled = autoBuyDedupeEnabled;
    if (autoBuyDedupeHours !== undefined) settings.autoBuyDedupeHours = parseFloat(autoBuyDedupeHours);

    if (webshare !== undefined) settings.webshare = webshare;
    if (clashProxyPort !== undefined) settings.clashProxyPort = clashProxyPort ? parseInt(clashProxyPort) : null;
    if (clashAutoRotate !== undefined) settings.clashAutoRotate = clashAutoRotate;

    await writeSettings(settings);
    // 同步把代理相关的设置写入 server/settings.json，供底层 fetchers.js 独立读取
    try {
        require('fs').writeFileSync(require('path').join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    } catch(e) {
        console.error('[Settings] failed to sync server/settings.json', e.message);
    }

    // Restart timer if EITHER is enabled
    if (settings.pushRankingEnabled || settings.pushTopUpEnabled) {
        // Only push immediately if a toggle was turned FROM false TO true
        const shouldPushImmediately = (settings.pushRankingEnabled && !oldPushRanking) || (settings.pushTopUpEnabled && !oldPushTopUp);
        startPushRanking(settings.pushRankingInterval, shouldPushImmediately);
    } else {
        if (pushRankingTimer) clearInterval(pushRankingTimer);
        pushRankingTimer = null;
    }

    res.json({ success: true, settings });
});


// Test DingTalk endpoint
app.get('/api/test-dingtalk', async (req, res) => {
    const settings = await readSettings();
    if (!settings.dingTalkWebhook) {
        return res.status(400).json({ error: '未配置钉钉 Webhook' });
    }
    const testItem = {
        name: '测试物品 (AK-47 | 火蛇)',
        hashName: 'AK-47 | Fire Serpent (Field-Tested)',
        lastC5Price: '8888',
        steamPrices: { CNY: '¥ 12000.00', USD: '$1740.00' }
    };
    await sendDingTalkAlert(
        settings.dingTalkWebhook,
        settings.dingTalkSecret,
        testItem,
        '这是一条来自价格追踪器的测试预警消息 ✅'
    );
    res.json({ success: true, message: '测试消息已发送，请检查钉钉群' });
});

app.patch('/api/tracked/interval', async (req, res) => {
    const { hashName, interval } = req.body;
    if (!hashName || !interval) return res.status(400).json({ error: 'hashName and interval required' });

    let items = await readTracked();
    const idx = items.findIndex(i => i.hashName === hashName);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });

    items[idx].interval = parseInt(interval);
    // Reset nextUpdate relative to lastUpdate (fallback to now)
    const baseTime = items[idx].lastUpdated ? new Date(items[idx].lastUpdated).getTime() : Date.now();
    items[idx].nextUpdate = new Date(baseTime + parseInt(interval) * 60 * 1000).toISOString();

    await writeTracked(items);
    res.json(items[idx]);
});

app.post('/api/tracked/alert', async (req, res) => {
    const { hashName, minAlert, maxAlert, minRatioAlert, maxRatioAlert } = req.body;
    if (!hashName) return res.status(400).json({ error: 'hashName is required' });

    let items = await readTracked();
    const idx = items.findIndex(i => i.hashName === hashName);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });

    items[idx].minAlert = minAlert || null;
    items[idx].maxAlert = maxAlert || null;
    items[idx].minRatioAlert = minRatioAlert || null;
    items[idx].maxRatioAlert = maxRatioAlert || null;

    await writeTracked(items);
    res.json(items[idx]);
});

app.patch('/api/tracked/series-interval', async (req, res) => {
    const { baseName, interval } = req.body;
    if (!baseName || !interval) return res.status(400).json({ error: 'baseName and interval required' });

    let items = await readTracked();
    let updatedCount = 0;

    items.forEach((item, idx) => {
        if (getItemBaseName(item) === baseName) {
            items[idx].interval = parseInt(interval);
            const baseTime = items[idx].lastUpdated ? new Date(items[idx].lastUpdated).getTime() : Date.now();
            items[idx].nextUpdate = new Date(baseTime + parseInt(interval) * 60 * 1000).toISOString();
            updatedCount++;
        }
    });

    if (updatedCount === 0) return res.status(404).json({ error: 'No items found in series' });

    await writeTracked(items);
    res.json({ success: true, updatedCount });
});

app.delete('/api/tracked/series', async (req, res) => {
    const { baseName } = req.query;
    if (!baseName) return res.status(400).json({ error: 'baseName is required' });

    let items = await readTracked();
    const initialCount = items.length;

    items = items.filter(item => {
        const itemBase = getItemBaseName(item);
        // 支持精确匹配和前缀匹配（例如 "电竞 2013" 匹配 "电竞 2013 冬季武器箱"）
        return itemBase !== baseName && !itemBase.startsWith(baseName);
    });

    if (items.length === initialCount) {
        return res.status(404).json({ error: 'No items found for this series' });
    }

    await writeTracked(items);
    res.json({ success: true, deletedCount: initialCount - items.length });
});

app.delete('/api/tracked', async (req, res) => {
    const { hashName } = req.query;
    let items = await readTracked();
    items = items.filter(i => i.hashName !== hashName);
    await writeTracked(items);
    res.json({ success: true });
});

/**
 * Manual Series Update
 */
app.post('/api/tracked/update-series', async (req, res) => {
    const { baseName, forceCrawl = false } = req.body;
    if (!baseName) return res.status(400).json({ error: 'baseName is required' });

    try {
        let items = await readTracked();
        const settings = await readSettings();
        const currencyId = 23; // CNY

        // 1. Check if series is already tracked (Data-Driven Mode)
        const targetItems = items.filter(item => {
            const itemBase = getItemBaseName(item);
            return itemBase === baseName || itemBase.includes(baseName) || baseName.includes(itemBase);
        });

        if (targetItems.length > 0 && !forceCrawl) {
            console.log(`[排行榜/系列] "${baseName}" 正在进行即时同步采集... (模式: ${forceCrawl ? '强制爬取' : '数据驱动'})`);

            const allAccs = await readAccounts();
            const cookiePool = allAccs.filter(a => a.steamCookie && (a.name === '132' || a.name === '133' || a.name === '134')).map(a => a.steamCookie);
            const groupKey = getItemBaseName(targetItems[0]);

            // Execute the live update!
            await performPriceUpdate(groupKey, items, cookiePool);
            await writeTracked(items);

            return res.json({
                success: true,
                items: items.filter(i => getItemBaseName(i) === groupKey),
                source: 'live',
                message: '已完成即时同步采集。'
            });
        }

        // 2. Discovery Mode: search Steam, then enrich with C5 prices
        console.log(`[手动更新] 启动主动爬取模式: "${baseName}" (CNY)...`);
        await new Promise(r => setTimeout(r, 1000));

        const allAccsForDisc = await readAccounts();
        const discCookiePool = allAccsForDisc.filter(a => a.steamCookie && (a.name === '132' || a.name === '133' || a.name === '134')).map(a => a.steamCookie);
        const randomCookie = discCookiePool.length > 0 ? discCookiePool[Math.floor(Math.random() * discCookiePool.length)] : '';
        
        const steamDiscovery = await fetchSteamSeries(baseName, 23, randomCookie);
        if (targetItems.length === 0 && steamDiscovery.length === 0) {
            return res.status(404).json({ error: 'No items found in series' });
        }

        // Enrich discovered items with C5 prices
        const discoveryHashNames = steamDiscovery.map(s => s.hash_name);
        const c5Discovery = discoveryHashNames.length > 0 ? await fetchC5GamePriceBatch(discoveryHashNames) : new Map();

        res.json({
            success: true,
            items: steamDiscovery.map(s => ({
                hashName: s.hash_name,
                name: s.name,
                image: s.image,
                lastC5Price: c5Discovery.has(s.hash_name) ? String(c5Discovery.get(s.hash_name).sellPrice.toFixed(2)) : 'N/A',
                steamPrices: { CNY: s.price }
            })),
            source: 'discovery'
        });

    } catch (e) {
        console.error(`[手动更新] 系列 "${baseName}" 处理失败:`, e.message);
        res.status(500).json({ error: 'Manual update failed' });
    }
});

app.get('/api/search-series', async (req, res) => {
    let query = req.query.q;
    const currencyCode = (req.query.currency || 'CNY').toUpperCase();
    console.log(`\n>>> [API] GET /api/search-series - Query: "${query}" (Forced CNY)`);
    const currencyId = 23; // CNY

    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        // Step 1: Use Youpin's superior Chinese fuzzy search to get disambiguation candidates.
        // Steam's Chinese search engine often fails on nicknames or returns irrelevant items.
        // Youpin handles this perfectly and gives us accurate commodityHashNames.
        console.log(`[Series Search] 使用悠悠接口进行初步模糊联想: "${query}"...`);
        const rawResults = await fetchYoupinSeries(query);

        if (!rawResults || rawResults.length === 0) {
            console.log(`[Series Search] 悠悠模糊搜索未找到结果，回退使用精准名策略...`);
            // Add a small fallback in case Youpin is totally down or fails
            const fallbackTerm = await translateChineseToEnglish(query);
            const accounts = await readAccounts();
            const cnyCookiePool = accounts
                .filter(a => a.steamCookie && (a.name === '132' || a.name === '133' || a.name === '134'))
                .map(a => a.steamCookie);
            const randomCookie = cnyCookiePool.length > 0 ? cnyCookiePool[0] : '';
            const fallbackResults = await fetchSteamSeries(fallbackTerm, currencyId, randomCookie, 1, 0, false);
            if (fallbackResults && fallbackResults.length > 0) {
                rawResults.push(...fallbackResults);
            }
        }

        // Fast-path: check if it's already an exact query.
        const isExactQuery = query.includes(' | ');

        // Step 3: Majority vote — strip wear brackets from BOTH hash_name (English) and name (Chinese)
        // hash_name: "AK-47 | Hydroponic (Battle-Scarred)" -> English base for API calls
        // name:      "AK-47 | 水栽竹 (战痕累累)"           -> Chinese base for display
        const WEAR_TIERS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
        const WEAR_CN = {
            'Factory New':   '崭新出厂',
            'Minimal Wear':  '略有磨损',
            'Field-Tested':  '久经沙场',
            'Well-Worn':     '破损不堪',
            'Battle-Scarred':'战痕累累',
        };
        const wearPattern = /\s*\([^)]+\)\s*$/;

        // Vote on English hash bases (for API) and track corresponding Chinese names
        const voteMap = new Map();       // English base -> count
        const chineseBaseMap = new Map(); // English base -> Chinese base (from first match)
        for (const item of rawResults) {
            const engBase = (item.hash_name || '').replace(wearPattern, '').trim();
            const chnBase = (item.name || '').replace(wearPattern, '').trim();
            if (!engBase) continue;
            voteMap.set(engBase, (voteMap.get(engBase) || 0) + 1);
            if (!chineseBaseMap.has(engBase) && chnBase) {
                chineseBaseMap.set(engBase, chnBase);
            }
        }

        if (voteMap.size === 0) {
            console.log(`[Series Search] No results from Youpin/Steam for "${query}"`);
            return res.json([]);
        }

        // Pick the winner (most votes)
        const winner = [...voteMap.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const winnerCN = chineseBaseMap.get(winner) || winner; // Chinese base name for display
        console.log(`[Series Search] 多数投票结果: "${winner}" / "${winnerCN}" (${voteMap.get(winner)} 票, 共 ${rawResults.length} 条结果)`);

        // Step 4: Construct all 5 wear tier hash names for the winner
        const allHashNames = WEAR_TIERS.map(w => `${winner} (${w})`);

        // Step 5: Batch fetch C5 prices for all constructed names (single request)
        const c5PriceMap = await fetchC5GamePriceBatch(allHashNames);
        console.log(`[Series Search] C5批价: ${c5PriceMap.size} 条有效价格`);

        // Step 6: Build initial Steam price map from first search results
        const steamPriceByHash = new Map();
        let sharedImage = null;
        for (const item of rawResults) {
            steamPriceByHash.set(item.hash_name, item);
            if (item.image && !sharedImage) sharedImage = item.image;
        }

        // Step 6b: If first search didn't get all wear tiers, do a targeted fuzzy search
        // with the exact winner name — Steam returns ALL wear tiers for an exact skin name.
        // Skip if the original query was already an exact name (first search already covered it).
        const missingCount = allHashNames.filter(h => !steamPriceByHash.has(h) && c5PriceMap.has(h)).length;
        if (missingCount > 0 && !isExactQuery) {
            console.log(`[Series Search] 用精确皮肤名 "${winner}" 补充搜索全磨损 Steam 价格...`);
            const exactResults = await fetchSteamSeries(winner, currencyId, randomCookie, 1, 0, false);
            for (const item of exactResults) {
                if (!steamPriceByHash.has(item.hash_name)) {
                    steamPriceByHash.set(item.hash_name, item);
                }
                if (item.image && !sharedImage) sharedImage = item.image;
            }
            console.log(`[Series Search] 精确搜索补充 ${exactResults.length} 条，现共 ${steamPriceByHash.size} 个磨损档有 Steam 价格`);
        }

        // Step 6c: Final fallback — for still-missing wear tiers (rare/expensive skins with few listings),
        // use fetchSteamItemPrice (histogram API) exactly like performPriceUpdate's Step 2.
        // Run in parallel for speed.
        const stillMissing = allHashNames.filter(h => !steamPriceByHash.has(h) && c5PriceMap.has(h));
        if (stillMissing.length > 0) {
            console.log(`[Series Search] ${stillMissing.length} 个磨损档仍缺 Steam 价格，走直方图精确补全 (并行)...`);
            const fallbackResults = await Promise.all(
                stillMissing.map(hashName =>
                    fetchSteamItemPrice(hashName, currencyId, randomCookie)
                        .then(r => ({ hashName, result: r }))
                        .catch(() => ({ hashName, result: null }))
                )
            );
            for (const { hashName, result } of fallbackResults) {
                if (result && result.price) {
                    console.log(`[Series Search] 直方图补全: ${hashName} -> ${result.price}`);
                    steamPriceByHash.set(hashName, {
                        hash_name: hashName,
                        price: result.price,
                        listings: 0,
                        image: sharedImage,
                    });
                }
            }
        }

        // Build final results for all wear tiers
        const finalResults = [];
        for (const hashName of allHashNames) {
            const c5Data = c5PriceMap.get(hashName);
            const steamItem = steamPriceByHash.get(hashName);

            // Only include if we have at least a C5 price or a Steam price
            if (!c5Data && !steamItem) continue;

            // Extract English wear qualifier then map to Chinese
            const wearMatch = hashName.match(/\(([^)]+)\)$/);
            const wearEn = wearMatch ? wearMatch[1] : '';
            const wearCN = WEAR_CN[wearEn] || wearEn;

            finalResults.push({
                hash_name: hashName,
                name: wearCN ? `${winnerCN} (${wearCN})` : winnerCN,
                price: steamItem?.price || null,
                listings: steamItem?.listings || 0,
                image: steamItem?.image || sharedImage,
                c5Price: c5Data ? String(c5Data.sellPrice.toFixed(2)) : 'N/A',
                c5SellCount: c5Data?.sellCount || 0,
                wear: wearEn,
            });
        }

        // Filter out souvenirs
        const output = finalResults.filter(item => {
            const nameStr = item.name || item.hash_name || '';
            return !nameStr.toLowerCase().includes('souvenir') && !nameStr.includes('纪念品');
        });

        console.log(`[Series Search] Returning ${output.length} items. First few: ${output.slice(0, 3).map(r => r.hash_name).join(', ')}`);
        res.json(output);

    } catch (error) {
        console.error(`Search for ${query} failed:`, error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.post('/api/tracked/batch', async (req, res) => {
    const { items: newItems } = req.body;
    if (!Array.isArray(newItems)) return res.status(400).json({ error: 'Items array required' });

    let items = await readTracked();
    const added = [];

    for (const item of newItems) {
        if (!items.find(i => i.hashName === item.hashName)) {
            const newItem = {
                name: item.name || item.hashName,
                hashName: item.hashName,
                image: item.image || null,
                lastSteamPrice: item.steamPrice || 'N/A',
                lastC5Price: item.c5Price || 'N/A',
                lastUpdated: new Date().toISOString()
            };
            items.push(newItem);
            added.push(newItem);
        }
    }

    await writeTracked(items);
    res.json({ addedCount: added.length, added });
});

app.get('/api/ping', async (req, res) => {
    res.send('pong');
});

// 打开浏览器（含 Cookie 保障 + 进程清理）
app.post('/api/open-browser', async (req, res) => {
    let { url, browserPath, profileName, browserType, profilePath } = req.body;
    console.log(`[浏览器启动器] 收到请求: ${url}`);
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isFirefox = browserType === 'firefox';
    const defaultEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const defaultFirefox = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    const targetPath = browserPath || (isFirefox ? defaultFirefox : defaultEdge);

    // ── 仅在使用隔离 profile 文件夹时才需要清理 + Cookie 保障 ──
    if (profilePath && !isFirefox) {
        // Step 1: 杀掉占用该 profile 的后台进程（Puppeteer sync 等）
        await killProcessesUsingProfile(profilePath, browserType || 'edge', profileName || 'Default').catch(() => { });

        // Step 2: 从 accounts.json 查出正确的 profileName
        try {
            const accts = JSON.parse(await fs.readFile(path.join(__dirname, 'accounts.json'), 'utf8'));
            const acc = accts.find(a => a.profilePath === profilePath);
            if (acc?.profile) {
                profileName = acc.profile;
                const exists = await fs.access(path.join(profilePath, profileName)).then(() => true).catch(() => false);
                if (!exists && profileName !== 'Default') profileName = 'Default';
            }

            // Step 3: 按需 Cookie 注入（仅当 steamcommunity.com 没有 steamLoginSecure 时才跑）
            // 原因：Puppeteer sync 只访问 store.steampowered.com，导致 steamcommunity.com 的域名下
            // 缺少 steamLoginSecure，市场/社区页面打开后显示未登录。
            // 有了 cookie 后，后续打开都会跳过此步骤，不增加延迟。
            const profile = profileName || 'Default';
            if (acc?.steamCookie) {
                // 每次打开都重新注入最新 Cookie，防止旧 Cookie 过期后市场价格无法加载
                try {
                    const puppeteer = require('puppeteer-core');
                    const parseCookies = (str, domain) => str.split(';')
                        .map(p => { const [n, ...v] = p.trim().split('='); return { name: n.trim(), value: v.join('=').trim(), domain, path: '/' }; })
                        .filter(c => c.name && c.value);

                    const ib = await puppeteer.launch({
                        executablePath: targetPath, headless: true, userDataDir: profilePath,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--remote-debugging-port=0']
                    });
                    try {
                        const p = await ib.newPage();
                        await p.goto('https://steamcommunity.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
                        // 注入登录Cookie以及强行固定语言Cookie，防止账号跨区出现商品详情页的无限 302 重定向
                        await p.setCookie(
                            ...parseCookies(acc.steamCookie, '.steamcommunity.com'),
                            { name: 'Steam_Language', value: 'schinese', domain: 'steamcommunity.com', path: '/' },
                            { name: 'timezoneOffset', value: '28800,0', domain: 'steamcommunity.com', path: '/' }
                        );
                    } finally { await ib.close(); }
                    await killProcessesUsingProfile(profilePath, browserType || 'edge', profile).catch(() => { });
                } catch (_) { /* 注入失败不阻止打开 */ }
            }
        } catch (_) { /* 非致命错误，继续打开 */ }
    }

    // Step 4: 以干净的原始参数启动 GUI 浏览器
    let args;
    if (isFirefox) {
        args = profilePath ? ['--profile', profilePath, url] : [url];
    } else if (profilePath) {
        const profile = profileName || 'Default';
        args = [
            `--user-data-dir=${profilePath}`,
            `--profile-directory=${profile}`,
            '--new-window',
            '--no-first-run',
            '--no-default-browser-check',
            url
        ];
    } else {
        args = [`--profile-directory=${profileName || 'Default'}`, url];
    }

    spawn(targetPath, args, { detached: true, stdio: 'ignore', shell: false }).unref();
    res.json({ success: true });
});



app.post('/api/accounts/kill-browser', async (req, res) => {
    const { id, browserType } = req.body;
    console.log(`[浏览器强制关闭] 收到请求, 账号 ID: ${id}`);
    try {
        if (id) {
            const accounts = await readAccounts();
            const acc = accounts.find(a => String(a.id) === String(id));
            if (acc) {
                const userDataDir = acc.profilePath || path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data');
                console.log(`[浏览器强制关闭] 已找到账号: ${acc.name}。正在清理该该配置文件的进程: ${userDataDir}`);
                await killProcessesUsingProfile(userDataDir, acc.browserType || browserType || 'edge', acc.profile);
                return res.json({ success: true, message: `针对账号 ${acc.name} 的强制结束已完成。` });
            } else {
                console.warn(`[KillBrowser] Account not found for ID: ${id}`);
            }
        }

        // Fallback or if no ID provided (legacy support for global kill, but now more cautious)
        const processName = browserType === 'firefox' ? 'firefox.exe' : 'msedge.exe';
        console.log(`[浏览器启动器] !!! 正在强制结束所有 ${processName} 进程 !!!`);
        exec(`taskkill /F /IM ${processName} /T`, (err, stdout) => {
            res.json({ success: true, error: err ? err.message : null });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/accounts/setup-profile', async (req, res) => {
    const profilesDir = path.join(__dirname, 'profiles');
    try {
        await fs.mkdir(profilesDir, { recursive: true });
        const profilePath = path.join(profilesDir, `acc_${Date.now()}`);
        await fs.mkdir(profilePath, { recursive: true });
        console.log(`[账号设置] 已创建新的 Firefox 配置文件: ${profilePath}`);
        res.json({ profilePath });
    } catch (e) {
        console.error(`[账号设置] 创建配置文件文件夹失败:`, e.message);
        res.status(500).json({ error: '创建配置文件文件夹失败' });
    }
});

/**
 * Account Red-Letter Scanning (Detailed Detection)
 */
/**
 * ── 封禁检测公共函数 ─────────────────────────────────────────────────
 * 调用 Steam Web API GetPlayerBans，每批最多 100 个 SteamID
 * 返回 Map<steamId64, banInfo>
 */
async function fetchSteamBans(steamIds) {
    const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
    if (!STEAM_API_KEY) throw new Error('未配置 STEAM_API_KEY，请在 .env 中设置');

    const { steamRequest } = require('./fetchers');

    const resultMap = new Map();
    const chunks = [];
    for (let i = 0; i < steamIds.length; i += 100) chunks.push(steamIds.slice(i, i + 100));

    for (const chunk of chunks) {
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/`
            + `?key=${STEAM_API_KEY}&steamids=${chunk.join(',')}`;
        // 使用 steamRequest 代替裸 axios：自动走代理 + TLS/网络错误最多重试3次换IP
        const resp = await steamRequest(url, { timeout: 15000 }, 3);
        for (const p of (resp.data?.players || [])) {
            resultMap.set(p.SteamId, {
                steamId:          p.SteamId,
                communityBanned:  p.CommunityBanned,
                vacBanned:        p.VACBanned,
                numberOfVACBans:  p.NumberOfVACBans,
                numberOfGameBans: p.NumberOfGameBans,
                economyBan:       p.EconomyBan,
                daysSinceLastBan: p.DaysSinceLastBan,
            });
        }
    }
    return resultMap;
}

/**
 * 格式化封禁状态为易读字符串
 */
function formatBanStatus(b) {
    if (!b) return '未知';
    const flags = [];
    if (b.communityBanned)   flags.push('🔴 社区封禁');
    if (b.vacBanned)         flags.push(`🔴 VAC封禁×${b.numberOfVACBans}(${b.daysSinceLastBan}天前)`);
    if (b.numberOfGameBans)  flags.push(`🟡 游戏封禁×${b.numberOfGameBans}`);
    if (b.economyBan === 'banned')     flags.push('🔴 交易封禁');
    if (b.economyBan === 'probation')  flags.push('🟡 交易观察期');
    return flags.length ? flags.join(' | ') : '✅ 正常';
}

/**
 * POST /api/accounts/scan-red-letters
 * 批量导入检测：接收 maFiles，解析 steamId64，即时查询封禁状态后流式返回。
 * 前端可根据结果即时决定是否删除。
 */
app.post('/api/accounts/scan-red-letters', async (req, res) => {
    const { maFiles } = req.body; // Array of { name: string, content: string }
    if (!maFiles || !Array.isArray(maFiles) || maFiles.length === 0) {
        return res.status(400).json({ error: '请提供 maFiles 文件列表内容' });
    }

    // 解析所有 maFile → { name, steamId64 }
    const entries = [];
    for (const file of maFiles) {
        try {
            const parsed = parseMaFile(file.content);
            const steamId64 = parsed.steamId64 || parsed.Session?.SteamID;
            if (steamId64) {
                entries.push({ name: file.name.replace('.maFile', ''), steamId64: String(steamId64) });
            } else {
                entries.push({ name: file.name.replace('.maFile', ''), steamId64: null, error: '无法解析 SteamID' });
            }
        } catch (e) {
            entries.push({ name: file.name.replace('.maFile', ''), steamId64: null, error: e.message });
        }
    }

    // SSE 流式推送
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ line: `[红信扫描] 共 ${maFiles.length} 个文件，正在查询 Steam 封禁状态...` });

    try {
        const validIds = entries.filter(e => e.steamId64).map(e => e.steamId64);
        const banMap = validIds.length ? await fetchSteamBans(validIds) : new Map();

        for (const entry of entries) {
            if (!entry.steamId64) {
                send({ line: `❌ [${entry.name}] 解析失败: ${entry.error}`, result: { name: entry.name, error: entry.error } });
                continue;
            }
            const b = banMap.get(entry.steamId64);
            const status = formatBanStatus(b);
            const isBanned = b && (b.communityBanned || b.vacBanned || b.economyBan === 'banned');
            const isSuspicious = !isBanned && b && (b.numberOfGameBans > 0 || b.economyBan === 'probation');
            send({
                line: `[${entry.name}] ${status}`,
                result: { name: entry.name, steamId64: entry.steamId64, status, isBanned: !!isBanned, isSuspicious: !!isSuspicious, ...b }
            });
        }
        send({ line: `✅ 扫描完成`, done: true });
    } catch (e) {
        send({ line: `❌ 查询失败: ${e.message}`, done: true, error: e.message });
    }
    res.end();
});

/**
 * POST /api/accounts/check-bans
 * 分组封禁检测：检测指定分组下全部账号的封禁状态（一次调用返回 JSON）。
 * Body: { groupId: number }  （groupId 为 0 或不传 = 全部账号）
 */
app.post('/api/accounts/check-bans', async (req, res) => {
    try {
        const { groupId } = req.body;
        const allAccounts = await db.readAccounts();
        const targets = groupId
            ? allAccounts.filter(a => String(a.groupId) === String(groupId))
            : allAccounts;

        if (targets.length === 0) {
            return res.json({ success: true, results: [], message: '该分组暂无账号' });
        }

        const steamIds = targets.map(a => a.steamId64).filter(Boolean);
        const banMap = await fetchSteamBans(steamIds);

        const results = [];
        for (const acc of targets) {
            const b = banMap.get(acc.steamId64) || null;
            const isBanned = b && (b.communityBanned || b.vacBanned || b.economyBan === 'banned');
            const isSuspicious = !isBanned && b && (b.numberOfGameBans > 0 || b.economyBan === 'probation');
            const newStatus = isBanned ? 'banned' : isSuspicious ? 'suspicious' : 'normal';

            // 直接精准更新单条记录的 ban_status，不影响其他字段
            await db.updateAccountBanStatus(acc.id, newStatus);

            results.push({
                id:              acc.id,
                name:            acc.name,
                steamId64:       acc.steamId64,
                status:          formatBanStatus(b),
                isBanned:        !!isBanned,
                isSuspicious:    !!isSuspicious,
                banStatus:       newStatus,
                communityBanned: b?.communityBanned || false,
                vacBanned:       b?.vacBanned || false,
                numberOfVACBans: b?.numberOfVACBans || 0,
                numberOfGameBans:b?.numberOfGameBans || 0,
                economyBan:      b?.economyBan || 'none',
                daysSinceLastBan:b?.daysSinceLastBan || 0,
            });
        }

        const bannedCount = results.filter(r => r.isBanned).length;
        const suspiciousCount = results.filter(r => r.isSuspicious).length;
        console.log(`[封禁检测] 分组${groupId || '全部'}: ${targets.length} 个账号，${bannedCount} 个异常，${suspiciousCount} 个可疑`);
        res.json({ success: true, total: targets.length, bannedCount, suspiciousCount, results });
    } catch (e) {
        console.error('[封禁检测] 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🗄️ 令牌确认全局内存缓存（库存转移成功后自动写入，打开面板时立即可见）
// ─────────────────────────────────────────────────────────────────────────────
// Map<accountId:string, { confirmations: FormattedConf[], fetchedAt: number }>
const confirmationCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// 📦 库存转移 — 并发批量拉取多账号 CS2 库存
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/batch-inventory', async (req, res) => {
    const { accountIds } = req.body;
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
        return res.status(400).json({ error: '需要 accountIds 数组' });
    }
    const allAccounts = await db.readAccounts();
    const targets = allAccounts.filter(a => accountIds.includes(String(a.id)));
    if (targets.length === 0) return res.json({ results: [] });

    // 开启 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const CONCURRENCY = 10;

    async function fetchOneInventory(acc) {
        const cookieString = acc.steamCookie || '';
        const steamId64 = acc.steamId64;
        if (!steamId64 || !cookieString) {
            return { accountId: acc.id, accountName: acc.name, items: [], error: '缺少 SteamID 或 Cookie' };
        }
        try {
            let allAssets = [], allDescriptions = [], descMap = new Map(), lastId = null;
            for (let p = 0; p < 30; p++) {
                let url = `https://steamcommunity.com/inventory/${steamId64}/730/2?l=schinese&count=200`;
                if (lastId) url += `&start_assetid=${lastId}`;
                const invRes = await steamRequest(url, {
                    method: 'GET', validateStatus: () => true,
                    headers: { 'Cookie': cookieString, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                if (invRes.status !== 200) {
                    if (invRes.status === 429) {
                        return { accountId: acc.id, accountName: acc.name, items: [], error: `Steam 限频(429)` };
                    }
                    break;
                }
                const data = typeof invRes.data === 'string' ? JSON.parse(invRes.data) : invRes.data;
                (data.assets || []).forEach(a => allAssets.push(a));
                (data.descriptions || []).forEach(d => {
                    const k = `${d.classid}_${d.instanceid}`;
                    if (!descMap.has(k)) descMap.set(k, d);
                });
                if (data.more_items && data.last_assetid) { lastId = data.last_assetid; await new Promise(r => setTimeout(r, 400)); }
                else break;
            }
            // 合并 asset + description（包含冷却中物品）
            const items = allAssets.map(a => {
                const desc = descMap.get(`${a.classid}_${a.instanceid}`) || {};
                const isTradable = desc.tradable === 1;
                // 解析冷却解锁时间（Steam 会在 desc.descriptions 里写 "Tradeable After: xxx"）
                let tradeHoldExpiry = null;
                const descTexts = desc.descriptions || [];
                for (const d of descTexts) {
                    const m = (d.value || '').match(/Tradeable After:\s*(.+)/i);
                    if (m) { tradeHoldExpiry = m[1].trim(); break; }
                }
                return {
                    assetid: a.assetid, classid: a.classid, instanceid: a.instanceid,
                    amount: parseInt(a.amount) || 1,
                    market_hash_name: desc.market_hash_name || '',
                    name: desc.name || desc.market_hash_name || a.classid,
                    icon_url: desc.icon_url || '',
                    tradable: isTradable,
                    locked: !isTradable,
                    tradeHoldExpiry,
                    type: desc.type || '',
                    accountId: acc.id, accountName: acc.name
                };
            }); // 不过滤冷却物品，全部返回
            return { accountId: acc.id, accountName: acc.name, items };
        } catch (e) {
            return { accountId: acc.id, accountName: acc.name, items: [], error: e.message };
        }
    }

    // 并发控制池：动态流式分发
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= targets.length) break;
            const currentAcc = targets[i];
            const result = await fetchOneInventory(currentAcc);
            send({ type: 'result', result });
        }
    });

    await Promise.all(workers);
    send({ type: 'done' });
    res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// 📥 批量接受传入的交易报价 + 自动令牌确认（适用于接收方账号）
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/accept-incoming-offers', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: '缺少 accountId' });

    const allAccounts = await db.readAccounts();
    const acc = allAccounts.find(a => String(a.id) === String(accountId));
    if (!acc) return res.status(404).json({ error: '账号不存在' });
    if (!acc.mafileContent) return res.status(400).json({ error: '该账号没有 maFile' });

    const SteamCommunity = require('steamcommunity');
    const SteamTotp = require('steam-totp');

    try {
        const mafile = JSON.parse(acc.mafileContent);
        const refreshToken = mafile?.Session?.RefreshToken;
        const identitySecret = mafile?.identity_secret;
        if (!refreshToken) throw new Error('无 RefreshToken');

        const sessionResult = await withTimeout(
            steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
            25000, `${acc.name} Cookie刷新`
        );
        if (!sessionResult?.cookieArray) throw new Error('Cookie 刷新失败');

        // 用 steamcommunity 库的内置 HTTP 客户端（自带 CookieJar，正确处理 Steam 重定向）
        let proxyUrl = getProxyAgent('https://steamcommunity.com');
        let community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
        community.setCookies(sessionResult.cookieArray);

        const sessionid = (sessionResult.cookieArray.find(c => c.startsWith('sessionid=')) || '').replace('sessionid=', '').trim();

        // 1. 用 community 内置 HTTP 获取传入报价页面（避免 axios redirect 死循环）
        const htmlBody = await withTimeout(
            new Promise((resolve, reject) => {
                community.httpRequest({
                    method: 'GET',
                    url: `https://steamcommunity.com/profiles/${acc.steamId64}/tradeoffers/`,
                    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' }
                }, (err, response, body) => {
                    if (err) return reject(err);
                    resolve(body || '');
                });
            }), 20000, `${acc.name} 获取传入报价页面`
        );

        // 从 HTML 提取传入报价 ID
        let offerIds = [];
        if (typeof htmlBody === 'string') {
            const m1 = htmlBody.matchAll(/ShowTradeOffer\(\s*'(\d+)'/g);
            for (const m of m1) offerIds.push(m[1]);
            const m2 = htmlBody.matchAll(/"tradeofferid"\s*:\s*"(\d+)"/g);
            for (const m of m2) offerIds.push(m[1]);
            const m3 = htmlBody.matchAll(/tradeoffer_(\d+)/g);
            for (const m of m3) offerIds.push(m[1]);
            offerIds = [...new Set(offerIds)];
        }

        console.log(`[接受报价] ${acc.name} 发现 ${offerIds.length} 个传入报价，开始批量接受...`);
        writeLog(TRANSFER_LOG, `[接受报价] ${acc.name}(${acc.id}) 发现 ${offerIds.length} 个传入报价，开始批量接受`);

        const accepted = [], acceptErrors = [];
        const cookieStr = sessionResult.cookieArray.join('; ');

        for (const offerId of offerIds) {
            try {
                // 用 community 内置 HTTP POST 接受报价（同样避免 redirect 问题）
                const acceptResult = await withTimeout(
                    new Promise((resolve, reject) => {
                        community.httpRequest({
                            method: 'POST',
                            url: `https://steamcommunity.com/tradeoffer/${offerId}/accept`,
                            form: {
                                sessionid,
                                serverid: '1',
                                tradeofferid: String(offerId),
                                partner: '',
                                captcha: ''
                            },
                            headers: {
                                'Referer': `https://steamcommunity.com/tradeoffer/${offerId}/`,
                                'Origin': 'https://steamcommunity.com',
                            },
                            json: true
                        }, (err, response, body) => {
                            if (err) return reject(err);
                            resolve({ status: response.statusCode, body });
                        });
                    }), 12000, `${acc.name} 接受报价 #${offerId}`
                );

                if (acceptResult.status === 200 && !acceptResult.body?.strError) {
                    accepted.push(offerId);
                    console.log(`[接受报价] ✅ ${acc.name} 接受报价 #${offerId}`);
                } else {
                    const errMsg = acceptResult.body?.strError || `HTTP ${acceptResult.status}`;
                    acceptErrors.push({ offerId, error: errMsg });
                    console.warn(`[接受报价] ❌ ${acc.name} 报价 #${offerId} 接受失败: ${errMsg}`);
                }
                await new Promise(r => setTimeout(r, 400));
            } catch (e) {
                acceptErrors.push({ offerId, error: e.message });
                console.error(`[接受报价] 报价 #${offerId} 异常: ${e.message}`);
            }
        }

        // 2. 如果有 identitySecret，自动做 TOTP 令牌确认
        let totp_confirmed = 0, totp_errors = [];
        if (identitySecret && accepted.length > 0) {
            await new Promise(r => setTimeout(r, 2000)); // 等 Steam 处理

            try {
                const tConf = Math.floor(Date.now() / 1000);
                const kConf = SteamTotp.getConfirmationKey(identitySecret, tConf, 'conf');
                const confs = await withTimeout(
                    new Promise((resolve, reject) => {
                        community.getConfirmations(tConf, kConf, (e, c) => e ? reject(e) : resolve(c || []));
                    }), 12000, `${acc.name} 获取确认列表`
                );

                console.log(`[接受报价] ${acc.name} 找到 ${confs.length} 个待确认项，开始批量确认...`);

                for (const conf of confs) {
                    try {
                        const tAllow = Math.floor(Date.now() / 1000);
                        const opKey = SteamTotp.getConfirmationKey(identitySecret, tAllow, 'allow');
                        await withTimeout(
                            new Promise((resolve, reject) => {
                                community.respondToConfirmation(conf.id, conf.key, tAllow, opKey, true, (e) => e ? reject(e) : resolve());
                            }), 12000, `${acc.name} 确认 ${conf.id}`
                        );
                        totp_confirmed++;
                        console.log(`[接受报价] ✅ ${acc.name} 令牌确认 ${conf.id} 成功`);
                        await new Promise(r => setTimeout(r, 300));
                    } catch (ce) {
                        totp_errors.push({ confId: conf.id, error: ce.message });
                        console.error(`[接受报价] ❌ ${acc.name} 令牌确认 ${conf.id} 失败: ${ce.message}`);
                    }
                }
            } catch (e) {
                totp_errors.push({ error: `获取确认列表失败: ${e.message}` });
            }
        }

        const summary = `[接受报价] ✅ ${acc.name}: 接受 ${accepted.length}/${offerIds.length} 个报价，令牌确认 ${totp_confirmed} 个`;
        console.log(summary);
        writeLog(TRANSFER_LOG, summary);

        res.json({
            success: true,
            totalFound: offerIds.length,
            accepted: accepted.length,
            acceptErrors,
            totp_confirmed,
            totp_errors
        });
    } catch (e) {
        console.error(`[接受报价] ${acc.name} 失败: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔓 将指定账号的 Steam 库存设置为公开（保留私密性其他设置）
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/set-public-inventory', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: '缺少 accountId' });

    const allAccounts = await db.readAccounts();
    const acc = allAccounts.find(a => String(a.id) === String(accountId));
    if (!acc) return res.status(404).json({ error: '账号不存在' });
    if (!acc.mafileContent) return res.status(400).json({ error: '没有 maFile，无法使用该功能' });

    const SteamCommunity = require('steamcommunity');

    try {
        const mafile = JSON.parse(acc.mafileContent);
        const refreshToken = mafile?.Session?.RefreshToken;
        if (!refreshToken) throw new Error('无 RefreshToken');

        // 刷新 Cookie
        const sessionResult = await withTimeout(
            steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
            20000, `${acc.name} 隐私设置前刷新Cookie`
        );
        if (!sessionResult?.cookieArray) throw new Error('Cookie 刷新失败');

        let proxyUrl = getProxyAgent('https://steamcommunity.com');
        let community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
        community.setCookies(sessionResult.cookieArray);

        await withTimeout(
            new Promise((resolve, reject) => {
                community.profileSettings({
                    inventory: SteamCommunity.PrivacyState.Public
                }, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            }), 40000, `${acc.name} 设置库存公开`
        );

        console.log(`[设置隐私] ✅ ${acc.name} 库存已成功设置为公开`);
        res.json({ success: true });
    } catch (e) {
        console.error(`[设置隐私] ❌ ${acc.name} 失败: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🗑️ 撤销所有待接受的已发出报价（清理上次转移遗留的 Active 报价）
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/cancel-sent-offers', async (req, res) => {
    const { accountIds } = req.body; // 可选：指定账号ID数组；不传则处理全部有 maFile 的账号
    const allAccounts = await db.readAccounts();
    const targets = accountIds && accountIds.length > 0
        ? allAccounts.filter(a => accountIds.includes(String(a.id)) && a.mafileContent)
        : allAccounts.filter(a => a.mafileContent && a.steamCookie);

    const results = [];
    const CONCURRENCY = 5;
    let idx = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
        while (idx < targets.length) {
            const acc = targets[idx++];
            const accResult = { accountId: acc.id, accountName: acc.name, cancelled: [], errors: [] };
            try {
                // 刷新 Cookie
                const mafile = JSON.parse(acc.mafileContent);
                const refreshToken = mafile?.Session?.RefreshToken;
                if (!refreshToken) throw new Error('无 RefreshToken');
                const sessionResult = await withTimeout(
                    steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
                    25000, `${acc.name} Cookie刷新`
                );
                if (!sessionResult?.cookieArray) throw new Error('Cookie 刷新失败');
                const cookieStr = sessionResult.cookieArray.join('; ');
                const sessionid = (sessionResult.cookieArray.find(c => c.startsWith('sessionid=')) || '').replace('sessionid=', '').trim();

                // 拉取已发出的报价列表（state=2 = Active）
                const offersResp = await steamRequest(
                    `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?key=${process.env.STEAM_API_KEY || ''}&get_sent_offers=1&active_only=1&time_historical_cutoff=0`,
                    { method: 'GET', validateStatus: () => true, headers: { 'Cookie': cookieStr } }, 2
                );

                let offerIds = [];
                if (offersResp.data?.response?.trade_offers_sent) {
                    offerIds = offersResp.data.response.trade_offers_sent
                        .filter(o => o.trade_offer_state === 2) // 2 = Active
                        .map(o => o.tradeofferid);
                } else {
                    // 如果没有 API key，用 Steam Community 页面接口
                    const pageResp = await steamRequest(
                        `https://steamcommunity.com/id/${acc.steamId64}/tradeoffers/sent/?l=schinese`,
                        { method: 'GET', validateStatus: () => true, headers: { 'Cookie': cookieStr } }, 1
                    );
                    // 从 HTML 里提取 offerID（fallback）
                    const matches = (typeof pageResp.data === 'string' ? pageResp.data : '').matchAll(/tradeoffer_(\d+)/g);
                    for (const m of matches) offerIds.push(m[1]);
                    offerIds = [...new Set(offerIds)]; // 去重
                }

                console.log(`[撤销报价] ${acc.name} 找到 ${offerIds.length} 个 Active 报价，开始撤销...`);

                // 逐个撤销
                for (const offerId of offerIds) {
                    try {
                        const cancelParams = new URLSearchParams({ sessionid });
                        const cancelResp = await steamRequest(
                            `https://steamcommunity.com/tradeoffer/${offerId}/cancel`,
                            {
                                method: 'POST',
                                data: cancelParams.toString(),
                                headers: {
                                    'Cookie': cookieStr,
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'Referer': `https://steamcommunity.com/tradeoffer/${offerId}/`,
                                    'Origin': 'https://steamcommunity.com',
                                },
                                timeout: 10000,
                                validateStatus: () => true,
                            }, 1
                        );
                        if (cancelResp.status === 200 && !cancelResp.data?.strError) {
                            accResult.cancelled.push(offerId);
                            console.log(`[撤销报价] ✅ ${acc.name} 报价 #${offerId} 已撤销`);
                            writeLog(TRANSFER_LOG, `[撤销报价] ✅ ${acc.name}(${acc.id}) 报价 #${offerId} 已撤销`);
                        } else {
                            const err = cancelResp.data?.strError || `HTTP ${cancelResp.status}`;
                            accResult.errors.push({ offerId, error: err });
                            console.warn(`[撤销报价] ❌ ${acc.name} 报价 #${offerId} 撤销失败: ${err}`);
                        }
                        await new Promise(r => setTimeout(r, 300)); // 避免触发限频
                    } catch (ce) {
                        accResult.errors.push({ offerId, error: ce.message });
                    }
                }
            } catch (e) {
                accResult.errors.push({ error: e.message });
                console.error(`[撤销报价] ${acc.name} 处理失败: ${e.message}`);
            }
            results.push(accResult);
        }
    });

    await Promise.all(workers);
    const totalCancelled = results.reduce((s, r) => s + r.cancelled.length, 0);
    res.json({ success: true, totalCancelled, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// 📦 库存转移 — 向指定账号发送交易报价
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/send-trade-offer', async (req, res) => {
    const { fromAccountId, toTradeUrl, assetIds } = req.body;
    if (!fromAccountId || !toTradeUrl || !Array.isArray(assetIds) || assetIds.length === 0) {
        return res.status(400).json({ error: '缺少必要参数: fromAccountId, toTradeUrl, assetIds' });
    }
    const allAccounts = await db.readAccounts();
    const acc = allAccounts.find(a => String(a.id) === String(fromAccountId));
    if (!acc) return res.status(404).json({ error: '账号不存在' });
    if (!acc.mafileContent) return res.status(400).json({ error: '该账号没有 maFile，无法进行会话刷新' });
    if (!acc.steamId64) return res.status(400).json({ error: '该账号缺少 SteamID64' });

    try {
        // 从 maFile 中取出 RefreshToken（maFile Token 是 Mobile 平台，必须用 steamRefreshSession）
        const mafile = JSON.parse(acc.mafileContent);
        const refreshToken = mafile?.Session?.RefreshToken;
        if (!refreshToken) return res.status(400).json({ error: 'maFile 中没有 RefreshToken，请重新绑定令牌' });

        // steamRefreshSession: GenerateAccessTokenForApp -> MobileApp session -> getWebCookies()
        // 这是处理 Mobile RefreshToken 的正确流程，直接用 WebBrowser LoginSession 会 401
        const sessionResult = await withTimeout(
            steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
            30000, `${acc.name} Cookie刷新`
        );
        if (!sessionResult || !sessionResult.cookieArray) throw new Error('RefreshToken 已失效，请重新扫码绑定令牌');

        const webCookies = sessionResult.cookieArray;
        const cookieString = sessionResult.cookieString;
        const sessionid = (webCookies.find(c => c.startsWith('sessionid=')) || '').replace('sessionid=', '').trim();
        if (!sessionid) throw new Error('刷新 Cookie 成功但缺少 sessionid');

        console.log(`[库存转移] ✅ ${acc.name} Cookie 刷新成功，sessionid=${sessionid.slice(0, 8)}...`);

        // 解析交易 URL
        const urlMatch = toTradeUrl.match(/partner=(\d+)&token=([A-Za-z0-9_-]+)/);
        if (!urlMatch) return res.status(400).json({ error: '交易链接格式无效' });
        const partnerId32 = urlMatch[1];
        const token = urlMatch[2];
        const partnerSteamId64 = String(BigInt(partnerId32) + 76561197960265728n);

        // 构建交易报价 JSON
        const offerJson = JSON.stringify({
            newversion: true,
            version: assetIds.length + 1,
            me: {
                assets: assetIds.map(assetId => ({
                    appid: 730, contextid: '2', amount: 1, assetid: String(assetId),
                })),
                currency: [], ready: false,
            },
            them: { assets: [], currency: [], ready: false },
        });

        const params = new URLSearchParams({
            sessionid,
            serverid: '1',
            partner: partnerSteamId64,
            tradeoffermessage: '库存转移',
            json_tradeoffer: offerJson,
            captcha: '',
            trade_offer_create_params: JSON.stringify({ trade_offer_access_token: token }),
        });

        const resp = await steamRequest(
            'https://steamcommunity.com/tradeoffer/new/send',
            {
                method: 'POST',
                data: params.toString(),
                headers: {
                    'Cookie': cookieString,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': `https://steamcommunity.com/tradeoffer/new/?partner=${partnerId32}&token=${token}`,
                    'Origin': 'https://steamcommunity.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                timeout: 15000,
                validateStatus: () => true,
            },
            3 // retry 3 times on network/429 errors
        );

        if (resp.status !== 200) {
            console.error(`[库存转移] Steam HTTP ${resp.status}:`, JSON.stringify(resp.data).slice(0, 300));
            const errMsg = `Steam 返回 HTTP ${resp.status}: ${JSON.stringify(resp.data)}`;
            writeLog(TRANSFER_LOG, `[库存转移] ❌ ${acc.name}(${acc.id}) 发送失败: ${errMsg}`);
            throw new Error(errMsg);
        }
        const result = resp.data;
        if (result.strError) {
            if (result.strError.includes('(15)')) {
                const err = '交易被限制 (15)：发送方或接收方账号存在 VAC/游戏封禁或且物品处于交易冷却，无法发送报价';
                writeLog(TRANSFER_LOG, `[库存转移] ❌ ${acc.name}(${acc.id}) 发送失败: ${err}`);
                throw new Error(err);
            }
            writeLog(TRANSFER_LOG, `[库存转移] ❌ ${acc.name}(${acc.id}) 发送失败: ${result.strError}`);
            throw new Error(result.strError);
        }
        if (!result.tradeofferid) {
            const errIdMsg = `[库存转移] ❌ ${acc.name} 未返回报价 ID: ${JSON.stringify(result)}`;
            writeLog(TRANSFER_LOG, errIdMsg);
            throw new Error('Steam 未返回报价 ID: ' + JSON.stringify(result));
        }

        const offerId = result.tradeofferid;
        const successMsg = `[库存转移] ✅ ${acc.name}(${acc.id}) → ${partnerId32}: 报价 #${offerId} 已发送 (${assetIds.length} 件)`;
        console.log(successMsg);
        writeLog(TRANSFER_LOG, successMsg);

        // ─────────────────────────────────────────────────────────────────────
        // 全自动转移流程
        // 步骤1: A账号令牌确认「发出报价」
        // 步骤2: B账号接受报价
        // 步骤3: B账号令牌确认「接受」
        // ─────────────────────────────────────────────────────────────────────
        const SteamCommunity = require('steamcommunity');
        const SteamTotp = require('steam-totp');

        // --- 步骤1: 查找并确认 A 账号待确认的报价 ---
        let step1Result = '跳过(无maFile)';
        let step3Result = '跳过(无maFile)';
        try {
            const maA = JSON.parse(acc.mafileContent);
            const identitySecretA = maA?.identity_secret;
            const refreshTokenA = maA?.Session?.RefreshToken;
            if (identitySecretA && refreshTokenA) {
                const sessionA = await withTimeout(
                    steamRefreshSession({ ...acc, refreshToken: refreshTokenA, steamId64: acc.steamId64 }),
                    25000, `${acc.name} A-Cookie刷新`
                );
                if (sessionA?.cookieArray) {
                    let proxyA = getProxyAgent('https://steamcommunity.com');
                    let commA = new SteamCommunity(proxyA ? { httpProxy: proxyA } : {});
                    commA.setCookies(sessionA.cookieArray);
                    const timeA = Math.floor(Date.now() / 1000);
                    const keyA = SteamTotp.getConfirmationKey(identitySecretA, timeA, 'conf');
                    const confsA = await withTimeout(
                        new Promise((resolve, reject) => {
                            commA.getConfirmations(timeA, keyA, (e, c) => e ? reject(e) : resolve(c || []));
                        }), 12000, `${acc.name} 获取确认列表`
                    );
                    // 找到对应 offerId 的确认项
                    const targetConf = confsA.find(c =>
                        c.offerID === String(offerId) || c.id === String(offerId) ||
                        (c.details && String(c.details).includes(String(offerId)))
                    ) || confsA[0]; // 没有 offerID 字段时，取最新一条（刚發的就是第一条）
                    if (targetConf) {
                        const tA = Math.floor(Date.now() / 1000);
                        const opKeyA = SteamTotp.getConfirmationKey(identitySecretA, tA, 'allow');
                        await withTimeout(
                            new Promise((resolve, reject) => {
                                commA.respondToConfirmation(targetConf.id, targetConf.key, tA, opKeyA, true, (e) => e ? reject(e) : resolve());
                            }), 12000, `${acc.name} A-确认报价`
                        );
                        step1Result = `✅ 已确认报价 #${offerId}`;
                        console.log(`[库存转移] 步骤1 ${step1Result}`);
                    } else {
                        step1Result = '⚠️ 未找到匹配的确认项，可能已自动确认';
                    }
                }
            }
        } catch (e1) {
            step1Result = `❌ ${e1.message}`;
            console.error(`[库存转移] 步骤1 A账号确认失败: ${e1.message}`);
        }

        // --- 步骤2 & 3: B账号接受报价并确认 ---
        // 找到 B 账号（接收方）
        let step2Result = '跳过(B账号不在系统中或无maFile)';
        const allAccs = await db.readAccounts();
        // partnerSteamId64 已在上方第2503行声明，此处直接复用
        const accB = allAccs.find(a => String(a.steamId64) === partnerSteamId64);

        if (accB) {
            try {
                const mafileB = accB.mafileContent ? JSON.parse(accB.mafileContent) : null;
                const refreshTokenB = mafileB?.Session?.RefreshToken;
                if (!refreshTokenB) throw new Error('B账号无RefreshToken');

                const sessionB = await withTimeout(
                    steamRefreshSession({ ...accB, refreshToken: refreshTokenB, steamId64: accB.steamId64 }),
                    25000, `${accB.name} B-Cookie刷新`
                );
                if (!sessionB?.cookieArray) throw new Error('B账号Cookie刷新失败');

                // 等待 Steam 处理确认（步骤1完成后需稍等）
                await new Promise(r => setTimeout(r, 2000));

                // 接受报价：POST /tradeoffer/:offerId/accept
                // partner = 发送方(A)的 steamId64，不是接收方自己的 ID
                const sessionidB = (sessionB.cookieArray.find(c => c.startsWith('sessionid=')) || '').replace('sessionid=', '').trim();
                const acceptParams = new URLSearchParams({
                    sessionid: sessionidB,
                    serverid: '1',
                    tradeofferid: String(offerId),
                    partner: acc.steamId64,   // ← A账号的 steamId64（报价发送方）
                    captcha: ''
                });
                const acceptResp = await steamRequest(
                    `https://steamcommunity.com/tradeoffer/${offerId}/accept`,
                    {
                        method: 'POST',
                        data: acceptParams.toString(),
                        headers: {
                            'Cookie': sessionB.cookieArray.join('; '),
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Referer': `https://steamcommunity.com/tradeoffer/${offerId}/`,
                            'Origin': 'https://steamcommunity.com',
                        },
                        timeout: 15000,
                        validateStatus: () => true,
                    }, 2
                );
                if (acceptResp.status !== 200) throw new Error(`接受报价HTTP ${acceptResp.status}`);
                if (acceptResp.data?.strError) throw new Error(acceptResp.data.strError);
                step2Result = `✅ B账号(${accB.name})已接受报价`;
                console.log(`[库存转移] 步骤2 ${step2Result}`);

                // 步骤3: B账号令牌确认接受
                if (mafileB?.identity_secret) {
                    try {
                        await new Promise(r => setTimeout(r, 1500));
                        let proxyB = getProxyAgent('https://steamcommunity.com');
                        let commB = new SteamCommunity(proxyB ? { httpProxy: proxyB } : {});
                        commB.setCookies(sessionB.cookieArray);
                        const tB = Math.floor(Date.now() / 1000);
                        const keyB = SteamTotp.getConfirmationKey(mafileB.identity_secret, tB, 'conf');
                        const confsB = await withTimeout(
                            new Promise((resolve, reject) => {
                                commB.getConfirmations(tB, keyB, (e, c) => e ? reject(e) : resolve(c || []));
                            }), 12000, `${accB.name} B-获取确认列表`
                        );
                        if (confsB.length > 0) {
                            // 找最新的接受确认
                            const confB = confsB.find(c =>
                                c.offerID === String(offerId) || c.id === String(offerId)
                            ) || confsB[0];
                            const tB2 = Math.floor(Date.now() / 1000);
                            const opKeyB = SteamTotp.getConfirmationKey(mafileB.identity_secret, tB2, 'allow');
                            await withTimeout(
                                new Promise((resolve, reject) => {
                                    commB.respondToConfirmation(confB.id, confB.key, tB2, opKeyB, true, (e) => e ? reject(e) : resolve());
                                }), 12000, `${accB.name} B-确认接受`
                            );
                            step3Result = `✅ B账号(${accB.name})令牌确认接受完成`;
                        } else {
                            step3Result = '⚠️ B账号无需令牌确认（已自动完成）';
                        }
                        console.log(`[库存转移] 步骤3 ${step3Result}`);
                    } catch (e3) {
                        step3Result = `❌ ${e3.message}`;
                        console.error(`[库存转移] 步骤3 B账号令牌确认失败: ${e3.message}`);
                    }
                } else {
                    step3Result = '跳过(B账号无identity_secret)';
                }
            } catch (e2) {
                step2Result = `❌ ${e2.message}`;
                console.error(`[库存转移] 步骤2 B账号接受失败: ${e2.message}`);
            }
        }

        const finalMsg = `[库存转移] ✅ 全流程完成: 步1=${step1Result} | 步2=${step2Result} | 步3=${step3Result}`;
        console.log(finalMsg);
        writeLog(TRANSFER_LOG, finalMsg);

        res.json({
            success: true,
            offerId,
            message: `报价 #${offerId} 全流程完成`,
            steps: { confirm: step1Result, accept: step2Result, confirmAccept: step3Result }
        });
    } catch (e) {
        console.error(`[库存转移] ❌ ${acc.name} 发送失败: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔑 令牌确认 — 获取账号待确认交易列表
// ─────────────────────────────────────────────────────────────────────────────

// 来源平台关键词识别（同时支持内部转移：接收方为库中账号即标记为「库存转移」）
function detectTradeSource(title, allAccounts) {
    const text = (title || '').toLowerCase();
    // 优先关键词匹配
    const platforms = [
        { name: 'BUFF',     icon: '🟠', color: '#f97316', keywords: ['buff_', 'buff163', 'netease', 'buff bot'] },
        { name: '悠悠有品', icon: '🟣', color: '#a855f7', keywords: ['youyou', '悠悠', 'uu163', 'uuyp'] },
        { name: 'C5Game',   icon: '🔵', color: '#38bdf8', keywords: ['c5game', 'c5_bot', 'c5 bot'] },
        { name: '库存转移', icon: '📦', color: '#22c55e', keywords: ['库存转移'] },
        { name: '交易市场', icon: '🏪', color: '#f59e0b', keywords: ['steam market', 'community market'] },
    ];
    for (const p of platforms) {
        if (p.keywords.some(k => text.includes(k))) return p;
    }
    // 「Trade Offer - <username>」格式 → 提取用户名匹配数据库账号
    if (allAccounts && Array.isArray(allAccounts)) {
        const m = (title || '').match(/Trade Offer\s*-\s*(.+)$/i);
        if (m) {
            const partnerName = m[1].trim().toLowerCase();
            const matched = allAccounts.find(a => 
                (a.name || '').toLowerCase() === partnerName ||
                (a.personaName || '').toLowerCase() === partnerName
            );
            if (matched) return { name: '库存转移', icon: '📦', color: '#22c55e', matchedAccount: matched.name || matched.personaName };
            
            // 调试用：没有匹配到说明数据库里没存对
            console.log(`[调试] 无法匹配用户名: "${partnerName}"。当前首个账号为: name=${allAccounts[0]?.name}, personaName=${allAccounts[0]?.personaName}`);
        }
    }
    return { name: '普通用户', icon: '👤', color: '#94a3b8' };
}

// 核心拉取函数（可被 send-trade-offer 调用写缓存）
async function fetchAndCacheConfirmations(acc) {
    const SteamCommunity = require('steamcommunity');
    const SteamTotp = require('steam-totp');
    const allAccounts = await db.readAccounts();

    if (!acc.mafileContent) return null;
    let identitySecret = null, refreshToken = null;
    try {
        const parsed = JSON.parse(acc.mafileContent);
        identitySecret = parsed.identity_secret;
        refreshToken = parsed?.Session?.RefreshToken;
    } catch (_) { return null; }
    if (!identitySecret || !refreshToken) return null;

    let sessionResult = await withTimeout(
        steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
        25000, `${acc.name} Cookie刷新`
    );

    if (!sessionResult || !sessionResult.cookieArray) {
        if (acc.accountPassword) {
            console.log(`[令牌确认] ⚠️ ${acc.name} RefreshToken 已失效，正在尝试使用密码自动重登...`);
            try {
                const reloginResult = await reloginWithPassword(acc);
                console.log(`[令牌确认] ✅ ${acc.name} 自动重登成功，开始使用新 Token 刷新 Cookie...`);
                acc.mafileContent = reloginResult.newMafileContent;
                refreshToken = reloginResult.newRefreshToken;
                sessionResult = await withTimeout(
                    steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
                    25000, `${acc.name} 新Token刷新`
                );
                if (!sessionResult || !sessionResult.cookieArray) throw new Error('使用新Token刷新Cookie失败');
            } catch (reloginErr) {
                throw new Error(`RefreshToken 已失效 (尝试自动重登失败: ${reloginErr.message})`);
            }
        } else {
            throw new Error('RefreshToken 已失效 (未保存密码，无法自动重登)');
        }
    }

    let proxyUrl = getProxyAgent('https://steamcommunity.com');
    let community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
    community.setCookies(sessionResult.cookieArray);

    const time = Math.floor(Date.now() / 1000);
    const key = SteamTotp.getConfirmationKey(identitySecret, time, 'conf');

    // getConfirmations 加重试逻辑：429 指数退避+强制换IP（最多 3 次）
    const MAX_RETRIES = 3;
    let confirmations = [];
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const t = Math.floor(Date.now() / 1000);
        const k = SteamTotp.getConfirmationKey(identitySecret, t, 'conf');
        try {
            confirmations = await withTimeout(
                new Promise((resolve, reject) => {
                    community.getConfirmations(t, k, (err, confs) => {
                        if (err) return reject(err);
                        resolve(confs || []);
                    });
                }),
                12000, `${acc.name} 获取确认列表`
            );
            break; // 成功，退出重试循环
        } catch (e) {
            const is429 = /429|rate.?limit|too many|timeout/i.test(e.message);
            if (is429 && attempt < MAX_RETRIES) {
                const wait = 2000 * Math.pow(2, attempt - 1); // 2s / 4s / 8s
                console.warn(`[令牌确认] ⚠️ ${acc.name} 429/超时，${attempt}/${MAX_RETRIES}，换IP并等待 ${wait}ms...`);
                await new Promise(r => setTimeout(r, wait));
                // 核心修复：重新获取一个全新 IP 并重建实例
                proxyUrl = getProxyAgent('https://steamcommunity.com');
                community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
                community.setCookies(sessionResult.cookieArray);
            } else {
                throw e; // 非 429 或已达最大重试次数，手动抛出
            }
        }
    }

    const toNameList = (val) => {
        // 库返回的 sending/receiving 是字符串（来自 conf.summary[0/1]），不是对象数组
        if (!val) return [];
        if (typeof val === 'string') return val ? [val] : [];
        if (Array.isArray(val)) return val.map(i =>
            typeof i === 'string' ? i : (i.name || i.market_hash_name || '未知物品')
        );
        return [];
    };

    const formatted = confirmations.map(c => {
        // c.time 是 ISO string（库源码第52行），转为 unix 秒供前端 fmtTime 使用
        const ts = c.timestamp
            ? Math.floor(c.timestamp.getTime() / 1000)
            : (typeof c.time === 'string' ? Math.floor(new Date(c.time).getTime() / 1000) : (c.time || time));
        const source = detectTradeSource(c.title || '', allAccounts);
        return {
            id: c.id,
            key: c.nonce || c.key,
            title: c.title || '待确认交易',
            sending: toNameList(c.sending),
            receiving: toNameList(c.receiving),
            time: isNaN(ts) ? time : ts,
            source
        };
    });

    const record = { accountId: acc.id, accountName: acc.name, confirmations: formatted };
    // 写入内存缓存
    confirmationCache.set(String(acc.id), { result: record, fetchedAt: Date.now() });
    console.log(`[令牌缓存] ✅ ${acc.name}: 缓存 ${formatted.length} 条确认`);
    return record;
}

app.post('/api/accounts/get-confirmations', async (req, res) => {
    const { accountIds, useCache } = req.body;
    const allAccounts = await db.readAccounts();
    const targets = accountIds && accountIds.length > 0
        ? allAccounts.filter(a => accountIds.includes(String(a.id)))
        : allAccounts;

    // 如果请求携带 useCache=true（UI 打开时），只返回缓存数据并立刻结束，绝不触发实际拉取
    if (useCache) {
        const cached = [];
        for (const acc of targets) {
            const hit = confirmationCache.get(String(acc.id));
            if (hit) cached.push(hit.result);
        }
        return res.json({ results: cached, fromCache: true });
    }

    // 并发 10 个账号同时拉取，批次之间加间隔防止触发 429
    const CONCURRENCY = 10;
    const results = [];
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async acc => {
            try {
                return await fetchAndCacheConfirmations(acc);
            } catch (e) {
                console.warn(`[令牌确认] ⚠️ ${acc.name} 失败: ${e.message}`);
                return { accountId: acc.id, accountName: acc.name, confirmations: [], error: e.message };
            }
        }));
        for (const r of batchResults) {
            if (r && (r.confirmations.length > 0 || r.error)) results.push(r);
        }
        // 批次之间等待（最后一批不需要等）
        if (i + CONCURRENCY < targets.length) {
            await new Promise(r => setTimeout(r, 600));
        }
    }

    res.json({ results });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔑 令牌确认 — TOTP 批量确认交易
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/accounts/confirm-trades', async (req, res) => {
    const { confirmations } = req.body; // [{accountId, confirmationId, confirmationKey}]
    if (!Array.isArray(confirmations) || confirmations.length === 0) {
        return res.status(400).json({ error: '需要 confirmations 数组' });
    }
    const allAccounts = await db.readAccounts();
    const results = [];

    // 按 accountId 分组处理
    const byAccount = {};
    for (const c of confirmations) {
        if (!byAccount[c.accountId]) byAccount[c.accountId] = [];
        byAccount[c.accountId].push(c);
    }

    const accountEntries = Object.entries(byAccount);
    const CONCURRENCY = 10;
    
    for (let i = 0; i < accountEntries.length; i += CONCURRENCY) {
        const batch = accountEntries.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ([accountId, confs]) => {
            const acc = allAccounts.find(a => String(a.id) === String(accountId));
            if (!acc || !acc.mafileContent) {
                confs.forEach(c => results.push({ accountId, confirmationId: c.confirmationId, success: false, error: '账号或 maFile 不可用' }));
                return;
            }

            let identitySecret = null;
            try {
                const parsed = JSON.parse(acc.mafileContent);
                identitySecret = parsed.identity_secret;
            } catch (_) { }
            if (!identitySecret) {
                confs.forEach(c => results.push({ accountId, confirmationId: c.confirmationId, success: false, error: '找不到 identity_secret' }));
                return;
            }

            try {
                // 用 steamRefreshSession 正确处理 Mobile 平台 RefreshToken
                const mafileParsed = JSON.parse(acc.mafileContent);
                let refreshTokenForConfirm = mafileParsed?.Session?.RefreshToken;
                if (!refreshTokenForConfirm) throw new Error('maFile 中没有 RefreshToken');
                let sessionResult = await withTimeout(
                    steamRefreshSession({ ...acc, refreshToken: refreshTokenForConfirm, steamId64: acc.steamId64 }),
                    25000, `${acc.name} Cookie刷新`
                );

                if (!sessionResult || !sessionResult.cookieArray) {
                    if (acc.accountPassword) {
                        console.log(`[令牌确认] ⚠️ ${acc.name} RefreshToken 已失效，正在尝试使用密码自动重登...`);
                        try {
                            const reloginResult = await reloginWithPassword(acc);
                            console.log(`[令牌确认] ✅ ${acc.name} 自动重登成功，开始使用新 Token 刷新 Cookie...`);
                            acc.mafileContent = reloginResult.newMafileContent;
                            refreshTokenForConfirm = reloginResult.newRefreshToken;
                            sessionResult = await withTimeout(
                                steamRefreshSession({ ...acc, refreshToken: refreshTokenForConfirm, steamId64: acc.steamId64 }),
                                25000, `${acc.name} 新Token刷新`
                            );
                            if (!sessionResult || !sessionResult.cookieArray) throw new Error('使用新Token刷新Cookie失败');
                        } catch (reloginErr) {
                            throw new Error(`RefreshToken 已失效 (尝试自动重登失败: ${reloginErr.message})`);
                        }
                    } else {
                        throw new Error('RefreshToken 已失效 (未配置密码，无法自动重登)');
                    }
                }

                const SteamCommunity = require('steamcommunity');
                const SteamTotp = require('steam-totp');
                let proxyUrl = getProxyAgent('https://steamcommunity.com');
                let community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
                community.setCookies(sessionResult.cookieArray);

                for (const conf of confs) {
                    let success = false;
                    let attemptError = null;
                    const MAX_RETRIES = 3;
                    
                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        try {
                            const time = Math.floor(Date.now() / 1000);
                            // action: 'allow'=确认, 'deny'=拒绝
                            // 库源码第115行: tag = accept ? 'allow' : 'cancel'（拒绝用 'cancel' 不是 'deny'）
                            const action = conf.action === 'deny' ? 'deny' : 'allow';
                            const totp_tag = action === 'allow' ? 'allow' : 'cancel';
                            const accept = action === 'allow';
                            const opKey = SteamTotp.getConfirmationKey(identitySecret, time, totp_tag);

                            await new Promise((resolve, reject) => {
                                community.respondToConfirmation(conf.confirmationId, conf.confirmationKey, time, opKey, accept, (err) => {
                                    if (err) return reject(err);
                                    resolve();
                                });
                            });
                            
                            const actionLabel = accept ? '✅ 已确认' : '❌ 已拒绝';
                            console.log(`[令牌确认操作] ${actionLabel} ${acc.name}: #${conf.confirmationId}`);
                            results.push({ accountId, confirmationId: conf.confirmationId, accountName: acc.name, success: true, action });
                            const logLabel = (action === 'allow' ? '确认' : '拒绝');
                            writeLog(CONFIRM_LOG, `[令牌确认] ✅ ${acc.name}(${acc.id}): ${logLabel}成功, ID=${conf.confirmationId}`);
                            success = true;
                            break;
                        } catch (e) {
                            attemptError = e;
                            const is429 = /429|rate.?limit|too many|timeout/i.test(e.message);
                            if (is429 && attempt < MAX_RETRIES) {
                                const wait = 2000 * Math.pow(2, attempt - 1);
                                console.warn(`[令牌确认操作] ⚠️ ${acc.name} 429/超时，${attempt}/${MAX_RETRIES}，换IP并等待 ${wait}ms...`);
                                await new Promise(r => setTimeout(r, wait));
                                proxyUrl = getProxyAgent('https://steamcommunity.com');
                                community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
                                community.setCookies(sessionResult.cookieArray);
                            } else {
                                break;
                            }
                        }
                    }
                    if (!success) {
                        const err = attemptError?.message || '未知错误';
                        console.warn(`[令牌确认操作] ❌ ${acc.name}: #${conf.confirmationId} 失败: ${err}`);
                        results.push({ accountId, confirmationId: conf.confirmationId, accountName: acc.name, success: false, error: err });
                        const logLabel = (action === 'allow' ? '确认' : '拒绝');
                        writeLog(CONFIRM_LOG, `[令牌确认] ❌ ${acc.name}(${acc.id}): ${logLabel}失败, ID=${conf.confirmationId}, 原因=${err}`);
                    }
                    await new Promise(r => setTimeout(r, 600)); // 确空间隔加长防连击
                }
            } catch (e) {
                confs.forEach(c => results.push({ accountId, confirmationId: c.confirmationId, success: false, error: e.message }));
                writeLog(CONFIRM_LOG, `[令牌确认] ❌ ${acc.name}(${acc.id}): 账号级错误, 原因=${e.message}`);
            }
        }));
    }

    res.json({ results });
});



app.get('/api/accounts', async (req, res) => {
    const accounts = await readAccounts();
    res.json(accounts);
});

app.post('/api/accounts', async (req, res) => {
    const accounts = req.body;
    if (!Array.isArray(accounts)) return res.status(400).json({ error: '需要账号数组' });
    await writeAccounts(accounts);
    res.json({ success: true });
});

// DELETE /api/accounts/:id — 删除单个账号（避免发送大型 inventoryData 导致 413）
app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const accounts = await readAccounts();
    const idx = accounts.findIndex(a => String(a.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: '账号不存在' });
    const removed = accounts.splice(idx, 1)[0];
    await writeAccounts(accounts);
    console.log(`[账号] 已删除: ${removed.name} (${id})`);
    res.json({ success: true, deleted: removed.name });
});



/**
 * 使用有效的 Cookie 通过纯 HTTP API 获取账号数据（余额、库存、交易链接）
 * 完全不需要 Puppeteer，速度更快更稳定
 */
async function fetchAccountDataViaApi(acc, cookieString) {
    const steamId64 = acc.steamId64;
    // 通用请求封装：自动走 Webshare 住宅 IP 代理池
    const proxyGet = async (url, cookie) => {
        const res = await steamRequest(url, {
            method: 'GET',
            validateStatus: () => true,   // 任何 HTTP 状态都返回，不抛出
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Cookie': cookie
            }
        });
        return { status: res.status, data: res.data };
    };

    const result = { balance: null, inventoryCount: null, tradeUrl: null, inventoryData: null };

    // 1. 获取余额（通过 Steam 钉包 API）
    try {
        const balRes = await proxyGet('https://store.steampowered.com/api/GetClientWalletDetails/v1/?language=schinese', cookieString);
        if (balRes.status === 200) {
            const j = typeof balRes.data === 'string' ? JSON.parse(balRes.data) : balRes.data;
            const wallet = j?.response;
            if (wallet?.has_wallet) {
                // Steam API 返回整数分为单位，需要除以 100
                const amount = wallet.balance / 100;
                const currency = wallet.currency;
                const symbols = { 'CNY': '¥', 'USD': '$', 'EUR': '€', 'GBP': '£', 'SGD': 'S$', 'HKD': 'HK$' };
                const sym = symbols[currency] || currency;
                result.balance = `${sym} ${amount.toFixed(2)}`;
                console.log(`[API同步] ✅ ${acc.name} 余额: ${result.balance}`);
            }
        }
    } catch (e) { console.warn(`[API同步] ⚠️ ${acc.name} 获取余额失败: ${e.message}`); }

    // 2. 获取库存
    try {
        let allAssets = [], allDescriptions = [], descSeen = new Set(), lastId = null, total = null, pageCount = 0;
        for (let p = 0; p < 30; p++) {
            let url = `https://steamcommunity.com/inventory/${steamId64}/730/2?l=schinese&count=200`;
            if (lastId) url += `&start_assetid=${lastId}`;
            const invRes = await proxyGet(url, cookieString);
            if (invRes.status !== 200) {
                console.warn(`[API同步] ⚠️ ${acc.name} 库存请求失败 HTTP ${invRes.status}`);
                break;
            }
            const data = typeof invRes.data === 'string' ? JSON.parse(invRes.data) : invRes.data;
            if (p === 0) total = data.total_inventory_count;
            (data.assets || []).forEach(a => allAssets.push(a));
            (data.descriptions || []).forEach(d => {
                const k = `${d.classid}_${d.instanceid}`;
                if (!descSeen.has(k)) { descSeen.add(k); allDescriptions.push(d); }
            });
            pageCount++;
            if (data.more_items && data.last_assetid) { lastId = data.last_assetid; await new Promise(r => setTimeout(r, 600)); }
            else break;
        }
        result.inventoryCount = total || allAssets.length;
        result.inventoryData = { total: result.inventoryCount, assets: allAssets, descriptions: allDescriptions, updateTime: new Date().toISOString() };
        console.log(`[API同步] ✅ ${acc.name} 库存: ${result.inventoryCount} 件饲品 (${pageCount} 页)`);
    } catch (e) { console.warn(`[API同步] ⚠️ ${acc.name} 获取库存失败: ${e.message}`); }

    // 3. 获取交易链接 token
    try {
        const privacyRes = await proxyGet(`https://steamcommunity.com/profiles/${steamId64}/tradeoffers/privacy`, cookieString);
        if (privacyRes.status === 200) {
            const body = typeof privacyRes.data === 'string' ? privacyRes.data : JSON.stringify(privacyRes.data);
            const tokenMatch = body.match(/trade_offer_access_url['":\s]+https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=([A-Za-z0-9_-]+)/);
            if (tokenMatch) {
                // 需要将 steamId64 转为 32位 AccountID
                const accountId32 = String(BigInt(steamId64) - 76561197960265728n);
                result.tradeUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${accountId32}&token=${tokenMatch[1]}`;
                console.log(`[API同步] ✅ ${acc.name} 交易链接已获取`);
            }
        }
    } catch (e) { console.warn(`[API同步] ⚠️ ${acc.name} 获取交易链接失败: ${e.message}`); }

    return result;
}

/**
 * Core Sync Logic: Scrape balance and fetch inventory
 */
async function syncAccountInventory(id, options = { force: false, isAuto: false }) {
    if (activeSyncs.has(id)) {
        throw new Error('该账号同步任务已在运行中');
    }
    activeSyncs.add(id);

    let browser;
    try {
        let accounts = await readAccounts();
        const acc = accounts.find(a => a.id === id);
        if (!acc) throw new Error('未找到账号');

        // Removed: console.log(`[资产同步] >>> 同步开始${options.isAuto ? ' (自动)' : ''}: "${acc.name}" (ID: ${id})`);

        // ══════════════════════════════════════════════
        // 🚀 快速路径：RefreshToken → 纯 API 同步（无 Puppeteer）
        // 优先级最高，只要 maFile 中有有效的 RefreshToken 即可使用
        // ══════════════════════════════════════════════
        if (acc.refreshToken) {
            console.log(`[资产同步] 🔑 账号 ${acc.name} 有 RefreshToken，尝试免浏览器 API 快速同步...`);
            const freshCookie = await steamRefreshSession(acc);

            if (freshCookie) {
                // 更新账号的 Cookie 缓存
                acc.steamCookie = freshCookie;

                // 拉取数据（余额 + 库存 + 交易链接）
                const apiData = await fetchAccountDataViaApi(acc, freshCookie);

                // 更新并写回账号信息
                if (apiData.balance) acc.balance = apiData.balance;
                if (apiData.tradeUrl) acc.tradeUrl = apiData.tradeUrl;
                if (apiData.inventoryCount !== null) acc.inventoryValue = `${apiData.inventoryCount} 件饰品`;
                acc.steamId64 = acc.steamId64;
                acc.lastSync = new Date().toISOString();

                if (apiData.inventoryData) {
                    await fs.mkdir(path.join(__dirname, 'inventories'), { recursive: true }).catch(() => { });
                    await fs.writeFile(
                        path.join(__dirname, 'inventories', `${id}.json`),
                        JSON.stringify(apiData.inventoryData, null, 2)
                    );
                }

                let latestAccounts = await readAccounts();
                const idx = latestAccounts.findIndex(a => a.id === id);
                if (idx !== -1) { latestAccounts[idx] = acc; await writeAccounts(latestAccounts); }

                console.log(`[资产同步] ✅ 账号 ${acc.name} API 快速同步完成（余额=${acc.balance}, 库存=${acc.inventoryValue}）`);
                activeSyncs.delete(id);
                return acc;
            } else {
                console.warn(`[资产同步] ⚠️ ${acc.name} RefreshToken 刷新失败，降级到浏览器模式...`);
            }
        }

        // ══════════════════════════════════════════════
        // 🌐 标准路径：Puppeteer 浏览器模式（无 RefreshToken 时使用）
        // ══════════════════════════════════════════════
        const isFirefox = acc.browserType === 'firefox';

        let targetProfilePath = acc.profilePath;
        if (!targetProfilePath) {
            const fs = require('fs');
            targetProfilePath = path.join(__dirname, 'profiles', `acc_${Date.now() + Math.floor(Math.random() * 1000)}`);
            try { fs.mkdirSync(targetProfilePath, { recursive: true }); } catch (e) { }
            acc.profilePath = targetProfilePath;
            acc.browserType = 'edge';
            acc.browserPath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
            await db.upsertAccount({ ...acc });
            console.log(`[隔离环境修复] 为账号 ${acc.name} 自动生成并补齐独立浏览器配置路径: ${targetProfilePath}`);
        }

        const userDataDir = targetProfilePath;

        // isAuto normally avoids closing user browser, but force (e.g. 502 verification) overrides it.
        if (options.isAuto && !options.force) {
            console.log(`[资产同步] 检测到 ${acc.name} 的浏览器锁定，跳过以避免关闭用户窗口。`);
            return;
        }

        if (options.force) {
            // killProcessesUsingProfile now handles its own status logging and only reports if it did something
            const killedCount = await killProcessesUsingProfile(userDataDir, acc.browserType, acc.profile, acc.name);

            if (killedCount > 0) {
                // For Chromium-based browsers, clear common lock files that might persist after a crash/kill
                if (!isFirefox) {
                    try {
                        // SingletonLock and lockfile are common Chromium lock file names
                        await fs.unlink(path.join(userDataDir, 'SingletonLock')).catch(() => { });
                        await fs.unlink(path.join(userDataDir, 'lockfile')).catch(() => { });
                    } catch (err) {
                        console.warn('[资产同步] 无法删除部分锁定文件:', err.message);
                    }
                }
                await new Promise(r => setTimeout(r, 3000)); // Increased to 3s for OS to release files
            }
        }

        const defaultEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        const defaultFirefox = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
        let targetPath = acc.browserPath || (isFirefox ? defaultFirefox : defaultEdge);

        const launchOptions = {
            executablePath: targetPath,
            headless: true,
            userDataDir: userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        };

        if (isFirefox) {
            try { await fs.unlink(path.join(userDataDir, 'parent.lock')).catch(() => { }); } catch (e) { }
            launchOptions.product = 'firefox';
            launchOptions.headless = 'new';
            process.env.PUPPETEER_PRODUCT = 'firefox';
            launchOptions.args.push('--marionette', '--wait-for-browser', '--no-remote');
        } else {
            if (!acc.profilePath || acc.profilePath.includes('Default')) {
                if (!acc.profilePath) launchOptions.args.push(`--profile-directory=${acc.profile || 'Default'}`);
            }
        }

        try {
            browser = await puppeteer.launch(launchOptions);
        } catch (e) {
            console.error('\n[Puppeteer Error Full]:\n', e);
            throw new Error(`无法启动浏览器（可能已打开或被锁定）: ${e.message}`);
        }

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.setCacheEnabled(false);

        // --- INJECT PRE-EXISTING COOKIE FOR TOKEN BOUND ACCOUNTS ---
        if (acc.steamCookie) {
            try {
                const cookieParts = acc.steamCookie.split(';').map(p => p.trim()).filter(p => p);
                const pCookies = [];
                for (const part of cookieParts) {
                    const eqIdx = part.indexOf('=');
                    if (eqIdx > 0) {
                        const name = part.substring(0, eqIdx).trim();
                        const value = part.substring(eqIdx + 1).trim();
                        if (name) {
                            pCookies.push({ name, value, domain: '.steampowered.com' });
                            pCookies.push({ name, value, domain: '.steamcommunity.com' });
                        }
                    }
                }
                if (pCookies.length > 0) {
                    await page.setCookie(...pCookies);
                    // console.log(`[资产同步] 已向无头模式预注入 Cookie`);
                }
            } catch (e) {
                console.warn('[资产同步] Cookie 注入失败:', e.message);
            }
        }
        // -----------------------------------------------------------

        // 1. Balance - With RETRY for network issues like ERR_CONNECTION_RESET
        let navSuccess = false;
        for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
            try {
                await page.goto('https://store.steampowered.com/', { waitUntil: 'load', timeout: 60000 });
                navSuccess = true;
                break;
            } catch (e) {
                console.warn(`[资产同步] 导航尝试第 ${navAttempt} 次失败，账号 ${acc.name}: ${e.message}`);
                if (navAttempt < 3) await new Promise(r => setTimeout(r, 2000));
            }
        }
        if (!navSuccess) throw new Error(`Steam 商店加载失败: ${acc.name} 连接被重置或超时`);

        const balanceSelector = '#header_wallet_balance';
        await page.waitForSelector(balanceSelector, { timeout: 10000 }).catch(() => { });

        let balance = '¥ 0.00';
        try {
            balance = await page.$eval(balanceSelector, el => {
                let text = el.innerText.trim().replace(/\n+/g, ' ');
                const match = text.match(/^(.*?)(Pending|待处理|待入账)[:：]?\s*(.*)$/i);
                return match ? `${match[1].trim()} (待处理: ${match[3].trim()})` : text;
            });
        } catch (e) { }

        // 2. SteamID64
        let steamId64 = acc.steamId64;
        if (!steamId64) {
            await page.goto('https://steamcommunity.com/my/', { waitUntil: 'load', timeout: 60000 });
            const html = await page.content();
            const match = html.match(/g_rgProfileData\s*=\s*{\s*"url":\s*"https:\\\/\\\/steamcommunity\.com\\\/profiles\\\/(\d+)\\\/"/);
            if (match) steamId64 = match[1];
        }

        let hasValidWebSession = false;
        try {
            hasValidWebSession = await page.evaluate(() => {
                const text = document.body.innerText;
                return !text.includes('登录') && !text.includes('Login') && !text.includes('Sign in');
            });
        } catch (e) { }

        if (!hasValidWebSession) {
            console.warn(`[资产同步] ⚠️ 账号 ${acc.name} 的网页端 Session 已失效 (通常是自动导入的过时 Cookie)。将跳过余额更新，尝试降级拉取公开库存...`);
            balance = '需要重新登录';
        } else {

            // --- Added: Automated Cookie Extraction ---
            const cookies = await page.cookies('https://steamcommunity.com', 'https://store.steampowered.com');
            const relevantNames = ['sessionid', 'steamLoginSecure', 'steamCountry', 'steamMachineAuth', 'steamRememberLogin'];
            const filtered = cookies.filter(c => relevantNames.some(name => c.name.startsWith(name)));

            if (filtered.length > 0) {
                const cookieMap = {};
                filtered.forEach(c => { cookieMap[c.name] = c.value; });
                const cookieString = Object.entries(cookieMap).map(([name, value]) => `${name}=${value}`).join('; ');
                acc.steamCookie = cookieString;
            } else {
                console.warn(`[资产同步] 未找到 ${acc.name} 的相关 Cookie，保留旧 Cookie。`);
            }
            // ------------------------------------------

            if (balance === '¥ 0.00') {
                try {
                    await page.goto('https://store.steampowered.com/account/', { waitUntil: 'load', timeout: 60000 });
                    const bh = await page.$('.accountRow .account_data');
                    if (bh) balance = await page.evaluate(el => el.innerText.trim(), bh);
                } catch (e) { }
            }
        } // end of hasValidWebSession block

        // 3. Inventory
        let inventoryValue = acc.inventoryValue || '¥ 0.00';
        if (steamId64) {
            const invHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                // 如果网页 Session 已经判定无效，绝对不能再次发送老的残破 Cookie，否则极易触发 Steam 服务器的 500 报错
                'Cookie': (hasValidWebSession && acc.steamCookie) ? acc.steamCookie : 'steamLanguage=schinese;'
            };
            let allAssets = [], allDescriptions = [], descSeen = new Set(), lastId = null, total = null;
            let invSuccess = true;
            for (let p = 0; p < 30; p++) {
                let url = `https://steamcommunity.com/inventory/${steamId64}/730/2?l=schinese&count=200`;
                if (lastId) url += `&start_assetid=${lastId}`;
                const res = await fetch(url, { headers: invHeaders });
                if (!res.ok) {
                    console.warn(`[资产同步] ❌ 抓取 ${acc.name} 的库存失败，HTTP 状态: ${res.status} (如为 429 请稍后再试，如为 403 可能是私密库存或被红信)`);
                    invSuccess = false;
                    break;
                }
                const data = await res.json();
                if (p === 0) total = data.total_inventory_count;
                (data.assets || []).forEach(a => allAssets.push(a));
                (data.descriptions || []).forEach(d => {
                    const k = `${d.classid}_${d.instanceid}`;
                    if (!descSeen.has(k)) { descSeen.add(k); allDescriptions.push(d); }
                });
                if (data.more_items && data.last_assetid) { lastId = data.last_assetid; await new Promise(r => setTimeout(r, 600)); }
                else break;
            }
            if (invSuccess) {
                console.log(`[资产同步] ✅ 成功为 ${acc.name} 拉取库存: 共找到 ${total || allAssets.length} 件公开饰品`);
                inventoryValue = `${total || allAssets.length} 件饰品`;
                await fs.writeFile(path.join(__dirname, 'inventories', `${id}.json`), JSON.stringify({
                    total: total || allAssets.length,
                    assets: allAssets,
                    descriptions: allDescriptions,
                    updateTime: new Date().toISOString()
                }, null, 2));
            }
        } else {
            console.warn(`[资产同步] ❌ 账号 ${acc.name} 的 SteamID64 本地解析失败，无法进行降级库存拉取！`);
        }

        // Update Account
        acc.balance = balance;
        acc.steamId64 = steamId64;
        acc.inventoryValue = inventoryValue;
        acc.lastSync = new Date().toISOString();

        let latestAccounts = await readAccounts();
        const idx = latestAccounts.findIndex(a => a.id === id);
        if (idx !== -1) {
            latestAccounts[idx] = acc;
            await writeAccounts(latestAccounts);
        }
        return acc;

    } catch (error) {
        console.error(`[资产同步] 严重错误:`, error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
        activeSyncs.delete(id);
    }
}

app.post('/api/accounts/sync', async (req, res) => {
    const { id, force } = req.body;
    try {
        const acc = await syncAccountInventory(id, { force: !!force, isAuto: false });
        res.json(acc);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/accounts/market-listings', async (req, res) => {
    const { id } = req.query;
    console.log(`[API] 正在获取账号 ID 为 ${id} 的市场挂单...`);
    try {
        const accounts = await readAccounts();
        const acc = accounts.find(a => a.id === id);
        if (!acc) {
            console.warn(`[API] 未找到账号 ID: ${id}`);
            return res.status(404).json({ error: 'Account not found' });
        }

        console.log(`[API] 已找到账号: ${acc.name}。正在从 Steam 获取挂单...`);
        const listings = await fetchMyActiveListings(acc.steamCookie);
        console.log(`[API] 成功获取到账号 ${acc.name} 的 ${listings.length} 个挂单。`);
        res.json(listings);
    } catch (error) {
        console.error(`[API] 获取账号 ${id} 的挂单出错:`, error.message);
        if (error.response && error.response.status === 400) {
            return res.status(401).json({ error: 'Cookie 已过期或无效 (Steam 返回 400)，请更新账号 Cookie' });
        }
        res.status(500).json({ error: `无法获取市场记录: ${error.message}` });
    }
});

app.post('/api/accounts/remove-listing', async (req, res) => {
    const { accountId, listingId } = req.body;
    console.log(`[API] Removing single listing ${listingId} for account ${accountId}`);
    try {
        const accounts = await readAccounts();
        const acc = accounts.find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });

        const success = await removeSteamListing(listingId, acc.steamCookie);
        if (success) {
            console.log(`[API] Successfully removed listing ${listingId}`);
            res.json({ success: true });
        } else {
            throw new Error('Steam rejected the removal request');
        }
    } catch (error) {
        console.error(`[API] Error removing single listing:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/accounts/batch-remove-listings', async (req, res) => {
    const { accountId, listingIds } = req.body;
    console.log(`[API] Batch removing ${listingIds.length} listings for account ${accountId}`);
    try {
        const accounts = await readAccounts();
        const acc = accounts.find(a => a.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Account not found' });

        const results = {
            success: [],
            failed: []
        };

        // Process in sequence to avoid hitting Steam too hard at once
        for (const listingId of listingIds) {
            try {
                const ok = await removeSteamListing(listingId, acc.steamCookie);
                if (ok) {
                    results.success.push(listingId);
                } else {
                    results.failed.push({ id: listingId, error: 'Steam rejected the removal request' });
                }
            } catch (err) {
                results.failed.push({ id: listingId, error: err.message });
            }
            // Small delay between removals to avoid rate limiting
            if (listingIds.length > 1) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        console.log(`[API] Batch removal complete for ${accountId}. Success: ${results.success.length}, Failed: ${results.failed.length}`);
        res.json(results);
    } catch (error) {
        console.error(`[API] Error in batch removal:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

/*
// Background Sync Task: Every 10 minutes
setInterval(async () => {
    console.log(`[自动同步] 正在开始对所有账号进行批量进行库存同步...`);
    try {
        const accounts = await readAccounts();
        const now = Date.now();
        for (const acc of accounts) {
            try {
                // Always force sync to ensure cookies are fresh per USER request
                await syncAccountInventory(acc.id, { force: true, isAuto: true });
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.error(`[自动同步] 账号 ${acc.name} 已跳过: ${e.message}`);
            }
        }
        // console.log(`[自动同步] 批量同步任务已完成。`);
    } catch (e) {
        console.error(`[自动同步] 任务失败:`, e.message);
    }
}, 10 * 60 * 1000);
*/

// Get aggregated inventory counts for all accounts
// Get aggregated inventory for ALL accounts
app.get('/api/inventory/total', async (req, res) => {
    try {
        const inventoriesDir = path.join(__dirname, 'inventories');
        const files = await fs.readdir(inventoriesDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        const itemMap = new Map(); // hashName -> { count, description }
        let totalItems = 0;
        let lastUpdateTime = null;

        for (const file of jsonFiles) {
            try {
                const data = JSON.parse(await fs.readFile(path.join(inventoriesDir, file), 'utf8'));
                if (data.assets && data.descriptions) {
                    const descMap = new Map();
                    data.descriptions.forEach(d => {
                        // Filter out trash items (Sticker Remover, Graffiti) and non-marketable items
                        const nameStr = d.market_bucket_group_name || d.name || d.market_name || '';
                        if (nameStr.includes('挂件拆卸器包') || nameStr.includes('涂鸦') || d.marketable !== 1) return;

                        descMap.set(d.classid + '_' + d.instanceid, d);
                    });

                    data.assets.forEach(a => {
                        const desc = descMap.get(a.classid + '_' + a.instanceid);
                        if (desc) {
                            const hash = desc.market_hash_name;
                            if (!itemMap.has(hash)) {
                                itemMap.set(hash, { count: 1, description: desc });
                            } else {
                                itemMap.get(hash).count++;
                            }
                            totalItems++;
                        }
                    });

                    if (!lastUpdateTime || new Date(data.updateTime) > new Date(lastUpdateTime)) {
                        lastUpdateTime = data.updateTime;
                    }
                }
            } catch (e) {
                console.error(`Error aggregating inventory file ${file}:`, e.message);
            }
        }

        const items = Array.from(itemMap.values()).map(entry => ({
            ...entry.description,
            totalCount: entry.count
        }));

        res.json({
            total: totalItems,
            descriptions: items,
            updateTime: lastUpdateTime,
            isTotalView: true,
            accountCount: jsonFiles.length
        });
    } catch (error) {
        console.error('Aggregate total inventory error:', error);
        res.status(500).json({ error: '无法获取总库存汇总数据' });
    }
});

app.get('/api/inventory/summary', async (req, res) => {
    try {
        const inventoriesDir = path.join(__dirname, 'inventories');
        const files = await fs.readdir(inventoriesDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        const summary = {}; // hashName -> count

        for (const file of jsonFiles) {
            try {
                const data = JSON.parse(await fs.readFile(path.join(inventoriesDir, file), 'utf8'));
                if (data.assets && data.descriptions) {
                    const descMap = new Map();
                    data.descriptions.forEach(d => {
                        if (d.marketable === 1) {
                            descMap.set(d.classid + '_' + d.instanceid, d.market_hash_name);
                        }
                    });

                    data.assets.forEach(a => {
                        const hashName = descMap.get(a.classid + '_' + a.instanceid);
                        if (hashName) {
                            summary[hashName] = (summary[hashName] || 0) + 1;
                        }
                    });
                }
            } catch (e) {
                console.error(`Error reading inventory file ${file}:`, e.message);
            }
        }
        res.json(summary);
    } catch (error) {
        console.error('Aggregate inventory summary error:', error);
        res.status(500).json({ error: '无法获取库存汇总数据' });
    }
});

// Get detailed inventory for an account
app.get('/api/accounts/inventory/:id', async (req, res) => {
    try {
        const inventoryPath = path.join(__dirname, 'inventories', `${req.params.id}.json`);
        const stats = await fs.stat(inventoryPath).catch(() => null);
        if (stats && stats.isFile()) {
            const data = await fs.readFile(inventoryPath, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.status(404).json({ error: '未找到库存档案，请先尝试“同步资产数据”' });
        }
    } catch (error) {
        console.error('Read inventory error:', error);
        res.status(500).json({ error: '读取库存档案失败' });
    }
});

// Simple in-memory cache for market prices to avoid rate limiting
const marketPriceCache = new Map(); // hashName_currency -> { data, timestamp }
const MARKET_PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch current Steam market lowest price for an item
app.get('/api/market-price', async (req, res) => {
    try {
        const { hashName, currency = 23 } = req.query;
        if (!hashName) return res.status(400).json({ error: 'hashName required' });

        const cacheKey = `${hashName}_${currency}`;
        const cached = marketPriceCache.get(cacheKey);

        // Return valid cache
        if (cached && (Date.now() - cached.timestamp < MARKET_PRICE_CACHE_TTL)) {
            return res.json(cached.data);
        }

        const settings = await readSettings();

        // Use the robust fetcher first as it provides listings count and accurate price
        const stObj = await fetchSteamItemPrice(hashName, parseInt(currency), settings.steamCookie);
        if (stObj && stObj.price) {
            const data = {
                success: true,
                lowest_price: stObj.price,
                median_price: null, // Histogram doesn't provide median easily
                volume: '?',
                listings: stObj.listings
            };
            marketPriceCache.set(cacheKey, { data, timestamp: Date.now() });
            return res.json(data);
        }

        // Fallback to basic priceoverview if precise fetch fails
        const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=${currency}&market_hash_name=${encodeURIComponent(hashName)}`;
        let response;
        try {
            response = await steamRequest(url, {
                method: 'GET',
                validateStatus: () => true,
                headers: { 'Cookie': settings.steamCookie || '' }
            });
        } catch (e) {
            if (cached) return res.json(cached.data);
            return res.status(500).json({ error: 'Steam API request failed: ' + e.message });
        }

        if (response.status === 429) {
            if (cached) return res.json(cached.data);
            return res.status(429).json({ error: 'Steam API rate limit exceeded' });
        }

        if (response.status < 200 || response.status >= 300) return res.status(response.status).json({ error: 'Steam API failed' });

        const data = response.data;
        if (data && data.success) {
            marketPriceCache.set(cacheKey, { data, timestamp: Date.now() });
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sell item on Steam Market
app.post('/api/accounts/:id/sell-item', async (req, res) => {
    try {
        const { assetid, sellerPriceFen, itemName = '饰品' } = req.body;
        if (!assetid || sellerPriceFen == null) {
            return res.status(400).json({ error: '缺少必要参数 assetid 或 price' });
        }

        const result = await performSteamSell(req.params.id, assetid, sellerPriceFen, itemName);
        if (result.success) {
            res.json({ success: true, message: '上架成功！' });
        } else {
            res.json({ success: false, error: result.message });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [NEW] 批量上岸接口
app.post('/api/accounts/:id/batch-sell', async (req, res) => {
    const { items } = req.body; // [{ assetid, sellerPriceFen, itemName }]
    const accountId = req.params.id;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '缺少待上架饰品列表' });
    }

    console.log(`[BatchSell] 收到批量上架请求: 账号 ${accountId}, 共 ${items.length} 件饰品`);

    const results = {
        successCount: 0,
        failed: []
    };

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
            // 每上架一个后，强制等待 1.5s 左右，防止触发 Steam 429
            if (i > 0) await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));

            const sellRes = await performSteamSell(accountId, item.assetid, item.sellerPriceFen, item.itemName);
            if (sellRes.success) {
                results.successCount++;
            } else {
                results.failed.push({ assetid: item.assetid, itemName: item.itemName, error: sellRes.message });
            }
        } catch (err) {
            results.failed.push({ assetid: item.assetid, itemName: item.itemName, error: err.message });
        }
    }

    res.json(results);
});


const dingTalkSessions = new Map();

/**
 * Unified helper to perform Steam market listing and handle reporting
 */
async function performSteamSell(accId, assetId, priceFen, itemName, senderId = null) {
    try {
        const accounts = await readAccounts();
        const acc = accounts.find(a => String(a.id) === String(accId));
        if (!acc || !acc.steamCookie) {
            const err = "账号不存在或 Cookie 已失效";
            if (senderId) await dingTalkBot.send({ msgtype: "text", text: { content: `❌ 上架 [${itemName}] 失败: ${err}` } });
            return { success: false, message: err };
        }

        const isUSD = acc.balance && acc.balance.includes('$');
        const currencyId = isUSD ? '1' : '23';

        // Use optimized cookie for community domain
        const communityCookie = prepareCookieHeader(acc.steamCookie, 'community');
        const sessionid = communityCookie.match(/sessionid=([^;]+)/)?.[1] || '';

        // Extract country from cookie, fallback to CN
        const countryMatch = communityCookie.match(/steamCountry=([^%|;]+)/);
        const country = countryMatch ? countryMatch[1] : 'CN';

        const sellRes = await steamRequest(
            'https://steamcommunity.com/market/sellitem/',
            {
                method: 'POST',
                data: new URLSearchParams({
                    sessionid: sessionid,
                    appid: '730',
                    contextid: '2',
                    assetid: String(assetId), // Ensure string
                    amount: '1',
                    price: Math.round(priceFen),
                    currency: currencyId,
                    country: country
                }).toString(),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Cookie': communityCookie,
                    'Referer': `https://steamcommunity.com/profiles/${acc.steamId64}/inventory/`,
                    'Origin': 'https://steamcommunity.com',
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="118"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin'
                },
                timeout: 25000
            }
        );

        if (sellRes.data && sellRes.data.success) {
            console.log(`[SteamSell] Success: ${acc.name} listed ${itemName} for ${priceFen} fen`);

            // Update inventory file
            try {
                const inventoryPath = path.join(__dirname, 'inventories', `${acc.id}.json`);
                const invRaw = await fs.readFile(inventoryPath, 'utf8').catch(() => null);
                if (invRaw) {
                    const inv = JSON.parse(invRaw);
                    const before = inv.assets.length;
                    inv.assets = inv.assets.filter(a => a.assetid !== String(assetId));
                    inv.total = Math.max(0, (inv.total || before) - (before - inv.assets.length));
                    await fs.writeFile(inventoryPath, JSON.stringify(inv, null, 2));
                }
            } catch (e) { }

            return { success: true };
        } else {
            const msg = translateSteamError(sellRes.data?.message);
            if (senderId) await dingTalkBot.send({ msgtype: "text", text: { content: `❌ 账号 [${acc.name}] 上架 [${itemName}] 失败: ${msg}` } });
            return { success: false, message: msg };
        }
    } catch (error) {
        console.error(`[SteamSell] Error for ${accId}:`, error.message);
        if (senderId) await dingTalkBot.send({ msgtype: "text", text: { content: `❌ 账号 [${accId}] 请求异常: ${error.message}` } });
        return { success: false, message: error.message };
    }
}

function calculateBuyerPrice(sellerReceiveFen) {
    let fee1 = Math.floor(sellerReceiveFen * 0.1);
    if (fee1 < 1) fee1 = 1;
    let fee2 = Math.floor(sellerReceiveFen * 0.05);
    if (fee2 < 1) fee2 = 1;
    return sellerReceiveFen + fee1 + fee2;
}

function calculateSellerPriceFen(buyerPayFen) {
    for (let base = Math.floor(buyerPayFen / 1.15) - 2; base <= buyerPayFen; base++) {
        if (base <= 0) continue;
        let fee1 = Math.floor(base * 0.1); if (fee1 < 1) fee1 = 1;
        let fee2 = Math.floor(base * 0.05); if (fee2 < 1) fee2 = 1;
        let total = base + fee1 + fee2;
        if (total >= buyerPayFen) {
            if (total === buyerPayFen) return base;
            return base - 1; // Overshot, use the highest valid one below target
        }
    }
    return Math.max(1, Math.floor(buyerPayFen / 1.15));
}

app.post('/api/dingtalk', async (req, res) => {
    try {
        const settings = await readSettings();
        const secret = settings.dingTalkSecret;
        if (!secret) return res.status(403).json({ error: 'Bot secret not configured' });

        const timestamp = req.headers.timestamp;
        const sign = req.headers.sign;

        if (!timestamp || !sign) {
            console.log(`[DingTalk] 缺少签名或时间戳，请求被拒绝。`);
            return res.status(403).json({ error: 'Missing signature' });
        }

        const stringToSign = timestamp + "\n" + secret;
        const computedSign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');

        if (sign !== computedSign) {
            console.log(`[DingTalk] 签名校验失败!`);
            return res.status(403).json({ error: 'Invalid signature' });
        }

        let textContent = (req.body.text && req.body.text.content || '').trim();
        let senderId = req.body.senderId || req.body.senderStaffId || req.body.senderCorpId || 'defaultNode';

        console.log(`[DingTalk] 收到推送 "${textContent}"`);

        // 新增 简单连通性测试指令
        if (textContent.toLowerCase() === 'ping' || textContent === '你好') {
            return res.json({ msgtype: "text", text: { content: `[V13.5 Debug] 你好！连接正常。\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n指令: ${textContent}` } });
        }
        // Update session activity
        if (dingTalkSessions.has(senderId)) {
            dingTalkSessions.get(senderId).lastActivity = Date.now();
        }

        // Improved @mention stripping: handles missing spaces after @names
        if (textContent.startsWith('@')) {
            const spaceIdx = textContent.indexOf(' ');
            if (spaceIdx !== -1) {
                textContent = textContent.substring(spaceIdx).trim();
            } else {
                textContent = textContent.replace(/^@\S+\s*/, '').trim();
            }
        }

        if (!textContent) {
            const rawBody = (req.body.text && req.body.text.content || '');
            const numericMatch = rawBody.match(/\d+/);
            if (numericMatch) textContent = numericMatch[0];
        }
        textContent = textContent.trim();

        if (!textContent) {
            console.log(`[DingTalk] Empty message after stripping @mentions. Original: "${req.body.text && req.body.text.content}"`);
            return res.json({ msgtype: "text", text: { content: "收到 (请避免 @ 后紧跟命令而不留空格)" } });
        }

        // ==========================================
        // 🤖 钉钉机器人指令路由中心 (Command Dispatcher)
        // 未来添加新指令只需在这里增加配置即可
        // ==========================================
        const commands = [
            {
                pattern: /^余额(?:\s+(.+))?$/,
                handler: async (match, senderId) => {
                    const accounts = await readAccounts();
                    const query = match[1] ? match[1].trim() : null;

                    if (query) {
                        const acc = accounts.find(a => String(a.id) === query || a.name === query || (a.name && a.name.includes(query)));
                        if (!acc) return { msgtype: "text", text: { content: `找不到账号: ${query}` } };
                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: `余额查询: ${acc.name}`,
                                text: `**账号**: ${acc.name || acc.id}\n**钱包余额**: ${enhanceWalletDisplay(acc.balance || '¥ 0.00')}\n\n---\n\n💡 发送 \`查价 [名称]\` 可查询并购买饰品，发送 \`库存 [账号]\` 可出售库存。`
                            }
                        };
                    } else {
                        if (accounts.length === 0) return { msgtype: "text", text: { content: "当前没有配置任何账号。" } };
                        let textLines = accounts.map(a => `- **${a.name || a.id}**: ${enhanceWalletDisplay(a.balance || '¥ 0.00')}`);
                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: "全部账号余额汇总",
                                text: `### 💰 钱包余额汇总\n\n${textLines.join('\n')}\n\n---\n\n💡 发送 \`查价 [名称]\` 可查询并购买饰品，发送 \`库存 [账号]\` 可出售库存。`
                            }
                        };
                    }
                }
            },
            {
                pattern: /^(换余额|余额榜)$/,
                handler: async (match, senderId) => {
                    await pushRankingToDingTalk('TOPUP');
                    return { msgtype: "text", text: { content: "✅ 已手动触发【余额榜】推送，请查看群消息。" } };
                }
            },
            {
                pattern: /^(换现金|现金榜)$/,
                handler: async (match, senderId) => {
                    await pushRankingToDingTalk('CASH');
                    return { msgtype: "text", text: { content: "✅ 已手动触发【现金榜】推送，请查看群消息。" } };
                }
            },
            {
                // 指令: [账号] [数量] (自动低价上架刚才推送的饰品)
                // 指令: [账号] [价格] [数量] (手动定价上架)
                pattern: /^(\d+|[\w\u4e00-\u9fa5]+)\s+(\d+(\.\d+)?)(?:\s+(\d+))?$/,
                handler: async (match, senderId) => {
                    const accInput = match[1].trim();
                    const val2 = parseFloat(match[2]);
                    const val3 = match[4] ? parseInt(match[4], 10) : null;

                    console.log(`[DingTalk] 尝试匹配账号上架指令: AccInput="${accInput}", val2=${val2}, val3=${val3}`);

                    const accounts = await readAccounts();
                    // 优先精确匹配，再模糊匹配
                    const acc = accounts.find(a => String(a.id) === accInput || a.name === accInput) ||
                        accounts.find(a => a.name && a.name.includes(accInput));

                    if (!acc) {
                        console.log(`[DingTalk] 未找到对应账号 context: "${accInput}"`);
                        return null;
                    }

                    // 尝试从文件加载持久化的推送记录 (防止服务器重启丢失)
                    let currentMatches = lastPushInventoryMatches;
                    try {
                        const pushMatchesPath = path.join(__dirname, 'last_push_matches.json');
                        const data = await fs.readFile(pushMatchesPath, 'utf8').catch(() => null);
                        if (data) currentMatches = JSON.parse(data);
                    } catch (e) { }

                    const matches = (currentMatches || []).filter(m => String(m.accId) === String(acc.id) || m.accName === acc.name);
                    if (matches.length === 0) {
                        console.log(`[DingTalk] 账号 ${acc.name} (${acc.id}) 在最近推送中无匹配。`);
                        return { msgtype: "text", text: { content: `账号 ${acc.name || acc.id} 在最近一次推送中没有发现匹配库存。` } };
                    }

                    // For now, take the FIRST match found for this account in the push
                    const targetMatch = matches[0];
                    let priceFen, qty;

                    if (val3 !== null) {
                        // Manual: [Account] [BuyerPrice] [Qty]
                        const buyerPriceBuyerFen = Math.round(val2 * 100);
                        priceFen = calculateSellerPriceFen(buyerPriceBuyerFen);
                        qty = val3;
                    } else {
                        // Automatic: [Account] [Qty]
                        const steamPriceStr = targetMatch.priceText || '0';
                        const steamBuyerFen = Math.round(parseFloat(steamPriceStr.replace(/[^\d.]/g, '')) * 100);
                        if (steamBuyerFen <= 0) return { msgtype: "text", text: { content: "无法获取该饰品的 Steam 市场底价，请使用 `[账号] [价格] [数量]` 格式。" } };

                        const targetBuyerFen = steamBuyerFen - 1;
                        priceFen = calculateSellerPriceFen(targetBuyerFen);
                        qty = Math.round(val2);
                    }
                    if (qty > targetMatch.count) {
                        return { msgtype: "text", text: { content: `数量超出！账号 ${acc.name} 仅拥有 ${targetMatch.count} 个 [${targetMatch.displayName}]。` } };
                    }

                    // Execute Sell async but return initial confirmation immediately
                    (async () => {
                        let successCount = 0;
                        for (let i = 0; i < qty; i++) {
                            const assetId = targetMatch.assetIds[i];
                            const result = await performSteamSell(acc.id, assetId, priceFen, targetMatch.displayName);
                            if (result.success) successCount++;
                            // Short delay between listings
                            if (i < qty - 1) await new Promise(r => setTimeout(r, 1500));
                        }

                        if (successCount > 0) {
                            await dingTalkBot.send({
                                msgtype: "text",
                                text: { content: `💰 [${acc.name}] 上架完成！成功: ${successCount}/${qty}。请在手机端确认。` }
                            });
                        }
                    })();

                    return {
                        msgtype: "text",
                        text: { content: `✅ 收到！正在为 [${acc.name}] 上架 ${qty} 个 [${targetMatch.displayName}]...\n价格: ${targetMatch.isUSD ? '$' : '¥'} ${((priceFen * 1.15) / 100).toFixed(2)} (到手 ${targetMatch.isUSD ? '$' : '¥'} ${(priceFen / 100).toFixed(2)})` }
                    };
                }
            },
            {
                pattern: /^(查价|查询|价格|搜索)\s+(.+)$/i,
                handler: async (match, senderId) => {
                    const keyword = match[2].trim();
                    const now = Date.now();
                    if (now < globalRateLimitEnd) {
                        const remaining = Math.round((globalRateLimitEnd - now) / 1000);
                        return {
                            msgtype: "text",
                            text: { content: `⚠️ Steam 接口目前正处于保护性冷却中（剩余 ${remaining}秒），请稍后再试。` }
                        };
                    }

                    try {
                        const englishKw = await translateChineseToEnglish(keyword) || keyword;
                        const cnyCookie = await getCNYCookie();

                        const [c5SearchItems, steamCNYResults] = await Promise.all([
                            fetchC5GamePriceBatch([englishKw]),
                            fetchSteamSeries(englishKw, 23, cnyCookie, 2).catch(e => { if (e.response?.status === 429) throw e; return []; })
                        ]);

                        // Get top Steam results and enrich with C5 prices
                        const topSteamItems = steamCNYResults.slice(0, 5);
                        const topHashNames = topSteamItems.map(s => s.hash_name);
                        const c5BatchForTop = topHashNames.length > 0 ? await fetchC5GamePriceBatch(topHashNames) : new Map();

                        if (topSteamItems.length > 0) {
                            const filtered = topSteamItems.filter(item =>
                                !item.hash_name.toLowerCase().includes('souvenir')
                            );
                            const topItems = filtered.slice(0, 5);
                            let textLines = [];

                            for (let idx = 0; idx < topItems.length; idx++) {
                                const item = topItems[idx];
                                const c5d = c5BatchForTop.get(item.hash_name);
                                let steamCNYDisplay = item.price || 'N/A';
                                let ratioDisplay = 'N/A';

                                let steamVal = parseFloat((item.price || '').replace(/[^\d.]/g, '')) || 0;

                                if (c5d && steamVal > 0) {
                                    ratioDisplay = (c5d.sellPrice / steamVal).toFixed(3);
                                }

                                textLines.push(`### ${idx + 1}. ${item.name || item.hash_name}\n- **C5底价**: ¥ ${c5d ? c5d.sellPrice.toFixed(2) : 'N/A'}\n- **Steam在售最低价**: ${steamCNYDisplay}\n- **比例 (C5 / Steam)**: ${ratioDisplay}`);

                                // Store hash_name for later selection
                                topItems[idx].hash_name = item.hash_name;
                            } // end for loop

                            if (senderId) {
                                dingTalkSessions.set(senderId, {
                                    state: 'AWAITING_BUY_ITEM',
                                    buyResults: topItems,
                                    lastActivity: Date.now()
                                });
                            }

                            return {
                                msgtype: "markdown",
                                markdown: {
                                    title: `查询结果: ${keyword}`,
                                    text: textLines.join('\n\n---\n\n') + '\n\n---\n\n💡 发送序号（如 `1`）可进入购买流程'
                                }
                            };
                        } else {
                            return { msgtype: "text", text: { content: `未找到与"${keyword}"相关的饰品。` } };
                        }
                    } catch (e) {
                        if (e.response && e.response.status === 429) {
                            console.error(`[查询] 检测到 429 限频！全局进入 15 分钟冷静期。`);
                            globalRateLimitEnd = Date.now() + 15 * 60 * 1000;
                            return { msgtype: "text", text: { content: "⚠️ Steam 访问受限（429），已进入 15 分钟保护期。请稍后再试。" } };
                        }
                        console.error('Search Handler Error:', e);
                        return { msgtype: "text", text: { content: `查询异常: ${e.message}` } };
                    }
                }
            },
            {
                pattern: /^库存\s+(.+)$/,
                handler: async (match, senderId) => {
                    const accId = match[1].trim();
                    try {
                        const accsRaw = await fs.readFile(path.join(__dirname, 'accounts.json'), 'utf8');
                        const accs = JSON.parse(accsRaw);
                        const acc = accs.find(a => a.id === accId || a.name === accId);

                        if (!acc) {
                            return { msgtype: "text", text: { content: `未找到账号 "${accId}"，请检查输入格式。` } };
                        }

                        const inventoryPath = path.join(__dirname, 'inventories', `${acc.id}.json`);
                        const stats = await fs.stat(inventoryPath).catch(() => null);

                        if (!stats || !stats.isFile()) {
                            return { msgtype: "text", text: { content: `账号 ${acc.name || accId} 暂无库存档案，请先在控制台进行“同步资产数据”。` } };
                        }

                        const invRaw = await fs.readFile(inventoryPath, 'utf8');
                        const invData = JSON.parse(invRaw);

                        if (!invData.descriptions || invData.descriptions.length === 0) {
                            return { msgtype: "text", text: { content: `账号 ${acc.name || accId} 的库存为空或已被隐藏。` } };
                        }

                        // Sort descriptions by count descending, then by rarity descending
                        const getRarityScore = (typeStr) => {
                            if (!typeStr) return 0;
                            if (typeStr.includes('Covert') || typeStr.includes('隐秘')) return 6;
                            if (typeStr.includes('Classified') || typeStr.includes('保密')) return 5;
                            if (typeStr.includes('Restricted') || typeStr.includes('受限')) return 4;
                            if (typeStr.includes('Mil-Spec') || typeStr.includes('军规级')) return 3;
                            if (typeStr.includes('Industrial') || typeStr.includes('工业级')) return 2;
                            if (typeStr.includes('Consumer') || typeStr.includes('消费级')) return 1;
                            return 0;
                        };

                        // Build an asset count map from the raw assets list
                        const assetMap = new Map();
                        for (const asset of (invData.assets || [])) {
                            const key = `${asset.classid}_${asset.instanceid}`;
                            assetMap.set(key, (assetMap.get(key) || 0) + 1);
                        }

                        const itemsWithCount = invData.descriptions.filter(item => {
                            const nameStr = item.market_bucket_group_name || item.name || item.market_name || '';
                            return !nameStr.includes('挂件拆卸器包') && !nameStr.includes('涂鸦') && item.marketable === 1;
                        }).map(item => {
                            const key = `${item.classid}_${item.instanceid}`;
                            const count = assetMap.get(key) || item.totalCount || 0;
                            return {
                                name: item.market_name || item.name,
                                market_hash_name: item.market_hash_name || '',
                                count: count,
                                marketable: item.marketable === 1,
                                rarityScore: getRarityScore(item.type)
                            };
                        }).filter(i => i.count > 0).sort((a, b) => {
                            if (b.count !== a.count) return b.count - a.count;
                            return b.rarityScore - a.rarityScore;
                        });

                        // Take the top 15 items to avoid blowing up the DingTalk message limit
                        const topItems = itemsWithCount.slice(0, 15);
                        let textLines = [
                            `💡 **提示**: 发送 \`出售 1\` 或 \`1\` 即可快捷出售以下列表里编号为 #1 的饰品！\n`,
                            `**账号**: ${acc.name || accId}`,
                            `**总饰品数**: ${invData.total} 件\n`,
                            `### 📦 主要库存清单 (Top 15)`
                        ];

                        for (let idx = 0; idx < topItems.length; idx++) {
                            const i = topItems[idx];
                            const statusLabel = i.marketable ? '' : ' *(不可交易)*';
                            textLines.push(`- **#${idx + 1}** - **${i.name}**: \`${i.count}\` 个${statusLabel}`);
                        }

                        if (itemsWithCount.length > 15) {
                            textLines.push(`\n*...以及其他 ${itemsWithCount.length - 15} 种饰品*`);
                        }

                        if (senderId) {
                            const isUSD = acc.balance && acc.balance.includes('$');
                            dingTalkSessions.set(senderId, {
                                state: 'AWAITING_ITEM',
                                accId: acc.id,
                                accName: acc.name || accId,
                                isUSD: isUSD,
                                inventoryList: topItems,
                                lastActivity: Date.now()
                            });
                        }

                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: `库存汇报: ${acc.name || accId}`,
                                text: textLines.join('\n') + '\n\n---\n\n💡 发送序号（如 `1`）或 `出售 1` 可快捷上架卖出，退出发送 `取消`'
                            }
                        };

                    } catch (err) {
                        return { msgtype: "text", text: { content: `库存查询失败: ${err.message}` } };
                    }
                }
            },
            {
                pattern: /^已(上架|挂单)\s+(.+)$/,
                handler: async (match, senderId) => {
                    const accId = match[2].trim();
                    try {
                        const accounts = await readAccounts();
                        const acc = accounts.find(a => a.id === accId || a.name === accId || (a.name && a.name.includes(accId)));
                        if (!acc) return { msgtype: "text", text: { content: `未找到账号 "${accId}"` } };

                        const listings = await fetchMyActiveListings(acc.steamCookie);
                        if (!listings) throw new Error('Steam接口调用失败 (Cookie可能已失效)');

                        if (listings.length === 0) {
                            return { msgtype: "text", text: { content: `账号 [${acc.name}] 当前没有正在上架的饰品。` } };
                        }

                        let textLines = listings.slice(0, 15).map((l, i) => `${i + 1}. **${l.name}**\n   - 价格: ${l.priceText} (${l.created})`);
                        if (listings.length > 15) textLines.push(`\n...等共 ${listings.length} 件饰品`);

                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: `已上架清单: ${acc.name}`,
                                text: `### 📦 ${acc.name} 当前已上架 (${listings.length})\n\n${textLines.join('\n')}\n\n---\n💡 可在控制台查看详情。`
                            }
                        };
                    } catch (e) {
                        return { msgtype: "text", text: { content: `获取失败: ${e.message}` } };
                    }
                }
            },
            {
                // 购买确认指令：确认 [账号]
                pattern: /^确认\s+(.+)$/,
                handler: async (match, senderId) => {
                    let session = dingTalkSessions.get(senderId);
                    if (!session || (session.state !== 'AWAITING_BUY_CONFIRM' && session.state !== 'AWAITING_BUY_REPEAT')) {
                        // Session expired or wrong state — could be a server restart wiping in-memory session
                        const accName = match[1].trim();
                        return {
                            msgtype: 'text',
                            text: {
                                content: `⚠️ 当前没有待确认的购买流程（会话可能因服务器重启丢失）。\n\n请重新发送序号（如 \`4\`）来重新选择物品，再发送 \`确认 ${accName}\` 完成购买。`
                            }
                        };
                    }

                    const accName = match[1].trim();
                    const accounts = await readAccounts();
                    const acc = accounts.find(a => a.id === accName || (a.name && a.name.includes(accName)));
                    console.log(`[DingTalkBuy] Confirm command for accName="${accName}". Matched Account: ${acc ? `${acc.name} (ID: ${acc.id})` : 'None'}`);

                    if (!acc) return { msgtype: "text", text: { content: `找不到账号 "${accName}"，请检查账号名称。` } };

                    const isUSD = acc.balance && acc.balance.includes('$');
                    const accCookie = acc.steamCookie;
                    if (!accCookie) {
                        return { msgtype: "text", text: { content: `账号 "${acc.name || accName}" 没有配置 Steam Cookie，请在账号管理界面填写。` } };
                    }

                    // Get latest listing to buy
                    const hashName = session.buyHashName;
                    const currency = isUSD ? 1 : 23;
                    const listingCoin = isUSD ? 'USD' : 'CNY';

                    let listing = null;
                    try {
                        listing = await fetchCheapestListing(hashName, currency, accCookie);
                    } catch (e) {
                        console.warn(`[DingTalkBuy] fetchCheapestListing failed, trying pendingListing cache:`, e.message);
                    }

                    // Fallback to cached listing from when item was selected
                    if (!listing && session.pendingListing) {
                        listing = session.pendingListing;
                        console.log(`[DingTalkBuy] Using cached listing: ${listing.listingId}`);
                    }

                    if (!listing || !listing.listingId) {
                        return { msgtype: "text", text: { content: `无法获取 ${hashName} 的市场上架信息（ID缺失），可能目前无人售卖，或 Steam 接口超时。请稍后重试。` } };
                    }

                    // Balance check
                    const balanceNum = parseFloat((acc.balance || '0').replace(/[^\d.]/g, ''));
                    const requiredNum = listing.total / 100;
                    if (balanceNum < requiredNum) {
                        const sym = isUSD ? '$' : '¥';
                        return { msgtype: "text", text: { content: `账号 ${acc.name || accName} 余额不足！\n当前余额: ${acc.balance || '0'}\n需要: ${sym} ${requiredNum.toFixed(2)}` } };
                    }

                    // Execute buy
                    isPurchaseInProgress = true;
                    let buyResult;
                    try {
                        buyResult = await executeSteamBuy(listing.listingId, listing.currency, listing.subtotal, listing.fee, listing.total, accCookie, hashName, acc.mafileContent);
                    } finally {
                        isPurchaseInProgress = false;
                    }

                    // Respond immediately to prevent DingTalk timeout
                    const statusIcon = buyResult.success ? '✅' : '❌';
                    const isPending = buyResult.success && buyResult.message.includes('手机');

                    const responseBody = {
                        msgtype: "markdown",
                        markdown: {
                            title: buyResult.success ? (isPending ? '购买已发起' : '购买成功') : '购买失败',
                            text: `### ${statusIcon} ${buyResult.message}\n\n**物品**: ${session.buyItemName}\n**价格**: ${listing.priceText}\n**账号**: ${acc.name || acc.id}\n**状态**: ${buyResult.success ? (isPending ? '等待手机确认' : '已成功') : '支付失败'}\n\n---\n💡 您可以继续发送 \`确认 [账号]\` 再次购买，或发送 \`取消\` 退出。`
                        }
                    };

                    // Background: Refresh session data (only update state on success)
                    (async () => {
                        try {
                            const cnyCookie = await getCNYCookie();
                            const [newListing, c5Refresh] = await Promise.all([
                                fetchCheapestListing(hashName, 23, cnyCookie),
                                fetchC5GamePriceBatch([hashName])
                            ]);
                            if (newListing) {
                                session.lastCNY = newListing.priceText;
                                session.pendingListing = newListing;
                            }
                            const c5d = c5Refresh.get(hashName);
                            if (c5d) {
                                session.lastYP = String(c5d.sellPrice.toFixed(2));
                                const currentCny = session.lastCNY || '0';
                                const steamVal = parseFloat(currentCny.replace(/[^\d.]/g, ''));
                                if (steamVal > 0) session.lastRatio = (c5d.sellPrice / steamVal).toFixed(3);
                            }
                            const newUSD = await fetchCheapestListing(hashName, 1, '');
                            if (newUSD) session.lastUSD = newUSD.priceText;

                            // Only advance state if this buy was successful (need mobile confirm)
                            if (buyResult.success) {
                                session.state = 'AWAITING_BUY_REPEAT';
                                console.log(`[DingTalkBuy] Session -> AWAITING_BUY_REPEAT for ${hashName}`);
                            } else {
                                console.log(`[DingTalkBuy] Buy failed, session stays at ${session.state} for ${hashName}`);
                            }
                        } catch (e) {
                            console.error(`[DingTalkBuy] Background refresh error:`, e.message);
                        }
                    })();

                    return responseBody;
                }
            },
            {
                // 出售 N 指令：处理库存选择或账号选择
                pattern: /^出售\s+(\d+)$/,
                handler: async (match, senderId) => {
                    let session = dingTalkSessions.get(senderId);
                    if (!session) return null;

                    const idx = parseInt(match[1], 10) - 1;

                    if (session.state === 'AWAITING_SELL_ACCOUNTS') {
                        // --- New: Select Account for Top-up Sell ---
                        const option = session.sellOptions && session.sellOptions[idx];
                        if (!option) return { msgtype: "text", text: { content: "编号无效，请检查输入的编号。" } };

                        const accounts = await readAccounts();
                        const acc = accounts.find(a => a.id === option.accId);
                        if (!acc) return { msgtype: "text", text: { content: "账号不存在。" } };

                        const isUSD = acc.balance && acc.balance.includes('$');
                        const hashName = session.sellItemName;

                        // Fetch price for THIS specific account currency
                        const currency = isUSD ? 1 : 23;
                        const cookie = isUSD ? '' : acc.steamCookie;
                        let listing = await fetchSteamPriceRobust(hashName, currency, cookie);

                        let targetBuyerPrice = 0;
                        let sellerReceivePrice = 0;
                        if (listing && listing.total > 0) {
                            targetBuyerPrice = listing.total - 1;
                            if (targetBuyerPrice <= 0) targetBuyerPrice = 1;
                            sellerReceivePrice = calculateSellerPriceFen(targetBuyerPrice);
                        }

                        session.state = 'AWAITING_SELL_CONFIRM';
                        session.sellAccId = option.accId;
                        session.sellAssetId = option.assetId;
                        session.sellPriceFen = sellerReceivePrice;
                        session.sellPriceBuyerFen = targetBuyerPrice;
                        session.isUSD = isUSD;

                        const accName = acc.name || acc.id;
                        const sym = isUSD ? '$' : '¥';
                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: `确认上架: ${session.sellItemName}`,
                                text: `### ${session.sellItemName}\n- **所选账号**: ${accName}\n- **币种**: ${isUSD ? 'USD' : 'CNY'}\n- **上架价格**: ${sym} ${(targetBuyerPrice / 100).toFixed(2)}\n- **到手价**: ${sym} ${(sellerReceivePrice / 100).toFixed(2)}\n\n确认按此价格上架请发送 \`确认\`，或输入(上架价格 数量)，退出请发送 \`取消\``
                            }
                        };
                    }

                    if (session.state !== 'AWAITING_ITEM') {
                        return { msgtype: "text", text: { content: "当前没有待处理的出售指令。" } };
                    }

                    if (!session.inventoryList || !session.inventoryList[idx]) {
                        return { msgtype: "text", text: { content: "编号无效，请检查输入的编号。" } };
                    }
                    const item = session.inventoryList[idx];
                    if (!item.marketable) {
                        return { msgtype: "text", text: { content: "该饰品不可交易，无法上架。" } };
                    }
                    session.state = 'AWAITING_PRICE_QTY';
                    session.selectedItem = item;

                    let steamPriceStr = '未知';
                    let steamPriceFen = 0;
                    let ratioDisplay = '未知';
                    try {
                        const targetHashName = item.market_hash_name || item.name;
                        const currency = session.isUSD ? 1 : 23;
                        const cnyCookie = await getCNYCookie();
                        const cookie = session.isUSD ? '' : cnyCookie;

                        // Optimization: Use Direct Precise Search (Robust)
                        const [c5SellBatch, steamResult] = await Promise.all([
                            fetchC5GamePriceBatch([targetHashName]),
                            fetchSteamPriceRobust(targetHashName, currency, cookie)
                        ]);

                        if (steamResult) {
                            steamPriceStr = steamResult.priceText;
                            steamPriceFen = steamResult.total;

                            if (!session.isUSD) {
                                const c5d = c5SellBatch.get(targetHashName);
                                if (c5d && c5d.sellPrice) {
                                    const steamVal = steamPriceFen / 100;
                                    if (steamVal > 0) {
                                        ratioDisplay = (c5d.sellPrice / steamVal).toFixed(3);
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                    session.steamPriceFen = steamPriceFen;

                    return {
                        msgtype: "markdown",
                        markdown: {
                            title: "输入上架价格",
                            text: `准备上架【**${session.accName}**】的饰品：\n\n### ${item.name}\n- **拥有总数**: ${item.count}\n- **当前底价 (买家付)**: ${steamPriceStr}\n${session.isUSD ? '' : `- **比例 (悠悠 / Steam)**: ${ratioDisplay}\n`}\n请回复价格和数量（格式如 \`1.97 2\`，以空格分隔），或者直接回复数量（格式如\`1\`），将以少于底价0.01${session.isUSD ? '美元' : '元人民币'}价格上架饰品。\n> 前面的数字为**上架价格** (买家付的钱)，后面的数字为**出售数量**。`
                        }
                    };
                }
            },
            {
                pattern: /^(\d+(\.\d+)?\s+\d+|\d+)$/,
                handler: async (match, senderId) => {
                    const settings = await readSettings();
                    let session = dingTalkSessions.get(senderId);
                    const idx = parseInt(match[1].trim(), 10) - 1;

                    // Suppressed noisy input log
                    if (session) console.log(`[钉钉机器人] 当前会话状态: ${session.state}`);
                    else console.log(`[钉钉机器人] ${senderId} 无活跃会话`);

                    // --- HIGH PRIORITY SESSION CHECKS ---
                    // These states handle bare numbers as shortcuts for specific active flows

                    // State: AWAITING_BUY_ITEM — select an item from the 查价 results to buy
                    if (session && session.state === 'AWAITING_BUY_ITEM') {
                        if (!session.buyResults || !session.buyResults[idx]) {
                            return { msgtype: "text", text: { content: "编号无效，请检查输入的编号。" } };
                        }
                        const buyItem = session.buyResults[idx];
                        let hashName = buyItem.hash_name;

                        // 修复部分饰品从 Youpin 拿到的 hashName 是中文导致 Steam 接口 404 的问题
                        if (/[\u4e00-\u9fa5]/.test(hashName)) {
                            const cnyCookie = await getCNYCookie();
                            const steamAuth = await fetchSteamSeries(buyItem.name || hashName, 23, cnyCookie);
                            if (steamAuth && steamAuth.length > 0) {
                                hashName = steamAuth[0].hash_name;
                                session.buyResults[idx].hash_name = hashName;
                            }
                        }

                        // Fetch C5Game price + Steam CNY cheapest in parallel
                        const cnyCookie = await getCNYCookie();
                        const [c5PriceMap, cnyListing] = await Promise.all([
                            fetchC5GamePriceBatch([hashName]),
                            fetchCheapestListing(hashName, 23, cnyCookie).catch(() => null)
                        ]);

                        const c5Data = c5PriceMap.get(hashName);
                        const ypPrice = c5Data ? `¥ ${c5Data.sellPrice.toFixed(2)}` : '未知';
                        let cnyPrice = cnyListing ? cnyListing.priceText : '未知';

                        // FALLBACK: If cnyListing failed, try fetchSteamPrice (priceoverview)
                        if (cnyPrice === '未知') {
                            try {
                                const stPrice = await fetchSteamPrice(hashName, 23, cnyCookie);
                                if (stPrice && stPrice.lowest_price) {
                                    cnyPrice = stPrice.lowest_price;
                                }
                            } catch (e) { }
                        }

                        let ratio = '未知';
                        if (c5Data && cnyListing) {
                            const sv = cnyListing.total / 100;
                            if (sv > 0) ratio = (c5Data.sellPrice / sv).toFixed(3);
                        }

                        // Use cached balances (no immediate refresh to prevent DingTalk timeout)
                        const accounts = await readAccounts();
                        const accLines = accounts.map(a => `- **${a.name || a.id}**: ${enhanceWalletDisplay(a.balance || '¥ 0.00')}`).join('\n');


                        // Update session
                        session.state = 'AWAITING_BUY_CONFIRM';
                        session.buyHashName = hashName;
                        session.buyItemName = buyItem.name || hashName;
                        session.lastCNY = cnyPrice;
                        session.lastYP = ypItem ? ypItem.price : '未知';
                        session.lastRatio = ratio;
                        session.lastActivity = Date.now();
                        if (cnyListing) session.pendingListing = cnyListing;

                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: `购买确认: ${buyItem.name || hashName}`,
                                text: `### ${buyItem.name || hashName}\n- **C5底价**: ${ypPrice}\n- **Steam在售最低价**: ${cnyPrice}\n- **比例 (悠悠 / Steam)**: ${ratio}\n\n### 账号余额\n${accLines}\n\n确认购买请发送 \`确认 [账号]\`，退出请发送 \`取消\``
                            }
                        };
                    }

                    // State: AWAITING_ITEM — treat a bare number as an item selection shortcut (same as 出售 N)
                    if (session && session.state === 'AWAITING_ITEM') {
                        if (!session.inventoryList || !session.inventoryList[idx]) {
                            return { msgtype: "text", text: { content: "编号无效，请检查输入的编号。" } };
                        }
                        const item = session.inventoryList[idx];
                        if (!item.marketable) {
                            return { msgtype: "text", text: { content: "该饰品不可交易，无法上架。" } };
                        }
                        session.state = 'AWAITING_PRICE_QTY';
                        session.selectedItem = item;

                        let steamPriceStr = '未知';
                        let steamPriceFen = 0;
                        let ratioDisplay = '未知';
                        try {
                            const targetHashName = item.market_hash_name || item.name;
                            const currency = session.isUSD ? 1 : 23;
                            const cnyCookie = await getCNYCookie();
                            const cookie = session.isUSD ? '' : cnyCookie;

                            // Optimization: Use Direct Precise Search (Robust)
                            const [c5PriceRes, steamResult] = await Promise.all([
                                fetchC5GamePriceBatch([targetHashName]),
                                fetchSteamPriceRobust(targetHashName, currency, cookie)
                            ]);

                            if (steamResult) {
                                steamPriceStr = steamResult.priceText;
                                steamPriceFen = steamResult.total;

                                if (!session.isUSD) {
                                    const c5d = c5PriceRes.get(targetHashName);
                                    if (c5d && c5d.sellPrice) {
                                        const steamVal = steamPriceFen / 100;
                                        if (steamVal > 0) {
                                            ratioDisplay = (c5d.sellPrice / steamVal).toFixed(3);
                                        }
                                    }
                                }
                            }
                        } catch (e) { }
                        session.steamPriceFen = steamPriceFen;

                        return {
                            msgtype: "markdown",
                            markdown: {
                                title: "输入上架价格",
                                text: `准备上架【**${session.accName}**】的饰品：\n\n### ${item.name}\n- **拥有总数**: ${item.count}\n- **当前底价 (买家付)**: ${steamPriceStr}\n${session.isUSD ? '' : `- **比例 (悠悠 / Steam)**: ${ratioDisplay}\n`}\n请回复价格和数量（格式如 \`1.97 2\`，以空格分隔），或者直接回复数量（格式如\`1\`），将以少于底价0.01${session.isUSD ? '美元' : '元人民币'}价格上架饰品。\n> 前面的数字为**上架价格** (买家付的钱)，后面的数字为**出售数量**。`
                            }
                        };
                    }

                    // --- LOW PRIORITY FALLBACKS ---
                    // Handle push leaderboard selections

                    // Fallback to Global Push Ranking if no individual session for buying is active
                    if (globalPushRankingItems && (!session || !['AWAITING_BUY_CONFIRM', 'AWAITING_SELL_CONFIRM', 'AWAITING_SELL_ACCOUNTS', 'AWAITING_PRICE_QTY', 'AWAITING_CONFIRM_SELL', 'AWAITING_BUY_ITEM', 'AWAITING_ITEM'].includes(session.state))) {
                        // Ensure session exists even if it's the first interaction after a push
                        if (!session) {
                            session = { state: 'IDLE' };
                            dingTalkSessions.set(senderId, session);
                        }
                        const items = globalPushRankingItems.items || [];
                        const item = items[idx];

                        if (item) {
                            // NEW: If user says "购买 N" or just "N" and it was a TOPUP list,
                            // we should probably offer them the BUY flow too if they don't have it,
                            // or if they explicitly want to buy.
                            // For simplicity, we'll ALWAYS provide the BUY flow for CASH and
                            // allow BUY flow for TOPUP if requested or as a fallback.

                            if (globalPushRankingItems.type === 'CASH') {
                                // --- Existing BUY Flow ---
                                let cashHashName = item.hash_name || item.hashName;

                                // Fix for cashHashName (some items might have name instead of cashHashName in tracked_items)
                                if (!cashHashName || /[\u4e00-\u9fa5]/.test(cashHashName)) {
                                    const cnyCookie = await getCNYCookie();
                                    const steamAuth = await fetchSteamSeries(item.name || cashHashName, 23, cnyCookie);
                                    if (steamAuth && steamAuth.length > 0) cashHashName = steamAuth[0].hash_name;
                                }

                                const cnyCookieMain = await getCNYCookie();
                                let [c5PriceMapCash, cnyListing] = await Promise.all([
                                    fetchC5GamePriceBatch([cashHashName]),
                                    fetchCheapestListing(cashHashName, 23, cnyCookieMain).catch(() => null)
                                ]);

                                // Fallback for Steam prices (if listing search 429'd)
                                if (!cnyListing) {
                                    const fb = await fetchSteamItemPrice(cashHashName, 23, cnyCookieMain);
                                    if (fb && fb.lowest_price) {
                                        cnyListing = {
                                            priceText: fb.lowest_price,
                                            total: Math.round(parseFloat(fb.lowest_price.replace(/[^\d.]/g, '')) * 100)
                                        };
                                    }
                                }
                                const c5CashData = c5PriceMapCash.get(cashHashName);
                                const ypPrice = c5CashData ? `¥ ${c5CashData.sellPrice.toFixed(2)}` : '未知';
                                const cnyPrice = cnyListing ? cnyListing.priceText : '未知';

                                let ratio = '未知';
                                if (c5CashData && cnyListing) {
                                    const sv = cnyListing.total / 100;
                                    if (sv > 0) ratio = (c5CashData.sellPrice / sv).toFixed(3);
                                }

                                const accts_cash = await readAccounts();
                                const accLines = accts_cash.map(a => `- **${a.name || a.id}**: ${enhanceWalletDisplay(a.balance || '¥ 0.00')}`).join('\n');

                                // Update session
                                session.state = 'AWAITING_BUY_CONFIRM';
                                session.buyHashName = cashHashName;
                                session.buyItemName = item.name || cashHashName;
                                session.lastCNY = cnyPrice;
                                session.lastYP = ypItem ? ypItem.price : '未知';
                                session.lastRatio = ratio;
                                session.lastActivity = Date.now();
                                if (cnyListing) session.pendingListing = cnyListing;

                                return {
                                    msgtype: "markdown",
                                    markdown: {
                                        title: `购买确认: ${item.name || cashHashName}`,
                                        text: `### ${item.name || cashHashName}\n- **C5底价**: ${ypPrice}\n- **Steam在售最低价**: ${cnyPrice}\n- **比例 (悠悠 / Steam)**: ${ratio}\n\n### 账号余额\n${accLines}\n\n确认购买请发送 \`确认 [账号]\`，退出请发送 \`取消\``
                                    }
                                };
                            } else if (globalPushRankingItems.type === 'TOPUP') {
                                // --- New SELL Flow ---
                                let hashNameTopup = item.hash_name || item.hashName;
                                if (!hashNameTopup || /[\u4e00-\u9fa5]/.test(hashNameTopup)) {
                                    const cnyCookie = await getCNYCookie();
                                    const steamAuth = await fetchSteamSeries(item.name || hashNameTopup, 23, cnyCookie);
                                    if (steamAuth && steamAuth.length > 0) hashNameTopup = steamAuth[0].hash_name;
                                }

                                // Scan all accounts for this item
                                const accts_topup = await readAccounts();
                                let foundInAccounts = [];
                                for (const acc of accts_topup) {
                                    const invPath = path.join(__dirname, 'inventories', `${acc.id}.json`);
                                    try {
                                        const invRaw = await fs.readFile(invPath, 'utf8');
                                        const inv = JSON.parse(invRaw);
                                        const matchingDescs = (inv.descriptions || []).filter(d =>
                                            d.market_hash_name === hashNameTopup || d.name === (item.name || hashNameTopup)
                                        );

                                        const matches = [];
                                        if (matchingDescs.length > 0) {
                                            const assetIds = new Set(matchingDescs.map(d => d.classid));
                                            (inv.assets || []).forEach(a => {
                                                if (assetIds.has(a.classid)) {
                                                    matches.push(a);
                                                }
                                            });
                                        }

                                        if (matches.length > 0) {
                                            foundInAccounts.push({
                                                accId: acc.id,
                                                accName: acc.name || acc.id,
                                                assets: matches,
                                                steamCookie: acc.steamCookie,
                                                isUSD: acc.balance && acc.balance.includes('$')
                                            });
                                        }
                                    } catch (e) { }
                                }

                                if (foundInAccounts.length === 0) {
                                    console.log(`[钉钉机器人] 饰品 "${item.name}" 在库存中未找到 (余额榜)。正在回退至购买流程...`);

                                    // Re-trigger the BUY flow for this item
                                    let hashNameFallback = item.hash_name || item.hashName;
                                    if (!hashNameFallback || /[\u4e00-\u9fa5]/.test(hashNameFallback)) {
                                        const cnyCookie = await getCNYCookie();
                                        const steamAuth = await fetchSteamSeries(item.name || hashNameFallback, 23, cnyCookie);
                                        if (steamAuth && steamAuth.length > 0) hashNameFallback = steamAuth[0].hash_name;
                                    }

                                    const cnyCookieMain = await getCNYCookie();
                                    let [c5PriceMapFb, cnyListing] = await Promise.all([
                                        fetchC5GamePriceBatch([hashNameFallback]),
                                        fetchCheapestListing(hashNameFallback, 23, cnyCookieMain).catch(() => null)
                                    ]);

                                    if (!cnyListing) {
                                        const fb = await fetchSteamItemPrice(hashNameFallback, 23, cnyCookieMain);
                                        if (fb && fb.lowest_price) {
                                            cnyListing = {
                                                priceText: fb.lowest_price,
                                                total: Math.round(parseFloat(fb.lowest_price.replace(/[^\d.]/g, '')) * 100)
                                            };
                                        }
                                    }

                                    const c5FbData = c5PriceMapFb.get(hashNameFallback);
                                    const ypPrice = c5FbData ? `¥ ${c5FbData.sellPrice.toFixed(2)}` : '未知';
                                    const cnyPrice = cnyListing ? cnyListing.priceText : '未知';

                                    let ratio = '未知';
                                    if (c5FbData && cnyListing) {
                                        const sv = cnyListing.total / 100;
                                        if (sv > 0) ratio = (c5FbData.sellPrice / sv).toFixed(3);
                                    }

                                    const accts_fallback = await readAccounts();
                                    const accLines = accts_fallback.map(a => `- **${a.name || a.id}**: ${enhanceWalletDisplay(a.balance || '¥ 0.00')}`).join('\n');

                                    session.state = 'AWAITING_BUY_CONFIRM';
                                    session.buyHashName = hashNameFallback;
                                    session.buyItemName = item.name || hashNameFallback;
                                    session.lastCNY = cnyPrice;
                                    session.lastYP = ypItem ? ypItem.price : '未知';
                                    session.lastRatio = ratio;
                                    session.lastActivity = Date.now();
                                    if (cnyListing) session.pendingListing = cnyListing;

                                    return {
                                        msgtype: "markdown",
                                        markdown: {
                                            title: `购买确认 (来自余额榜): ${item.name || hashNameFallback}`,
                                            text: `⚠️ **提醒**: 您库存中尚无此饰品，已自动切至购买流程：\n\n### ${item.name || hashNameFallback}\n- **C5底价**: ${ypPrice}\n- **Steam在售最低价**: ${cnyPrice}\n- **比例 (悠悠 / Steam)**: ${ratio}\n\n### 账号余额\n${accLines}\n\n确认购买请发送 \`确认 [账号]\`，退出请发送 \`取消\``
                                        }
                                    };
                                }

                                // If only one account, calculate price for that specific account's currency
                                let finalAcc = foundInAccounts.length === 1 ? foundInAccounts[0] : null;
                                let targetBuyerPrice = 0;
                                let sellerReceivePrice = 0;
                                let priceText = '未知';

                                if (finalAcc) {
                                    const currency = finalAcc.isUSD ? 1 : 23;
                                    const cookie = finalAcc.isUSD ? '' : finalAcc.steamCookie;
                                    let listing = await fetchSteamPriceRobust(hashNameTopup, currency, cookie);

                                    if (listing && listing.total > 0) {
                                        targetBuyerPrice = listing.total - 1;
                                        if (targetBuyerPrice <= 0) targetBuyerPrice = 1;
                                        sellerReceivePrice = calculateSellerPriceFen(targetBuyerPrice);
                                        priceText = `${finalAcc.isUSD ? '$' : '¥'} ${(targetBuyerPrice / 100).toFixed(2)} (实得 ${finalAcc.isUSD ? '$' : '¥'} ${(sellerReceivePrice / 100).toFixed(2)})`;
                                    }

                                    session.state = 'AWAITING_SELL_CONFIRM';
                                    session.sellAccId = finalAcc.accId;
                                    session.sellAssetId = finalAcc.assets[0].assetid;
                                    session.sellItemName = item.name || hashNameTopup;
                                    session.sellPriceFen = sellerReceivePrice;
                                    session.sellPriceBuyerFen = targetBuyerPrice;
                                    session.isUSD = finalAcc.isUSD;
                                    session.lastActivity = Date.now();

                                    return {
                                        msgtype: "markdown",
                                        markdown: {
                                            title: `出售确认: ${item.name || hashNameTopup}`,
                                            text: `### ${item.name || hashNameTopup}\n- **所选账号**: ${finalAcc.accName}\n- **币种**: ${finalAcc.isUSD ? 'USD' : 'CNY'}\n- **上架价格**: ${finalAcc.isUSD ? '$' : '¥'} ${(targetBuyerPrice / 100).toFixed(2)}\n- **到手价**: ${finalAcc.isUSD ? '$' : '¥'} ${(sellerReceivePrice / 100).toFixed(2)}\n\n确认按此价格上架请发送 \`确认\`，或输入(上架价格 数量)，退出请发送 \`取消\``
                                        }
                                    };
                                } else {
                                    // Multiple accounts have it — wait for user to select account first
                                    session.state = 'AWAITING_SELL_ACCOUNTS';
                                    session.sellItemName = item.name || hashNameTopup;
                                    session.sellOptions = foundInAccounts.map(f => ({ accId: f.accId, assetId: f.assets[0].assetid }));
                                    session.lastActivity = Date.now();

                                    const accList = foundInAccounts.map((f, i) => `${i + 1}. **${f.accName}** (${f.assets.length} 件, ${f.isUSD ? 'USD' : 'CNY'})`).join('\n');
                                    return {
                                        msgtype: "markdown",
                                        markdown: {
                                            title: `选择出售账号: ${item.name || hashNameTopup}`,
                                            text: `### ${item.name || hashNameTopup}\n发现多个账号拥有该物品，请先选择账号以确定对应的市场价格：\n\n${accList}\n\n请回复 \`出售 [序号]\` 来在该账号上架，例如 \`出售 1\``
                                        }
                                    };
                                }
                            }
                        }
                    }

                    // State: AWAITING_ITEM was moved to high priority section above

                    if (!session || !['AWAITING_PRICE_QTY', 'AWAITING_CONFIRM_SELL', 'AWAITING_SELL_CONFIRM'].includes(session.state)) {
                        console.log(`[DingTalk] No matching state for number "${match[1]}" (State: ${session ? session.state : 'NONE'})`);
                        return null; // fall through to help message
                    }

                    const text = match[1].trim();
                    let priceFen, buyerPriceFen, qty;

                    if (text.includes(' ')) {
                        const parts = text.split(/\s+/);
                        buyerPriceFen = Math.round(parseFloat(parts[0]) * 100);
                        qty = parseInt(parts[1], 10);
                        priceFen = calculateSellerPriceFen(buyerPriceFen);
                    } else {
                        if (!session.steamPriceFen) {
                            return { msgtype: "text", text: { content: "当前无法获取 Steam 底价，请使用「价格 数量」的格式手动输入。" } };
                        }
                        qty = parseInt(text, 10);
                        buyerPriceFen = session.steamPriceFen - 1;
                        if (buyerPriceFen <= 0) buyerPriceFen = 1;
                        priceFen = calculateSellerPriceFen(buyerPriceFen);
                    }

                    let item = session.selectedItem;
                    if (!item && session.sellItemName) {
                        // Synthetic item for leaderboard sells
                        item = { name: session.sellItemName, count: 999 }; // 999 to bypass qty check as we sell single assetid anyway
                    }

                    if (!item) return null;

                    if (qty > item.count) {
                        return { msgtype: "text", text: { content: `输入数量(${qty})超过了库存拥有的数量(${item.count})，请重新输入。` } };
                    }

                    session.state = 'AWAITING_CONFIRM_SELL';
                    session.sellTask = {
                        priceFen,
                        buyerPriceFen,
                        qty
                    };

                    return {
                        msgtype: "markdown",
                        markdown: {
                            title: "出售确认",
                            text: `### ${item.name}\n- **所选账号**: ${session.accName}\n- **上架价格**: ¥ ${(buyerPriceFen / 100).toFixed(2)}\n- **到手价**: ¥ ${(priceFen / 100).toFixed(2)}\n- **上架数量**: ${qty} 个\n- **总计到手**: ¥ ${((priceFen * qty) / 100).toFixed(2)}\n\n确认按此价格上架请发送 \`确认\`，或重新输入(格式: 上架价格 数量)，退出请发送 \`取消\`。`
                        }
                    };
                }
            },
            {
                pattern: /^(确认|确认出售|yes|y)$/i,
                handler: async (match, senderId) => {
                    let session = dingTalkSessions.get(senderId);
                    if (!session) return null;

                    if (session.state === 'AWAITING_SELL_CONFIRM') {
                        // --- New: Execute Top-up Sell ---
                        const { sellAccId, sellAssetId, sellItemName, sellPriceFen } = session;
                        dingTalkSessions.delete(senderId);

                        const accounts = await readAccounts();
                        const acc = accounts.find(a => a.id === sellAccId);
                        if (!acc || !acc.steamCookie) {
                            return { msgtype: "text", text: { content: "账号信息不存在或 Cookie 已失效，上架中止。" } };
                        }

                        // Respond immediately (fire-and-forget pattern)
                        if (!res.headersSent) res.json({
                            msgtype: "text",
                            text: { content: `✅ 正在为您在账号 [${acc.name || acc.id}] 上架 [${sellItemName}]，请稍后在手机 Steam App 上进行确认。` }
                        });

                        (async () => {
                            const result = await performSteamSell(sellAccId, sellAssetId, sellPriceFen, sellItemName, senderId);
                            if (result.success) {
                                // Additional success reporting if needed, though performSteamSell handles most
                            }
                        })();
                        return true;
                    }

                    if (session.state !== 'AWAITING_CONFIRM_SELL') {
                        return null;
                    }

                    const { accId, selectedItem, sellTask, accName } = session;
                    dingTalkSessions.delete(senderId); // clear early

                    let invData;
                    try {
                        const invRaw = await fs.readFile(path.join(__dirname, 'inventories', `${accId}.json`), 'utf8');
                        invData = JSON.parse(invRaw);
                    } catch (e) {
                        return { msgtype: "text", text: { content: "无法读取库存档案，上架失败。" } };
                    }

                    const desc = invData.descriptions.find(d => (d.market_name || d.name) === selectedItem.name);
                    if (!desc) {
                        return { msgtype: "text", text: { content: "库存中找不到该饰品详情，请前往控制台更新资产。" } };
                    }

                    const matchAssets = invData.assets.filter(a => a.classid === desc.classid && a.instanceid === desc.instanceid);
                    if (matchAssets.length < sellTask.qty) {
                        return { msgtype: "text", text: { content: `可用的 assetid 数量(${matchAssets.length})不足请求数量(${sellTask.qty})，请前往控制台重新同步。` } };
                    }

                    const assetidsPool = matchAssets.map(a => a.assetid);
                    const targetQty = sellTask.qty;

                    // Respond immediately to DingTalk, process async
                    if (!res.headersSent) res.json({
                        msgtype: "text",
                        text: { content: `✅ 开始为账号 ${accName} 批量上架 ${targetQty} 个 ${selectedItem.name}，将于后台静默执行（遇到手机待处理将自动跳过并尝试下一个）。` }
                    });

                    (async () => {
                        const accsRaw = await fs.readFile(path.join(__dirname, 'accounts.json'), 'utf8');
                        const accs = JSON.parse(accsRaw);
                        const acc = accs.find(a => String(a.id) === String(accId));
                        if (!acc || !acc.steamCookie) return;

                        const soldAssetIds = [];
                        let soldCount = 0;

                        for (let i = 0; i < assetidsPool.length; i++) {
                            if (soldCount >= targetQty) break;

                            const assetid = assetidsPool[i];
                            const result = await performSteamSell(acc.id, assetid, sellTask.priceFen, selectedItem.name);

                            if (result.success) {
                                soldAssetIds.push(assetid);
                                soldCount++;
                                console.log(`[BotSell] Successfully listed ${assetid} for ${acc.name} (${soldCount}/${targetQty})`);
                            } else {
                                console.error(`[BotSell] Failed for ${assetid}: ${result.message}`);
                                // If we fail due to "pending confirmation" or other common Steam errors, don't necessarily abort the whole loop
                                // performSteamSell already handled the translation and logging
                            }

                            if (i < assetidsPool.length - 1 && soldCount < targetQty) {
                                await new Promise(r => setTimeout(r, 1500));
                            }
                        }

                        // Update disk inventory after loop to remove all successful sales
                        if (soldAssetIds.length > 0) {
                            try {
                                const inventoryPath = path.join(__dirname, 'inventories', `${accId}.json`);
                                const invRaw = await fs.readFile(inventoryPath, 'utf8').catch(() => null);
                                if (invRaw) {
                                    const inv = JSON.parse(invRaw);
                                    const before = inv.assets.length;
                                    inv.assets = inv.assets.filter(a => !soldAssetIds.includes(a.assetid));
                                    inv.total = Math.max(0, (inv.total || before) - (before - inv.assets.length));
                                    await fs.writeFile(inventoryPath, JSON.stringify(inv, null, 2));
                                    console.log(`[BotSell] Updated disk inventory for ${acc.name}: -${soldAssetIds.length} items.`);
                                }
                            } catch (err) {
                                console.error(`[自动售] 更新磁盘库存失败:`, err.message);
                            }
                        }
                    })();

                    return true; // done
                }
            },
            {
                pattern: /^(取消|q|quit|cancel|退出)$/i,
                handler: async (match, senderId) => {
                    if (dingTalkSessions.has(senderId)) {
                        dingTalkSessions.delete(senderId);
                        return { msgtype: "text", text: { content: "✅ 操作已取消，清理会话上下文。" } };
                    }
                    return null;
                }
            }
        ];

        // 匹配指令并执行
        // 增加 4.5s 强制超时保护，确保钉钉能在 5s 内得到回复
        const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve({
                msgtype: "text",
                text: { content: "⚠️ 服务器响应稍慢，正在为您努力查询中，请稍后刷新或再次尝试特定关键词。" }
            }), 4500)
        );

        const executionPromise = (async () => {
            for (const cmd of commands) {
                const match = textContent.match(cmd.pattern);
                if (match) {
                    const result = await cmd.handler(match, senderId);
                    if (result !== null && result !== undefined) return result;
                }
            }
            // 默认回复帮助信息
            return {
                msgtype: "markdown",
                markdown: {
                    title: "🎯 机器人指令帮助",
                    text: "### 🤖 支持以下基础指令：\n\n•**查价 [关键词]**：查询各类饰品价格，支持后续快捷购买 (例：查价 AK 墨岩)\n\n•**换余额**：立即推送一次换余额榜单\n\n•**换现金**：立即推送一次换现金榜单\n\n•**余额** 或 **余额 [账号名]**：查看当前所有账号或指定账号资金\n\n•**库存 [账号名]**：查看该账号所有可售库存，支持快捷出售 (例：库存 132)\n\n•**取消**：强制中断当前正在进行的选择/确认等操作流\n\n💡 许多指令在输入后会提供额外的数字快捷键（如直接回复 1 这类），机器人会按步骤引导你完成后续的购买与出售操作。"
                }
            };
        })();

        const finalResult = await Promise.race([executionPromise, timeoutPromise]);
        if (!res.headersSent) {
            return res.json(finalResult);
        }

    } catch (e) {
        console.error('[DingTalk] 接收异常:', e.message);
        if (!res.headersSent) {
            try {
                res.json({ msgtype: "text", text: { content: `[DingTalk] 接收异常: ${e.message}` } });
            } catch (jsonErr) {
                res.status(500).end();
            }
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// C5 Merchant API Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/c5/balance — C5 账户余额
app.get('/api/c5/balance', async (req, res) => {
    const { merchantId } = req.query;
    try {
        const data = await fetchC5Balance(merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 余额查询失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/c5/inventory/:steamId — 通过 C5 代理读取 Steam 库存
// --- Inventory Cache API ---
app.get('/api/inventory/cache', async (req, res) => {
    const { groupId } = req.query;
    const cache = await db.readInventoryCache(groupId);
    if (!cache) return res.json({ success: false, message: 'No cache available' });
    res.json({ success: true, ...cache });
});

app.post('/api/inventory/cache', async (req, res) => {
    const { groupId, items } = req.body;
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ success: false, error: 'Missing items' });
    }
    try {
        await db.writeInventoryCache(groupId, items);
        res.json({ success: true });
    } catch (e) {
        console.error('[InventoryCache] Write failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/c5/prices/batch — 批量获取 C5 市场价格
app.post('/api/c5/prices/batch', async (req, res) => {
    const { hashNames, merchantId } = req.body;
    if (!hashNames || !Array.isArray(hashNames)) {
        return res.status(400).json({ success: false, error: '缺少饰品名称列表' });
    }
    try {
        const pricesMap = await fetchC5GamePriceBatch(hashNames, merchantId);
        // Convert Map to plain object for JSON response
        const data = {};
        pricesMap.forEach((v, k) => { data[k] = v; });
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 批量查价失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// C5 API Proxy
app.get('/api/c5/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    const { merchantId } = req.query;
    try {
        let mid = merchantId;
        if (!mid) {
            const acc = (await db.readAccounts()).find(a => a.steamId64 === steamId);
            mid = acc?.c5MerchantId;
        }
        const data = await fetchC5Inventory(steamId, mid);

        // Preserve original inventory price as c5Price (market floor price) for all items
        data.forEach(item => {
            if (item.price) item.c5Price = item.price;
        });

        // Enrich status=1 (on-sale) items with their productId from the listings endpoint
        const saleItems = data.filter(item => item.status === 1);
        if (saleItems.length > 0) {
            try {
                const listingsData = await fetchC5Listings(steamId, 1, mid);
                const listings = listingsData.list || [];

                // Build assetId -> listing object map (only from listings with valid assetId)
                const assetIdMap = new Map();
                listings.forEach(l => {
                    const aid = l.assetInfo?.assetId;
                    if (aid && String(aid) !== '0' && String(aid) !== 'null') {
                        assetIdMap.set(String(aid), l);
                    }
                });

                // Inject productId and sync fresh price from listings
                saleItems.forEach(item => {
                    const listing = assetIdMap.get(String(item.assetId));
                    if (listing) {
                        if (!item.productId) {
                            item.productId = listing.id;
                        }
                        // Always sync the fresh price from the listing, as inventory API price is often cached
                        if (listing.price) {
                            item.price = listing.price;
                        }
                    }
                });
            } catch (e) {
                console.warn('[C5] 库存挂单合并失败 (非致命):', e.message);
            }
        }

        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 库存查询失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/c5/listings/:steamId — 查询指定账号的 C5 在售挂单
app.get('/api/c5/listings/:steamId', async (req, res) => {
    const { steamId } = req.params;
    const { merchantId } = req.query;
    try {
        let mid = merchantId;
        if (!mid) {
            const acc = (await db.readAccounts()).find(a => a.steamId64 === steamId);
            mid = acc?.c5MerchantId;
        }
        const page = parseInt(req.query.page) || 1;
        const data = await fetchC5Listings(steamId, page, mid);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 挂单查询失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/c5/list-item — 上架到 C5
app.post('/api/c5/list-item', async (req, res) => {
    const { token, styleToken, price, items, itemsArray } = req.body;
    let listItems = items || itemsArray || [];

    // Backwards compatibility with single item request
    if (listItems.length === 0 && token && styleToken && price != null) {
        listItems = [{ token, styleToken, price }];
    }

    if (listItems.length === 0) {
        return res.status(400).json({ success: false, error: '缺少上架必要参数' });
    }

    try {
        const data = await c5ListItem(listItems, null, null, req.body.merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 上架失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/c5/buy — C5 购买指定商品 (hashName 快速定向购买)
app.post('/api/c5/buy', async (req, res) => {
    const { hashName, price, tradeUrl, merchantId } = req.body;
    if (!hashName || price == null || !tradeUrl) {
        return res.status(400).json({ success: false, error: '缺少必要参数: hashName, price, tradeUrl' });
    }
    try {
        const data = await c5QuickBuy(tradeUrl, hashName, parseFloat(price), 0, merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 购买失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/c5/search — 先用 Steam 搜索中文关键词，取英文 hashName，再从 C5 查购买列表
app.get('/api/c5/search', async (req, res) => {
    const { keyword, maxPrice } = req.query;
    if (!keyword) return res.status(400).json({ success: false, error: '缺少搜索关键词' });
    const max = maxPrice ? parseFloat(maxPrice) : null;
    try {
        // Step 1: C5 元数据解析（通过公共接口获取精准 ID 和英文名）
        console.log(`[C5/搜索] 正在解析关键词: "${keyword}" ...`);
        const itemMetadata = await fetchC5ItemMetadata(keyword).catch(() => []);
        
        let allItems = [];
        if (itemMetadata.length > 0) {
            console.log(`[C5/搜索] 成功解析到 ${itemMetadata.length} 个匹配项: ${itemMetadata.map(m => m.name).join(', ')}`);
            // Step 2: 对每个解析到的 Metadata (优先用 itemId) 查 C5 商户在售列表
            const searches = await Promise.allSettled(itemMetadata.map(m => fetchC5GameSearch(m.itemId, 730, 30)));
            for (const result of searches) {
                if (result.status === 'fulfilled') allItems.push(...result.value);
            }
        } 
        
        // Step 3: 如果元数据解析没结果，回退到 Steam 系列搜索（翻译）
        if (allItems.length === 0) {
            console.log(`[C5/搜索] 元数据解析无结果，回退至 Steam 翻译机制...`);
            const steamResults = await fetchSteamSeries(keyword, 730, 5).catch(() => []);
            const hashNames = steamResults.map(r => r.hash_name || r.hashName).filter(Boolean);

            if (hashNames.length > 0) {
                console.log(`[C5/搜索] Steam 匹配到 ${hashNames.length} 个英文名: ${hashNames.join(', ')}`);
                const searches = await Promise.allSettled(hashNames.map(h => fetchC5GameSearch(h, 730, 30)));
                for (const result of searches) {
                    if (result.status === 'fulfilled') allItems.push(...result.value);
                }
            }
        }

        // 最后的回退：如果依然没任何结果，直接用原始关键词查一次（可能某些英文名直接匹配）
        if (allItems.length === 0) {
            console.log(`[C5/搜索] 翻译全链路无结果，尝试原始关键词直接搜索: "${keyword}"`);
            const fallbackItems = await fetchC5GameSearch(keyword, 730, 30);
            allItems.push(...fallbackItems);
        }

        // 按价格过滤并去重（同 token 只取一条）
        const seen = new Set();
        const filtered = allItems.filter(item => {
            if (seen.has(item.token)) return false;
            seen.add(item.token);
            if (max != null && parseFloat(item.price) > max) return false;
            return true;
        });
        // 按价格升序
        filtered.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

        res.json({ success: true, data: filtered });
    } catch (e) {
        console.error('[C5] 搜索失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/c5/modify-price — 修改 C5 挂单价格
app.put('/api/c5/modify-price', async (req, res) => {
    const { saleId, price, items } = req.body;
    let modifyItems = items || [];
    if (modifyItems.length === 0 && saleId && price != null) {
        modifyItems = [{ saleId, price }];
    }
    if (modifyItems.length === 0) {
        return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    try {
        const data = await c5ModifyPrice(modifyItems, null, req.body.merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 改价失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/c5/delist — 下架 C5 挂单
app.put('/api/c5/delist', async (req, res) => {
    const { saleId, saleIds, merchantId } = req.body;
    const ids = saleIds || (saleId ? [saleId] : []);
    if (!ids || (Array.isArray(ids) && ids.length === 0)) {
        return res.status(400).json({ success: false, error: '缺少必要参数: saleId 或 saleIds' });
    }
    try {
        const data = await c5Delist(ids, req.body.merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] 下架失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/c5/steam-info — 查询 C5 绑定的 Steam 账号信息
app.get('/api/c5/steam-info', async (req, res) => {
    const { merchantId } = req.query;
    try {
        const data = await fetchC5SteamInfo(merchantId);
        res.json({ success: true, data });
    } catch (e) {
        console.error('[C5] Steam 账号信息查询失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/sync-cloud — 同步 C5 云端账号到本地数据库
app.post('/api/accounts/sync-cloud', async (req, res) => {
    const { steamId, personaName, tradeUrl, merchantId } = req.body;
    if (!steamId) {
        return res.status(400).json({ success: false, error: '缺少 steamId' });
    }

    try {
        const accounts = readAccounts();
        const existing = accounts.find(a => a.steamId64 === steamId);
        if (existing) {
            return res.json({ success: true, message: '账号已在本地存在', data: existing });
        }

        const newAcc = {
            id: Date.now().toString(),
            name: personaName || '云端同步-' + steamId.substring(steamId.length - 4),
            profile: 'Default',
            browserType: 'edge',
            steamId64: steamId,
            tradeUrl: tradeUrl || null,
            personaName: personaName || null,
            c5MerchantId: merchantId || null,
            autoConfirm: 1
        };

        upsertAccount(newAcc);
        res.json({ success: true, data: newAcc });
    } catch (e) {
        console.error('[C5] 同步云端账号失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Account Groups CRUD ───────────────────────────────────────────────────────

// GET /api/groups — 获取所有分组（含账号数量）
app.get('/api/groups', async (req, res) => {
    try {
        res.json({ success: true, groups: await db.readGroups() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/groups — 创建/更新分组
app.post('/api/groups', async (req, res) => {
    const { id, name, color, sortOrder } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: '分组名称不能为空' });
    try {
        await db.upsertGroup({ id, name: name.trim(), color, sortOrder });
        res.json({ success: true, groups: await db.readGroups() });
    } catch (e) {
        if (e.message?.includes('UNIQUE')) {
            return res.status(400).json({ success: false, error: '分组名称已存在' });
        }
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/groups/:id — 删除分组（账号自动解除关联）
app.delete('/api/groups/:id', async (req, res) => {
    try {
        await db.deleteGroup(Number(req.params.id));
        res.json({ success: true, groups: await db.readGroups() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/accounts/:id/totp — 生成当前 Steam Guard 五位验证码
app.get('/api/accounts/:id/totp', async (req, res) => {
    const acc = (await db.readAccounts()).find(a => String(a.id) === String(req.params.id));
    if (!acc) return res.status(404).json({ success: false, error: '账号不存在' });

    let sharedSecret = null;
    // 优先从存储的 mafile_content 中提取 shared_secret
    if (acc.mafileContent) {
        try {
            const parsed = JSON.parse(acc.mafileContent);
            sharedSecret = parsed.shared_secret || null;
        } catch (_) { }
    }
    if (!sharedSecret) {
        return res.status(400).json({ success: false, error: '该账号的 maFile 数据未存储（旧账号需重新通过"批量导入"导入 maFile 才能生成令牌）' });
    }

    try {
        const crypto = require('crypto');
        const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

        // Steam Guard TOTP 算法
        function generateSteamCode(secret, timestamp) {
            const timeBytes = Buffer.alloc(8);
            const timeCounter = Math.floor(timestamp / 30);
            // 写入 8 字节大端 int64（JS 安全整数范围内无精度问题）
            timeBytes.writeUInt32BE(Math.floor(timeCounter / 0x100000000), 0);
            timeBytes.writeUInt32BE(timeCounter >>> 0, 4);

            const key = Buffer.from(secret, 'base64');
            const hmac = crypto.createHmac('sha1', key).update(timeBytes).digest();

            const offset = hmac[19] & 0x0f;
            const code32 = ((hmac[offset] & 0x7f) << 24)
                | ((hmac[offset + 1] & 0xff) << 16)
                | ((hmac[offset + 2] & 0xff) << 8)
                | (hmac[offset + 3] & 0xff);

            let code = '';
            let val = code32;
            for (let i = 0; i < 5; i++) {
                code += STEAM_CHARS[val % STEAM_CHARS.length];
                val = Math.floor(val / STEAM_CHARS.length);
            }
            return code;
        }

        const now = Math.floor(Date.now() / 1000);
        const code = generateSteamCode(sharedSecret, now);
        const secondsRemaining = 30 - (now % 30);

        res.json({ success: true, code, secondsRemaining });
    } catch (e) {
        res.status(500).json({ success: false, error: '生成失败: ' + e.message });
    }
});

// POST /api/accounts/:id/refresh-token — 使用 RefreshToken 换取新的 Steam Web Cookie
app.post('/api/accounts/:id/refresh-token', async (req, res) => {
    const acc = (await db.readAccounts()).find(a => String(a.id) === String(req.params.id));
    if (!acc) return res.status(404).json({ success: false, error: '账号不存在' });
    if (!acc.refreshToken) return res.status(400).json({ success: false, error: '该账号没有 RefreshToken，无法刷新' });
    try {
        const newCookie = await steamRefreshSession(acc);
        if (!newCookie) return res.status(500).json({ success: false, error: '刷新失败，RefreshToken 可能已过期' });
        console.log(`[Token刷新] ✅ 账号 ${acc.name}: 手动触发刷新成功`);
        res.json({ success: true, message: 'Cookie 已刷新', newCookie });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// PUT /api/accounts/:id/group — 将账号分配到分组（groupId=null 表示移除分组）
app.put('/api/accounts/:id/group', async (req, res) => {
    const { groupId } = req.body;
    try {
        await db.assignAccountGroup(req.params.id, groupId || null);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// GET /api/steam/inventory/:steamId — Steam 公开库存代理（无需 Cookie）
// 返回字段已标准化，与 C5 库存接口字段兼容（imageUrl, status, name 等）
// 429 防封：由 steamRequest 内部处理，3次指数退避（3s/6s/9s）换IP重试
app.get('/api/steam/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    const count = parseInt(req.query.count) || 500;
    const startAssetId = req.query.start_assetid || '';
    try {
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=schinese&count=${count}${startAssetId ? `&start_assetid=${startAssetId}` : ''}`;
        // 优先策略：账号有 maFile → 直接实时刷新 Cookie，可访问私密库存和冷却物品
        // 无 maFile → 用存储的 steamCookie；Cookie 失效 → 匿名回退
        const accounts = await readAccounts();
        const acc = accounts.find(a => String(a.steamId64) === String(steamId));
        let resp;
        if (acc?.mafileContent) {
            // 有 maFile：始终用新鲜 Cookie（能看私密库存 + 冷却物品）
            try {
                const mafile = JSON.parse(acc.mafileContent);
                const refreshToken = mafile?.Session?.RefreshToken;
                if (!refreshToken) throw new Error('无 RefreshToken');
                const sessionResult = await withTimeout(
                    steamRefreshSession({ ...acc, refreshToken, steamId64: acc.steamId64 }),
                    20000, `${acc.name} Cookie刷新`
                );
                if (!sessionResult?.cookieArray) throw new Error('Cookie 刷新失败');
                // ✅ 关键修复：cookieArray 是 Set-Cookie 格式（含 Domain/Path），must use prepareCookieHeader 提取纯 key=value
                const rawCookieStr = sessionResult.cookieArray.join('; ');
                const freshCookie = prepareCookieHeader(rawCookieStr, 'community');
                console.log(`[Steam库存] ${acc.name} Cookie 片段预览: ${freshCookie.slice(0, 120)}`);

                // 使用 Referer 模拟账户所有者从自己的库存页发起请求
                resp = await steamRequest(url, {
                    method: 'GET', validateStatus: () => true,
                    timeout: 20000,
                    headers: {
                        'Cookie': freshCookie,
                        'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/`
                    }
                });
                console.log(`[Steam库存] ${acc.name} 已认证访问，获取到 ${resp.data?.assets?.length || 0} 件（含冷却中）`);
                // 后台静默更新 Cookie（存纯净格式）
                setImmediate(async () => {
                    try { await db.getPool().execute('UPDATE accounts SET steam_cookie = ? WHERE id = ?', [freshCookie, acc.id]); } catch (_) {}
                });
            } catch (refreshErr) {
                console.warn(`[Steam库存] ${acc.name} maFile Cookie 刷新失败(${refreshErr.message})，降级用存储 Cookie`);
                // 刷新失败，降级用存储 Cookie
                const axiosConfig2 = { method: 'GET', validateStatus: () => true, headers: {} };
                if (acc.steamCookie) axiosConfig2.headers['Cookie'] = prepareCookieHeader(acc.steamCookie, 'community');
                resp = await steamRequest(url, axiosConfig2);
            }
        } else {
            // 无 maFile：用存储 Cookie 或匿名
            const axiosConfig = { method: 'GET', validateStatus: () => true, headers: {} };
            if (acc?.steamCookie) {
                axiosConfig.headers['Cookie'] = prepareCookieHeader(acc.steamCookie, 'community');
            }
            resp = await steamRequest(url, axiosConfig);
            // Cookie 过期回退匿名
            if (resp && (resp.status === 401 || resp.status === 403)) {
                resp = await steamRequest(url, { method: 'GET', validateStatus: () => true, headers: {} });
            }
        }


        if (!resp || !resp.data) {
            return res.json({ success: false, error: 'Steam 返回无效数据' });
        }
        if (resp.status === 403 || (resp.data && resp.data.error === 'This profile is private.')) {
            return res.json({ success: false, error: '库存已设为私密', private: true });
        }

        // 如果返回 total_inventory_count=0 但 success=1，可能是 Steam 的 10 天新物品隐藏机制
        // (2024年4月起，CS2 新交易物品对所有 HTTP API 隐藏 10 天，包括账户本人的认证请求)
        if (resp.data?.success === 1 && !resp.data?.assets && (resp.data?.total_inventory_count === 0 || resp.data?.total_inventory_count == null)) {
            console.log(`[Steam库存] ${steamId} 返回空库存（可能因 10 天新物品隐藏规则，稍后自动显示）`);
            return res.json({ success: true, data: { items: [], totalCount: 0, hiddenByNewItemRule: true } });
        }

        // 合并 assets + descriptions，标准化字段（兼容 C5 前端渲染）
        const assets = resp.data.assets || [];
        const descMap = {};
        (resp.data.descriptions || []).forEach(d => {
            descMap[`${d.classid}_${d.instanceid}`] = d;
        });

        const items = assets.map(a => {
            const desc = descMap[`${a.classid}_${a.instanceid}`] || {};
            const tradable = !!desc.tradable;
            const marketable = !!desc.marketable;
            // C5-compatible status: 0=可上架, 2=锁定/冷却, 3=不可上市
            let status;
            if (tradable && marketable) status = 0;
            else if (!tradable) status = 2;
            else status = 3;

            const iconPath = desc.icon_url || '';
            const imageUrl = iconPath
                ? `https://community.akamai.steamstatic.com/economy/image/${iconPath}/128fx96f`
                : null;

            const tags = desc.tags || [];
            const rarityTag = tags.find(t => t.category === "Rarity");
            const exteriorTag = tags.find(t => t.category === "Exterior");
            const itemInfo = {
                rarityName: rarityTag ? rarityTag.localized_tag_name : null,
                rarityColor: rarityTag ? `#${rarityTag.color}` : '#B0C3D9',
                exteriorName: exteriorTag ? exteriorTag.localized_tag_name : null,
            };

            // 解析冷却解锁时间（Steam 会在 desc.descriptions 里写 "Tradeable After: xxx"）
            let tradeHoldExpiry = null;
            const descTexts = desc.descriptions || [];
            for (const d of descTexts) {
                const m = (d.value || '').match(/Tradeable After:\s*(.+)/i);
                if (m) { tradeHoldExpiry = m[1].trim(); break; }
            }

            return {
                token: `steam_${a.assetid}`,
                marketHashName: desc.market_hash_name || '',
                name: desc.name || '',
                imageUrl,
                status,
                price: null,
                tradable,
                locked: !tradable,
                tradeHoldExpiry,
                marketable,
                assetId: a.assetid,
                classId: a.classid,
                amount: a.amount,
                source: 'steam',
                itemInfo
            };

        });

        return res.json({ success: true, data: { items, totalCount: resp.data.total_inventory_count || items.length } });

    } catch (e) {
        // steamRequest 三次换IP依然失败后会抛出429错误
        const is429 = e.response?.status === 429 || e.message?.includes('429');
        if (is429) {
            console.warn(`[Steam 库存] ${steamId} 三次换IP后仍然 429，停止同步`);
            return res.status(429).json({ success: false, error: '已连续 3 次 429 + IP切换，已停止同步', rateLimited: true });
        }
        res.status(500).json({ success: false, error: e.message });
    }
});



// POST /api/accounts/import-batch — 批量导入 maFile 到数据库（无 C5 绑定）—— SSE 流式推送
app.post('/api/accounts/import-batch', async (req, res) => {

    const { maFiles } = req.body;
    if (!maFiles || !Array.isArray(maFiles)) {
        return res.status(400).json({ success: false, error: '缺少 maFiles 数据' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const sendProgress = (name, status, detail = '') => send({ type: 'progress', name, status, detail });

    const results = [];
    let skipTradeUrlFetch = false;
    let consecutive429 = 0;

    // 自动为这批账号创建一个"分组X"
    const groups = await db.readGroups();
    let maxGroupNum = 0;
    for (const g of groups) {
        const match = g.name.match(/^分组(\d+)$/);
        if (match) maxGroupNum = Math.max(maxGroupNum, parseInt(match[1], 10));
    }
    const newGroupName = `分组${maxGroupNum + 1}`;
    const newGroupId = await db.upsertGroup({ name: newGroupName });

    // 并发处理函数（单个文件）
    async function processOneFile(file) {
        sendProgress(file.name, 'processing', '解析中...');
        try {
            const parsed = parseMaFile(file.content);
            if (!parsed.steamId64) throw new Error('解析 maFile 失败: 找不到 SteamID');

            // 重复检测
            const existingAccounts = await readAccounts();
            const isDuplicate = existingAccounts.some(a => String(a.steamId64) === String(parsed.steamId64));
            if (isDuplicate) {
                const existName = existingAccounts.find(a => String(a.steamId64) === String(parsed.steamId64))?.name || parsed.steamId64;
                sendProgress(file.name, 'skipped', `⚠️ 重复账号，已跳过 (已存在: ${existName})`);
                const resultEntry = { name: file.name, success: false, skipped: true, error: `重复账号: SteamID ${parsed.steamId64} 已存在 (${existName})` };
                results.push(resultEntry);
                send({ type: 'file_done', ...resultEntry });
                return;
            }

            let tradeUrl = null;
            let activeCookie = parsed.cookie;

            // Step 1: RefreshToken → 新鲜 Cookie
            if (parsed.refreshToken && !skipTradeUrlFetch) {
                sendProgress(file.name, 'processing', '刷新 Session...');
                try {
                    const fakeAcc = { name: parsed.accountName || file.name, steamId64: parsed.steamId64, refreshToken: parsed.refreshToken, existingAccessToken: parsed.existingAccessToken || null };
                    const freshCookie = await steamRefreshSession(fakeAcc);
                    if (freshCookie) {
                        activeCookie = freshCookie;
                        sendProgress(file.name, 'processing', 'Session 刷新成功，获取交易链接...');
                    }
                } catch (e) {
                    sendProgress(file.name, 'processing', `Session 刷新失败: ${e.message}`);
                }
            }

            // Step 2: 获取 TradeURL
            if (activeCookie && !skipTradeUrlFetch) {
                try {
                    tradeUrl = await fetchTradeUrlFromCookie(activeCookie, parsed.steamId64);
                    consecutive429 = 0;
                    sendProgress(file.name, 'processing', '交易链接已获取，保存账号...');
                } catch (e) {
                    const errMsg = e.message;
                    sendProgress(file.name, 'processing', `交易链接失败: ${errMsg}`);
                    if (errMsg.includes('429')) {
                        consecutive429++;
                        if (consecutive429 >= 3) skipTradeUrlFetch = true;
                    } else {
                        consecutive429 = 0;
                    }
                }
            }

            // Step 3: 保存到本地
            const cookieForDb = typeof activeCookie === 'object' && activeCookie !== null
                ? (activeCookie.cookieString || null)
                : (activeCookie || parsed.cookie || null);

            const newProfilePath = path.join(__dirname, 'profiles', `acc_${Date.now() + Math.floor(Math.random() * 1000)}`);
            try { await fs.mkdir(newProfilePath, { recursive: true }); } catch (e) { }

            const newAcc = {
                id: Date.now() + Math.floor(Math.random() * 1000).toString(),
                name: parsed.accountName || file.name.replace('.maFile', ''),
                profile: 'Default',
                browserType: 'edge',
                profilePath: newProfilePath,
                browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                steamId64: parsed.steamId64,
                steamCookie: cookieForDb,
                tradeUrl: tradeUrl,
                mafileContent: typeof file.content === 'object' ? JSON.stringify(file.content) : file.content,
                autoConfirm: 1,
                c5MerchantId: null,
                groupId: newGroupId
            };
            await db.upsertAccount(newAcc);

            const resultEntry = { name: file.name, success: true, steamId: parsed.steamId64, tradeUrl };
            results.push(resultEntry);
            send({ type: 'file_done', ...resultEntry });

        } catch (e) {
            const resultEntry = { name: file.name, success: false, error: e.message };
            results.push(resultEntry);
            send({ type: 'file_done', ...resultEntry });
        }
    }

    // 并发度为 3 的 worker pool
    const CONCURRENCY = 3;
    const queue = [...maFiles];
    const workers = Array.from({ length: Math.min(CONCURRENCY, maFiles.length) }, () =>
        (async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                if (file) await processOneFile(file);
            }
        })()
    );
    await Promise.all(workers);

    send({ type: 'done', results });
    res.end();
});


// POST /api/c5/batch-bind — 将已有数据库账号批量绑定到指定 C5 商户
// 需要用户提供 C5 Session 以及手机号用来设置秒发货
app.post('/api/c5/batch-bind', async (req, res) => {
    let { accountIds, merchantId, phone, areaCode = 86 } = req.body;
    if (!accountIds || !Array.isArray(accountIds) || !merchantId) {
        return res.status(400).json({ success: false, error: '缺少 accountIds 或 merchantId' });
    }

    try {
        const accounts = await readAccounts();
        const targets = accounts.filter(a => accountIds.includes(String(a.id)));
        if (targets.length === 0) return res.status(400).json({ success: false, error: '未找到指定账号' });

        // 校验资料完整度 (密码和交易链接，防止半途失败)
        const missingInfoAccounts = [];
        for (const acc of targets) {
            let missing = [];
            if (!acc.accountPassword) missing.push('密码');
            if (!acc.tradeUrl) missing.push('交易URL');
            
            if (missing.length > 0) {
                missingInfoAccounts.push(`[${acc.name}: 缺失 ${missing.join(' 和 ')}]`);
            }
        }
        
        if (missingInfoAccounts.length > 0) {
            return res.status(400).json({
                success: false, 
                error: `准备绑定的账号资料不完整，请在本地补充后再试！\n${missingInfoAccounts.join('，')}`
            });
        }

        // 获取该 C5 商户的 Cookie
        const c5Merchants = await db.readMerchants();
        const merchant = c5Merchants.find(m => String(m.id) === String(merchantId));
        if (!merchant || !merchant.sessionCookie) {
            return res.status(400).json({ success: false, error: '未找到指定 C5 商户或商户未登录' });
        }

        // 自动提取或记忆手机号
        if (!phone) {
            phone = merchant.phone;
            areaCode = merchant.areaCode || '86';
        } else if (phone !== merchant.phone || String(areaCode) !== String(merchant.areaCode)) {
            // 如果前端传了新手机号，且与数据库记录不同，更新进数据库予以保存记忆
            merchant.phone = phone;
            merchant.areaCode = areaCode;
            await db.upsertMerchant(merchant);
            console.log(`[C5 批量绑定] 已将手机号 ${phone} 保存至商户 ${merchant.name} 档中`);
        }

        if (!phone) {
            return res.status(400).json({ success: false, error: '第一次绑定需要填写手机号用于设置秒发货，后续可自动记忆' });
        }
        let c5Cookies = [];
        try {
            c5Cookies = JSON.parse(merchant.sessionCookie);
        } catch (e) {
            return res.status(400).json({ success: false, error: 'C5 商户 Cookie 格式错误' });
        }

        const { autoBindSingleAccount, getExecutablePath, puppeteer } = require('./c5-auto-bind.js');
        const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

        // 启动统一的浏览器实例
        const browser = await puppeteer.launch({ 
            executablePath: getExecutablePath(),
            headless: 'new', // 设定为后台无头模式
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--window-size=1400,900',
                '--disable-blink-features=AutomationControlled'
            ] 
        });

        const results = [];
        for (const acc of targets) {
            try {
                if (!acc.mafileContent) throw new Error('此账号缺少 maFile，无法获取 Steam Cookie');
                
                // 解析获取 Web Cookies
                const maf = JSON.parse(acc.mafileContent);
                let platform = EAuthTokenPlatformType.MobileApp;
                try {
                    const payload = JSON.parse(Buffer.from(maf.Session.RefreshToken.split('.')[1], 'base64').toString('utf8'));
                    if (payload.aud && payload.aud.includes('web')) {
                        platform = EAuthTokenPlatformType.WebBrowser;
                    }
                } catch(e) {}
                
                let session = new LoginSession(platform);
                session.refreshToken = maf.Session.RefreshToken;
                const steamCookies = await session.getWebCookies();

                console.log(`[C5 批量绑定] 正在执行 ${acc.name} 的网页端深度绑定...`);
                const bindRes = await autoBindSingleAccount(acc, steamCookies, browser);

                if (bindRes && bindRes.success) {
                    // OpenID 网页端和交易链接绑定均成功后，调用原始 API 为商户开启账号的「秒发货」模式
                    console.log(`[C5 批量绑定] ${acc.name} 网页绑定成功，正在注册秒发货...`);
                    try {
                        await bindC5SteamAccount(acc.steamId64, phone, merchantId, areaCode);
                        console.log(`[C5 批量绑定] ${acc.name} 开启秒发货成功！`);
                        await db.upsertAccount({ ...acc, c5MerchantId: merchantId });
                        results.push({ id: acc.id, name: acc.name, steamId: acc.steamId64, success: true });
                    } catch (secError) {
                        console.error(`[C5 批量绑定] ${acc.name} 秒发货注册失败:`, secError.message);
                        results.push({ id: acc.id, name: acc.name, success: false, error: '授权与交易链接已填，但秒发货失败: ' + secError.message });
                    }
                } else {
                    results.push({ id: acc.id, name: acc.name, success: false, error: bindRes ? bindRes.error : '未知错误' });
                }
            } catch (e) {
                console.error(`[C5 批量绑定] 账号 ${acc.name} 异常:`, e.message);
                results.push({ id: acc.id, name: acc.name, success: false, error: e.message });
            }
        }

        await browser.close();

        const successCount = results.filter(r => r.success).length;
        console.log(`[C5 批量绑定(Puppeteer)] 商户 ${merchantId}: 完整成功 ${successCount}/${targets.length}`);
        res.json({ success: true, results, successCount, totalCount: targets.length });

    } catch (err) {
        console.error('[C5 Batch Bind API Error]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});









// --- C5 Merchant Management ---


app.get('/api/c5/merchants', async (req, res) => {
    try {
        const merchants = await db.readMerchants();
        res.json({ success: true, merchants });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/c5/merchants', async (req, res) => {
    const { id, name, appKey, isDefault } = req.body;
    if (!name || !appKey) {
        return res.status(400).json({ success: false, error: '缺少必要参数: 姓名或 API KEY' });
    }
    try {
        await db.upsertMerchant({ id, name, appKey, isDefault });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/c5/merchants/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.deleteMerchant(parseInt(id));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/accounts/:id/trade-url — 更新账号的交易链接
app.put('/api/accounts/:id/trade-url', async (req, res) => {
    const { id } = req.params;
    const { tradeUrl } = req.body;
    try {
        await db.updateAccountTradeUrl(id, tradeUrl || null);
        res.json({ success: true });
    } catch (e) {
        console.error('[账号] 更新交易链接失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 内部 helper：用账号密码 + maFile TOTP 重新登录 Steam，获取新的 RefreshToken，并持久化到数据库。
 * 成功返回新的 refreshToken 字符串，失败抛出 Error。
 */
async function reloginWithPassword(acc) {
    const password = acc.accountPassword;
    if (!password) throw new Error(`账号 ${acc.name} 没有保存密码，无法自动重新登录`);
    if (!acc.mafileContent) throw new Error(`账号 ${acc.name} 没有 maFile，无法进行 Steam Guard 验证`);

    const mafile = JSON.parse(acc.mafileContent);
    const sharedSecret = mafile.shared_secret;
    const accountName = mafile.account_name || acc.name;
    if (!sharedSecret) throw new Error(`账号 ${acc.name} 的 maFile 中缺少 shared_secret`);

    const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');
    const SteamTotp = require('steam-totp');

    console.log(`[自动重登] 账号 ${acc.name}: 开始密码登录...`);

    const session = new LoginSession(EAuthTokenPlatformType.MobileApp);
    const proxyUrl = getProxyAgent('https://api.steampowered.com');
    if (proxyUrl) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        session.agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
    }

    // Step 1: 发起凭据登录，获取需要的验证类型
    const startResult = await session.startWithCredentials({ accountName, password });

    if (startResult.actionRequired) {
        const validActions = startResult.validActions || [];
        const needsDeviceCode = validActions.some(a =>
            a.type === EAuthSessionGuardType?.DeviceCode ||
            (typeof a.type === 'number' && a.type === 3) // EAuthSessionGuardType.DeviceCode = 3
        );

        if (needsDeviceCode) {
            // TOTP 设备验证码
            const code = SteamTotp.generateAuthCode(sharedSecret);
            console.log(`[自动重登] 账号 ${acc.name}: 提交 Steam Guard TOTP 代码 ${code}`);
            await session.submitSteamGuardCode(code);
        } else {
            // 检查是否需要设备确认（手机 App 确认）或邮件确认
            const needsConfirmation = validActions.some(a =>
                a.type === EAuthSessionGuardType?.DeviceConfirmation ||
                a.type === EAuthSessionGuardType?.EmailConfirmation ||
                (typeof a.type === 'number' && (a.type === 4 || a.type === 6))
            );
            if (needsConfirmation) {
                throw new Error(`账号 ${acc.name} 需要手机 App 或邮件确认，无法自动完成`);
            }
            // 未知类型，尝试直接提交 TOTP
            const code = SteamTotp.generateAuthCode(sharedSecret);
            console.log(`[自动重登] 账号 ${acc.name}: 未知验证类型 [${validActions.map(a=>a.type).join(',')}]，尝试提交 TOTP ${code}`);
            await session.submitSteamGuardCode(code);
        }
    }

    // Step 2: 等待 authenticated 事件（submitSteamGuardCode 成功后 Steam 侧 poll 会触发）
    await new Promise((resolve, reject) => {
        if (session.refreshToken) return resolve(); // 已经完成
        const timeout = setTimeout(() => reject(new Error('等待 Steam 认证完成超时(60s)')), 60000);
        session.on('authenticated', () => { clearTimeout(timeout); resolve(); });
        session.on('error', (err) => { clearTimeout(timeout); reject(err); });
        session.on('timeout', () => { clearTimeout(timeout); reject(new Error('Steam session 轮询超时')); });
    });

    const newRefreshToken = session.refreshToken;
    if (!newRefreshToken) throw new Error('登录成功但未获取到 RefreshToken');

    console.log(`[自动重登] 账号 ${acc.name}: ✅ 获取到新 RefreshToken，正在持久化...`);

    // 写回 mafile_content
    mafile.Session = mafile.Session || {};
    mafile.Session.RefreshToken = newRefreshToken;
    if (session.accessToken) mafile.Session.AccessToken = session.accessToken;
    const newMafileContent = JSON.stringify(mafile, null, 2);
    await db.getPool().execute(
        'UPDATE accounts SET mafile_content = ? WHERE id = ?',
        [newMafileContent, acc.id]
    );

    return { newRefreshToken, newMafileContent };
}

// POST /api/accounts/:id/fetch-trade-url — 通过 maFile 中的 RefreshToken 自动获取该账号的 Steam 交易链接
app.post('/api/accounts/:id/fetch-trade-url', async (req, res) => {
    const { id } = req.params;
    try {
        const accounts = await db.readAccounts();
        const acc = accounts.find(a => a.id === id);
        if (!acc) return res.status(404).json({ success: false, error: '账号不存在' });

        // 解析 maFile 获取 RefreshToken 和原始 AccessToken（FinalizeLogin nonce 类型不同）
        let refreshToken = acc.refreshToken || null;
        let existingAccessToken = null;
        let steamId64 = acc.steamId64;

        if (acc.mafileContent) {
            try {
                const parsed = parseMaFile(acc.mafileContent);
                if (!refreshToken) refreshToken = parsed.refreshToken;
                if (!steamId64)    steamId64    = parsed.steamId64;
                existingAccessToken = parsed.existingAccessToken || null;
            } catch (e) {
                return res.status(400).json({ success: false, error: `解析 maFile 失败: ${e.message}` });
            }
        }

        if (!refreshToken) {
            return res.status(400).json({ success: false, error: '该账号没有 RefreshToken，无法自动获取交易链接' });
        }
        if (!steamId64) {
            return res.status(400).json({ success: false, error: '该账号缺少 SteamID64' });
        }

        console.log(`[交易链接] 账号 ${acc.name}: 开始通过 RefreshToken 获取交易链接...`);

        // Step 1: 用 RefreshToken 换取新的 Web Cookie 和 AccessToken
        let refreshResult = await steamRefreshSession({ name: acc.name, steamId64, refreshToken, existingAccessToken });

        // RefreshToken 过期时，自动用保存的密码重新登录获取新 RefreshToken
        if (!refreshResult && acc.accountPassword && acc.mafileContent) {
            console.log(`[交易链接] 账号 ${acc.name}: RefreshToken 已失效，尝试用保存的密码自动重新登录...`);
            try {
                const { newRefreshToken, newMafileContent } = await reloginWithPassword(acc);
                // 用新令牌再试一次
                refreshResult = await steamRefreshSession({ name: acc.name, steamId64, refreshToken: newRefreshToken });
                if (refreshResult) {
                    console.log(`[交易链接] 账号 ${acc.name}: ✅ 自动重登成功，继续获取交易链接`);
                    // 同步更新 Cookie
                    if (refreshResult.cookieString) {
                        await db.getPool().execute('UPDATE accounts SET steam_cookie = ? WHERE id = ?', [refreshResult.cookieString, id]);
                    }
                } else {
                    return res.status(500).json({ success: false, error: '自动重登后 RefreshToken 刷新仍然失败' });
                }
            } catch (reloginErr) {
                console.error(`[交易链接] 账号 ${acc.name}: 自动重登失败: ${reloginErr.message}`);
                return res.status(500).json({ success: false, error: `RefreshToken 已过期，自动重登失败: ${reloginErr.message}` });
            }
        } else if (!refreshResult) {
            return res.status(500).json({ success: false, error: '令牌过期，请先导入密码' });
        }

        const { cookieString: freshCookie } = refreshResult;

        // Step 2: 用 Cookie 或 AccessToken 获取交易链接
        const tradeUrl = await fetchTradeUrlFromCookie(refreshResult, steamId64);
        console.log(`[交易链接] 账号 ${acc.name}: 成功获取 -> ${tradeUrl}`);

        // Step 3: 写入数据库
        await db.updateAccountTradeUrl(id, tradeUrl);

        // Step 4: 同时更新 steamCookie（趁热打铁，新 cookie 可能还有效）
        const updatedAcc = { ...acc, tradeUrl, steamCookie: freshCookie };
        await db.upsertAccount(updatedAcc);

        res.json({ success: true, tradeUrl });
    } catch (e) {
        console.error(`[交易链接] 获取失败:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/accounts/:id/save-password — 保存账号密码
app.post('/api/accounts/:id/save-password', async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '密码不能为空' });
    try {
        await db.updateAccountPassword(id, password);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/accounts/batch-update-passwords — 批量导入账号密码（格式：账号----密码）
app.post('/api/accounts/batch-update-passwords', async (req, res) => {
    const { entries } = req.body; // [{ name, password }]
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: '需要 entries 数组' });
    }
    try {
        const allAccounts = await db.readAccounts();
        // 构建大小写不敏感的名称 -> id 映射
        const nameMap = new Map();
        for (const acc of allAccounts) {
            if (acc.name) nameMap.set(acc.name.toLowerCase().trim(), acc.id);
        }

        const updated = [], notFound = [];
        for (const entry of entries) {
            const key = (entry.name || '').toLowerCase().trim();
            if (!key || !entry.password) continue;
            const id = nameMap.get(key);
            if (id) {
                await db.updateAccountPassword(id, entry.password);
                updated.push(entry.name);
            } else {
                notFound.push(entry.name);
            }
        }
        console.log(`[批量密码] 更新 ${updated.length} 个，未找到 ${notFound.length} 个`);
        res.json({ success: true, updatedCount: updated.length, notFoundCount: notFound.length, updated, notFound });
    } catch (e) {
        console.error('[批量密码] 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/accounts/:id/relogin — 用密码+maFile重新登录Steam，刷新RefreshToken
// 流程: StartWithCredentials -> Steam Guard TOTP -> 获取新 RefreshToken -> 写回 mafile_content
app.post('/api/accounts/:id/relogin', async (req, res) => {
    const { id } = req.params;
    const { password: bodyPassword } = req.body;

    const allAccounts = await db.readAccounts();
    const acc = allAccounts.find(a => String(a.id) === String(id));
    if (!acc) return res.status(404).json({ error: '账号不存在' });

    // 密码优先用请求里的，其次用数据库保存的
    const password = bodyPassword || acc.accountPassword;
    if (!password) return res.status(400).json({ error: '该账号没有保存密码，请先设置密码' });
    if (!acc.mafileContent) return res.status(400).json({ error: '该账号没有 maFile，无法进行 Steam Guard 验证' });

    try {
        // 如果请求里带了密码，先持久化（方便下次免输入）
        if (bodyPassword) await db.updateAccountPassword(id, bodyPassword);

        // 复用内部 helper 执行完整登录流
        const { newRefreshToken, newMafileContent } = await reloginWithPassword({ ...acc, accountPassword: password });

        // 立刻用新 RefreshToken 刷新 Cookie
        try {
            const sessionResult = await steamRefreshSession({ ...acc, mafileContent: newMafileContent, refreshToken: newRefreshToken });
            if (sessionResult?.cookieString) {
                await db.getPool().execute(
                    'UPDATE accounts SET steam_cookie = ? WHERE id = ?',
                    [sessionResult.cookieString, id]
                );
                console.log(`[重新登录] 账号 ${acc.name}: ✅ Cookie 已同步更新`);
            }
        } catch (cookieErr) {
            console.warn(`[重新登录] 账号 ${acc.name}: Cookie 更新失败 (${cookieErr.message})，但 RefreshToken 已保存`);
        }

        res.json({ success: true, message: `${acc.name} 重新登录成功，RefreshToken 已更新` });
    } catch (e) {
        console.error(`[重新登录] 账号 ${acc.name || id} 失败: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/accounts/batch-fetch-trade-urls — 批量为所有缺少交易链接的账号补全
app.post('/api/accounts/batch-fetch-trade-urls', async (req, res) => {
    // SSE 流式推送进度
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        const accounts = await db.readAccounts();
        const targets = accounts.filter(a => !a.tradeUrl && (a.refreshToken || a.mafileContent));
        send({ type: 'start', total: targets.length });

        let successCount = 0;
        for (const acc of targets) {
            send({ type: 'progress', name: acc.name, status: 'processing', detail: '刷新 Cookie...' });
            try {
                let refreshToken = acc.refreshToken;
                let steamId64 = acc.steamId64;

                if (!refreshToken && acc.mafileContent) {
                    const parsed = parseMaFile(acc.mafileContent);
                    refreshToken = parsed.refreshToken;
                    if (!steamId64) steamId64 = parsed.steamId64;
                }

                if (!refreshToken || !steamId64) {
                    send({ type: 'progress', name: acc.name, status: 'skip', detail: '缺少 RefreshToken 或 SteamID' });
                    continue;
                }

                const freshCookie = await steamRefreshSession({ name: acc.name, steamId64, refreshToken });
                if (!freshCookie) {
                    send({ type: 'progress', name: acc.name, status: 'error', detail: 'Cookie 刷新失败' });
                    continue;
                }

                send({ type: 'progress', name: acc.name, status: 'processing', detail: '获取交易链接...' });
                const tradeUrl = await fetchTradeUrlFromCookie(freshCookie, steamId64);
                await db.updateAccountTradeUrl(acc.id, tradeUrl);
                const updatedAcc = { ...acc, tradeUrl, steamCookie: freshCookie };
                await db.upsertAccount(updatedAcc);
                successCount++;
                send({ type: 'progress', name: acc.name, status: 'done', detail: tradeUrl });

                await new Promise(r => setTimeout(r, 800)); // 限速，避免频繁请求
            } catch (e) {
                send({ type: 'progress', name: acc.name, status: 'error', detail: e.message });
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        send({ type: 'done', successCount, total: targets.length });
        res.end();
    } catch (e) {
        send({ type: 'error', message: e.message });
        res.end();
    }
});

// POST /api/accounts/sync-personas — 批量拉取所有账号的 Steam 显示名并存储
app.post('/api/accounts/sync-personas', async (req, res) => {
    try {
        const accounts = await db.readAccounts();
        const results = [];
        const CONCURRENCY = 20;
        for (let i = 0; i < accounts.length; i += CONCURRENCY) {
            const batch = accounts.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (acc) => {
                if (!acc.steamId64) return;
                try {
                    // 用 Steam 社区 XML 接口（无需 API Key）
                    const xmlRes = await steamRequest(
                        `https://steamcommunity.com/profiles/${acc.steamId64}?xml=1`,
                        { timeout: 8000, headers: { 'User-Agent': 'SteamTool/1.0' } }
                    );
                    const match = xmlRes.data.match(/<steamID><!\[CDATA\[(.+?)\]\]><\/steamID>/);
                    const persona = match ? match[1].trim() : null;
                    if (persona) {
                        await db.updateAccountPersonaName(acc.id, persona);
                        results.push({ id: acc.id, name: acc.name, personaName: persona });
                    }
                } catch (e) {
                    console.warn(`[账号] 拉取 ${acc.name} persona 失败:`, e.message);
                }
            }));
        }
        res.json({ success: true, updated: results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- Serve React Frontend ---
// Allows accessing the compiled UI directly via port 3001
app.use(express.static(path.join(__dirname, '../client/dist')));

app.listen(PORT, async () => {
    console.log(`[启动] ${BUILD_ID} - 正在启动...`);
    console.log(`比价服务器已启动: http://localhost:${PORT}`);

    // On startup: if any items have a stale nextUpdate (server was down / crashed),
    // reschedule them immediately so the scheduler will update them within seconds.
    try {
        const items = await readTracked();
        const now = Date.now();
        const STALE_MS = 2 * 60 * 1000; // overdue by >2 minutes = stale
        let count = 0;
        for (const item of items) {
            const next = new Date(item.nextUpdate || 0).getTime();
            if (now > next + STALE_MS) {
                item.nextUpdate = new Date(now + 10000).toISOString(); // update in 10s
                count++;
            }
        }
        if (count > 0) {
            await writeTracked(items);
            console.log(`[启动] 已重新调度 ${count} 个过期饰品进行即时更新`);
        }
    } catch (e) {
        console.error('[启动] 无法重置过期计时器:', e.message);
    }

    // Startup ranking push timer
    try {
        const settings = await readSettings();
        if (settings.pushRankingEnabled || settings.pushTopUpEnabled) {
            startPushRanking(settings.pushRankingInterval);
        }
    } catch (e) {
        console.error('[启动] 推送排行榜启动错误:', e.message);
    }
});

module.exports = {
    syncAccountInventory,
    readAccounts,
    writeAccounts,
    readTracked,
    writeTracked,
    readSettings,
    writeSettings
};
// end