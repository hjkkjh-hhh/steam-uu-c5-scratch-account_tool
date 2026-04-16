# Steam 多账号管理工具

> 一套面向 CS2 / Steam 市场交易的**全栈自动化管理系统**，支持多账号批量导入、库存同步、Steam 市场挂刀、C5Game 平台对接、价格追踪与钉钉告警等核心功能。数据库层基于 MySQL，通过 Webshare 住宅代理池实现并发请求，完全规避 IP 封禁风险。

---

## 目录

- [功能概览](#功能概览)
- [技术架构](#技术架构)
- [目录结构](#目录结构)
- [核心模块详解](#核心模块详解)
- [API 路由一览](#api-路由一览)
- [数据库设计](#数据库设计)
- [代理策略](#代理策略)
- [并发模型](#并发模型)
- [Steam 认证流程](#steam-认证流程)
- [部署与运行](#部署与运行)
- [环境变量](#环境变量)

---

## 功能概览

| 模块 | 功能 |
|:---|:---|
| **账号管理** | 批量导入 `.maFile`、Steam Guard TOTP 生成、会话刷新、交易链接自动获取 |
| **库存同步** | 并发拉取全部账号库存，计算总市值，支持分组筛选与全自动缓存 |
| **市场自动化** | 批量下架/修改，查询挂单，**高精度 Histogram 价格采集**，自动过滤失效挂单 |
| **全自动转库** | **一键全流程转移库存**: 自动发起报价 → A端令牌确认 → B端自动接受 → B端令牌确认 |
| **令牌并发确认** | **并发确认 (Concurrency=10)**，支持 **密码重登自愈逻辑**，自动处理 429 限频 |
| **C5Game 对接** | 绑定商户 API Key，批量上架/改价/下架，C5 库存代理，**自动买入 (Python 增强)** |
| **智能价格监控** | 指定饰品实时价格追踪，设置多维度告警，推送 **现金榜/余额榜** 到钉钉 |
| **钉钉交互** | Webhook + HMAC 签名，支持 Markdown，支持库存联动提醒，直接回复指令操作 |
| **异常检测** | 基于 Puppeteer 的自动化 "红字" 扫描与账号状态分流处理 |
| **代理与安全** | **Webshare 住宅旋转代理池**，每请求换 IP，全局 429 冷静期保护 |

---

## 技术架构

```
┌──────────────────── 浏览器 (客户端) ────────────────────┐
│                                                          │
│   React 19 + Vite 8                                      │
│   单文件 SPA (App.jsx) — Vanilla CSS                     │
│   axios → REST API (http://localhost:3001)               │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────── 服务端 (Node.js) ───────────────────┐
│                                                          │
│   Express 5   ──  路由层 (index.js)                      │
│       │                                                  │
│       ├── db.js          MySQL 数据访问层(mysql2/promise) │
│       ├── fetchers.js    Steam / C5 业务逻辑层            │
│       └── Puppeteer      浏览器自动化 (headless Edge)     │
│                                                          │
│   代理出口: Webshare 住宅旋转代理 (https-proxy-agent)     │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
         MySQL 9.5                 Steam / C5Game
         (steam_tool)              外部 API
```

### 前端

| 技术 | 版本 | 用途 |
|:---|:---|:---|
| React | 19 | UI 框架 |
| Vite | 8 | 构建工具 / 开发服务器 |
| Vanilla CSS | — | 样式，无 UI 框架依赖 |
| axios | 1.x | HTTP 客户端 |

前端为**单页应用**，所有状态在 `App.jsx` 中通过 `useState` / `useEffect` 管理，无路由库，通过 Tab 切换页面。

### 后端

| 技术 | 版本 | 用途 |
|:---|:---|:---|
| Node.js | 22 | 运行时 |
| Express | 5 | HTTP 服务器 |
| mysql2/promise | 3.x | MySQL 连接池（异步） |
| dotenv | 17 | 环境变量注入 |
| steam-session | 1.9 | Steam 登录会话管理（`LoginSession`） |
| steam-totp | 2.1 | Steam Guard 动态验证码生成 |
| steam-user | 5.3 | Steam 网络层（`GenerateAccessTokenForApp`） |
| steamcommunity | 3.50 | Steam 社区操作（交易链接获取） |
| puppeteer-core | 24 | 浏览器自动化（Edge） |
| axios | 1.x | 服务端 HTTP 请求（代理转发） |
| https-proxy-agent | 9 | HTTPS 代理注入 |
| socks-proxy-agent | 10 | SOCKS5 代理支持 |

---

## 目录结构

```
steam_scratch/
├── .env                        # 数据库连接配置（不上传 Git）
├── .env.example                # 配置模板
├── package.json                # 服务端依赖
├── START_TOOL.bat              # 一键启动脚本
├── START_TOOL.ps1              # PowerShell 启动脚本
├── server_watchdog.bat         # 服务守护脚本（异常重启）
├── natapp.exe                  # 内网穿透工具（可选）
│
├── client/                     # 前端 (React + Vite)
│   ├── src/
│   │   ├── App.jsx             # 主应用（全部页面逻辑）
│   │   └── index.css           # 全局样式
│   ├── index.html
│   └── package.json            # 前端依赖
│
└── server/                     # 后端 (Node.js)
    ├── index.js                # Express 入口，全部 API 路由（~5300 行）
    ├── db.js                   # MySQL 数据访问层（全异步）
    ├── fetchers.js             # Steam / C5Game 业务函数库（~1900 行）
    ├── migrate_to_mysql.js     # SQLite → MySQL 迁移工具（幂等）
    ├── refresh_tradeurl_group1.js  # 分组交易链接批量刷新工具
    ├── profiles/               # 浏览器 Profile 目录（每账号独立）
    ├── logs/                   # 运行日志
    └── inventories/            # 库存快照缓存
```

---

## 核心模块详解

### `server/index.js` — 路由层

Express 5 应用入口，承载全部 REST API（65+ 条路由）。关键设计：

- **SSE 流式响应**：`/api/accounts/import-batch` 使用 Server-Sent Events 实时推送每个账号的导入进度，前端无需轮询。
- **并发 Worker Pool**：批量导入和库存同步均采用 3-并发 Worker 模式（见[并发模型](#并发模型)）。
- **中间件鉴权**：除登录接口外，所有请求通过密码（bcrypt hash）验证。

### `server/fetchers.js` — 业务逻辑层

包含所有与外部服务交互的核心函数：

#### Steam 认证链路

```
parseMaFile(content)
  ↓ 解析 .maFile 获取 refreshToken / shared_secret
steamRefreshSession(acc)
  ↓ 通过 steam-user.GenerateAccessTokenForApp 获取 AccessToken
  ↓ 注入 steam-session LoginSession → 构造 steamLoginSecure Cookie
fetchTradeUrlFromCookie(session, steamId64)
  ↓ 三级降级策略:
    1. steamcommunity 库（主）
    2. Steam API /IEconService/GetTradeOfferAccessToken/v1（备）
    3. HTML 页面爬取（兜底）
```

#### C5Game 集成

- `c5GetInventory()` — 拉取 C5 在售库存
- `c5ListItem()` — 上架饰品
- `c5ModifyPrice()` — 批量改价
- `c5Delist()` — 下架
- `fetchC5SteamInfo()` — 获取 C5 账号绑定的 Steam 信息

#### 价格与市场
- `fetchSteamPriceRobust()` — 鲁棒性 Steam 价格抓取，支持多账号轮询与自动重试
- `fetchSteamItemPrice()` — **高精度 Histogram 采集**，自动解析 `ItemNameID`
- `fetchCheapestListing()` — 挂单级精确分析，自动对齐到手价与手续费
- `fetchMarketListings()` — 账号市场挂单列表
- `removeListing()` / `batchRemoveListings()` — 下架处理
- `executeSteamBuy()` — **自动购买执行**（支持 Python/Conda 环境增强调用）

#### 交易与确认
- `transferInventory()` — **全自动三步转库**: 发起 → A端确认 → B端接受 → B端接收确认
- `confirmTradesBatch()` — **高并发令牌确认**: 支持 10 路并行，内置密码重登刷新 Token 逻辑

### `server/db.js` — 数据访问层

基于 `mysql2/promise` 连接池（`connectionLimit: 10`）。**所有函数均为 async**，调用方统一使用 `await`。

核心设计原则：
- **幂等写入**：所有 INSERT 均使用 `ON DUPLICATE KEY UPDATE`，安全重试。
- **连接池事务**：批量写操作（`writeTracked`, `writeAccounts`, `deleteGroup` 等）通过 `conn.beginTransaction() / commit() / rollback()` 保证原子性。
- **零 DDL 硬编码**：`initSchema()` 在每次服务启动时被调用，通过 `CREATE TABLE IF NOT EXISTS` 实现幂等建表，无需手动执行 SQL 文件。

---

## API 路由一览

### 认证

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `POST` | `/api/auth/login` | 密码登录，返回 token |

### 价格追踪

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/prices` | 获取所有追踪饰品当前价格 |
| `GET` | `/api/tracked` | 获取追踪列表 |
| `POST` | `/api/tracked` | 添加/更新追踪项 |
| `POST` | `/api/tracked/batch` | 批量添加 |
| `DELETE` | `/api/tracked` | 删除追踪项 |
| `POST` | `/api/tracked/alert` | 设置价格告警阈值 |
| `GET` | `/api/search-series` | 模糊搜索饰品系列 |

### 账号管理

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/accounts` | 获取全部账号 |
| `POST` | `/api/accounts` | 新增账号 |
| `DELETE` | `/api/accounts/:id` | 删除账号 |
| `POST` | `/api/accounts/import-batch` | SSE 批量导入 maFile（并发 3） |
| `POST` | `/api/accounts/sync` | 同步单账号库存 + 余额 |
| `GET` | `/api/accounts/:id/totp` | 生成当前 TOTP 验证码 |
| `POST` | `/api/accounts/:id/refresh-token` | 刷新 Steam 会话 |
| `PUT` | `/api/accounts/:id/trade-url` | 手动设置交易链接 |
| `POST` | `/api/accounts/:id/fetch-trade-url` | 自动获取交易链接 |
| `POST` | `/api/accounts/batch-fetch-trade-urls` | 批量获取全部账号交易链接 |
| `POST` | `/api/accounts/sync-personas` | 同步账号 Steam 昵称 |
| `POST` | `/api/accounts/scan-red-letters` | Puppeteer 扫描账号异常状态 |

### 分组

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/groups` | 获取所有分组（含账号数） |
| `POST` | `/api/groups` | 创建 / 更新分组 |
| `DELETE` | `/api/groups/:id` | 删除分组（账号自动解绑） |
| `PUT` | `/api/accounts/:id/group` | 分配账号到分组 |

### 库存

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/accounts/inventory/:id` | 获取单账号库存 |
| `GET` | `/api/inventory/total` | 获取分组库存聚合 + 总市值 |
| `GET` | `/api/inventory/summary` | 库存摘要 |
| `GET` | `/api/inventory/cache` | 读取库存缓存 |
| `POST` | `/api/inventory/cache` | 写入库存缓存 |
| `GET` | `/api/steam/inventory/:steamId` | 直接拉取 Steam 库存 |

### Steam 市场

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/accounts/market-listings` | 获取账号挂单列表 |
| `POST` | `/api/accounts/remove-listing` | 下架单个挂单 |
| `POST` | `/api/accounts/batch-remove-listings` | 批量下架 |
| `GET` | `/api/market-price` | 查询 Steam 市场价格 |
| `POST` | `/api/accounts/:id/sell-item` | 上架饰品到 Steam 市场 |
| `POST` | `/api/accounts/:id/batch-sell` | 批量上架 |

### C5Game

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/api/c5/balance` | 查询 C5 余额 |
| `GET` | `/api/c5/inventory/:steamId` | C5 在售库存 |
| `GET` | `/api/c5/listings/:steamId` | C5 挂单列表 |
| `POST` | `/api/c5/list-item` | 上架到 C5 |
| `PUT` | `/api/c5/modify-price` | 修改 C5 价格 |
| `PUT` | `/api/c5/delist` | C5 下架 |
| `POST` | `/api/c5/buy` | C5 购买 |
| `GET` | `/api/c5/search` | C5 饰品搜索 |
| `POST` | `/api/c5/batch-bind` | 批量绑定 C5 商户 |
| `GET/POST/DELETE` | `/api/c5/merchants` | 商户管理 CRUD |

### 设置 / 通知

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET/POST` | `/api/settings` | 读写全局配置 |
| `POST` | `/api/dingtalk` | 手动发送钉钉消息 |
| `GET` | `/api/test-dingtalk` | 测试钉钉 Webhook |

---

## 数据库设计

数据库：`steam_tool`（MySQL 9.5，`utf8mb4_unicode_ci`）

### 表结构

```sql
-- 账号分组
account_groups (id, name, color, sort_order, created_at)

-- Steam 账号
accounts (
  id, name, steam_id64, steam_cookie, trade_url,
  mafile_content, auto_confirm, persona_name,
  balance, inventory_value, last_sync,
  c5_merchant_id, group_id,
  profile, browser_type, profile_path, browser_path
)

-- C5Game 商户
c5_merchants (id, name, app_key, is_default, created_at)

-- 价格追踪列表
tracked_items (
  hash_name, name, image,
  steam_price_cny, steam_price_usd, last_cn_price,
  last_updated, next_update, interval_minutes,
  min_alert, max_alert, min_ratio_alert, max_ratio_alert,
  exclude_from_ranking
)

-- 全局设置（Key-Value）
settings (key, value)

-- 自动买入历史
bought_history (category, bought_at)

-- 失效挂单缓存
stale_listings (listing_id, recorded_at)

-- 饰品 NameID 缓存（加速市场查询）
item_nameid_cache (hash_name, name_id)

-- 库存聚合缓存（按分组）
inventory_cache (group_id, data, updated_at)
```

### 连接配置（`.env`）

```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=your_password
DB_NAME=steam_tool
```

---

## 代理策略

所有 Steam / C5Game 相关的对外 HTTP 请求均通过 **Webshare 住宅旋转代理**发出：

```
https://proxy.webshare.io/api/v2/proxy/list/
  → 每次请求随机取一个出口 IP
  → 代理格式: http://user:pass@host:port
  → 注入方式: axios httpsAgent = new HttpsProxyAgent(proxyUrl)
```

相比 Clash 代理节点方案，住宅代理池的优势：
- **无需本地代理软件**，服务端直接指定出口 IP
- **每请求换 IP**，天然规避 Steam 频率限制
- 支持并发 3 路请求同时使用不同 IP，互不干扰

---

## 并发模型

批量操作统一采用 **Worker Pool 模式**（并发度 = 3）：

```javascript
const CONCURRENCY = 3;
const queue = [...items];
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
    (async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) await processItem(item);
        }
    })()
);
await Promise.all(workers);
```

| 操作 | 并发度 | 位置 |
|:---|:---:|:---|
| 批量导入 maFile | 3 | `server/index.js` → `/api/accounts/import-batch` |
| 批量同步库存 | 3 | `client/src/App.jsx` → `syncAllAccounts()` |
| 批量刷新交易链接 | 3 | `server/refresh_tradeurl_group1.js` |

> **为何选 3**：Steam 对单 IP 的并发限制约为 3~5 个并发请求。配合住宅代理每请求换 IP，3 并发既能最大化吞吐，又不触发频率限制。

---

## Steam 认证流程

`.maFile` 是手机版 Steam 令牌文件（JSON 格式），包含：
- `shared_secret` — 用于 TOTP 验证码生成
- `identity_secret` — 用于交易确认
- `refresh_token` — 用于无密码 Session 刷新

### Session 刷新流程

```
1. parseMaFile()
     │ 提取 refresh_token、shared_secret、account_name
     ▼
2. steam-user.GenerateAccessTokenForApp()
     │ 通过 Webshare 代理连接 Steam CM 服务器
     │ 传入 refresh_token → 获取新 access_token
     ▼
3. steam-session LoginSession (EAuthTokenPlatformType.MobileApp)
     │ setAccessToken(access_token)
     │ 调用 getWebCookies()
     ▼
4. 构造 steamLoginSecure Cookie
     │ 格式: {steamId64}||{accessToken}  (URL编码后为 %7C%7C)
     ▼
5. 存入 MySQL accounts.steam_cookie
```

### 交易链接获取（三级降级）

```
尝试 steamcommunity 库
  └─ 成功 → 返回
  └─ 失败 ↓
尝试 Steam API /IEconService/GetTradeOfferAccessToken/v1
  └─ 成功 → 返回
  └─ 失败 ↓
HTML 爬取 steamcommunity.com/my/tradeoffers/privacy
  └─ 正则提取 token 参数
```

---

## 部署与运行

### 前置要求

- Node.js ≥ 22
- MySQL ≥ 8（推荐 9.5）
- 已配置 Webshare 代理（在 `server/fetchers.js` 中填入凭据）

### 安装

```bash
# 安装服务端依赖
npm install

# 安装客户端依赖
cd client && npm install && cd ..
```

### 配置

```bash
# 复制配置模板
cp .env.example .env

# 编辑 .env，填入 MySQL 连接信息
```

### 启动

```bash
# 开发模式（前后端独立启动）
node server/index.js          # 后端: http://localhost:3001
cd client && npm run dev      # 前端: http://localhost:5173

# 或使用一键启动脚本 (Windows)
START_TOOL.bat
```

首次启动时，`db.initSchema()` 会自动在 MySQL 中创建全部 9 张表，无需手动执行任何 SQL。

### 数据库迁移（从旧版 SQLite 迁移）

```bash
node server/migrate_to_mysql.js
```

脚本幂等，可安全重复执行（全部使用 `ON DUPLICATE KEY UPDATE`）。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `DB_HOST` | `127.0.0.1` | MySQL 主机 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `root` | MySQL 用户名 |
| `DB_PASS` | — | MySQL 密码 |
| `DB_NAME` | `steam_tool` | 数据库名 |
| `PORT` | `3001` | 服务端监听端口 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | 代理 TLS 兼容（开发环境） |

---

## 注意事项

1. **`.maFile` 文件含私钥**，勿上传 Git（已在 `.gitignore` 排除）
2. **`steam_cookie` 字段**存储明文 Cookie，数据库需做好访问控制
3. 旧版 `steam_tool.db`（SQLite）迁移完成后已删除，历史数据已完整转移至 MySQL
4. `NODE_TLS_REJECT_UNAUTHORIZED=0` 仅用于兼容部分代理的 TLS 握手，生产环境建议配置正确的证书链

---

*最后更新: 2026-04-10*
