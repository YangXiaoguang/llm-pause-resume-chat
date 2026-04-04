"use client";

import { FormEvent } from "react";

import { useActiveProvider, useChatController } from "@/src/chat/client";

export default function HomePage() {
  const {
    providers,
    selectedProviderId,
    setSelectedProviderId,
    session,
    input,
    setInput,
    isBootstrapping,
    isStreaming,
    error,
    createSession,
    sendMessage,
    pauseMessage,
    resumeMessage,
  } = useChatController();

  const activeProvider = useActiveProvider(providers, selectedProviderId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage();
  }

  return (
    <main className="shell">
      <section className="hero-panel">
        <div className="hero-kicker">Next.js Full-Stack Pause / Resume</div>
        <h1>可暂停、可继续、可扩展的 LLM Web 聊天程序</h1>
        <p className="hero-copy">
          前端负责流式体验，后端负责状态机、provider 适配与续写策略。当前实现已经把暂停/继续、多厂商接入和会话持久化边界拆开，后续替换存储或新增 provider 不需要重写 UI。
        </p>
      </section>

      <section className="workspace">
        <aside className="sidebar card">
          <div className="section-label">运行面板</div>
          <div className="field-group">
            <label htmlFor="provider">Provider</label>
            <select
              id="provider"
              value={selectedProviderId}
              onChange={(event) => setSelectedProviderId(event.target.value)}
              disabled={isStreaming || isBootstrapping}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          <div className="provider-card">
            <div className="provider-title">{activeProvider?.label ?? "未配置 Provider"}</div>
            <p>{activeProvider?.description ?? "页面加载后会自动创建会话。"}</p>
            <div className="meta-grid">
              <div>
                <span>模型</span>
                <strong>{session?.settings.model ?? activeProvider?.defaultModel ?? "-"}</strong>
              </div>
              <div>
                <span>缓存</span>
                <strong>{session?.settings.enablePromptCaching ? "启用" : "关闭"}</strong>
              </div>
              <div>
                <span>状态</span>
                <strong>{session?.status ?? "-"}</strong>
              </div>
              <div>
                <span>消息数</span>
                <strong>{session?.messages.length ?? 0}</strong>
              </div>
            </div>
          </div>

          <div className="button-stack">
            <button className="primary-button" onClick={() => void createSession()} disabled={!selectedProviderId || isStreaming}>
              新建会话
            </button>
            <button className="secondary-button" onClick={() => void resumeMessage()} disabled={session?.status !== "paused" || isStreaming}>
              继续生成
            </button>
            <button className="secondary-button" onClick={() => void pauseMessage()} disabled={!isStreaming}>
              暂停生成
            </button>
          </div>

          <div className="note-card">
            <div className="section-label">架构说明</div>
            <p>
              `Provider Strategy` 负责多厂商适配，`Repository` 负责会话持久化，`ChatService` 负责暂停/继续状态机与续写 prompt 组装。
            </p>
          </div>
        </aside>

        <section className="chat card">
          <div className="chat-header">
            <div>
              <div className="section-label">会话</div>
              <h2>{session?.title ?? "正在初始化..."}</h2>
            </div>
            <div className={`status-pill status-${session?.status ?? "idle"}`}>{session?.status ?? "idle"}</div>
          </div>

          <div className="messages" role="log" aria-live="polite">
            {session?.messages.length ? (
              session.messages.map((message) => (
                <article key={message.id} className={`message message-${message.role}`}>
                  <header>
                    <span>{message.role === "user" ? "你" : "助手"}</span>
                    <span className="message-state">{message.state}</span>
                  </header>
                  <p>{message.content || (message.role === "assistant" ? "正在等待模型输出..." : "")}</p>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <h3>开始一段新对话</h3>
                <p>发送一条消息后，你可以在流式输出过程中暂停，并在同一会话中继续生成。</p>
              </div>
            )}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="输入问题，例如：请分三层分析 LLM 暂停与恢复的工程实现。"
              rows={4}
              disabled={isBootstrapping || isStreaming}
            />
            <div className="composer-footer">
              <span>{error ? `错误：${error}` : isStreaming ? "正在流式输出，支持点击暂停。" : "支持多 provider 策略适配。"} </span>
              <button className="primary-button" type="submit" disabled={!input.trim() || isBootstrapping || isStreaming}>
                发送
              </button>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}
