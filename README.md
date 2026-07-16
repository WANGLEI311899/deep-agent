# DeepAgent

基于 DeepSeek 的本地 AI 智能体：支持技能（Skill）、沙箱写文件、HITL 确认、多会话 Web UI。

## 环境要求

- Node.js 20+
- DeepSeek API Key

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量（项目根目录创建 .env）
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_MODEL=deepseek-chat
# DEEPSEEK_TEMPERATURE=0.7
# DEEPSEEK_MAX_HISTORY=20
# PORT=5173
# TAVILY_API_KEY=        # 仅 demo:search / demo:multi 需要

# 启动 Web UI（推荐）
npm run ui
# 浏览器打开 http://localhost:5173
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run ui` | 构建并启动 Web 工作台 |
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
.deepagent/
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
| `TAVILY_API_KEY` | — | 搜索 Demo 可选 |

## 安全提示

- 本项目面向**本机开发**使用，Web 服务默认无鉴权。
- 输出目录可配置为任意本地路径，请勿对公网暴露端口。
- API Key 仅放在 `.env`，不要提交到 Git。
