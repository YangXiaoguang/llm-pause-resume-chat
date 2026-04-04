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

## 生产建议

- Vercel / Serverless 正式部署时，不要继续用 `file` 或 `memory` 仓储
- 建议把 `ChatSessionRepository` 换成 Redis、Postgres 或者持久 KV
- 如果要支持真正的工作流恢复，可在 `ChatService` 外再包一层 Temporal / Inngest orchestration
