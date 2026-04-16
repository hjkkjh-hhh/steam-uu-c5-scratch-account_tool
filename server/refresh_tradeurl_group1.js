'use strict';
/**
 * refresh_tradeurl_group1.js
 * 并发刷新「分组1」所有账号的交易链接 (并发度 3)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const db = require('./db.js');
const { steamRefreshSession, fetchTradeUrlFromCookie, parseMaFile } = require('./fetchers.js');

const CONCURRENCY  = 3;
const TARGET_GROUP = '分组1';

const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;

function ts() { const n=new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`; }

(async () => {
    console.log(BOLD(`\n══ 刷新「${TARGET_GROUP}」交易链接 ══  ${new Date().toLocaleString('zh-CN')}\n`));

    await db.initSchema();

    const allAccs  = await db.readAccounts();
    const groups   = await db.readGroups();
    const g        = groups.find(x => x.name === TARGET_GROUP) || groups.find(x => x.id === 1);

    if (!g) { console.log(RED('未找到' + TARGET_GROUP)); process.exit(1); }

    const targets = allAccs.filter(a => String(a.groupId) === String(g.id));
    console.log(`目标分组: 「${g.name}」(id=${g.id}) — ${targets.length} 个账号\n`);

    const results = { ok: 0, fail: 0 };
    const queue   = [...targets];
    const total   = queue.length;
    let   done    = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        (async () => {
            while (queue.length > 0) {
                const acc = queue.shift();
                if (!acc) continue;

                const tag = `[${acc.name}]`;
                done++;
                const progress = `(${String(done).padStart(2)}/${total})`;

                try {
                    // 解析 refreshToken
                    let refreshToken = null;
                    if (acc.mafileContent) {
                        try { refreshToken = parseMaFile(acc.mafileContent).refreshToken; } catch {}
                    }
                    if (!refreshToken) {
                        console.log(YELLOW(`${ts()} ${progress} ${tag} ⚠️  无 refreshToken，跳过`));
                        results.fail++;
                        continue;
                    }

                    console.log(DIM(`${ts()} ${progress} ${tag} 刷新 Session...`));

                    // 刷新 Session
                    const fakeAcc = {
                        name:                acc.name || acc.steamId64,
                        steamId64:           acc.steamId64,
                        refreshToken,
                        existingAccessToken: null,
                    };
                    const freshSession = await steamRefreshSession(fakeAcc);

                    // 获取交易链接
                    const tradeUrl = await fetchTradeUrlFromCookie(freshSession, acc.steamId64);

                    // 写入 MySQL
                    await db.updateAccountTradeUrl(acc.id, tradeUrl);
                    console.log(GREEN(`${ts()} ${progress} ${tag} ✅  ${tradeUrl}`));
                    results.ok++;

                } catch (e) {
                    console.log(RED(`${ts()} ${progress} ${tag} ❌  ${e.message}`));
                    results.fail++;
                }
            }
        })()
    );

    await Promise.all(workers);

    console.log(BOLD(`\n══ 完成 —— 成功: ${results.ok}  失败: ${results.fail} ══\n`));
    await db.close();
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
