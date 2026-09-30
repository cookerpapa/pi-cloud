import type { ConversationDetailResource } from "@pi-cloud/protocol";
import { Markdown } from "./Markdown.tsx";
import { MessageCopyButton } from "./MessageCopyButton.tsx";
import { useI18n } from "./i18n.tsx";

export function InheritedContext({
  messages,
  summary,
  truncated,
}: {
  messages: ConversationDetailResource["inheritedMessages"];
  summary: ConversationDetailResource["inheritedContextSummary"];
  truncated: boolean;
}) {
  const { t } = useI18n();
  if (messages.length === 0 && !summary && !truncated) return null;
  return (
    <section className="product-inherited-context">
      <header>
        <strong>{t("chat.inherited.title")}</strong>
        <span>{t("chat.inherited.description")}</span>
      </header>
      {summary ? (
        <div className="product-inherited-assistant" data-conversation-entry-id={summary.entryId}>
          <strong>{t("chat.inherited.summary")}</strong>
          <Markdown>{summary.text}</Markdown>
        </div>
      ) : null}
      {truncated ? <p className="product-muted">{t("chat.inherited.truncated")}</p> : null}
      {messages.map((message) => (
        <div
          className={`product-inherited-message ${message.role}`}
          data-conversation-entry-id={message.entryId}
          key={`${message.entryId}:${message.messageIndex ?? "entry"}`}
        >
          {message.role === "user" ? (
            <div className="product-user-message-body">
              <div className="product-user-bubble">{message.text}</div>
              <div className="product-user-message-actions">
                <MessageCopyButton
                  copiedLabel={t("turn.copied")}
                  label={t("turn.copyUserMessage")}
                  text={message.text}
                />
              </div>
            </div>
          ) : (
            <div className="product-inherited-assistant">
              <div className="product-assistant-content">
                <Markdown>{message.text}</Markdown>
                <div className="product-answer-actions">
                  <MessageCopyButton
                    copiedLabel={t("turn.copied")}
                    label={t("turn.copyAssistantMessage")}
                    text={message.text}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="product-inherited-divider">
        <span>{t("chat.inherited.divider")}</span>
      </div>
    </section>
  );
}
