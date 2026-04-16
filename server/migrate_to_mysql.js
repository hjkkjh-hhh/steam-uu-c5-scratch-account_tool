'use strict';
/**
 * migrate_to_mysql.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 将 steam_tool.db (SQLite) 全量迁移到 MySQL
 * 2. 迁移完成后，并发刷新「分组2」所有账号的交易链接
 *
 * 使用方法:
 *   node server/migrate_to_mysql.js
 *
 * 注意: 运行前确保 .env 里 DB_* 配置正确，MySQL 数据库 steam_tool 已存在。
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // Steam proxy TLS

const path     = require('path');
const SqliteDB = require('better-sqlite3');
const db       = require('./db');                  // MySQL async db
const { steamRefreshSession, fetchTradeUrlFromCookie, parseMaFile } = require('./fetchers');

const SQLITE_PATH  = path.join(__dirname, 'steam_tool.db');
const CONCURRENCY  = 3;   // 并发刷新交易链接

// ─── 颜色辅助 ─────────────────────────────────────────────────────────────────
const c = {
    ok:   (s) => `\x1b[32m${s}\x1b[0m`,
    warn: (s) => `\x1b[33m${s}\x1b[0m`,
    err:  (s) => `\x1b[31m${s}\x1b[0m`,
    dim:  (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(c.ok(`  ✅ ${msg}`)); }
function warn(msg) { console.log(c.warn(`  ⚠️  ${msg}`)); }
function err(msg)  { console.log(c.err(`  ❌ ${msg}`)); }
function head(msg) { console.log(`\n${c.bold(msg)}`); console.log('  ' + '─'.repeat(60)); }

// ─── Part 1: SQLite → MySQL 迁移 ─────────────────────────────────────────────

async function migrate() {
    head('PART 1 — SQLite → MySQL 全量迁移');

    let sqlite;
    try {
        sqlite = new SqliteDB(SQLITE_PATH, { readonly: true });
        log(`SQLite 路径: ${SQLITE_PATH}`);
    } catch (e) {
        err(`无法打开 SQLite: ${e.message}`);
        process.exit(1);
    }

    // 初始化 MySQL 表结构
    log('正在初始化 MySQL 表结构 (CREATE TABLE IF NOT EXISTS)...');
    await db.initSchema();
    ok('MySQL 表结构就绪');

    const pool = db.getPool();

    // ── account_groups ────────────────────────────────────────────────────────
    head('迁移 account_groups');
    const groups = sqlite.prepare('SELECT * FROM account_groups').all();
    log(`共 ${groups.length} 条`);
    for (const g of groups) {
        await pool.execute(
            `INSERT INTO account_groups (id,name,color,sort_order,created_at)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE name=VALUES(name),color=VALUES(color),sort_order=VALUES(sort_order)`,
            [g.id, g.name, g.color || '#667eea', g.sort_order || 0, g.created_at || new Date().toISOString()]
        );
    }
    // 同步 AUTO_INCREMENT
    if (groups.length > 0) {
        const maxId = Math.max(...groups.map(g => g.id));
        await pool.execute(`ALTER TABLE account_groups AUTO_INCREMENT = ${maxId + 1}`);
    }
    ok(`account_groups: ${groups.length} 条已迁移`);

    // ── c5_merchants ──────────────────────────────────────────────────────────
    head('迁移 c5_merchants');
    const merchants = sqlite.prepare('SELECT * FROM c5_merchants').all();
    log(`共 ${merchants.length} 条`);
    for (const m of merchants) {
        await pool.execute(
            `INSERT INTO c5_merchants (id,name,app_key,is_default,created_at)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE name=VALUES(name),app_key=VALUES(app_key),is_default=VALUES(is_default)`,
            [m.id, m.name, m.app_key, m.is_default || 0, m.created_at || new Date().toISOString()]
        );
    }
    if (merchants.length > 0) {
        const maxId = Math.max(...merchants.map(m => m.id));
        await pool.execute(`ALTER TABLE c5_merchants AUTO_INCREMENT = ${maxId + 1}`);
    }
    ok(`c5_merchants: ${merchants.length} 条已迁移`);

    // ── accounts ──────────────────────────────────────────────────────────────
    head('迁移 accounts');
    const accounts = sqlite.prepare('SELECT * FROM accounts').all();
    log(`共 ${accounts.length} 条`);
    let accOk = 0, accSkip = 0;
    for (const a of accounts) {
        try {
            await pool.execute(
                `INSERT INTO accounts
                    (id,name,profile,browser_type,profile_path,browser_path,steam_id64,
                     balance,inventory_value,last_sync,steam_cookie,trade_url,persona_name,
                     mafile_content,auto_confirm,c5_merchant_id,group_id)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                     name=VALUES(name),balance=VALUES(balance),inventory_value=VALUES(inventory_value),
                     last_sync=VALUES(last_sync),steam_cookie=VALUES(steam_cookie),
                     trade_url=VALUES(trade_url),persona_name=VALUES(persona_name),
                     mafile_content=VALUES(mafile_content),auto_confirm=VALUES(auto_confirm),
                     c5_merchant_id=VALUES(c5_merchant_id),group_id=VALUES(group_id)`,
                [a.id, a.name, a.profile, a.browser_type, a.profile_path, a.browser_path,
                 a.steam_id64, a.balance, a.inventory_value, a.last_sync, a.steam_cookie,
                 a.trade_url, a.persona_name, a.mafile_content, a.auto_confirm || 0,
                 a.c5_merchant_id, a.group_id]
            );
            accOk++;
        } catch (e) {
            warn(`账号 ${a.name || a.id} 迁移失败: ${e.message}`);
            accSkip++;
        }
    }
    ok(`accounts: ${accOk} 成功, ${accSkip} 失败`);

    // ── tracked_items ─────────────────────────────────────────────────────────
    head('迁移 tracked_items');
    const items = sqlite.prepare('SELECT * FROM tracked_items').all();
    log(`共 ${items.length} 条`);
    let itemOk = 0;
    for (const t of items) {
        await pool.execute(
            `INSERT INTO tracked_items
                (hash_name,name,image,steam_price_cny,steam_price_usd,last_cn_price,
                 last_updated,next_update,interval_minutes,min_alert,max_alert,
                 min_ratio_alert,max_ratio_alert,exclude_from_ranking)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
                 name=VALUES(name),steam_price_cny=VALUES(steam_price_cny),
                 steam_price_usd=VALUES(steam_price_usd),last_cn_price=VALUES(last_cn_price),
                 last_updated=VALUES(last_updated),next_update=VALUES(next_update)`,
            [t.hash_name,t.name,t.image,t.steam_price_cny,t.steam_price_usd,t.last_cn_price,
             t.last_updated,t.next_update,t.interval_minutes||30,t.min_alert,t.max_alert,
             t.min_ratio_alert,t.max_ratio_alert,t.exclude_from_ranking||0]
        );
        itemOk++;
    }
    ok(`tracked_items: ${itemOk} 条已迁移`);

    // ── settings ──────────────────────────────────────────────────────────────
    head('迁移 settings');
    const settings = sqlite.prepare('SELECT * FROM settings').all();
    log(`共 ${settings.length} 条`);
    for (const s of settings) {
        await pool.execute(
            'INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
            [s.key, s.value]
        );
    }
    ok(`settings: ${settings.length} 条已迁移`);

    // ── bought_history ────────────────────────────────────────────────────────
    head('迁移 bought_history');
    const history = sqlite.prepare('SELECT * FROM bought_history').all();
    log(`共 ${history.length} 条`);
    for (const h of history) {
        await pool.execute(
            'INSERT INTO bought_history (category,bought_at) VALUES (?,?) ON DUPLICATE KEY UPDATE bought_at=VALUES(bought_at)',
            [h.category, h.bought_at]
        );
    }
    ok(`bought_history: ${history.length} 条已迁移`);

    // ── stale_listings ────────────────────────────────────────────────────────
    head('迁移 stale_listings');
    const stale = sqlite.prepare('SELECT * FROM stale_listings').all();
    log(`共 ${stale.length} 条`);
    for (const s of stale) {
        await pool.execute(
            'INSERT INTO stale_listings (listing_id,recorded_at) VALUES (?,?) ON DUPLICATE KEY UPDATE recorded_at=VALUES(recorded_at)',
            [s.listing_id, s.recorded_at]
        );
    }
    ok(`stale_listings: ${stale.length} 条已迁移`);

    // ── item_nameid_cache ─────────────────────────────────────────────────────
    head('迁移 item_nameid_cache');
    const nameids = sqlite.prepare('SELECT * FROM item_nameid_cache').all();
    log(`共 ${nameids.length} 条`);
    for (const n of nameids) {
        await pool.execute(
            'INSERT INTO item_nameid_cache (hash_name,name_id) VALUES (?,?) ON DUPLICATE KEY UPDATE name_id=VALUES(name_id)',
            [n.hash_name, n.name_id]
        );
    }
    ok(`item_nameid_cache: ${nameids.length} 条已迁移`);

    // ── inventory_cache ───────────────────────────────────────────────────────
    head('迁移 inventory_cache');
    const invCache = sqlite.prepare('SELECT * FROM inventory_cache').all();
    log(`共 ${invCache.length} 条`);
    for (const ic of invCache) {
        await pool.execute(
            'INSERT INTO inventory_cache (group_id,data,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
            [ic.group_id, ic.data, ic.updated_at]
        );
    }
    ok(`inventory_cache: ${invCache.length} 条已迁移`);

    sqlite.close();
    head('PART 1 迁移完成 🎉');
}

// ─── Part 2: 刷新分组2的交易链接 ──────────────────────────────────────────────

async function refreshGroup2TradeUrls() {
    head('PART 2 — 刷新「分组2」所有账号的交易链接');

    // 找 分组2（先按名字查，再按 id=2 兜底）
    const allAccounts = await db.readAccounts();
    const allGroups   = await db.readGroups();

    // 查找名为"分组2"的分组，兜底找 id=2
    const targetGroup = allGroups.find(g => g.name === '分组2') || allGroups.find(g => g.id === 2);
    if (!targetGroup) {
        warn('未找到「分组2」，跳过交易链接刷新');
        return;
    }
    log(`目标分组: 「${targetGroup.name}」(id=${targetGroup.id})`);

    const targets = allAccounts.filter(a => String(a.groupId) === String(targetGroup.id));
    if (targets.length === 0) {
        warn('分组2 内没有账号');
        return;
    }

    log(`共 ${targets.length} 个账号，并发度 ${CONCURRENCY}`);
    log('');

    const results = { ok: 0, fail: 0 };
    const queue   = [...targets];

    // Worker pool: 并发 3
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        (async () => {
            while (queue.length > 0) {
                const acc = queue.shift();
                if (!acc) continue;

                const tag = `[${acc.name || acc.steamId64}]`;
                try {
                    // Step 1: 获取 refreshToken
                    let refreshToken = null;
                    if (acc.mafileContent) {
                        try {
                            const parsed = parseMaFile(acc.mafileContent);
                            refreshToken = parsed.refreshToken;
                        } catch (e) {
                            warn(`${tag} maFile 解析失败: ${e.message}`);
                        }
                    }

                    if (!refreshToken) {
                        warn(`${tag} 没有 refreshToken，跳过`);
                        results.fail++;
                        continue;
                    }

                    // Step 2: 刷新 Session
                    log(`${tag} 正在刷新 Session...`);
                    const fakeAcc = {
                        name:                 acc.name || acc.steamId64,
                        steamId64:            acc.steamId64,
                        refreshToken,
                        existingAccessToken:  null,
                    };
                    const freshSession = await steamRefreshSession(fakeAcc);

                    // Step 3: 获取交易链接
                    log(`${tag} 正在获取交易链接...`);
                    const tradeUrl = await fetchTradeUrlFromCookie(freshSession, acc.steamId64);

                    // Step 4: 更新 MySQL
                    await db.updateAccountTradeUrl(acc.id, tradeUrl);
                    ok(`${tag} ${tradeUrl}`);
                    results.ok++;

                } catch (e) {
                    err(`${tag} 失败: ${e.message}`);
                    results.fail++;
                }
            }
        })()
    );

    await Promise.all(workers);

    log('');
    head(`PART 2 完成 — 成功: ${results.ok}, 失败: ${results.fail}`);
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────

(async () => {
    console.log(c.bold('\n════════════════════════════════════════════════════'));
    console.log(c.bold('  Steam Tool — SQLite → MySQL 迁移 + 交易链接刷新'));
    console.log(c.bold('════════════════════════════════════════════════════\n'));

    try {
        await migrate();
        await refreshGroup2TradeUrls();
    } catch (e) {
        err(`脚本异常: ${e.stack || e.message}`);
        process.exit(1);
    } finally {
        await db.close();
        console.log(c.dim('\n  连接池已关闭，退出。'));
        process.exit(0);
    }
})();
