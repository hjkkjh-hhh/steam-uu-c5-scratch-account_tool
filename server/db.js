'use strict';
/**
 * db.js — MySQL database layer (mysql2/promise)
 *
 * Config via .env (or environment variables):
 *   DB_HOST   (default: 127.0.0.1)
 *   DB_PORT   (default: 3306)
 *   DB_USER   (default: root)
 *   DB_PASS   (default: '')
 *   DB_NAME   (default: steam_tool)
 *
 * All exported functions are ASYNC — callers must use await.
 */
const mysql = require('mysql2/promise');
const path  = require('path');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let _pool = null;

function getPool() {
    if (!_pool) {
        _pool = mysql.createPool({
            host:              process.env.DB_HOST     || '127.0.0.1',
            port:       parseInt(process.env.DB_PORT   || '3306'),
            user:              process.env.DB_USER     || 'root',
            password:          process.env.DB_PASS     || '',
            database:          process.env.DB_NAME     || 'steam_tool',
            waitForConnections: true,
            connectionLimit:    10,
            charset:           'utf8mb4',
            timezone:          '+08:00',
        });
    }
    return _pool;
}

// ─── Schema init (run once on startup) ─────────────────────────────────────
async function initSchema() {
    const pool = getPool();
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS tracked_items (
            hash_name            VARCHAR(255) PRIMARY KEY,
            name                 TEXT,
            image                TEXT,
            steam_price_cny      VARCHAR(50),
            steam_price_usd      VARCHAR(50),
            last_cn_price        VARCHAR(50),
            last_updated         VARCHAR(50),
            next_update          VARCHAR(50),
            interval_minutes     INT          DEFAULT 30,
            min_alert            VARCHAR(50),
            max_alert            VARCHAR(50),
            min_ratio_alert      VARCHAR(50),
            max_ratio_alert      VARCHAR(50),
            exclude_from_ranking TINYINT      DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            \`key\`  VARCHAR(100) PRIMARY KEY,
            value    TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS account_groups (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(255) NOT NULL UNIQUE,
            color      VARCHAR(20)  DEFAULT '#667eea',
            sort_order INT          DEFAULT 0,
            created_at DATETIME     DEFAULT NOW()
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS accounts (
            id              VARCHAR(50)  PRIMARY KEY,
            name            VARCHAR(255),
            profile         VARCHAR(50),
            browser_type    VARCHAR(50),
            profile_path    TEXT,
            browser_path    TEXT,
            steam_id64      VARCHAR(25),
            balance         VARCHAR(50),
            inventory_value VARCHAR(50),
            last_sync       VARCHAR(50),
            steam_cookie    MEDIUMTEXT,
            trade_url       TEXT,
            mafile_content  MEDIUMTEXT,
            auto_confirm    TINYINT      DEFAULT 0,
            persona_name    VARCHAR(255),
            c5_merchant_id  INT,
            group_id        INT,
            ban_status      VARCHAR(20)  DEFAULT NULL,
            account_password VARCHAR(255) DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // 迁移升级：ban_status 列
    try {
        await pool.execute(`ALTER TABLE accounts ADD COLUMN ban_status VARCHAR(20) DEFAULT NULL`);
        console.log('[DB] 已添加 ban_status 列');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) throw e;
    }

    // 迁移升级：account_password 列
    try {
        await pool.execute(`ALTER TABLE accounts ADD COLUMN account_password VARCHAR(255) DEFAULT NULL`);
        console.log('[DB] 已添加 account_password 列');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) throw e;
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS bought_history (
            category  VARCHAR(255) PRIMARY KEY,
            bought_at VARCHAR(50)  NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS stale_listings (
            listing_id  VARCHAR(50) PRIMARY KEY,
            recorded_at BIGINT      NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS item_nameid_cache (
            hash_name VARCHAR(255) PRIMARY KEY,
            name_id   VARCHAR(50)  NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS c5_merchants (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(255) NOT NULL,
            app_key    TEXT         NOT NULL,
            is_default TINYINT      DEFAULT 0,
            session_cookie TEXT,
            phone      VARCHAR(50)  DEFAULT NULL,
            area_code  VARCHAR(10)  DEFAULT '86',
            created_at DATETIME     DEFAULT NOW()
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    try {
        await pool.execute(`ALTER TABLE c5_merchants ADD COLUMN phone VARCHAR(50) DEFAULT NULL`);
        await pool.execute(`ALTER TABLE c5_merchants ADD COLUMN area_code VARCHAR(10) DEFAULT '86'`);
        console.log('[DB] 已向 c5_merchants 添加 phone 和 area_code 列');
    } catch (e) {
        if (!e.message.includes('Duplicate column')) throw e;
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS inventory_cache (
            group_id   VARCHAR(50) PRIMARY KEY,
            data       MEDIUMTEXT,
            updated_at VARCHAR(50)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Migrate old c5gameApiKey into c5_merchants if table is empty
    const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) as cnt FROM c5_merchants');
    if (cnt === 0) {
        const [[oldRow]] = await pool.execute("SELECT value FROM settings WHERE `key` = 'c5gameApiKey'");
        if (oldRow?.value?.trim()) {
            await pool.execute(
                'INSERT INTO c5_merchants (name, app_key, is_default) VALUES (?, ?, 1)',
                ['默认商户', oldRow.value]
            );
            console.log('[DB] 自动迁移: 已将旧版 c5gameApiKey 迁移至 c5_merchants 表');
        }
    }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function rowToItem(row) {
    if (!row) return null;
    return {
        hashName:           row.hash_name,
        name:               row.name || row.hash_name,
        image:              row.image || null,
        steamPrices:        buildSteamPrices(row.steam_price_cny, row.steam_price_usd),
        lastC5Price:        row.last_cn_price || 'N/A',
        lastUpdated:        row.last_updated || null,
        nextUpdate:         row.next_update || null,
        interval:           row.interval_minutes || 30,
        minAlert:           row.min_alert || null,
        maxAlert:           row.max_alert || null,
        minRatioAlert:      row.min_ratio_alert || null,
        maxRatioAlert:      row.max_ratio_alert || null,
        excludeFromRanking: !!row.exclude_from_ranking,
    };
}

function buildSteamPrices(cny, usd) {
    const prices = {};
    if (cny) prices.CNY = cny;
    if (usd) prices.USD = usd;
    return prices;
}

function rowToAccount(row) {
    if (!row) return null;
    return {
        id:              row.id,
        name:            row.name,
        profile:         row.profile,
        browserType:     row.browser_type,
        profilePath:     row.profile_path,
        browserPath:     row.browser_path,
        steamId64:       row.steam_id64,
        balance:         row.balance,
        inventoryValue:  row.inventory_value,
        lastSync:        row.last_sync,
        steamCookie:     row.steam_cookie,
        tradeUrl:        row.trade_url    || null,
        personaName:     row.persona_name || null,
        mafileContent:   row.mafile_content || null,
        autoConfirm:     !!row.auto_confirm,
        c5MerchantId:    row.c5_merchant_id || null,
        groupId:         row.group_id || null,
        banStatus:       row.ban_status || null,
        accountPassword: row.account_password || null,
    };
}

function rowToMerchant(row) {
    if (!row) return null;
    return {
        id:        row.id,
        name:      row.name,
        appKey:    row.app_key,
        isDefault: !!row.is_default,
        sessionCookie: row.session_cookie || null,
        phone:         row.phone || null,
        areaCode:      row.area_code || '86',
        createdAt: row.created_at,
    };
}

function parseSettingsRow(key, value) {
    const numericKeys = ['pushRankingInterval','pushRankingCashThreshold','pushRankingTopUpThreshold','autoBuyRatio','clashApiPort'];
    const boolKeys    = ['showCashOut','showTopUp','pushRankingEnabled','pushTopUpEnabled','showTrackedTopUp','autoBuyEnabled','clashAutoRotate'];
    const jsonKeys    = ['activeCurrencies'];
    if (value === null || value === undefined) return null;
    if (jsonKeys.includes(key))    { try { return JSON.parse(value); } catch { return []; } }
    if (numericKeys.includes(key)) return parseFloat(value) || 0;
    if (boolKeys.includes(key))    return value === '1' || value === 'true';
    return value;
}

const SETTINGS_DEFAULTS = {
    activeCurrencies:           JSON.stringify(['CNY']),
    showCashOut:                '1',
    showTopUp:                  '1',
    dingTalkWebhook:            '',
    dingTalkSecret:             '',
    adminPassword:              '',
    steamCookie:                '',
    pushRankingEnabled:         '0',
    pushTopUpEnabled:           '0',
    pushRankingInterval:        '1200000',
    pushRankingCashThreshold:   '0.82',
    pushRankingTopUpThreshold:  '0.6',
    rankingMinPrice:            '',
    rankingMaxPrice:            '',
    showTrackedTopUp:           '1',
    autoBuyEnabled:             '1',
    autoBuyRatio:               '0.85',
    c5gameApiKey:               '',
    c5gameAppSecret:            '',
    clashAutoRotate:            '0',
    clashPipeName:              'xfltd-mihomo',
    clashSecret:                '',
    clashGroup:                 'SteamBuy',
    clashProxyPort:             '',
    clashApiPort:               '3057',
    c5SessionCookie:            '',
};

// ─── Tracked Items ─────────────────────────────────────────────────────────────

async function readTracked() {
    const [rows] = await getPool().execute('SELECT * FROM tracked_items');
    return rows.map(rowToItem);
}

async function writeTracked(items) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM tracked_items');
        for (const item of items) {
            const r = itemToRow(item);
            await conn.execute(`
                INSERT INTO tracked_items
                    (hash_name,name,image,steam_price_cny,steam_price_usd,last_cn_price,
                     last_updated,next_update,interval_minutes,min_alert,max_alert,
                     min_ratio_alert,max_ratio_alert,exclude_from_ranking)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE
                    name=VALUES(name),image=VALUES(image),steam_price_cny=VALUES(steam_price_cny),
                    steam_price_usd=VALUES(steam_price_usd),last_cn_price=VALUES(last_cn_price),
                    last_updated=VALUES(last_updated),next_update=VALUES(next_update),
                    interval_minutes=VALUES(interval_minutes),min_alert=VALUES(min_alert),
                    max_alert=VALUES(max_alert),min_ratio_alert=VALUES(min_ratio_alert),
                    max_ratio_alert=VALUES(max_ratio_alert),exclude_from_ranking=VALUES(exclude_from_ranking)`,
                [r.hash_name,r.name,r.image,r.steam_price_cny,r.steam_price_usd,r.last_cn_price,
                 r.last_updated,r.next_update,r.interval_minutes,r.min_alert,r.max_alert,
                 r.min_ratio_alert,r.max_ratio_alert,r.exclude_from_ranking]);
        }
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

function itemToRow(item) {
    const prices = item.steamPrices || {};
    return {
        hash_name:           item.hashName,
        name:                item.name || item.hashName,
        image:               item.image || null,
        steam_price_cny:     prices.CNY || null,
        steam_price_usd:     prices.USD || null,
        last_cn_price:       item.lastC5Price || null,
        last_updated:        item.lastUpdated || null,
        next_update:         item.nextUpdate || null,
        interval_minutes:    item.interval || 30,
        min_alert:           item.minAlert || null,
        max_alert:           item.maxAlert || null,
        min_ratio_alert:     item.minRatioAlert || null,
        max_ratio_alert:     item.maxRatioAlert || null,
        exclude_from_ranking: item.excludeFromRanking ? 1 : 0,
    };
}

async function upsertTrackedItem(item) {
    const r = itemToRow(item);
    await getPool().execute(`
        INSERT INTO tracked_items
            (hash_name,name,image,steam_price_cny,steam_price_usd,last_cn_price,
             last_updated,next_update,interval_minutes,min_alert,max_alert,
             min_ratio_alert,max_ratio_alert,exclude_from_ranking)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
            name=VALUES(name),image=VALUES(image),steam_price_cny=VALUES(steam_price_cny),
            steam_price_usd=VALUES(steam_price_usd),last_cn_price=VALUES(last_cn_price),
            last_updated=VALUES(last_updated),next_update=VALUES(next_update),
            interval_minutes=VALUES(interval_minutes),min_alert=VALUES(min_alert),
            max_alert=VALUES(max_alert),min_ratio_alert=VALUES(min_ratio_alert),
            max_ratio_alert=VALUES(max_ratio_alert),exclude_from_ranking=VALUES(exclude_from_ranking)`,
        [r.hash_name,r.name,r.image,r.steam_price_cny,r.steam_price_usd,r.last_cn_price,
         r.last_updated,r.next_update,r.interval_minutes,r.min_alert,r.max_alert,
         r.min_ratio_alert,r.max_ratio_alert,r.exclude_from_ranking]);
}

async function deleteTrackedItem(hashName) {
    await getPool().execute('DELETE FROM tracked_items WHERE hash_name = ?', [hashName]);
}

// ─── Settings ──────────────────────────────────────────────────────────────────

async function readSettings() {
    const [rows] = await getPool().execute('SELECT `key`, value FROM settings');
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    const result = {};
    const allKeys = new Set([...Object.keys(SETTINGS_DEFAULTS), ...Object.keys(map)]);
    for (const key of allKeys) {
        const raw = map[key] !== undefined ? map[key] : SETTINGS_DEFAULTS[key];
        result[key] = parseSettingsRow(key, raw);
    }
    return result;
}

async function writeSettings(settings) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const [key, value] of Object.entries(settings)) {
            let stored = value;
            if (Array.isArray(value) || (value && typeof value === 'object')) stored = JSON.stringify(value);
            else if (typeof value === 'boolean') stored = value ? '1' : '0';
            else if (value === null || value === undefined) stored = '';
            else stored = String(value);
            await conn.execute(
                'INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
                [key, stored]);
        }
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

async function getSetting(key) {
    const [[row]] = await getPool().execute('SELECT value FROM settings WHERE `key` = ?', [key]);
    return parseSettingsRow(key, row ? row.value : (SETTINGS_DEFAULTS[key] ?? null));
}

async function setSetting(key, value) {
    let stored = value;
    if (Array.isArray(value) || (value && typeof value === 'object')) stored = JSON.stringify(value);
    else if (typeof value === 'boolean') stored = value ? '1' : '0';
    else if (value === null || value === undefined) stored = '';
    else stored = String(value);
    await getPool().execute(
        'INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
        [key, stored]);
}

// ─── Accounts ──────────────────────────────────────────────────────────────────

async function readAccounts() {
    const [rows] = await getPool().execute('SELECT * FROM accounts ORDER BY name ASC');
    return rows.map(rowToAccount);
}

async function writeAccounts(accounts) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM accounts');
        for (const a of accounts) await _upsertAccountConn(conn, a);
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

async function _upsertAccountConn(conn, acc) {
    await conn.execute(`
        INSERT INTO accounts
            (id,name,profile,browser_type,profile_path,browser_path,steam_id64,
             balance,inventory_value,last_sync,steam_cookie,trade_url,persona_name,
             mafile_content,auto_confirm,c5_merchant_id,group_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
            name=VALUES(name),profile=VALUES(profile),browser_type=VALUES(browser_type),
            profile_path=VALUES(profile_path),browser_path=VALUES(browser_path),
            steam_id64=VALUES(steam_id64),balance=VALUES(balance),
            inventory_value=VALUES(inventory_value),last_sync=VALUES(last_sync),
            steam_cookie=VALUES(steam_cookie),trade_url=VALUES(trade_url),
            persona_name=VALUES(persona_name),mafile_content=VALUES(mafile_content),
            auto_confirm=VALUES(auto_confirm),c5_merchant_id=VALUES(c5_merchant_id),
            group_id=VALUES(group_id)`,
        [acc.id, acc.name||null, acc.profile||null, acc.browserType||null,
         acc.profilePath||null, acc.browserPath||null, acc.steamId64||null,
         acc.balance||null, acc.inventoryValue||null, acc.lastSync||null,
         acc.steamCookie||null, acc.tradeUrl||null, acc.personaName||null,
         acc.mafileContent||null, acc.autoConfirm?1:0, acc.c5MerchantId||null,
         acc.groupId||null]);
}

async function upsertAccount(acc) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try { await _upsertAccountConn(conn, acc); }
    finally { conn.release(); }
}

async function updateAccountTradeUrl(id, tradeUrl) {
    await getPool().execute('UPDATE accounts SET trade_url = ? WHERE id = ?', [tradeUrl || null, id]);
}

async function updateAccountPersonaName(id, personaName) {
    await getPool().execute('UPDATE accounts SET persona_name = ? WHERE id = ?', [personaName || null, id]);
}

async function deleteAccount(id) {
    await getPool().execute('DELETE FROM accounts WHERE id = ?', [id]);
}

async function assignAccountGroup(accountId, groupId) {
    await getPool().execute('UPDATE accounts SET group_id = ? WHERE id = ?', [groupId || null, accountId]);
}

async function updateAccountBanStatus(accountId, banStatus) {
    await getPool().execute('UPDATE accounts SET ban_status = ? WHERE id = ?', [banStatus || null, accountId]);
}

async function updateAccountPassword(accountId, password) {
    await getPool().execute('UPDATE accounts SET account_password = ? WHERE id = ?', [password || null, accountId]);
}

// ─── Account Groups ────────────────────────────────────────────────────────────

async function readGroups() {
    const pool = getPool();
    const [groups] = await pool.execute('SELECT * FROM account_groups ORDER BY sort_order ASC, id ASC');
    return Promise.all(groups.map(async (g) => {
        const [[{ c }]] = await pool.execute('SELECT COUNT(*) as c FROM accounts WHERE group_id = ?', [g.id]);
        return { id: g.id, name: g.name, color: g.color || '#667eea', sortOrder: g.sort_order || 0, createdAt: g.created_at, count: c };
    }));
}

async function upsertGroup(group) {
    const pool = getPool();
    if (group.id) {
        await pool.execute('UPDATE account_groups SET name=?,color=?,sort_order=? WHERE id=?',
            [group.name, group.color || '#667eea', group.sortOrder || 0, group.id]);
        return group.id;
    } else {
        const [result] = await pool.execute('INSERT INTO account_groups (name,color,sort_order) VALUES (?,?,?)',
            [group.name, group.color || '#667eea', group.sortOrder || 0]);
        return result.insertId;
    }
}

async function deleteGroup(id) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('UPDATE accounts SET group_id = NULL WHERE group_id = ?', [id]);
        await conn.execute('DELETE FROM account_groups WHERE id = ?', [id]);
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

// ─── C5 Merchants ──────────────────────────────────────────────────────────────

async function readMerchants() {
    const [rows] = await getPool().execute('SELECT * FROM c5_merchants ORDER BY id ASC');
    return rows.map(rowToMerchant);
}

async function upsertMerchant(m) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (m.isDefault) await conn.execute('UPDATE c5_merchants SET is_default = 0');
        if (m.id) {
            await conn.execute('UPDATE c5_merchants SET name=?,app_key=?,is_default=?,session_cookie=?,phone=?,area_code=? WHERE id=?',
                [m.name, m.appKey, m.isDefault ? 1 : 0, m.sessionCookie || null, m.phone || null, m.areaCode || '86', m.id]);
        } else {
            await conn.execute('INSERT INTO c5_merchants (name,app_key,is_default,session_cookie,phone,area_code) VALUES (?,?,?,?,?,?)',
                [m.name, m.appKey, m.isDefault ? 1 : 0, m.sessionCookie || null, m.phone || null, m.areaCode || '86']);
        }
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

async function deleteMerchant(id) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('UPDATE accounts SET c5_merchant_id = NULL WHERE c5_merchant_id = ?', [id]);
        await conn.execute('DELETE FROM c5_merchants WHERE id = ?', [id]);
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally     { conn.release(); }
}

async function getMerchantById(id) {
    const [[row]] = await getPool().execute('SELECT * FROM c5_merchants WHERE id = ?', [id]);
    return rowToMerchant(row);
}

async function getDefaultMerchant() {
    const pool = getPool();
    let [[row]] = await pool.execute('SELECT * FROM c5_merchants WHERE is_default = 1');
    if (!row) { [[row]] = await pool.execute('SELECT * FROM c5_merchants ORDER BY id ASC LIMIT 1'); }
    return rowToMerchant(row);
}

// ─── Bought History ────────────────────────────────────────────────────────────

async function getBoughtHistory() {
    const [rows] = await getPool().execute('SELECT category, bought_at FROM bought_history');
    const map = {};
    for (const r of rows) map[r.category] = r.bought_at;
    return map;
}

async function setBoughtHistoryEntry(category, timestamp) {
    await getPool().execute(
        'INSERT INTO bought_history (category,bought_at) VALUES (?,?) ON DUPLICATE KEY UPDATE bought_at=VALUES(bought_at)',
        [category, timestamp || new Date().toISOString()]);
}

async function deleteBoughtHistoryEntry(category) {
    await getPool().execute('DELETE FROM bought_history WHERE category = ?', [category]);
}

async function clearBoughtHistory() {
    await getPool().execute('DELETE FROM bought_history');
}

// ─── Stale Listings ────────────────────────────────────────────────────────────

async function getStaleListings() {
    const [rows] = await getPool().execute('SELECT listing_id, recorded_at FROM stale_listings');
    const map = {};
    for (const r of rows) map[r.listing_id] = { timestamp: r.recorded_at };
    return map;
}

async function markListingAsStale(listingId) {
    if (!listingId) return;
    await getPool().execute(
        'INSERT INTO stale_listings (listing_id,recorded_at) VALUES (?,?) ON DUPLICATE KEY UPDATE recorded_at=VALUES(recorded_at)',
        [String(listingId), Date.now()]);
}

async function cleanStaleListings(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const [result] = await getPool().execute('DELETE FROM stale_listings WHERE recorded_at < ?', [cutoff]);
    return result.affectedRows;
}

async function getStaleListing(listingId) {
    const [[row]] = await getPool().execute('SELECT * FROM stale_listings WHERE listing_id = ?', [String(listingId)]);
    return row || null;
}

async function getAllStaleListingIds() {
    const [rows] = await getPool().execute('SELECT listing_id FROM stale_listings');
    return rows.map(r => r.listing_id);
}

// ─── Item NameId Cache ─────────────────────────────────────────────────────────

async function getItemNameId(hashName) {
    const [[row]] = await getPool().execute('SELECT name_id FROM item_nameid_cache WHERE hash_name = ?', [hashName]);
    return row ? row.name_id : null;
}

async function setItemNameId(hashName, nameId) {
    await getPool().execute(
        'INSERT INTO item_nameid_cache (hash_name,name_id) VALUES (?,?) ON DUPLICATE KEY UPDATE name_id=VALUES(name_id)',
        [hashName, String(nameId)]);
}

async function getAllNameIds() {
    const [rows] = await getPool().execute('SELECT hash_name, name_id FROM item_nameid_cache');
    const map = {};
    for (const r of rows) map[r.hash_name] = r.name_id;
    return map;
}

// ─── Inventory Cache ───────────────────────────────────────────────────────────

async function readInventoryCache(groupId) {
    const gid = String(groupId || 'all');
    const [[row]] = await getPool().execute('SELECT data, updated_at FROM inventory_cache WHERE group_id = ?', [gid]);
    if (!row) return null;
    try { return { items: JSON.parse(row.data), updatedAt: row.updated_at }; }
    catch { return null; }
}

async function writeInventoryCache(groupId, items) {
    const gid  = String(groupId || 'all');
    const data = JSON.stringify(items);
    const now  = new Date().toISOString();
    await getPool().execute(
        'INSERT INTO inventory_cache (group_id,data,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)',
        [gid, data, now]);
}

// ─── Close pool ────────────────────────────────────────────────────────────────

async function close() {
    if (_pool) { await _pool.end(); _pool = null; }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    initSchema,
    getPool,

    // Tracked items
    readTracked,
    writeTracked,
    upsertTrackedItem,
    deleteTrackedItem,

    // Settings
    readSettings,
    writeSettings,
    getSetting,
    setSetting,

    // Accounts
    readAccounts,
    writeAccounts,
    upsertAccount,
    deleteAccount,
    updateAccountTradeUrl,
    updateAccountPersonaName,
    updateAccountBanStatus,
    updateAccountPassword,
    assignAccountGroup,

    // Account Groups
    readGroups,
    upsertGroup,
    deleteGroup,

    // C5 Merchants
    readMerchants,
    upsertMerchant,
    deleteMerchant,
    getMerchantById,
    getDefaultMerchant,

    // Bought history
    getBoughtHistory,
    setBoughtHistoryEntry,
    deleteBoughtHistoryEntry,
    clearBoughtHistory,

    // Stale listings
    getStaleListings,
    markListingAsStale,
    cleanStaleListings,
    getStaleListing,
    getAllStaleListingIds,

    // NameId cache
    getItemNameId,
    setItemNameId,
    getAllNameIds,

    // Inventory Cache
    readInventoryCache,
    writeInventoryCache,

    close,
};
