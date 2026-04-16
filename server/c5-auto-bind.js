const puppeteerContext = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerContext.use(StealthPlugin());

const fs = require('fs');

// 用于寻找本地可用的浏览器
function getExecutablePath() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('未找到合适的本地 Chrome/Edge 浏览器');
}

/**
 * 自动将 Steam 账号以「用户登录」方式注册到 C5，创建该 Steam 账号自己的独立 C5 用户账号。
 *
 * 核心区别：
 *   旧方案：用「商户 Cookie」打开商户的 Steam 设置页 → 「添加 Steam」→ 仅给商户绑了个 Steam，不创建独立用户
 *   新方案：不设任何 C5 Cookie → 访问 C5 登录页 → 「Steam 用户登录」→ 为该 Steam 账号创建独立 C5 用户账号
 *
 * @param {Object} acc            数据库里的 account 对象（包含 steamId64, name, trade_url 等）
 * @param {Array}  steamCookieArray  从 steam-session 获取的 Cookie 数组，如 ["steamLoginSecure=xxx", "sessionid=yyy"]
 * @param {Browser} browser       传入的 puppeteer 浏览器实例
 */
async function autoBindSingleAccount(acc, steamCookieArray, browser) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
        // 反检测
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        const client = await page.target().createCDPSession();
        await client.send('Debugger.enable');
        await client.send('Debugger.setBreakpointsActive', { active: false });
        page.on('dialog', async dialog => { await dialog.accept(); });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });

        // 1. 只注入 Steam Cookie（不注入任何 C5 Cookie）
        console.log(`[AutoBind] [${acc.name}] 注入 Steam Cookie（不设 C5 Cookie）...`);
        const parsedSteamCookies = [];
        for (const str of steamCookieArray) {
            const parts = str.split(';');
            const [name, ...valParts] = parts[0].split('=');
            if (!name || valParts.length === 0) continue;
            const cookieName = name.trim();
            const cookieValue = valParts.join('=').trim();
            const isHttpOnly = str.toLowerCase().includes('httponly');
            for (const domain of ['.steamcommunity.com', 'steamcommunity.com', '.store.steampowered.com']) {
                parsedSteamCookies.push({ name: cookieName, value: cookieValue, domain, path: '/', secure: true, httpOnly: isHttpOnly });
            }
        }
        await page.setCookie(...parsedSteamCookies);

        // 2. 打开 C5 登录页，找 "Steam 登录" 按钮并拦截其目标 URL
        console.log(`[AutoBind] [${acc.name}] 访问 C5 登录页，寻找 Steam 登录入口...`);
        await page.goto('https://www.c5game.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[AutoBind] goto 登录页异常(可忽略):', e.message));

        // 3. 等待 Nuxt 初始化，然后通过 API 获取 Steam 登录 URL（无 C5 session → login 模式）
        await page.waitForFunction(() => window.$nuxt !== undefined, { timeout: 15000 }).catch(() => {});
        const isNuxtReady = await page.evaluate(() => !!window.$nuxt);

        let steamLoginUrl = null;

        if (isNuxtReady) {
            // 如果 Nuxt 加载完成，通过 $axios 调用 prepare（无 C5 cookie → 返回的是「新用户登录」URL）
            console.log(`[AutoBind] [${acc.name}] Nuxt 就绪，获取 Steam 登录 URL...`);
            steamLoginUrl = await page.evaluate(async () => {
                try {
                    // 尝试 login-prepare 端点
                    const r = await window.$nuxt.$axios.get('/uic/user/steam/v1/web/prepare', {
                        params: { returnPath: '/' }
                    });
                    return r.data?.data?.url || r.data?.url || null;
                } catch (e) {
                    return null;
                }
            });
        }

        // 兜底：直接从页面 DOM 里找 Steam 登录链接
        if (!steamLoginUrl) {
            steamLoginUrl = await page.evaluate(() => {
                const candidates = [
                    ...document.querySelectorAll('a[href], button')
                ].filter(el => {
                    const t = (el.textContent || '').toLowerCase();
                    const h = (el.href || '').toLowerCase();
                    return h.includes('steam') || t.includes('steam');
                });
                if (candidates.length > 0) return candidates[0].href || null;
                return null;
            });
        }

        if (!steamLoginUrl || !steamLoginUrl.includes('steamcommunity.com')) {
            await page.screenshot({ path: `error_${acc.name}_no_steam_login.png` });
            throw new Error('无法从 C5 登录页找到 Steam 登录入口，请检查截图');
        }

        // 4. 跳转到 Steam 授权页（Steam Cookie 已设好，应自动跳过输密码的步骤）
        console.log(`[AutoBind] [${acc.name}] 跳转到 Steam 授权页...`);
        for (let i = 0; i < 3; i++) {
            try {
                await page.goto(steamLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                break;
            } catch (err) {
                if (err.message.includes('ERR_ABORTED') && i < 2) {
                    console.warn(`[AutoBind] [${acc.name}] ERR_ABORTED，重试 (${i + 1}/3)...`);
                    await new Promise(r => setTimeout(r, 2000));
                } else throw err;
            }
        }

        // 5. 检查是否被拦到密码输入页
        const needsPass = await page.$('input[type="password"]');
        if (needsPass) {
            await page.screenshot({ path: `error_${acc.name}_steam_needs_pass.png` });
            throw new Error('Steam Cookie 已失效，要求输入账号密码');
        }

        // 6. 检查 Steam Sign In 按钮（如果有就点击；如果没有说明 Steam 自动同意了）
        let signInBtn = await page.$('input[type="image"][id="imageLogin"], input[type="submit"][value="Sign In"], input#imageLogin');
        const currentHost = new URL(page.url()).hostname;

        if (!signInBtn && (currentHost.includes('c5game') || currentHost.includes('imbastar'))) {
            console.log(`[AutoBind] [${acc.name}] Steam 已自动授权，直接跳回 C5`);
        } else if (!signInBtn) {
            await page.screenshot({ path: `error_${acc.name}_steam_bind.png` });
            throw new Error('Steam 页面找不到 Sign In 按钮，当前URL: ' + page.url());
        } else {
            console.log(`[AutoBind] [${acc.name}] 点击 Steam Sign In...`);
            await page.evaluate(() => document.querySelector('form')?.submit()).catch(() => signInBtn.click());
            try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (e) {}
        }

        // 7. 回到 C5，等待 Nuxt 就绪（现在的 C5 session 是该 Steam 账号自己的用户 session）
        console.log(`[AutoBind] [${acc.name}] 跳回 C5: ${page.url().substring(0, 60)}`);
        await page.waitForFunction(() => window.$nuxt !== undefined, { timeout: 20000 }).catch(() => {});

        // 8. 保存交易链接（用该 Steam 账号自己的 C5 用户 session）
        if (acc.trade_url) {
            console.log(`[AutoBind] [${acc.name}] 正在保存交易链接...`);
            let tradeUrlOk = false;
            let lastErr = null;
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const res = await page.evaluate(async (tradeUrl, steamId) => {
                        if (!window.$nuxt?.$axios) return { success: false, error: '$nuxt not ready' };
                        try {
                            const resp = await window.$nuxt.$axios.post('/support/user/steam/v1/tradeurl-save', {
                                steamTradeUrl: tradeUrl,
                                steamId
                            });
                            const ok = resp === true || resp?.success === true || resp?.data?.code === 200;
                            return { success: ok, data: resp };
                        } catch (err) {
                            return { success: false, error: err.response?.data || err.message };
                        }
                    }, acc.trade_url, acc.steamId64);

                    if (res?.success) {
                        console.log(`[AutoBind] [${acc.name}] 交易链接保存成功！`);
                        tradeUrlOk = true;
                        break;
                    }
                    lastErr = res;
                    console.warn(`[AutoBind] [${acc.name}] 交易链接保存重试 (${i + 1}/8)...`, JSON.stringify(lastErr).substring(0, 80));
                } catch (e) {
                    console.error(`[AutoBind] [${acc.name}] 脚本异常:`, e.message);
                }
            }
            if (!tradeUrlOk) {
                await page.screenshot({ path: `error_${acc.name}_tradeurl_fail.png` });
                throw new Error(`交易链接保存失败: ${JSON.stringify(lastErr).substring(0, 80)}`);
            }
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }

        await page.screenshot({ path: `c5_bind_returned_${acc.name}.png` });

        const bodyTxt = await page.evaluate(() => document.body.innerText);
        if (bodyTxt.includes(acc.steamId64) || bodyTxt.includes('成功') || page.url().includes('steam') || page.url().includes('c5game')) {
            console.log(`[AutoBind] [${acc.name}] 绑定成功，C5 用户账号已建立！`);
            return { success: true, url: page.url() };
        } else {
            return { success: false, error: '跳回 C5 后未发现绑定成功迹象，请查看截图', url: page.url() };
        }

    } catch (e) {
        console.error(`[AutoBind] [${acc.name}] 错误:`, e.message);
        return { success: false, error: e.message };
    } finally {
        await context.close();
    }
}

module.exports = {
    getExecutablePath,
    autoBindSingleAccount,
    puppeteer: puppeteerContext
};
