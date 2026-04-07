# LLM Pause / Resume Chat

一个基于 Next.js App Router 的全栈聊天程序，重点演示：

- 流式输出中的暂停与继续
- 多厂商 LLM provider 适配
- 会话状态与生成状态解耦
- 可替换的持久化仓储

## 架构

- `app/api/*`
  - 对外 HTTP 边界，提供会话创建、会话读取、暂停请求与流式 turn 接口
- `src/chat/service.ts`
  - 应用服务与状态机，统一处理 reply / pause / resume / finalize
- `src/chat/providers.ts`
  - Provider Strategy，封装 Anthropic、OpenAI-compatible、Mock 三类适配器
- `src/chat/repository.ts`
  - Repository 抽象，当前内置 `memory` 与 `file` 两个实现

## 暂停 / 继续实现

1. 用户发送消息时，服务层先写入 `user` 消息和一个空的 `assistant` 占位消息。
2. 后端通过 provider adapter 拉取上游流式 token，并把 token 逐段写回仓储。
3. 用户点击暂停时，前端调用 `/pause` 标记 `pauseRequested=true`，随后中断浏览器请求。
4. 服务层在 token 循环中检测到暂停标记后中断上游请求，并把当前 `assistant` 消息状态改成 `paused`。
5. 用户点击继续时，服务层把这条 `paused assistant` 消息作为上下文，再追加一条“请从上一条回复结束位置继续”的用户指令继续生成。

这条路径对应的是业界最实用的 `cancel -> resume request` 方案，而不是冻结模型内部隐藏态。

## 本地运行

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

然后打开 `http://localhost:3000`。

默认会始终暴露 `Mock Provider`，所以即使没配置真实 API Key 也能直接体验暂停/继续。

## 本地观测栈

如果你想在本地通过页面查看 trace、metrics 和运行状态，需要先准备 Docker，因为观测栈通过 `docker compose` 启动。

macOS 推荐做法：

1. 安装 Docker Desktop for Mac
2. 启动 `Docker.app`，等待 Docker Engine 就绪
3. 重新打开一个终端窗口
4. 先确认命令可用

```bash
docker version
docker compose version
```

5. 启动观测栈与应用

```bash
cp .env.example .env.local
pnpm install
pnpm obs:up
pnpm dev:otel
```

启动后可以访问：

- 应用页面：`http://localhost:3000`
- Grafana LGTM：`http://localhost:3002`
- OTel Collector health：`http://localhost:13133`
- Langfuse：取决于你的自托管或云端地址，默认示例为 `http://127.0.0.1:3003`

如果执行 `pnpm obs:up` 时看到 `sh: docker: command not found`，说明当前系统里还没有可用的 Docker CLI，或者 Docker Desktop 还没启动。这种情况下先完成 Docker 安装与启动，再重新执行上面的命令。

相关官方文档：

- Docker Desktop for Mac: https://docs.docker.com/desktop/setup/install/mac-install/
- Docker Compose: https://docs.docker.com/compose/install/

## 生产建议

- Vercel / Serverless 正式部署时，不要继续用 `file` 或 `memory` 仓储
- 建议把 `ChatSessionRepository` 换成 Redis、Postgres 或者持久 KV
- 如果要支持真正的工作流恢复，可在 `ChatService` 外再包一层 Temporal / Inngest orchestration
