# Observability

当前仓库已经完成两层观测接入：

- Next.js 服务端通过 `instrumentation.ts` 注册 OTel SDK
- `ChatService`、provider、repository、HTTP route、client controller 都会产出基础 telemetry
- 本地建议使用 `OpenTelemetry Collector -> grafana/otel-lgtm` 观察 trace、metrics 与结构化日志
- 当配置 Langfuse 凭证时，OTel span 会同步导入 Langfuse，prompt 版本、session/turn 关联，以及第 3 迭代的 operational scores 都会生效

## 本地启动

1. 复制环境变量

```bash
cp .env.example .env.local
```

2. 启动本地观测栈

```bash
pnpm obs:up
```

3. 启动应用

```bash
pnpm dev:otel
```

## 入口地址

- 应用: `http://localhost:3000`
- Grafana LGTM: `http://localhost:3002`
- OTel Collector health: `http://localhost:13133`
- Langfuse: 取决于你的自托管或云端地址，默认示例为 `http://127.0.0.1:3003`

## 当前已观测的关键事件

- 会话创建与会话读取
- turn 开始、完成、失败、暂停、客户端中断
- provider 请求拿到响应头的耗时
- TTFT、turn 总耗时、pause 生效耗时
- SSE 请求开始与中断
- 浏览器侧的 submit / first event / first text delta / pause UI feedback
- Langfuse session 维度的 turn 聚合
- Prompt 版本、fallback 状态、resume prompt 引用
- Provider generation observation 与 turn 的关联
- Langfuse operational scores: outcome、resume success、TTFT、duration、pause effective、prompt fallback、provider stop reason

## 默认内容采集策略

默认 `OBS_CAPTURE_CONTENT_MODE=off`，因此日志和 span 不会直接保存完整 prompt/response 正文，而是为下一轮治理预留接口。

Langfuse 导出也会复用同一套 masking 逻辑，因此即使启用了 Langfuse，默认也不会把完整正文原样送出。

## Langfuse 配置

如果你要启用 Langfuse，请在 `.env.local` 里补齐：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://127.0.0.1:3003
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_RELEASE=local
LANGFUSE_EXPORT_MODE=immediate
LANGFUSE_SCORE_ENABLED=true
LANGFUSE_PROMPT_LABEL=production
LANGFUSE_PROMPT_CACHE_TTL_SECONDS=300
```

## 第 3 迭代新增内容

### 1. Langfuse operational scores

终态 turn 会自动写回一组 fail-open 的运行评分，用来在 Langfuse 里按 session、prompt version、provider、resume 链路做横向对比。

当前会发出的 score 名称：

- `chat_turn_outcome`
- `chat_turn_success`
- `chat_turn_resume_success`
- `chat_turn_duration_ms`
- `chat_turn_ttft_ms`
- `chat_turn_pause_effective_ms`
- `chat_turn_prompt_fallback`
- `chat_turn_output_chars`
- `chat_provider_stop_reason`
- `chat_provider_output_tokens`

这里的 score 是“运行时 operational eval”，不是语义质量评测；它主要解决的是 pause/resume 流程是否健康、fallback 是否频繁、不同 prompt 版本的运行表现如何。

### 2. Collector 网关

本地 `pnpm obs:up` 现在会启动：

- `otel-collector`
- `grafana/otel-lgtm`

Collector 配置位于 `otel/collector/config.yaml`，当前做了三件事：

- `redaction/chat`：屏蔽 prompt、input、output、content 类字段和常见 secret / email 值
- `tail_sampling`：优先保留 error、resume、paused、slow traces，其余默认 20% 采样
- `attributes/governance`：在进入后端前丢弃高基数 request/message id

### 3. Grafana dashboard 模板

新增可导入模板：

- `otel/dashboards/chat-overview.json`
- `otel/dashboards/chat-runtime.json`

导入方式：

1. 打开 Grafana
2. 进入 `Dashboards -> New -> Import`
3. 选择上述 JSON 文件
4. 将 datasource 映射到 LGTM 内的 Prometheus/Mimir 数据源

模板里的 PromQL 故意对 `__name__` 使用了正则，以兼容不同后端对 OTel metric 名字的 `_total`、`_milliseconds` 翻译差异。

## Prompt 版本策略

- 默认 system prompt 会优先尝试从 Langfuse 的 `chat-system` 文本 prompt 读取
- resume instruction 会优先尝试从 Langfuse 的 `chat-resume-continue` 文本 prompt 读取
- 获取失败时自动 fallback 到本地内置版本，并在 turn summary 中保留 `isFallback/source/version/hash`

## 当前仍未覆盖的部分

当前实现已经覆盖 tracing、prompt version fallback、operational scores、Collector redaction/tail sampling 和 Grafana 模板，但还没有做：

- 基于人工反馈或模型判别器的语义质量 eval
- Prompt 在线创建/更新工具化
- Collector 多副本与跨实例 trace sticky routing
- Grafana 自动 provisioning 导入 dashboard
