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
| `npm run rag:status` | 查看当前工作区知识库状态 |
| `npm run rag:index` | 强制重建当前工作区知识库索引 |
| `npm run rag:evaluate` | 运行 RAG 回归评测并生成 JSON/Markdown 报告 |
| `npm run build` | 仅构建到 `dist/` |
| `npm run typecheck` | TypeScript 类型检查 |

## Web UI 能力

- 流式对话与多会话历史（重启后恢复）
- 工具调用时间线（技能扫描 / LLM / 写文件 / HITL）
- 写文件与高风险操作的 HITL 弹窗确认
- 自定义本机输出目录（任意绝对路径，可增删改切换）
- 单图上传、拖拽或粘贴截图，执行中英文 OCR 后结合文字指令识别意图
- 可选 LlamaIndex 工作区知识库检索（自动更新索引并引用来源）

## 图片、PDF 与视觉理解

输入框支持图片和 PDF。默认依次尝试 OpenAI、Ollama、本地 OCR/PDF；OpenAI 发生额度或限流错误后会临时熔断，避免每次请求重复等待失败。文字型 PDF 使用本地文本层，扫描页会渲染后交给 Ollama 或 OCR。

```env
VISION_API_KEY=你的视觉服务密钥
VISION_BASE_URL=https://api.openai.com/v1
VISION_MODEL=gpt-4.1-mini

# 无额度时的本地兜底
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_VISION_MODEL=qwen3-vl:8b
OLLAMA_EMBEDDING_MODEL=embeddinggemma
OLLAMA_VISION_TIMEOUT_MS=300000
```

原始文件只在本次请求的内存中存在，会话仅保存可编辑的解析文本、文件名和模型信息。因此可以在后续轮次继续追问解析结果，同时避免原件长期落盘。

## 图片 OCR

输入框支持上传、拖拽或粘贴一张图片。OCR 完成后会显示可编辑的识别结果，确认无误再发送给
Agent；只上传图片时，Agent 会尝试理解图片文字，意图不明确时先询问用户。

- 支持 JPG/JPEG、PNG、WebP
- 每次最多 1 张，单张不超过 10 MB、默认不超过 2,500 万像素
- 原图只在内存中参与识别，不写入工作区；会话仅保存文件名和确认后的 OCR 文字
- 使用本地 Tesseract.js，默认识别简体中文和英文；语言数据随依赖安装，首次初始化可能稍慢
- 图片中的高风险文字仍会经过现有 HITL 确认

## 工作区知识库（LlamaIndex RAG）

RAG 模块只负责文档切分、向量索引和检索，原有 DeepSeek Agent、Skill、HITL 和会话机制保持不变。
索引缓存在 `.deepcodex/rag/`，文档或分块配置变化后会自动重建。

先在 `.env` 配置一个 OpenAI-compatible embedding 服务。开启 Ollama 后，OpenAI 不可用会自动切换本地模型并安全重建索引：

```env
RAG_ENABLED=true
RAG_EMBEDDING_API_KEY=你的-embedding-key
RAG_EMBEDDING_BASE_URL=https://api.openai.com/v1
RAG_EMBEDDING_MODEL=text-embedding-3-small
OLLAMA_ENABLED=true
OLLAMA_EMBEDDING_MODEL=embeddinggemma

# 可选：允许索引过程调用视觉模型解析 PDF。默认关闭，防止意外费用。
RAG_MULTIMODAL_ENABLED=true
```

DeepSeek 当前聊天 Key 不作为 embedding Key 使用。配置完成后可以：

```bash
# 检查配置并构建索引
npm run rag:status
npm run rag:index

# 启动 UI 后使用明确的知识库指令
# 示例：根据工作区资料，生产环境应该怎样部署？
npm run ui
```

当前内置读取器面向文本和代码文件，包括 Markdown、TXT、JSON、CSV、HTML、JavaScript、
TypeScript、Vue、Python、Java、Go、Rust、SQL、YAML、TOML 和 XML。超大文件、符号链接、
`node_modules`、`.git`、`dist` 等目录默认跳过。
默认最多索引 2,000 个文件、单文件 2 MB、总计 50 MB，避免误选大型目录后产生不可控的
embedding 费用；可通过 `.env` 中的 `RAG_MAX_*` 参数调整。索引内容会发送给你配置的
embedding 服务，包含敏感资料的工作区应先确认服务方的数据处理政策。

### RAG 质量评测

复制示例评测集后，按实际文档维护问题与预期来源：

```bash
copy .deepcodex\rag-eval.example.json .deepcodex\rag-eval.json
npm run rag:evaluate
```

评测默认计算 Hit Rate、MRR、Precision@K 和 Recall@K，不产生额外生成费用。报告写入
`.deepcodex/rag-evaluations/`。若配置 `RAG_EVAL_LLM_ENABLED=true`，还会使用 DeepSeek
生成带来源回答，并评估关键词覆盖、回答相关性、忠实度和引用质量。

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
  rag/                # LlamaIndex 索引、embedding 与 RAG 评测
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
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 模型名；复杂推理可使用 `deepseek-v4-pro` |
| `DEEPSEEK_TEMPERATURE` | `0.7` | 温度 |
| `DEEPSEEK_MAX_HISTORY` | `20` | 模型上下文消息条数上限 |
| `PORT` | `5173` | Web 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `TAVILY_API_KEY` | — | 搜索 Demo 可选 |
| `ACCESS_TOKEN` | — | 访问口令；设置后网页需登录 |
| `PUBLIC_MODE` | `false` | `true` 时强制口令 + 锁定输出目录 |
| `RATE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟对话次数上限 |
| `ACCESS_TOKENS` | 空 | 多用户口令 JSON，例如 `{"alice":"token-a"}`；会话与输出目录按用户隔离 |
| `AGENT_REQUEST_TIMEOUT_MS` | `120000` | 单轮 Agent 请求总超时；断连时也会取消 |
| `AGENT_TOOL_TIMEOUT_MS` | `15000` | 单个工具默认超时 |
| `AGENT_MAX_TOOLS_PER_TURN` | `3` | 单轮最多自动匹配工具数 |
| `OCR_LANGUAGES` | `eng+chi_sim` | Tesseract OCR 语言组合 |
| `OCR_LANG_PATH` | 空 | 可选的自建/离线 Tesseract 语言数据目录 |
| `OCR_MAX_IMAGE_PIXELS` | `25000000` | 单图最大总像素数 |
| `OCR_MAX_TEXT_CHARS` | `20000` | OCR 结果进入聊天上下文的最大字符数 |
| `VISION_API_KEY` | 空 | 视觉/PDF模型密钥；留空时图片退回本地 OCR |
| `VISION_BASE_URL` | OpenAI | 支持 Responses 图片/文件输入的 API 地址 |
| `VISION_MODEL` | `gpt-4.1-mini` | OpenAI 图片与 PDF 解析模型 |
| `OLLAMA_ENABLED` | `false` | 启用本地视觉与 Embedding 兜底 |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama OpenAI-compatible 地址 |
| `OLLAMA_VISION_MODEL` | `qwen3-vl:8b` | 本地视觉模型 |
| `OLLAMA_EMBEDDING_MODEL` | `embeddinggemma` | 本地向量模型 |
| `PDF_MAX_OCR_PAGES` | `20` | 扫描 PDF 单次最多解析页数 |
| `RAG_ENABLED` | `false` | 是否启用工作区 LlamaIndex RAG |
| `RAG_MULTIMODAL_ENABLED` | `false` | 是否允许 RAG 调用视觉模型索引 PDF |
| `RAG_EMBEDDING_API_KEY` | 空 | 独立的 embedding 服务密钥 |
| `RAG_EMBEDDING_BASE_URL` | OpenAI | OpenAI-compatible embedding 地址 |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 模型名 |
| `RAG_TOP_K` | `5` | 每次检索返回的最大片段数 |
| `RAG_CHUNK_SIZE` | `700` | LlamaIndex 文档分块 token 数 |
| `RAG_CHUNK_OVERLAP` | `100` | 相邻分块重叠 token 数 |
| `RAG_EVAL_LLM_ENABLED` | `false` | 是否启用生成回答与 LLM 质量评分 |
| `LOG_LEVEL` | `info` | Pino 结构化日志等级 |
| `APP_VERSION` | `package version` | 日志中的部署版本号 |
| `SENTRY_DSN` | 空 | Sentry DSN；留空时完全禁用 |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Sentry 环境名称 |
| `SENTRY_RELEASE` | 空 | Sentry 发布版本 |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Sentry 性能追踪采样率（0-1） |

## 故障定位与可观测性

服务端使用 Pino 输出单行 JSON 结构化日志。每个 HTTP 请求都会生成 `requestId`，并通过
`X-Request-Id` 响应头返回；聊天 SSE 的 `done`、`error` 和 `cancelled` 事件也包含该编号。
向开发人员反馈问题时请同时提供 `requestId`，即可关联请求、会话、工具调用和耗时日志。

错误响应采用稳定结构：

```json
{
  "error": "模型响应超时，请稍后重试。",
  "code": "LLM_TIMEOUT",
  "stage": "agent_request",
  "retryable": true,
  "requestId": "请求编号"
}
```

配置 `SENTRY_DSN` 后会启用 Sentry 异常采集；未配置时不会产生外部数据传输。默认不会上传
用户问题、模型回答、Cookie、请求头或文件内容。生产环境建议同时设置 `APP_VERSION`、
`SENTRY_ENVIRONMENT` 和 `SENTRY_RELEASE`，以便按部署版本定位回归问题。

### 多用户模式

`ACCESS_TOKEN` 对应 `owner` 管理用户，并保留自定义本机工作区能力。需要给多人独立使用时，
配置 `ACCESS_TOKENS`，每个用户使用不同口令：

```env
ACCESS_TOKEN=owner-长随机口令
ACCESS_TOKENS={"alice":"alice-长随机口令","bob":"bob-长随机口令"}
```

不同用户只能读取和删除自己的会话，普通用户的生成文件写入
`output/users/<userId>`，不能查看或修改 owner 的工作区配置。

## 安全提示

- **本机开发**：可不设 `ACCESS_TOKEN`，仅本机访问。
- **公网部署**：必须 `PUBLIC_MODE=true` + 强 `ACCESS_TOKEN`；口令只告诉信任的人。
- 公网模式下禁止配置任意本机路径，文件只写入服务器默认 `output` 目录。
- 仍有人能用你的 DeepSeek 额度：注意限流、定期更换口令，额度异常时立刻轮换 API Key。
- API Key 只写在本地 `.env` 或云平台密钥面板，**不要**写进源码或提交到 Git。
- 会话记录、工作区路径、证书与日志均已忽略，不会进入仓库。
