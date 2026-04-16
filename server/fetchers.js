const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');

const fs = require('fs');

const LOGS_DIR = path.join(__dirname, 'logs');
const AUTO_BUY_LOG = path.join(LOGS_DIR, 'auto_buy.log');

async function logToAutoBuyFile(message, type = 'info') {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        const fullMsg = message.includes('[自动买]') ? message : `[自动买] ${message}`;
        if (type === 'error') console.error(fullMsg);
        else if (type === 'warn') console.warn(fullMsg);
        else console.log(fullMsg);
        fs.appendFileSync(AUTO_BUY_LOG, `[${ts}] ${fullMsg}\n`);
    } catch (err) {
        console.error(`[日志系统] 写入失败: ${err.message}`);
    }
}

// SQLite-backed nameid cache (replaces item_nameid_cache.json)
const db = require('./db');

// Python executable in conda steam_tool env
let _pythonPath = null;
function getPythonPath() {
    if (_pythonPath) return _pythonPath;
    // Try common conda paths on Windows
    const tried = [];
    const os = require('os');
    const home = os.homedir();
    const candidates = [
        path.join(home, 'miniconda3', 'envs', 'steam_tool', 'python.exe'),
        path.join(home, 'anaconda3', 'envs', 'steam_tool', 'python.exe'),
        path.join(home, 'miniforge3', 'envs', 'steam_tool', 'python.exe'),
        path.join('C:', 'ProgramData', 'miniconda3', 'envs', 'steam_tool', 'python.exe'),
        path.join('C:', 'ProgramData', 'anaconda3', 'envs', 'steam_tool', 'python.exe'),
    ];
    const fs2 = require('fs');
    for (const c of candidates) {
        if (fs2.existsSync(c)) { _pythonPath = c; return c; }
    }
    // Fallback: use conda run (slower but always works if conda is in PATH)
    _pythonPath = 'conda_run';
    return _pythonPath;
}

// Bypass TLS for local proxy if needed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Bypass SSL verification for internal proxy/TUN issues

// Fixed exchange rate fallback for when Steam doesn't return CNY
let currencyConfig = {
    USD_TO_CNY: 6.90,
    CNY_TO_USD: 0.145
};

/**
 * Fetch real-time exchange rate from the provided API
 * Base rate: 6.9. Valid range: [6.8, 7.1]
 */
async function updateGlobalExchangeRate() {
    const url = `https://186.yousheng186.com/api/currencyRate/info?ts=${Date.now()}`;
    try {
        console.log(`[汇率同步] 正在从 yousheng186 获取最新汇率...`);
        const response = await axios.get(url, {
            headers: {
                'Referer': 'https://186.yousheng186.com/rate',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'
            },
            timeout: 10000
        });

        if (response.data && response.data.code === "0000" && response.data.data && response.data.data.length > 0) {
            const rateStr = response.data.data[0].inverseRatio;
            const rate = parseFloat(rateStr);

            if (!isNaN(rate) && rate >= 6.8 && rate <= 7.1) {
                currencyConfig.USD_TO_CNY = rate;
                currencyConfig.CNY_TO_USD = 1 / rate;
                console.log(`[汇率同步] 成功更新汇率: 1 USD = ${rate.toFixed(4)} CNY (标准范围: 6.8 ~ 7.1)`);
                return true;
            } else {
                console.warn(`[汇率同步] 警告: 采集到的汇率 (${rateStr}) 超出异常范围 [6.8, 7.1]，已锁定为 6.90。`);
                currencyConfig.USD_TO_CNY = 6.90;
                currencyConfig.CNY_TO_USD = 1 / 6.90;
            }
        } else {
            console.error(`[汇率同步] 接口响应格式异常:`, JSON.stringify(response.data).substring(0, 100));
        }
    } catch (e) {
        console.error(`[汇率同步] 采集失败: ${e.message}。将维持当前汇率: ${currencyConfig.USD_TO_CNY}`);
    }
    return false;
}

/**
 * Get HTTPS Proxy Agent if enabled in settings
 */
/**
 * Get HTTPS Proxy Agent with smart routing based on target URL
 */
function getProxyAgent(url) {
    let settings = {};
    try {
        settings = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'settings.json'), 'utf8'));
    } catch (e) { /* ignores */ }

    // Logic: Webshare for Steam, Abuyun for SZSE, Direct for others (C5)
    
    // 1. Steam (Overseas) -> Webshare Rotating Residential (random user rotation)
    if (url && (url.includes('steamcommunity.com') || url.includes('steampowered.com') || url.includes('steam-chat.com'))) {
        if (settings.webshare && settings.webshare.enabled) {
            const { userPrefix, userMin, userMax, pass, host, port } = settings.webshare;
            const randomNum = Math.floor(Math.random() * (userMax - userMin + 1)) + userMin;
            const randomUser = `${userPrefix}${randomNum}`;
            // Format: http://xehleepc-N:pass@p.webshare.io:80
            return `http://${randomUser}:${pass}@${host}:${port}`;
        }
    }

    // 2. SZSE (Domestic) -> Abuyun
    if (url && (url.includes('szse.cn') || url.includes('sse.com.cn'))) {
        if (settings.abuyun && settings.abuyun.enabled) {
            const { appKey, appSecret, host, port } = settings.abuyun;
            return `http://${appKey}:${appSecret}@${host}:${port}`;
        }
    }

    // 3. Fallback: Legacy Clash (if explicitly enabled and no specific route matched)
    if (settings.clashAutoRotate && settings.clashProxyPort) {
        return `http://127.0.0.1:${settings.clashProxyPort}`;
    }

    return null;
}

/**
 * Unified Steam request wrapper with proxying and auto-IP rotation
 * retryCount: 最多3次重试，每次内部已内置指数退避等待
 * 并发429防踏躟：所有429请求共享同一次rotateIP，完成后加随机抖动重试
 */
async function steamRequest(url, axiosConfig = {}, retryCount = 3) {
    let rawSettings = {};
    try {
        rawSettings = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'settings.json'), 'utf8'));
    } catch (e) { /* ignores */ }

    const proxyUrl = getProxyAgent(url);
    const config = { ...axiosConfig };
    if (proxyUrl) {
        config.httpsAgent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
        config.httpAgent = new (require('http').Agent)({ keepAlive: false });
        config.proxy = false; 
    } else {
        config.proxy = false;
        config.httpsAgent = new (require('https').Agent)({ keepAlive: false });
    }
    config.headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        ...(config.headers || {})
    };
    if (config.maxRedirects === undefined) config.maxRedirects = 5;

    const maxRetries = 3;
    const attempt = maxRetries - retryCount + 1;

    try {
        const response = await axios(url, config);
        return response;
    } catch (err) {
        const isNetworkError = !err.response && (
            err.code === 'ECONNRESET' ||
            err.code === 'ETIMEDOUT' ||
            err.code === 'ERR_PROXY_CONNECTION_FAILED' ||
            err.message.includes('socket disconnected') ||
            err.message.includes('socket hang up') ||
            err.message.includes('timeout') ||
            err.message.includes('Proxy connection ended') ||   // Residential IP dropped CONNECT
            err.message.includes('CONNECT response') ||         // Proxy refused HTTPS tunnel
            err.message.includes('tunneling socket') ||         // Node https-proxy-agent tunnel error
            err.message.includes('ECONNREFUSED')                // Proxy port closed
        );
        const is429 = err.response && err.response.status === 429;
        const isDeadNode = err.response && (err.response.status === 502 || err.response.status === 503 || err.response.status === 504 || err.response.status === 500);

        // Parse boolean setting: treats '1' or true as enabled, anything else as disabled
        const isAutoRotateEnabled = rawSettings.clashAutoRotate === '1' || rawSettings.clashAutoRotate === true;

        if ((is429 || isNetworkError || isDeadNode) && retryCount > 0) {
            // 每次重试都切换到一个全新的随机住宅 IP
            const nextProxyUrl = getProxyAgent(url);
            const nextIpTag = nextProxyUrl
                ? (nextProxyUrl.match(/\/\/([^:]+):/) || [])[1] || 'proxy'
                : 'direct';

            // 代理连接失败/网络错误：极短等待立刻换IP；429限频：指数退避
            const isProxyConnectFail = err.message && (
                err.message.includes('Proxy connection ended') ||
                err.message.includes('CONNECT response') ||
                err.message.includes('tunneling socket')
            );
            const baseWait = is429 ? 3000 * attempt : (isProxyConnectFail ? 0 : 300);
            const jitter = Math.floor(Math.random() * (is429 ? 3000 : 200));
            const waitMs = baseWait + jitter;

            const errTag = is429 ? '429限频' : isProxyConnectFail ? '代理连接失败' : '网络异常';
            console.warn(`[Steam 请求] ${errTag}，换IP→(${nextIpTag})，${(waitMs / 1000).toFixed(1)}s后重试 (第${attempt}次/${maxRetries}次)...`);

            const newConfig = { ...axiosConfig };
            if (nextProxyUrl) {
                newConfig.httpsAgent = new HttpsProxyAgent(nextProxyUrl, { keepAlive: false });
                newConfig.httpAgent = new (require('http').Agent)({ keepAlive: false });
                newConfig.proxy = false;
            } else {
                newConfig.proxy = false;
                newConfig.httpsAgent = new (require('https').Agent)({ keepAlive: false });
            }
            newConfig.headers = { ...(axiosConfig.headers || {}), 'Connection': 'close' };

            await new Promise(r => setTimeout(r, waitMs));
            return steamRequest(url, newConfig, retryCount - 1);
        }
        throw err;
    }
}

// ─── C5Game Open API ──────────────────────────────────────────────────────────

const C5_BASE = 'https://openapi.c5game.com';

/**
 * Get C5Game API key for a specific merchant, with optional override.
 * @param {string|number} [merchantIdOrAppKey] - ID of the merchant or direct appKey
 */
async function getC5ApiKey(merchantIdOrAppKey) {
    if (typeof merchantIdOrAppKey === 'string' && merchantIdOrAppKey.length > 10) {
        return merchantIdOrAppKey;
    }
    const merchant = merchantIdOrAppKey
        ? await db.getMerchantById(merchantIdOrAppKey)
        : await db.getDefaultMerchant();
    return merchant?.appKey || (await db.getSetting('c5gameApiKey')) || '';
}

/**
 * Batch query lowest sell price from C5Game for up to 100 hash names.
 * Uses the released /merchant/market/v2/item/stat/hash/name endpoint.
 * Returns Map<hashName, { sellPrice: number (元), sellCount: number, itemId }>
 */
async function fetchC5GamePriceBatch(marketHashNames, apiKey) {
    const key = await getC5ApiKey(apiKey);
    if (!key) { console.warn('[C5] API Key 未配置'); return new Map(); }

    const chunks = [];
    for (let i = 0; i < marketHashNames.length; i += 100) {
        chunks.push(marketHashNames.slice(i, i + 100));
    }

    const resultMap = new Map();
    for (const chunk of chunks) {
        try {
            const res = await axios.post(
                `${C5_BASE}/merchant/market/v2/item/stat/hash/name?app-key=${encodeURIComponent(key)}`,
                { appId: 730, marketHashNames: chunk },
                {
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    timeout: 15000
                }
            );
            const body = res.data;
            if (body && body.success && body.data) {
                for (const [hashName, info] of Object.entries(body.data)) {
                    if (info && info.sellPrice != null) {
                        resultMap.set(hashName, {
                            sellPrice: parseFloat(info.sellPrice), // already in 元
                            sellCount: info.sellCount || 0,
                            itemId: info.itemId || null,
                        });
                    }
                }
            } else {
                console.warn(`[C5批价] 接口异常: ${body?.errorMsg || JSON.stringify(body).substring(0, 100)}`);
            }
        } catch (e) {
            console.error(`[C5批价] 请求失败:`, e.message);
        }
    }
    return resultMap;
}

/**
 * Search C5Game listings by marketHashName or itemId to get sell list.
 * Returns array of { productId, price (元), delivery, img, assetInfo }
 */
async function fetchC5GameSearch(queryParam, appId = 730, pageSize = 20, apiKey) {
    const key = await getC5ApiKey(apiKey);
    if (!key) return [];

    const targetAppId = 730;
    const payload = {
        appId: targetAppId,
        pageSize
    };

    if (typeof queryParam === 'number' || (!isNaN(queryParam) && !isNaN(parseFloat(queryParam)))) {
        payload.itemId = parseInt(queryParam);
        console.log(`[C5搜索] 使用 ItemID 请求: ${payload.itemId}`);
    } else {
        payload.marketHashName = queryParam;
        console.log(`[C5搜索] 使用英文名请求: ${queryParam}`);
    }

    console.log(`[C5搜索] Payload: ${JSON.stringify(payload)}`);

    try {
        const res = await axios.post(
            `${C5_BASE}/merchant/market/v2/products/search?app-key=${encodeURIComponent(key)}`,
            payload,
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const body = res.data;
        if (body && body.success && body.data && body.data.list) {
            console.log(`[C5搜索] 成功获取 ${body.data.list.length} 条结果`);
            return body.data.list;
        }

        if (body && !body.success) {
            const errCode = body.errorCode || body.code;
            const errMsg = body.errorMsg || body.msg || '未知错误';
            console.error(`[C5搜索] API错误: ${errMsg} (代码: ${errCode})`);

            if (errCode === 'IP_NOT_IN_WHITE_LIST' || errMsg.includes('白名单')) {
                console.error('[C5搜索] 关键提示: 请前往 C5 商户后台配置正确的 IP 白名单。');
            }
        } else if (body && body.success && (!body.data || !body.data.list)) {
            console.warn(`[C5搜索] 响应成功但列表为空。`);
        }
        return [];
    } catch (e) {
        console.error(`[C5搜索] 网络请求失败:`, e.response?.data || e.message);
        return [];
    }
}

/**
 * Resolve a keyword to C5 metadata (English name and ItemID) using public API.
 */
async function fetchC5ItemMetadata(keyword) {
    console.log(`[C5元数据] 正在解析关键词: "${keyword}" ...`);
    try {
        const url = `https://www.c5game.com/api/product/list.json?keyword=${encodeURIComponent(keyword)}&type=730`;
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const body = res.data;
        if (body && body.success && body.data && body.data.list && body.data.list.length > 0) {
            return body.data.list.slice(0, 3).map(item => ({
                itemId: item.id,
                marketHashName: item.market_hash_name,
                name: item.name
            }));
        }
        return [];
    } catch (e) {
        console.warn(`[C5元数据] 解析失败:`, e.message);
        return [];
    }
}

/**
 * Translate a Chinese query to an English hash name / series term.
 * Strategy: since Steam search supports Chinese characters natively,
 * we search Steam directly and extract the English hash core.
 * C5Game is used afterwards for price enrichment.
 */
async function translateChineseToEnglish(query) {
    // Already English → return as-is
    if (!/[\u4e00-\u9fa5]/.test(query)) return query;
    // We rely on Steam's own schinese search; the English hash names come back in results.
    // This function is kept for backwards compatibility — the actual translation
    // is handled by fetchSteamSeries which supports Chinese queries directly (l=schinese).
    console.log(`[翻译] 输入为中文，将直接透传给 Steam 搜索: "${query}"`);
    return query;
}

/**
 * Optimize Steam cookies for a specific domain (community vs store).
 * Steam uses separate steamLoginSecure cookies for different audiences.
 * If multiple exist, we must prioritize the one matching our target domain.
 */
function prepareCookieHeader(steamCookie, domain = 'community') {
    if (!steamCookie) return 'Steam_Language=english; timezoneOffset=28800,0';

    const parts = steamCookie.split(';').map(p => p.trim()).filter(p => p);
    const cookieMap = new Map();
    const secures = [];

    parts.forEach(p => {
        const [name, ...valParts] = p.split('=');
        const value = valParts.join('=');
        if (name === 'steamLoginSecure') {
            secures.push(value);
        } else {
            cookieMap.set(name, value);
        }
    });

    // Inject mandatory browser-like cookies
    if (!cookieMap.has('Steam_Language')) cookieMap.set('Steam_Language', 'english');
    if (!cookieMap.has('timezoneOffset')) cookieMap.set('timezoneOffset', '28800,0');
    if (!cookieMap.has('browserid')) cookieMap.set('browserid', Math.floor(Math.random() * 1000000000000000000).toString());

    // Ensure sessionid exists (essential for many Steam APIs)
    if (!cookieMap.has('sessionid')) {
        const crypto = require('crypto');
        cookieMap.set('sessionid', crypto.randomBytes(12).toString('hex'));
    }

    let targetSecure = secures[0] || '';
    if (secures.length > 1) {
        const targetAud = domain.includes('store') ? 'web:store' : 'web:community';
        for (const s of secures) {
            try {
                const decoded = decodeURIComponent(s);
                if (decoded.includes('||')) {
                    const jwt = decoded.split('||')[1];
                    const payloadBase64 = jwt.split('.')[1];
                    if (payloadBase64) {
                        const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
                        if (payload.aud && payload.aud.includes(targetAud)) {
                            targetSecure = s;
                            break;
                        }
                    }
                }
            } catch (e) { }
        }
    }

    let result = targetSecure ? `steamLoginSecure=${targetSecure}` : '';
    cookieMap.forEach((v, k) => {
        if (result) result += '; ';
        result += `${k}=${v}`;
    });
    return result;
}

/**
 * Fetch price from Steam Community Market
 */
async function fetchSteamPrice(marketHashName, currency = 23, steamCookie = '') {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&market_hash_name=${encodeURIComponent(marketHashName)}&currency=${currency}&country=CN&language=english`;
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
        const cookieHeader = optimizedCookie
            ? (optimizedCookie.includes('steamCurrencyId=')
                ? optimizedCookie.replace(/steamCurrencyId=\d+/, `steamCurrencyId=${currency}`)
                : `${optimizedCookie}; steamCurrencyId=${currency}`)
            : `steamCurrencyId=${currency}`;

        headers['Cookie'] = cookieHeader;
        const response = await steamRequest(url, {
            headers,
            timeout: 20000
        });
        if (response && response.data && response.data.success) {
            return {
                lowest_price: response.data.lowest_price,
                median_price: response.data.median_price,
                volume: response.data.volume
            };
        }
        return null;
    } catch (error) {
        console.error(`[Steam 采集] 价格概览错误 [${marketHashName}]:`, error.message);
        return null;
    }
}

/**
 * [DEPRECATED] fetchYoupinPrice — kept for emergency fallback only.
 */
async function fetchYoupinPrice(marketHashName) {
    const url = 'https://api.youpin898.com/api/homepage/pc/goods/market/querySaleTemplate';
    const payload = {
        listSortType: 0,
        sortType: 0,
        keyWords: marketHashName,
        pageSize: 1,
        pageIndex: 1
    };

    try {
        const response = await axios.post(url, payload, {
            headers: YOUPIN_HEADERS,
            timeout: 20000
        });

        if (response.data && response.data.Code === 0 && response.data.Data && response.data.Data.length > 0) {
            const item = response.data.Data[0];
            return {
                price: item.price,
                name: item.commodityName,
                hash_name: item.commodityHashName,
                onSaleCount: item.onSaleCount,
                image: item.commodityImage || item.image
            };
        }

        console.error(`[C5-Legacy采集] 接口错误: ${response.data.Msg} (代码: ${response.data.Code})`);

        return null;
    } catch (error) {
        console.error(`[C5-Legacy采集] 错误 [${marketHashName}]:`, error.message);
        return null;
    }
}

/**
 * Batch Search Steam Market for a skin series
 */
async function fetchSteamSeries(query, currency = 23, steamCookie = '', maxPages = 5, startOffset = 0, silent = false) {
    let allResults = [];
    let start = startOffset;
    const countPerPage = 10;
    const limitPages = maxPages;

    try {
        let seriesHeaderLogged = false;
        for (let page = 0; page < limitPages; page++) {
            const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(query)}&start=${start}&count=${countPerPage}&search_descriptions=0&sort_column=default&sort_dir=desc&appid=730&norender=1&currency=${currency}&listing_country=CN&country=CN&l=schinese&_=${Date.now()}`;

            if (!silent) console.log(`[Steam 搜索] 正在获取第 ${page + 1} 页 (start=${start})...`);
            let optimizedCookie = prepareCookieHeader(steamCookie, 'community');

            if (currency === 23) {
                const countryCookie = 'steamCountry=CN%7C00000000000000000000000000000000';
                const langCookie = 'Steam_Language=schinese';
                if (optimizedCookie.includes('steamCountry=')) {
                    optimizedCookie = optimizedCookie.replace(/steamCountry=[^;]+/, countryCookie);
                } else {
                    optimizedCookie += `; ${countryCookie}`;
                }
                if (optimizedCookie.includes('Steam_Language=')) {
                    optimizedCookie = optimizedCookie.replace(/Steam_Language=[^;]+/, langCookie);
                } else {
                    optimizedCookie += `; ${langCookie}`;
                }
            }

            const cookieHeader = optimizedCookie
                ? (optimizedCookie.includes('steamCurrencyId=')
                    ? optimizedCookie.replace(/steamCurrencyId=\d+/, `steamCurrencyId=${currency}`)
                    : `${optimizedCookie}; steamCurrencyId=${currency}`)
                : `steamCurrencyId=${currency}`;

            let response;
            try {
                response = await steamRequest(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Cookie': cookieHeader,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': `https://steamcommunity.com/market/search?q=${encodeURIComponent(query)}`
                    },
                    timeout: 20000
                });
            } catch (err) {
                if (err.response && err.response.status === 429) {
                    console.error(`[Steam 搜索] 自动换 IP 后重试仍然触发 429，跳过此页...`);
                    break;
                } else {
                    throw err;
                }
            }

            if (response && response.data && response.data.results && response.data.results.length > 0) {
                const pageResults = response.data.results.map(item => {
                    let priceText = item.sell_price_text;
                    if (currency === 23 && priceText) {
                        if (priceText.includes('$') || priceText.includes('USD')) {
                            // USD → CNY conversion
                            const usdVal = parseFloat(priceText.replace(/[^\d.]/g, ''));
                            if (!isNaN(usdVal) && usdVal > 0) {
                                priceText = `¥ ${(usdVal * currencyConfig.USD_TO_CNY).toFixed(2)}`;
                            } else {
                                priceText = null;
                            }
                        } else if (!priceText.includes('¥') && !priceText.includes('￥')) {
                            // Non-CNY/USD currency (e.g. VND ₫, THB ฿, etc.) — reject it
                            // This happens when the Steam account cookie's region overrides our currency param
                            console.warn(`[Steam 搜索] 检测到非 CNY/USD 货币价格: "${priceText}"，已丢弃 (账号区域与请求货币不匹配)`);
                            priceText = null;
                        }
                    }
                    if (priceText && !silent) {
                        if (!seriesHeaderLogged) { console.log(`[Steam 搜索] 系列 "${query}"`); seriesHeaderLogged = true; }
                        const logMsg = `获取到: ${item.name} (${priceText})`;
                        if (console.directLog) console.directLog(logMsg); else console.log(logMsg);
                    }
                    return {
                        hash_name: (item.hash_name || '').trim(),
                        name: (item.name || item.hash_name || '').trim(),
                        price: priceText,
                        listings: item.sell_listings,
                        image: item.asset_description
                            ? `https://community.akamai.steamstatic.com/economy/image/${item.asset_description.icon_url}` : null
                    };
                });
                allResults.push(...pageResults);
                if (response.data.results.length < countPerPage) break;
                start += response.data.results.length;
                await new Promise(resolve => setTimeout(resolve, 600));
            } else {
                break;
            }
        }

        const uniqueMap = new Map();
        allResults.forEach(r => uniqueMap.set(r.hash_name, r));
        return Array.from(uniqueMap.values());
    } catch (error) {
        if (error.response && error.response.status === 429) throw error;
        console.error(`[Steam 系列搜索] 错误 [${query}]:`, error.message);
        return allResults;
    }
}


/**
 * Fetch exact price for a single item by its market_hash_name.
 * Uses Steam market search with the exact name — much faster and more reliable than priceoverview.
 */
async function fetchSteamItemPrice(marketHashName, currency = 23, steamCookie = '') {
    let cachedImage = null;
    let cachedListings = 0;

    // Stage 1: Fast Search Method (Used primarily for IMAGE metadata now)
    const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(marketHashName)}&start=0&count=10&search_descriptions=0&sort_column=default&sort_dir=desc&appid=730&norender=1&currency=${currency}&_=${Date.now()}`;
    const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
    const cookieHeader = optimizedCookie
        ? (optimizedCookie.includes('steamCurrencyId=')
            ? optimizedCookie.replace(/steamCurrencyId=\d+/, `steamCurrencyId=${currency}`)
            : `${optimizedCookie}; steamCurrencyId=${currency}`)
        : `steamCurrencyId=${currency}`;

    try {
        const response = await steamRequest(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cookie': cookieHeader,
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 8000
        });

        if (response && response.data && response.data.results) {
            const match = response.data.results.find(r =>
                r.hash_name === marketHashName ||
                r.name === marketHashName ||
                (r.asset_description && r.asset_description.market_name === marketHashName)
            );
            if (match) {
                cachedListings = match.sell_listings;
                cachedImage = match.asset_description ? `https://community.akamai.steamstatic.com/economy/image/${match.asset_description.icon_url}` : null;

                // If NOT CNY, we can trust the search price to save one request
                if (currency !== 23 && match.sell_price_text && !match.sell_price_text.includes('$')) {
                    return {
                        price: match.sell_price_text,
                        listings: cachedListings,
                        image: cachedImage
                    };
                }
            }
        }
    } catch (e) {
        if (e.response && e.response.status === 429) throw e;
        console.warn(`[fetchSteamItemPrice] 快速搜索失败:`, e.message);
    }

    // Stage 2: Precise Fetch Fallback (MANDATORY for CNY)
    console.log(`[精确搜索] 正在对 "${marketHashName}" 执行高精度精准获取...`);
    try {
        const itemNameId = await getItemNameId(marketHashName, steamCookie);
        if (itemNameId) {
            const histogram = await fetchPriceHistogram(itemNameId, currency, steamCookie);
            if (histogram) {
                const finalPrice = histogram.isBuyOrder ? `${histogram.price} (求)` : histogram.price;
                return {
                    price: finalPrice,
                    listings: histogram.count || cachedListings,
                    image: cachedImage
                };
            }
        }
    } catch (e) {
        console.error(`[fetchSteamItemPrice] 精确采集失败 "${marketHashName}":`, e.message);
    }
    return null;
}

/**
 * Extract the internal item_nameid from a skin's market listing page.
 */
async function getItemNameId(marketHashName, steamCookie = '') {
    // Check DB cache first
    const cached = db.getItemNameId(marketHashName);
    if (cached) return cached;

    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;

    const tryFetch = async (useCookie) => {
        try {
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Referer': 'https://steamcommunity.com/market/search?appid=730'
            };
            if (useCookie && steamCookie) {
                headers['Cookie'] = prepareCookieHeader(steamCookie, 'community');
            }

            const response = await steamRequest(url, {
                headers,
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: s => s < 500
            });

            if (response && response.data) {
                const match = response.data.match(/Market_LoadOrderSpread\(\s*(\d+)/);
                if (match && match[1]) return match[1];
            }
        } catch (e) {
            // Ignore Axios errors in tryFetch, will return null and fallback
        }
        return null;
    };

    // 1. 先尝试无 Cookie 游客请求（避免任何由于账号状态导致的 302 重定向如 eligibilitycheck）
    let id = await tryFetch(false);

    // 2. 如果游客请求失败（偶尔遇到 IP 流控或异常拦截极小概率），带上账号 Cookie 重试
    if (!id && steamCookie) {
        console.warn(`[获取名称ID] ${marketHashName} 游客请求未匹配到 ID，尝试带上账号 Cookie 重试...`);
        id = await tryFetch(true);
    }

    if (id) {
        db.setItemNameId(marketHashName, id);
        console.log(`[获取名称ID] 成功解析并缓存: ${marketHashName} -> ${id}`);
        return id;
    }

    console.warn(`[获取名称ID] "${marketHashName}" 解析失败 (页面中未找到 ID，或网络被阻断)。`);
    return null;
}

/**
 * Fetch the lowest sell price from the itemordershistogram API.
 */
async function fetchPriceHistogram(itemNameId, currency = 23, steamCookie = '') {
    const url = `https://steamcommunity.com/market/itemordershistogram?country=CN&language=english&currency=${currency}&item_nameid=${itemNameId}&two_factor=0`;
    try {
        const response = await steamRequest(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Cookie': prepareCookieHeader(steamCookie, 'community'),
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 20000
        });
        const data = response ? response.data : null;
        if (data && data.success === 1) {
            let priceVal = null;
            let count = 0;
            let isBuyOrder = false;

            if (data.sell_order_graph && data.sell_order_graph.length > 0) {
                // Primary: Lowest Sell Order
                priceVal = data.sell_order_graph[0][0];
                count = data.sell_order_graph[0][1];
            } else if (data.buy_order_graph && data.buy_order_graph.length > 0) {
                // Fallback: Highest Buy Order (if nobody is selling)
                priceVal = data.buy_order_graph[0][0];
                count = data.buy_order_graph[0][1];
                isBuyOrder = true;
            } else if (data.highest_buy_order) {
                priceVal = parseInt(data.highest_buy_order) / 100;
                count = 1;
                isBuyOrder = true;
            }

            if (priceVal != null) {
                const sym = currency === 23 ? '¥' : (currency === 1 ? '$' : '');
                return {
                    price: `${sym} ${priceVal.toFixed(2)}`,
                    count: count,
                    isBuyOrder: isBuyOrder
                };
            }
        }
    } catch (e) {
        console.warn(`[fetchPriceHistogram] 接口错误:`, e.message);
    }
    return null;
}

// Youpin Headers (Configuration placeholders for public release)
// Users should provide their own tokens in settings.json or environment variables
let YOUPIN_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'App-Version': '5.26.0',
    'appType': '1',
    'AppVersion': '5.26.0',
    'authorization': '',
    'Content-Type': 'application/json',
    'deviceId': '',
    'deviceUk': '',
    'platform': 'pc',
    'secret-v': 'h5_v1',
    'uk': '',
    'Referer': 'https://youpin898.com/',
    'Origin': 'https://youpin898.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

/**
 * Perform a fuzzy search using Youpin's API to get accurate Chinese/English names.
 * We rely on Youpin's superior Chinese nickname mapping (e.g. "高达" -> "M4A1-S | Mecha Industries").
 */
async function fetchYoupinSeries(query) {
    const url = 'https://api.youpin898.com/api/homepage/pc/goods/market/querySaleTemplate';
    const payload = {
        listSortType: 0,
        sortType: 0,
        keyWords: query,
        pageSize: 50,
        pageIndex: 1
    };
    try {
        // Try to enrich headers from settings if possible
        try {
            const db = require('./db');
            const settings = await db.readSettings();
            if (settings.youpinAuth) YOUPIN_HEADERS.authorization = settings.youpinAuth;
            if (settings.youpinDeviceId) YOUPIN_HEADERS.deviceId = settings.youpinDeviceId;
            if (settings.youpinDeviceUk) YOUPIN_HEADERS.deviceUk = settings.youpinDeviceUk;
            if (settings.youpinUk) YOUPIN_HEADERS.uk = settings.youpinUk;
        } catch (e) { /* DB not initialized or keys missing */ }

        const response = await axios.post(url, payload, { headers: YOUPIN_HEADERS, timeout: 10000 });
        if (response.data && response.data.Data) {
            // Map the Youpin response to our standard format
            return response.data.Data.map(item => ({
                hash_name: item.commodityHashName,
                name: item.commodityName,
                price: item.minPrice ? `¥ ${item.minPrice}` : null,
                image: item.imageOrRawData
            }));
        }
        return [];
    } catch (e) {
        console.error('[Youpin Search] Fetch failed:', e.message);
        return [];
    }
}

function extractCore(hashName) {
    if (hashName.includes(' | ')) {
        const parts = hashName.split(' | ');
        if (!parts[0].toLowerCase().includes('sticker')) {
            return parts[1].replace(/\s*\([^)]+\)$/, '').trim();
        }
    }
    const capsuleMatch = hashName.match(/^(.+?)\s+(?:Legends|Challengers|Contenders|Champions|Autograph|Sticker|Legends Autograph|Challengers Autograph|Contenders Autograph|Champions Autograph)\s+(?:Capsule|Sticker Capsule)$/i);
    if (capsuleMatch) return capsuleMatch[1].trim();
    const yearMatch = hashName.match(/^([A-Za-z\s]+ \d{4})\b/);
    if (yearMatch) return yearMatch[1].trim();
    let core = hashName.replace(/\s*\([^)]+\)$/, '');
    core = core.replace(/\s+(Case|Capsule|Package|Collection|Sticker Capsule)$/i, '');
    core = core.replace(/\s+\d+$/, '');
    return core.trim();
}

/**
 * Fetch the cheapest active listing for an item on Steam Market.
 * Returns { listingId, subtotal, fee, total, priceText, currency } or null.
 * subtotal/fee/total are in smallest currency units (fen for CNY, cents for USD).
 */
async function fetchCheapestListing(marketHashName, currency = 23, steamCookie = '', excludeIds = []) {
    const encodedName = encodeURIComponent(marketHashName);
    const countryMatch = steamCookie.match(/steamCountry=([^%|;]+)/);
    const country = countryMatch ? countryMatch[1] : 'CN';

    const url = `https://steamcommunity.com/market/listings/730/${encodedName}/render/?country=${country}&language=english&currency=${currency}&_=${Date.now()}`;
    const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
    const cookieHeader = optimizedCookie
        ? (optimizedCookie.includes('steamCurrencyId=')
            ? optimizedCookie.replace(/steamCurrencyId=\d+/, `steamCurrencyId=${currency}`)
            : `${optimizedCookie}; steamCurrencyId=${currency}`)
        : `steamCurrencyId=${currency}`;

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await steamRequest(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Cookie': cookieHeader,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://steamcommunity.com/market/',
                },
                timeout: 20000,
                validateStatus: (status) => status < 500
            });

            if (!response) {
                console.warn(`[Steam 采集] "${marketHashName}" 请求失败 (无响应)`);
                return null;
            }

            if (response.status === 429) {
                throw new Error('429 请求过多 (Too Many Requests)');
            }

            const rawData = response.data;
            if (!rawData) {
                console.warn(`[Steam 采集] "${marketHashName}" 返回数据为空 (状态码: ${response.status})`);
                return null;
            }

            // Extract listinginfo keys from raw string if possible to avoid BigInt precision loss
            // Actually, we can use the object keys which are already strings if axios parsed them
            if (!rawData.listinginfo || Object.keys(rawData.listinginfo).length === 0) {
                console.warn(`[Steam 采集] "${marketHashName}" 无在售列表信息。`);
                return null;
            }

            // Map keys (listingids) back to objects to ensure we have the EXACT ID string
            const listingKeys = Object.keys(rawData.listinginfo);
            let listings = listingKeys.map(id => {
                const item = rawData.listinginfo[id];
                return { ...item, listingid: id }; // Use the string key as the ID
            });

            // Filter out excluded IDs (stale listings)
            if (excludeIds && excludeIds.length > 0) {
                const countBefore = listings.length;
                listings = listings.filter(l => !excludeIds.includes(String(l.listingid)));
                if (listings.length < countBefore) {
                    console.log(`[Steam 采集] 已过滤 ${countBefore - listings.length} 个失效挂单。`);
                }
            }

            if (listings.length === 0) {
                console.warn(`[Steam 采集] "${marketHashName}" 过滤后无剩余有效挂单。`);
                return null;
            }

            console.log(`[Steam 采集] 找到 ${listings.length} 条 "${marketHashName}" 的在售记录`);

            listings.sort((a, b) => (a.converted_price + a.converted_fee) - (b.converted_price + b.converted_fee));
            const cheapest = listings[0];

            let subtotal = cheapest.converted_price;
            let fee = cheapest.converted_fee;
            let total = subtotal + fee;

            // --- BRUTE-FORCE ALIGNMENT (FINAL V2 RE-FIX) ---
            const sPredicted = Math.floor(total / 1.15);
            let foundMatch = false;
            for (let sPivot = Math.max(1, sPredicted - 3); sPivot <= sPredicted + 3; sPivot++) {
                const gF = Math.max(1, Math.floor(sPivot * 0.10));
                const sF = Math.max(1, Math.floor(sPivot * 0.05));
                if (sPivot + gF + sF === total) {
                    subtotal = sPivot;
                    fee = gF + sF;
                    foundMatch = true;
                    break;
                }
            }

            if (foundMatch) {
                // console.log(`[价格对齐] 原: ${cheapest.converted_price}+${cheapest.converted_fee}=${total} -> 修: ${subtotal}+${fee}=${total}`);
            }

            const sym = currency === 1 ? '$' : '¥';
            const priceText = `${sym} ${(total / 100).toFixed(2)}`;

            return {
                listingId: String(cheapest.listingid),
                subtotal,
                fee,
                total,
                priceText,
                currency
            };
        } catch (e) {
            lastError = e;
            if (e.message?.includes('429')) {
                // DON'T retry on 429 inside this function
                break;
            }
            console.warn(`[Steam 采集] 尝试 ${attempt} 失败 "${marketHashName}": ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }

    if (lastError?.message?.includes('429')) {
        throw lastError; // Bubble it up immediately
    }
    console.error(`[Steam 采集] "${marketHashName}" 最终失败:`, lastError?.message);
    return null;
}


/**
 * Fetch current active market listings for the account.
 */
async function fetchMyActiveListings(steamCookie) {
    if (!steamCookie) return null;
    let allListings = [];
    let start = 0;
    const batchCount = 100;

    try {
        while (true) {
            const url = `https://steamcommunity.com/market/mylistings/render/?query=&start=${start}&count=${batchCount}&norender=1&_=${Date.now()}`;
            const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
            const response = await steamRequest(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                    'Cookie': optimizedCookie,
                    'Referer': 'https://steamcommunity.com/market/'
                },
                timeout: 15000
            });

            if (response && response.data && response.data.success) {
                const listings = response.data.listings || [];
                const totalCount = response.data.total_count || 0;

                allListings = allListings.concat(listings);

                // If we've reached the total or this batch is empty, we're done
                if (allListings.length >= totalCount || listings.length === 0) {
                    break;
                }

                start += batchCount;
                // Avoid rate limits
                await new Promise(r => setTimeout(r, 600));
            } else {
                break;
            }
        }

        return allListings.map(l => {
            const sellerPrice = l.converted_price || 0;
            const fee = l.converted_fee || 0;
            const total = sellerPrice + fee;

            // Translate Steam date format: "23 Mar" -> "3月23日"
            let dateStr = l.time_created_str || '';
            const monthsMap = {
                Jan: '1月', Feb: '2月', Mar: '3月', Apr: '4月', May: '5月', Jun: '6月',
                Jul: '7月', Aug: '8月', Sep: '9月', Oct: '10月', Nov: '11月', Dec: '12月'
            };
            Object.keys(monthsMap).forEach(m => {
                if (dateStr.includes(m)) {
                    const parts = dateStr.replace(m, '').trim().split(',');
                    const day = parts[0].trim();
                    dateStr = `${monthsMap[m]}${day}日`;
                }
            });

            return {
                listingId: l.listingid,
                assetId: l.asset ? l.asset.id : null,
                name: l.asset ? (l.asset.market_name || l.asset.name) : 'Unknown Item',
                hashName: l.asset ? l.asset.market_hash_name : null,
                sellerPrice: sellerPrice,
                fee: fee,
                price: total, // in cents/fen
                priceText: `¥ ${(total / 100).toFixed(2)}`,
                created: dateStr,
                image: l.asset ? `https://community.akamai.steamstatic.com/economy/image/${l.asset.icon_url}` : null
            };
        });
    } catch (e) {
        console.error(`[fetchMyActiveListings] Error:`, e.message);
        throw e;
    }
}

/**
 * Execute a Steam Market purchase via Python/requests (more reliable session handling).
 * Falls back to the legacy Node.js implementation if Python is unavailable.
 * Returns { success: boolean, message: string }
 */
async function executeSteamBuy(listingId, currency, subtotal, fee, total, steamCookie, marketHashName = '', mafileContent = null) {
    // db.readSettings() doesn't include clash proxy fields (not in SETTINGS_DEFAULTS schema)
    // So read settings.json directly for proxy port
    let clashProxyPort = null;
    try {
        const rawSettings = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
        clashProxyPort = rawSettings.clashProxyPort || null;
    } catch (e) { /* settings.json not found, no proxy */ }

    const pythonPath = getPythonPath();
    const scriptPath = path.join(__dirname, 'python', 'steam_buy.py');

    const params = {
        cookie: steamCookie,
        listingId: String(listingId),
        marketHashName: marketHashName,
        subtotal: Math.round(subtotal),
        fee: Math.round(fee),
        total: Math.round(total),
        currency: currency,
        mafile: mafileContent,
        proxyPort: clashProxyPort  // Read from settings.json directly (not in db schema)
    };

    return new Promise((resolve) => {
        try {
            let child;
            if (pythonPath === 'conda_run') {
                child = spawn('conda', ['run', '-n', 'steam_tool', '--no-capture-output', 'python', scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
            } else {
                child = spawn(pythonPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
            }

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => { stdout += d.toString(); });
            child.stderr.on('data', d => { stderr += d.toString(); });

            // Send params to stdin
            child.stdin.write(JSON.stringify(params), 'utf8');
            child.stdin.end();

            // Timeout safety
            const timer = setTimeout(() => {
                child.kill();
                resolve({ success: false, message: 'Python购买脚本超时(35s)' });
            }, 35000);

            child.on('close', (code) => {
                clearTimeout(timer);
                if (stderr) logToAutoBuyFile(`[Python调试] ${stderr.trim()}`);
                try {
                    const line = stdout.trim().split('\n').pop(); // last JSON line
                    const result = JSON.parse(line);
                    resolve(result);
                } catch {
                    console.error(`[Python买入] 解析失败 stdout: ${stdout.substring(0, 200)} stderr: ${stderr.substring(0, 200)}`);
                    resolve({ success: false, message: `Python解析失败(code=${code})` });
                }
            });

            child.on('error', (e) => {
                clearTimeout(timer);
                console.error(`[Python买入] 启动失败:`, e.message);
                // Fall back to legacy Node.js implementation
                resolve(executeSteamBuyLegacy(listingId, currency, subtotal, fee, total, steamCookie, marketHashName));
            });
        } catch (e) {
            console.error(`[Python买入] 异常:`, e.message);
            resolve(executeSteamBuyLegacy(listingId, currency, subtotal, fee, total, steamCookie, marketHashName));
        }
    });
}

/**
 * Legacy Node.js Steam Market purchase (fallback if Python unavailable).
 */
async function executeSteamBuyLegacy(listingId, currency, subtotal, fee, total, steamCookie, marketHashName = '') {
    if (!steamCookie) return { success: false, message: 'Cookie 未配置' };

    const sessionIdMatch = steamCookie.match(/sessionid=([^;]+)/);
    if (!sessionIdMatch) return { success: false, message: 'Cookie 中缺少 sessionid' };
    const sessionId = sessionIdMatch[1];

    const url = `https://steamcommunity.com/market/buylisting/${listingId}`;
    const referer = marketHashName
        ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`
        : 'https://steamcommunity.com/market/';

    const countryMatch = steamCookie.match(/steamCountry=([^%|;]+)/);
    const country = countryMatch ? countryMatch[1] : 'CN';

    // Use a more reliable billing country: 
    // If steamCountry cookie exists and is NOT CN, try using it as billing_country
    // as it frequently causes 502 if mismatched with IP.
    const reliableCountry = (country && country !== 'CN') ? country : (currency == 23 ? 'CN' : (currency == 1 ? 'US' : 'CN'));

    // Core payload — restored to full browser capture standard
    const paramsObj = {
        sessionid: sessionId,
        appid: '730',
        contextid: '2',
        currency: String(currency),
        subtotal: String(Math.round(subtotal)),
        fee: String(Math.round(fee)),
        total: String(Math.round(total)),
        quantity: '1',
        billing_state: '',
        save_my_address: '0',
        tradefee_tax: '0',
        confirmation: '0',
        billing_country: 'CN'
    };

    if (currency == 1) { // USD only — extra billing info
        paramsObj.first_name = 'John';
        paramsObj.last_name = 'Doe';
        paramsObj.billing_address = '100 SW Main St';
        paramsObj.billing_address_two = '';
        paramsObj.billing_city = 'Portland';
        paramsObj.billing_state = 'OR';
        paramsObj.billing_postal_code = '97204';
        paramsObj.save_my_address = '1';
    }

    const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
    let finalCookie = optimizedCookie.includes('steamCurrencyId=')
        ? optimizedCookie.replace(/steamCurrencyId=\d+/, `steamCurrencyId=${currency}`)
        : `${optimizedCookie}; steamCurrencyId=${currency}`;

    // Force steamCountry=CN to match CNY currency and avoid 502 on cross-region purchase
    if (finalCookie.includes('steamCountry=')) {
        finalCookie = finalCookie.replace(/steamCountry=[^;]+/, 'steamCountry=CN');
    } else {
        finalCookie += '; steamCountry=CN';
    }

    // Re-extract sessionId from the FINAL cookie string to ensure consistency
    const finalSessionIdMatch = finalCookie.match(/sessionid=([^;]+)/);
    const finalSessionId = finalSessionIdMatch ? finalSessionIdMatch[1] : sessionId;

    // Use a simplified Referer as some versions of Steam reject complex ones on POST
    const simplifiedReferer = 'https://steamcommunity.com/market/';

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://steamcommunity.com',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': simplifiedReferer,
        'Cookie': finalCookie,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"'
    };

    // Correct payload — use the finalized session id
    paramsObj.sessionid = finalSessionId;
    const payloadQuery = new URLSearchParams(paramsObj).toString();

    console.log(`[Steam 购买] 正在请求: ${url}`);

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await steamRequest(url, {
                method: 'POST',
                data: payloadQuery,
                headers: headers,
                timeout: 30000,
                validateStatus: () => true
            });

            const data = response.data;
            if (response.status >= 400) {
                console.log(`[Steam 购买] 状态码 ${response.status} (第 ${attempt} 次尝试)`);
                console.error(`[Steam 购买] 响应体:`, typeof data === 'object' ? JSON.stringify(data).substring(0, 300) : String(data).substring(0, 300));

                if (response.status >= 500) {
                    // 502/500 on purchase often means the listing is in a glitchy state or gone,
                    // BUT it can also be a "Ghost Success" where the purchase actually worked.
                    return { success: false, isStale: true, potentialSuccess: true, message: `Steam 服务器错误 (${response.status})，建议刷新` };
                }
            }

            // Success or logical failure (e.g. 406 Not Acceptable is sometimes used by Steam for blocks)
            if (response.status === 200 || response.status === 406 || response.status === 400) {
                const innerData = (typeof data === 'string' && data.trim().startsWith('{')) ? JSON.parse(data) : data;
                const isSuccess = innerData && (innerData.success === 1 || innerData.success === 22 || innerData.success === true || innerData.wallet_info);

                if (isSuccess) {
                    const needsConfirm = innerData.need_confirmation || innerData.success === 22;
                    return {
                        success: true,
                        message: needsConfirm ? '购买请求已发送，请在手机 Steam 令牌中确认购买' : '购买成功！'
                    };
                }
                if (innerData && innerData.message) {
                    const isAlreadyPurchased = innerData.message.includes("already purchased") ||
                        innerData.message.includes("已经购买了此饰品") ||
                        innerData.message.includes("You've already purchased this item");
                    const isStale = innerData.message.includes("removed") ||
                        innerData.message.includes("下架") ||
                        innerData.message.includes("Refresh the page");
                    return {
                        success: false,
                        alreadyPurchased: isAlreadyPurchased,
                        isStale: isStale,
                        message: `Steam 错误: ${innerData.message}`
                    };
                }
                if (innerData && innerData.success) {
                    return { success: false, message: `Steam 失败码: ${innerData.success}` };
                }
            }

            if (response.status === 401 || response.status === 403) {
                return { success: false, message: `Cookie 已失效 (${response.status})` };
            }

            return { success: false, message: `购买失败 (${response.status})` };

        } catch (e) {
            lastError = e;
            console.error(`[Steam 购买] 第 ${attempt} 次尝试失败:`, e.message);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    return { success: false, message: `购买过程遇到错误: ${lastError?.message}` };
}

/**
 * Remove (cancel) a Steam Market sell listing.
 */
async function removeSteamListing(listingId, steamCookie) {
    if (!steamCookie) throw new Error('Cookie 未配置');

    const sessionIdMatch = steamCookie.match(/sessionid=([^;]+)/);
    if (!sessionIdMatch) throw new Error('Cookie 中未找到 sessionid');
    const sessionId = sessionIdMatch[1];

    try {
        console.log(`[Steam] 正在尝试下架挂单 ${listingId}...`);
        const optimizedCookie = prepareCookieHeader(steamCookie, 'community');
        const response = await axios.post(
            `https://steamcommunity.com/market/removelisting/${listingId}`,
            `sessionid=${sessionId}`,
            {
                headers: {
                    'Cookie': optimizedCookie,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Origin': 'https://steamcommunity.com',
                    'Referer': 'https://steamcommunity.com/market/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                timeout: 15000
            }
        );

        console.log(`[Steam] 下架响应 (挂单ID ${listingId}):`, JSON.stringify(response.data));
        // Steam returns [] on success, or an object with success: 1/message on failure
        return response.status === 200;
    } catch (e) {
        console.error(`[removeSteamListing] Error:`, e.response?.data || e.message);
        const steamMsg = e.response?.data?.message || 'Steam 拒绝了下架请求';
        const status = e.response?.status ? ` (Status: ${e.response.status})` : '';
        throw new Error(`${steamMsg}${status}`);
    }
}

/**
 * Fetch item image URL from Steam market listings page.
 * This is more reliable than fetchSteamSeries because it returns icon_url directly.
 * @param {string} marketHashName - Full hash name of the item
 * @returns {string|null} - Full CDN image URL or null
 */
async function fetchSteamItemImage(marketHashName) {
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}/render?currency=23&language=english&two_factor=0&norender=1&start=0&count=1`;
    try {
        const response = await steamRequest(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://steamcommunity.com/market/'
            },
            timeout: 20000
        });
        const data = response.data;
        // listings render response: data.assets["730"]["2"] is a map of assetid -> item
        if (data && data.assets && data.assets['730'] && data.assets['730']['2']) {
            const assets = data.assets['730']['2'];
            const firstAsset = Object.values(assets)[0];
            if (firstAsset && firstAsset.icon_url) {
                return `https://community.akamai.steamstatic.com/economy/image/${firstAsset.icon_url}`;
            }
        }
        return null;
    } catch (err) {
        console.error(`[fetchSteamItemImage] Error for "${marketHashName}":`, err.message);
        return null;
    }
}

// ─── C5Game Merchant Operation APIs ──────────────────────────────────────────
// Auth: only app-key query param required, no HMAC signing (confirmed from official docs)
// Note: C5_BASE is declared above at line ~82, reused here.

/**
 * Build common C5 axios config with app-key
 * @param {string|number} [merchantIdOrAppKey] - Merchant ID or direct appKey
 * @param {object} [extra] - Additional axios config
 */
async function c5Config(merchantIdOrAppKey, extra = {}) {
    // If first arg is an object, assume it's 'extra' and use default merchant
    if (typeof merchantIdOrAppKey === 'object' && merchantIdOrAppKey !== null) {
        extra = merchantIdOrAppKey;
        merchantIdOrAppKey = undefined;
    }
    const key = await getC5ApiKey(merchantIdOrAppKey);
    return {
        timeout: 15000,
        ...extra,
        params: { 'app-key': key, ...(extra.params || {}) },
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'SteamTool/1.0',
            ...(extra.headers || {})
        }
    };
}

/**
 * Query C5 account balance
 * GET /merchant/account/v2/balance
 * @returns {{ moneyAmount, depositAmount, tradeSettleAmount, creditMoney, creditDeposit }}
 */
async function fetchC5Balance(merchantId) {
    const res = await axios.get(`${C5_BASE}/merchant/account/v2/balance`, await c5Config(merchantId));
    if (!res.data.success) throw new Error(`C5 余额查询失败: ${res.data.errorMsg}`);
    return res.data.data;
}

/**
 * Get Steam inventory via C5 proxy (richer data than raw Steam)
 * GET /merchant/inventory/v2/{steamId}/730
 * @param {string} steamId - Steam ID 64
 * @returns {Array} Inventory item list
 */
async function fetchC5Inventory(steamId, merchantId) {
    const res = await axios.get(`${C5_BASE}/merchant/inventory/v2/${steamId}/730`, await c5Config(merchantId, {
        params: { language: 'zh' }
    }));
    if (!res.data.success) throw new Error(`C5 库存查询失败: ${res.data.errorMsg}`);
    return res.data.data?.list || [];
}

/**
 * Get seller's listings on C5 marketplace
 * GET /merchant/sale/v1/search
 * @param {string} steamId - The Steam ID to filter by
 * @param {number} page - Page number (1-based)
 * @returns {{ list, total, pages }}
 */
async function fetchC5Listings(steamId, page = 1, merchantId) {
    const res = await axios.get(`${C5_BASE}/merchant/sale/v1/search`, await c5Config(merchantId, {
        params: { appId: 730, steamId: steamId || '', page, limit: 50 }
    }));
    if (!res.data.success) throw new Error(`C5 挂单查询失败: ${res.data.errorMsg}`);
    return res.data.data || { list: [], total: 0, pages: 1 };
}

/**
 * List an inventory item on C5 marketplace
 * POST /merchant/sale/v2/create
 * @param {string} token - Item token from inventory list
 * @param {string} styleToken - Item style token required by C5
 * @param {number} price - Sell price in CNY (e.g. 12.50)
 */
async function c5ListItem(tokenOrItems, styleToken, price, merchantId) {
    let dataList = [];
    if (Array.isArray(tokenOrItems)) {
        dataList = tokenOrItems.map(item => ({
            price: parseFloat(item.price.toFixed(2)),
            description: '',
            acceptBargain: 0,
            token: item.token,
            styleToken: item.styleToken
        }));
    } else {
        dataList = [{
            price: parseFloat(price.toFixed(2)),
            description: '',
            acceptBargain: 0,
            token: tokenOrItems,
            styleToken: styleToken
        }];
    }

    const res = await axios.post(`${C5_BASE}/merchant/sale/v2/create`, {
        dataList
    }, await c5Config(merchantId));
    if (!res.data.success) throw new Error(`C5 上架失败: ${res.data.errorMsg}`);
    return res.data.data;
}


/**
 * Quick buy from C5 marketplace by marketHashName
 * POST /merchant/trade/v2/quick-buy
 * @param {string} tradeUrl - Buyer's Steam trade URL
 * @param {string} marketHashName - Item hash name
 * @param {number} maxPrice - Maximum price willing to pay
 * @param {number} [delivery=2] - 1=manual, 2=auto (prefer auto-delivery)
 */
async function c5QuickBuy(tradeUrl, marketHashName, maxPrice, delivery = 0, merchantId) {
    const outTradeNo = `ST${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const res = await axios.post(`${C5_BASE}/merchant/trade/v2/quick-buy`, {
        outTradeNo,
        tradeUrl,
        appId: 730,
        marketHashName,
        maxPrice: parseFloat(maxPrice.toFixed(2)),
        delivery,
        lowPrice: 1  // always buy cheapest
    }, await c5Config(merchantId));
    if (!res.data.success) throw new Error(`C5 购买失败: ${res.data.errorMsg}`);
    return res.data.data;
}

/**
 * Modify sale price on C5 marketplace
 * POST /merchant/sale/v1/modify
 * @param {string|object[]} saleIdOrItems - Single saleId (string) or array of { saleId, price }
 * @param {number} [price] - New price in CNY (if first param is single saleId)
 */
async function c5ModifyPrice(saleIdOrItems, price, merchantId) {
    let dataList = [];
    if (Array.isArray(saleIdOrItems)) {
        dataList = saleIdOrItems.map(item => ({
            productId: String(item.saleId),   // Keep as string to avoid JS precision loss on large IDs
            price: Number(Number(item.price).toFixed(2))
        }));
    } else {
        dataList = [{
            productId: String(saleIdOrItems),  // Keep as string to avoid JS precision loss on large IDs
            price: Number(Number(price).toFixed(2))
        }];
    }
    const res = await axios.post(`${C5_BASE}/merchant/sale/v1/modify`, {
        appId: 730,
        dataList
    }, await c5Config(merchantId));

    if (!res.data.success) throw new Error(`C5 改价失败: ${res.data.errorMsg}`);

    // C5 returns failedList as a template even when empty — parse actual failures from dataList
    const d = res.data.data || {};
    const actualFailures = (d.failedList || []).flatMap(f => f.dataList || []);
    const successNum = d.successNum ?? (dataList.length - actualFailures.length);
    const failNum = actualFailures.length;

    if (failNum > 0 && successNum === 0) {
        const reasons = [...new Set((d.failedList || [])
            .filter(f => (f.dataList || []).length > 0)
            .map(f => f.disableSaleReason))].join('; ');
        throw new Error(`C5 改价失败: 成功 ${successNum} 件, 失败 ${failNum} 件. 原因: ${reasons}`);
    }

    return { successNum, failNum, raw: d };
}

/**
 * Delist (取消挂单) from C5 marketplace
 * POST /merchant/sale/v1/cancel
 */
async function c5Delist(saleId, merchantId) {
    const ids = Array.isArray(saleId) ? saleId : [saleId];
    const payload = { appId: 730, productIds: ids.map(id => String(id)) };
    const res = await axios.post(`${C5_BASE}/merchant/sale/v1/cancel`, payload, await c5Config(merchantId));
    if (!res.data.success) throw new Error(`C5 下架失败: ${res.data.errorMsg}`);
    return res.data.data;
}

/**
 * Fetch Steam user info linked to C5 (for verifying steamId binding)
 * GET /merchant/account/v2/steam-info
 */
async function fetchC5SteamInfo(merchantId) {
    const res = await axios.get(`${C5_BASE}/merchant/account/v1/steamInfo`, await c5Config(merchantId));
    if (!res.data.success) throw new Error(`C5 账号信息查询失败: ${res.data.errorMsg}`);
    return res.data.data;
}

/**
 * Bind a Steam account to C5 merchant account
 * POST /merchant/account/v2/bind
 */
async function bindC5SteamAccount(steamId, phone, merchantId, areaCode = 86) {
    const cfg = await c5Config(merchantId);
    // ⚠️ steamId64 超过 JS 安全整数范围(2^53)，Number()会丢失精度导致"系统异常"
    // 必须手动构建 JSON body，让 steamId 作为原始 JSON 数字字面量传递
    const rawBody = `{"steamId":${steamId},"areaCode":${Number(areaCode)},"phone":"${phone}"}`;
    const url = `${C5_BASE}/merchant/quick/steam/v1/bind`;
    const params = new URLSearchParams({ 'app-key': cfg.params['app-key'] }).toString();
    const res = await axios.post(`${url}?${params}`, rawBody, {
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SteamTool/1.0' },
        timeout: 15000
    });
    if (!res.data.success) throw new Error(`C5 绑定失败: ${res.data.errorMsg}`);
    return res.data.data;
}

/**
 * Extract Steam Trade URL from a given session.
 * Now supports both direct API-based retrieval (robust) and HTML scraping (fallback).
 */
async function fetchTradeUrlFromCookie(sessionResult, steamId64) {
    const isObject    = typeof sessionResult === 'object' && sessionResult !== null;
    const cookie      = isObject ? sessionResult.cookieString : sessionResult;
    const accessToken = isObject ? sessionResult.accessToken  : null;
    const cookieArr   = isObject ? sessionResult.cookieArray  : null;

    // --- METHOD 1: steamcommunity 库 (最可靠) ---
    if (cookieArr && cookieArr.length > 0) {
        console.log(`[交易链接] 正在尝试通过 steamcommunity 库获取 (SteamID: ${steamId64})...`);
        try {
            const SteamCommunity = require('steamcommunity');
            const proxyUrl = getProxyAgent('https://steamcommunity.com');
            const community = new SteamCommunity(proxyUrl ? { httpProxy: proxyUrl } : {});
            community.setCookies(cookieArr);
            const tradeUrl = await new Promise((resolve, reject) => {
                community.getTradeURL((err, url, token) => {
                    if (err) return reject(err);
                    const partnerId = (BigInt(steamId64) & 0xFFFFFFFFn).toString();
                    resolve(`https://steamcommunity.com/tradeoffer/new/?partner=${partnerId}&token=${token}`);
                });
            });
            console.log(`[交易链接] ✅ steamcommunity 库成功!`);
            return tradeUrl;
        } catch (e) {
            console.warn(`[交易链接] steamcommunity 库失败: ${e.message}`);
        }
    }

    // --- METHOD 2: 官方 API (access_token) ---
    if (accessToken && steamId64) {
        console.log(`[交易链接] 正在尝试通过官方 API 获取 (SteamID: ${steamId64})...`);
        const partnerId = (BigInt(steamId64) & 0xFFFFFFFFn).toString();
        for (const opts of [
            { params: { access_token: accessToken } },
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        ]) {
            try {
                const r = await steamRequest('https://api.steampowered.com/IEconService/GetTradeOfferAccessToken/v1/', { ...opts, timeout: 10000 });
                if (r.data?.response?.trade_offer_access_token) {
                    const token = r.data.response.trade_offer_access_token;
                    return `https://steamcommunity.com/tradeoffer/new/?partner=${partnerId}&token=${token}`;
                }
            } catch (e) {
                console.warn(`[交易链接] API 尝试失败: ${e.response?.status || e.message}`);
            }
        }
    }

    // --- METHOD 3: 网页抓取 (兑底) ---
    if (!cookie) throw new Error('所有方式均失败且无 Cookie，放弃');

    let finalCookie = cookie;
    if (!finalCookie.includes('sessionid=')) {
        const { randomBytes } = require('crypto');
        finalCookie = `sessionid=${randomBytes(12).toString('hex')}; ${finalCookie}`;
    }

    const profileUrl = steamId64
        ? `https://steamcommunity.com/profiles/${steamId64}/tradeoffers/privacy`
        : 'https://steamcommunity.com/my/tradeoffers/privacy';

    console.log(`[交易链接] 正在网页抓取: ${profileUrl}`);

    let res;
    try {
        res = await steamRequest(profileUrl, {
            headers: { 'Cookie': finalCookie },
            maxRedirects: 8,
            validateStatus: (s) => s < 500
        });
    } catch (scrapeErr) {
        if (scrapeErr.message && scrapeErr.message.includes('redirects')) {
            throw new Error('网页抓取失败: Cookie 未被接受，登录重定向循环');
        }
        throw new Error(`网页抓取请求失败: ${scrapeErr.message}`);
    }

    if (!res || !res.data) throw new Error('无法访问 Steam 隐私页面');

    const responseUrl = res.request?.res?.responseUrl || res.request?.responseURL || '';
    if (responseUrl.includes('/login') ||
        String(res.data).includes('g_steamID = false') ||
        String(res.data).includes('"steamid":false')) {
        throw new Error('网页抓取失败: Session 已过期或 Cookie 无效');
    }

    const urlMatch = String(res.data).match(/https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([a-zA-Z0-9_\-]+)/);
    if (!urlMatch) throw new Error('未在页面中找到交易链接，请确认账号交易隐私设置为公开');
    return urlMatch[0];
}

/**
 * Get a fresh Steam Web Cookie using a RefreshToken.
 * Uses the correct MobileApp auth flow via steam-session library:
 *   1. GenerateAccessTokenForApp (through residential proxy, up to 3 retries)
 *   2. steam-session.getWebCookies() with pre-loaded accessToken (no extra network requests)
 *   Returns { cookieString, cookieArray, accessToken, isFallbackCookie }
 */
async function steamRefreshSession(acc) {
    const refreshToken = acc.refreshToken;
    const steamId64    = acc.steamId64;
    if (!refreshToken || !steamId64) return null;

    const https  = require('https');
    const crypto = require('crypto');

    const getResidentialProxyUrl = () => getProxyAgent('https://api.steampowered.com');

    function httpsPost(options, body) {
        return new Promise((resolve, reject) => {
            options.rejectUnauthorized = false;
            const proxyUrl = getResidentialProxyUrl();
            if (proxyUrl) options.agent = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    let parsed = {};
                    try { parsed = JSON.parse(data); } catch (e) {}
                    resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: data });
                });
            });
            req.on('error', reject);
            req.setTimeout(20000, () => { req.destroy(); reject(new Error('req timeout')); });
            if (body) req.write(body);
            req.end();
        });
    }

    try {
        const proxyTag = getResidentialProxyUrl() ? 'Webshare' : 'None';
        console.log(`[Token刷新] 账号 ${acc.name}: 正在刷新会话 (Proxy: ${proxyTag})...`);

        // Step 1: RefreshToken -> fresh AccessToken (max 3 retries)
        const tokenBody = `refresh_token=${encodeURIComponent(refreshToken)}&steamid=${steamId64}`;
        let accessToken = null;
        for (let i = 1; i <= 3 && !accessToken; i++) {
            try {
                const r = await httpsPost({
                    hostname: 'api.steampowered.com',
                    path: '/IAuthenticationService/GenerateAccessTokenForApp/v1/',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) }
                }, tokenBody);
                accessToken = r?.body?.response?.access_token;
                if (!accessToken) {
                    console.warn(`[Token刷新] 账号 ${acc.name} 第${i}次无token (HTTP ${r.status}): ${r.raw?.slice(0,80)}`);
                    if (i < 3) {
                        const waitMs = (r.status === 429 || r.status === 0 ? 3000 : 1000) * i;
                        await new Promise(r => setTimeout(r, waitMs));
                    }
                }
            } catch (e) {
                console.warn(`[Token刷新] 账号 ${acc.name} 第${i}次网络异常: ${e.message}`);
                if (i < 3) await new Promise(r => setTimeout(r, 2000 * i));
            }
        }

        if (!accessToken) {
            console.error(`[Token刷新] 账号 ${acc.name}: 3次均获取不到 accessToken`);
            return null;
        }

        // Step 2: steam-session MobileApp -> getWebCookies() (no network, uses pre-loaded accessToken)
        let cookieArray      = null;
        let isFallbackCookie = false;
        try {
            const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
            const session = new LoginSession(EAuthTokenPlatformType.MobileApp);
            session.refreshToken = refreshToken;
            session.accessToken  = accessToken;
            cookieArray = await session.getWebCookies();
            console.log(`[Token刷新] 账号 ${acc.name}: ✅ steam-session cookie 成功`);
        } catch (e) {
            console.warn(`[Token刷新] 账号 ${acc.name}: steam-session 失败 (${e.message}), 使用兜底 cookie`);
            isFallbackCookie = true;
            const sid = crypto.randomBytes(12).toString('hex');
            cookieArray = [
                `steamLoginSecure=${encodeURIComponent(steamId64 + '||' + accessToken)}`,
                `sessionid=${sid}`
            ];
        }

        const browserId  = Math.floor(Math.random() * 1e18).toString();
        const cookieStr  = cookieArray.join('; ');
        const fullCookie = `${cookieStr}; steamCountry=HK%7C214f0d311bda67b4c2ea6cbdcf63f730; browserid=${browserId}; timezoneOffset=28800,0; Steam_Language=english`;

        console.log(`[Token刷新] 账号 ${acc.name}: ✅ 刷新${isFallbackCookie ? '(兜底)' : ''}成功`);
        return { cookieString: fullCookie, cookieArray, accessToken, isFallbackCookie };

    } catch (e) {
        console.error(`[Token刷新] 账号 ${acc.name} 异常: ${e.message}`);
        return null;
    }
}

/**
 * Simple parser for SDA-format maFile contents
 */
function parseMaFile(content) {
    try {
        const raw = typeof content === 'string' ? content : JSON.stringify(content);
        const data = JSON.parse(raw);
        const steamIdMatch = raw.match(/"SteamID"\s*:\s*(\d{15,20})/) || raw.match(/"steamid"\s*:\s*"?(\d{15,20})"?/i);
        const steamId64 = steamIdMatch ? steamIdMatch[1] : null;

        const result = {
            steamId64,
            accountName: data.account_name || null,
            sharedSecret: data.shared_secret || null,
            identitySecret: data.identity_secret || null,
            refreshToken: data.Session?.RefreshToken || null,
            // Session.AccessToken 是 maFile 原始 token，可作为 FinalizeLogin nonce
            existingAccessToken: data.Session?.AccessToken || null,
            cookie: null
        };

        if (data.Session?.SteamLoginSecure) {
            const sls = data.Session.SteamLoginSecure;
            result.cookie = `sessionid=1234567890abcdef12345678; steamLoginSecure=${sls}; steamid=${steamId64}`;
        }
        return result;
    } catch (e) {
        throw new Error('maFile 格式错误，请确保是正确的 JSON 文件');
    }
}

module.exports = {
    fetchSteamPrice,
    fetchSteamItemPrice,
    fetchCheapestListing,
    executeSteamBuy,
    logToAutoBuyFile,
    fetchSteamSeries,
    steamRequest,
    fetchYoupinSeries,       // deprecated stub — kept for safety
    translateChineseToEnglish,
    fetchMyActiveListings,
    removeSteamListing,
    fetchSteamItemImage,
    prepareCookieHeader,

    // C5Game Price APIs
    fetchC5GamePriceBatch,
    fetchC5GameSearch,
    getC5ApiKey,

    // C5Game Merchant Operation APIs
    fetchC5Balance,
    fetchC5Inventory,
    fetchC5Listings,
    c5ListItem,
    c5QuickBuy,
    c5ModifyPrice,
    c5Delist,
    fetchC5SteamInfo,
    bindC5SteamAccount,

    // Core Steam automation
    steamRefreshSession,
    fetchTradeUrlFromCookie,
    parseMaFile,

    USD_TO_CNY: currencyConfig.USD_TO_CNY,
    CNY_TO_USD: currencyConfig.CNY_TO_USD,
    currencyConfig,
    updateGlobalExchangeRate,
    getProxyAgent,
};
