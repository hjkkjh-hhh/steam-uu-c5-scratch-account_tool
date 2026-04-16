/**
 * register_steam_auth.js (纯净加速版)
 * 
 * 使用说明：
 * 1. 请在您的电脑上开启 Steam 加速器 (如 UU 加速器、Watt Toolkit 等)。
 * 2. 确保在浏览器中能顺畅打开 steamcommunity.com。
 * 3. 运行此脚本：node server/scripts/register_steam_auth.js
 */

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const readline = require('readline');
const { getDb, upsertAccount } = require('../db');
const fs = require('fs');
const path = require('path');

// 允许跳过部分 SSL 校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ☢️ “因果律”级拦截：重写底层的连接方法，强行修正所有连接参数
const originalConnect = SteamUser.prototype._connect;
SteamUser.prototype._connect = function(server) {
    if (server && server.endpoint) {
        // 强制把所有非 443 的端口改为 443，且尽量使用物理 IP
        if (!server.endpoint.includes(':443')) {
            const host = server.endpoint.split(':')[0];
            server.endpoint = host + ':443';
        }
    }
    // 强制注入 Socks5 代理设置 (通常现代 Clash 端口同时支持 HTTP 和 Socks5)
    this.httpProxy = null;
    this.socksProxy = 'socks5://127.0.0.1:7897';
    return originalConnect.apply(this, arguments);
};

const client = new SteamUser({
    protocol: SteamUser.EConnectionProtocol.WebSocket
});

// 开启基本调试
client.on('debug', (msg) => {
    if (msg.includes('Connecting to')) {
        console.log(`[Steam 调试] 正在强制通过 443 隧道建立物理连接: ${msg.split(' ').pop()}`);
    } else {
        console.log(`[Steam 调试] ${msg}`);
    }
});


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// ⏱️ 设置 45 秒超时
const timeoutTimer = setTimeout(() => {
    console.log('\n⌛ 登录超时。请确认您是否开启了 Steam 加速器 (UU/Watt Toolkit 等)。');
    process.exit(1);
}, 45000);

async function start() {
    console.log('\n--- 🛠️ Steam 手机令牌注册/导入工具 (加速器兼容版) ---');
    
    const username = await question('请输入 Steam 账号名: ');
    const password = await question('请输入 Steam 密码: ');

    console.log('\n正在通过系统加速器尝试登录...');

    client.logOn({
        accountName: username,
        password: password
    });

    client.on('loggedOn', async (details) => {
        clearTimeout(timeoutTimer);
        console.log('✅ 登录成功！SteamID: ' + client.steamID.getSteamID64());
        
        const mode = await question('\n请选择操作:\n1. 绑定新手机令牌\n2. 导入现有 maFile\n请输入 (1/2): ');
        if (mode === '1') setupNewMobileAuth();
        else if (mode === '2') importExistingMaFile();
        else process.exit(0);
    });

    client.on('error', (err) => {
        clearTimeout(timeoutTimer);
        console.error('❌ 登录失败: ' + err.message);
        process.exit(1);
    });

    client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
        const code = await question(`请输入发送到您的邮箱 (${domain}) 的 5 位验证码: `);
        callback(code);
    });
}

/**
 * 场景1: 绑定新令牌
 */
async function setupNewMobileAuth() {
    client.enableTwoFactor((err, response) => {
        if (err) {
            console.error('❌ 绑定失败:', err.message);
            process.exit(1);
            return;
        }
        console.log('\n🔐 您的恢复代码 (Recovery Code) 为: ' + response.revocation_code);
        console.log('请务必保存！短信已发送，请输入：');
        promptSmsAndFinalize(response);
    });
}

async function promptSmsAndFinalize(authData) {
    const smsCode = await question('请输入短信验证码: ');
    client.finalizeTwoFactor(authData.shared_secret, smsCode, (err) => {
        if (err) {
            console.error('❌ 验证失败:', err.message);
            process.exit(1);
            return;
        }
        console.log('🎊 恭喜！手机令牌绑定完成。');
        saveToDb(authData);
    });
}

/**
 * 场景2: 导入现有 maFile
 */
async function importExistingMaFile() {
    console.log('\n请粘贴您的 .maFile 完整内容:');
    const input = await question('内容: ');
    try {
        const jsonData = JSON.parse(input);
        saveToDb(jsonData);
    } catch (e) {
        console.error('❌ 解析失败: ' + e.message);
        process.exit(1);
    }
}

function saveToDb(data) {
    const steamId = client.steamID.getSteamID64();
    const acc = {
        id: steamId,
        name: client.accountName,
        steamId64: steamId,
        mafile_content: JSON.stringify(data),
        auto_confirm: 1
    };
    upsertAccount(acc);
    console.log('\n💾 令牌数据已加密存储到项目数据库中。');
    process.exit(0);
}

start();
