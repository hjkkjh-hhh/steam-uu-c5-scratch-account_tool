# Steam 多账号管理与自动化工具

> 一套面向开发者和专业用户的 **Steam & C5Game 资产管理全栈系统**。支持高频库存同步、市场自动化挂单、跨账号全自动转库以及令牌并发确认。

---

[English Version](./README.md) | **中文版本**

---

## 🌟 核心功能

- **多账号安全管理**: 通过 `.maFile` (2FA/TOTP) 批量导入账号。支持 Session 自动刷新 (LoginSecure)，所有操作均受管理员密码保护。
- **全自动库存转移**: “一键转库”逻辑。自动发起报价 → 调用发送方令牌确认 → 自动接受报价 → 调用接收方令牌最终确认。
- **大规模并发令牌确认**: 支持高达 10 线程并行确认。内置 **“密码重登自愈”** 逻辑，当令牌失效时自动通过密码重新登录获取新 Session。
- **智能市场行情**: 使用 Steam Histogram (ItemNameID) 获取精确到手价。集成 C5Game API，实时同步 USD/CNY 汇率。
- **自动买入引擎**: 基于规则的 Steam 市场与 C5Game 采购编排。支持通过钉钉推送“现金榜/余额榜”告警，并联动 Python 脚本执行高级买入策略。
- **工业级基础架构**:
  - **MySQL 8.0+**: 持久化存储，支持幂等数据库迁移。
  - **Webshare 住宅代理**: 智能路由（Steam/C5 分流）+ 每请求动态换 IP，完美规避 429 频率限制。
  - **浏览器自动化**: 集成 Puppeteer 自动扫描“红字”及账号异常状态。

---

## 🛠️ 技术栈

- **前端**: React 19 + Vite 8 (原生 CSS，无沉重 UI 框架)
- **后端**: Node.js 22 (Express 5, MySQL2/Promise)
- **安全**: Steam-Session (LoginSession), Steam-TOTP, bcrypt
- **自动化**: Axios (集成 HTTPS 代理注入), Puppeteer-Core (Edge/Chrome)

---

## 🚀 快速开始 (开发者)

### 1. 前置要求

- **Node.js**: 22.x 或更高版本
- **MySQL**: 8.0 或 9.5 (推荐)
- **代理服务**: 建议准备 **Webshare** (旋转住宅代理) 账号，用于稳定访问 Steam API。
- **Python**: (可选) 3.10+ 用于运行 `steam_buy.py` 增强逻辑。

### 2. 安装

克隆仓库并安装后端与前端依赖：

```bash
# 安装服务端依赖
npm install

# 安装客户端依赖
cd client
npm install
cd ..
```

### 3. 配置

#### a. 环境变量
将 `.env.example` 复制为 `.env` 并配置您的 MySQL 连接信息：

```bash
cp .env.example .env
```

#### b. 应用设置
将 `server/settings.example.json` 复制为 `server/settings.json` 并配置 API 密钥、钉钉 Webhook 及代理信息：

```bash
cp server/settings.example.json server/settings.json
```

**关键配置项：**
- `adminPassword`: 用于访问 Web 界面和 API 的管理密码 (Bearer Auth)。
- `webshare`: 用于穿透 Steam 频率限制的住宅代理凭据。
- `youpinAuth`: 用于增强型饰品模糊搜索的令牌。

### 4. 运行

**Windows 一键启动：**
直接运行目录下的 `START_TOOL.ps1` (PowerShell)。它将自动启动：
- 后端服务 (端口 3001)
- 前端开发服务器 (端口 5173 - 自动打开浏览器)
- 守护进程 (崩溃自动重启)

**手动启动：**
```bash
# 后端
node server/index.js

# 前端
cd client
npm run dev
```

---

## 📁 目录结构

```text
├── client/                 # React 前端代码
├── server/                 # Express 后端代码
│   ├── index.js            # 主路由控制器 (65+ 接口)
│   ├── db.js               # MySQL 数据库交互层
│   ├── fetchers.js         # Steam/C5 核心业务逻辑
│   ├── python/             # Python 自动化脚本
│   └── scripts/            # CLI 工具 (迁移、认证等)
├── START_TOOL.ps1          # 启动脚本
└── .gitignore              # 已预设多账号隐私保护规则
```

---

## 🔒 安全与隐私

本项目处理敏感的 Steam 凭据。
- **maFiles**: 请存放在本地。它们已被 `.gitignore` 排除，**绝不会**离开您的本地机器。
- **数据库**: 所有的账号 Session (steam_cookie) 和密码都存储在您的本地 MySQL 中。
- **脱敏**: 源代码中已清除所有硬编码的私有密钥。请始终使用 `settings.json` 存储您的私有令牌。

---

## ⚠️ 常见问题

1. **数据库初始化**: 首次启动时，程序会自动在 MySQL 中建表。请确保 `.env` 中的用户具有 `CREATE` 权限。
2. **Steam 429 (频率限制)**: 如果请求失败，请检查 Webshare 代理配置。Steam 对数据中心 IP 的封锁非常严格。
3. **浏览器路径**: 如果自动化扫描失败，请在数据库或 UI 中将 `acc.browserPath` 修改为您本地 Edge/Chrome 的实际路径。

---

## 📄 开源协议
MIT License. **仅供学习与安全研究使用。** 使用自动化脚本需严格遵守 Steam 订户协议。

---
*最后更新: 2026-04-16*
