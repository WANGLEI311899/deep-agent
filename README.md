# deepCodex

基于 DeepSeek 的 AI 智能体：支持技能（Skill）、沙箱写文件、HITL 确认、多会话 Web UI。  
可本机运行，也可部署到公网，让别人通过一个网址使用（需访问口令）。

**仓库地址：** https://github.com/WANGLEI311899/deep-codex

## 环境要求

- Node.js 20+
- DeepSeek API Key

## 快速开始（本机）

```bash
# 安装依赖
npm install

# 配置环境变量（复制模板后填入自己的 Key，切勿提交 .env）
cp .env.example .env
# 编辑 .env：至少填写 DEEPSEEK_API_KEY
# 可选：TAVILY_API_KEY（仅 demo:search / demo:multi 需要）

# 启动 Web UI（推荐）
npm run ui
# 浏览器打开 http://localhost:5173
```

> **安全提示**：`.env` 已在 `.gitignore` 中忽略，请只把密钥写在本地 `.env`，不要写进源码或提交到 Git。

## 在线部署（给别人一个网址）

部署后，别人打开平台给你的 `https://xxx` 链接，输入你设置的 **访问口令** 即可使用。  
费用走你的 `DEEPSEEK_API_KEY`，请务必设置强口令并限制分享范围。

### 必填环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek Key |
| `ACCESS_TOKEN` | 访问口令（随机长字符串） |
| `PUBLIC_MODE` | 设为 `true`（锁定输出目录、强制口令） |

可选：`DEEPSEEK_MODEL`、`RATE_LIMIT_PER_MIN`（默认 30）、`PORT`、`HOST=0.0.0.0`。

### 方式一：Railway（推荐，步骤少）

1. 打开 [Railway](https://railway.app) → New Project → Deploy from GitHub  
2. 选择仓库 `WANGLEI311899/deep-codex`（或你的 fork）  
3. 构建方式会读根目录 `Dockerfile` / `railway.toml`  
4. 在 Variables 中添加：

   ```
   DEEPSEEK_API_KEY=sk-你的密钥
   ACCESS_TOKEN=请换成足够长的随机口令
   PUBLIC_MODE=true
   ```

5. 部署完成后打开生成的域名，例如 `https://deep-codex-production-xxxx.up.railway.app`  
6. 把 **网址 + 访问口令** 发给朋友即可  

健康检查路径：`/api/health`。

### 方式二：Render

1. [Render](https://render.com) → New → Blueprint，连接本仓库（含 `render.yaml`）  
2. 在 Dashboard 填入 `DEEPSEEK_API_KEY`；`ACCESS_TOKEN` 可自动生成  
3. 部署成功后使用 Render 提供的 URL  

### 方式三：本机 Docker

```bash
docker build -t deep-codex .
docker run --rm -p 5173:5173 \
  -e DEEPSEEK_API_KEY=sk-你的密钥 \
  -e ACCESS_TOKEN=你的访问口令 \
  -e PUBLIC_MODE=true \
  deep-codex
```

浏览器打开 `http://localhost:5173`，输入 `ACCESS_TOKEN`。

### 分享给别人时怎么说

> 打开：`https://你的部署域名`  
> 访问口令：`你设置的 ACCESS_TOKEN`  
> （请勿外传口令；对话会消耗我的 API 额度）

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run ui` | 构建并启动 Web 工作台（开发） |
| `npm start` | 生产启动（需先 `npm run build`） |
| `npm run dev` | 终端交互模式 |
| `npm run demo:basic` | Skill 基础演示 |
| `npm run demo:search` | 搜索 + 写文件演示（需 Tavily） |
| `npm run demo:multi` | 多阶段协作演示 |
| `npm run build` | 仅构建到 `dist/` |
| `npm run typecheck` | TypeScript 类型检查 |

## Web UI 能力

- 流式对话与多会话历史（重启后恢复）
- 工具调用时间线（技能扫描 / LLM / 写文件 / HITL）
- 写文件与高风险操作的 HITL 弹窗确认
- 自定义本机输出目录（任意绝对路径，可增删改切换）

## 目录结构

```
src/
  agent.ts           # 智能体核心
  server.ts           # Web / SSE / HITL API
  sessions.ts         # 多会话 + 持久化
  workspace-store.ts  # 本地输出目录配置
  sandbox.ts          # 文件沙箱
  hitl.ts             # 人工确认
  skill-loader.ts     # Skill 加载
  tools/              # 搜索等工具
web/public/           # 前端静态页面
.deepcodex/
  skills/             # *.skill.md 技能文件
  workspaces.json     # 输出目录配置（本地，gitignore）
  sessions.json       # 会话历史（本地，gitignore）
```

## 写文件约定

模型使用如下代码块时会触发沙箱写入（需 HITL 批准）：

````markdown
```filename:notes.md
内容...
```
````

文件会写入**当前激活的输出目录**。

## 配置说明

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | — | 必填 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `DEEPSEEK_TEMPERATURE` | `0.7` | 温度 |
| `DEEPSEEK_MAX_HISTORY` | `20` | 模型上下文消息条数上限 |
| `PORT` | `5173` | Web 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `TAVILY_API_KEY` | — | 搜索 Demo 可选 |
| `ACCESS_TOKEN` | — | 访问口令；设置后网页需登录 |
| `PUBLIC_MODE` | `false` | `true` 时强制口令 + 锁定输出目录 |
| `RATE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟对话次数上限 |

## 安全提示

- **本机开发**：可不设 `ACCESS_TOKEN`，仅本机访问。
- **公网部署**：必须 `PUBLIC_MODE=true` + 强 `ACCESS_TOKEN`；口令只告诉信任的人。
- 公网模式下禁止配置任意本机路径，文件只写入服务器默认 `output` 目录。
- 仍有人能用你的 DeepSeek 额度：注意限流、定期更换口令，额度异常时立刻轮换 API Key。
- API Key 只写在本地 `.env` 或云平台密钥面板，**不要**写进源码或提交到 Git。
- 会话记录、工作区路径、证书与日志均已忽略，不会进入仓库。
