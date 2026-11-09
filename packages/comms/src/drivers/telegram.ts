import type { OutboundMessage, ProviderAdapter, SendResult, WebhookEvent, WebhookRequest } from "../adapter";
import { renderTemplate } from "../templates";
import {
  asRecord,
  constantTimeEqual,
  defaultFetch,
  type DriverOptions,
  type FetchLike,
  guardSend,
  header,
  httpError,
  safeJson,
  str,
} from "./http";

export interface TelegramConfig {
  botToken: string;
  /** Sent back by Telegram in X-Telegram-Bot-Api-Secret-Token (set via setWebhook secret_token). */
  webhookSecret: string;
}

export class TelegramDriver implements ProviderAdapter {
  readonly name = "telegram-bot";
  readonly channel = "telegram" as const;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: TelegramConfig,
    options: DriverOptions = {},
  ) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? (() => new Date());
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return guardSend(async () => {
      const t = renderTemplate(message.template, message.locale, message.variables);
      const res = await this.fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: message.to, text: `${t.subject}\n\n${t.body}` }),
      });
      const json = asRecord(safeJson(await res.text()));
      if (!res.ok || json.ok !== true) {
        const status = res.ok ? 400 : res.status;
        // 403: the user blocked the bot or deleted the chat.
        return httpError(status, `telegram_${status}`, str(json.description) ?? `HTTP ${status}`, status === 403);
      }
      const id = str(asRecord(json.result).message_id);
      if (!id) return httpError(502, "telegram_no_id", "response carried no message id");
      return { ok: true, providerMessageId: `${message.to}:${id}`, acceptedAt: this.now() };
    });
  }

  verifyWebhook(request: WebhookRequest): boolean {
    const given = header(request.headers, "x-telegram-bot-api-secret-token");
    return !!given && constantTimeEqual(given, this.config.webhookSecret);
  }

  parseWebhook(request: WebhookRequest): WebhookEvent[] {
    const update = asRecord(safeJson(request.rawBody));
    const m = asRecord(update.message ?? update.edited_message);
    const chatId = str(asRecord(m.chat).id);
    const id = str(m.message_id);
    if (chatId && id) {
      const date = Number(m.date);
      return [
        {
          kind: "inbound",
          message: {
            channel: "telegram",
            from: chatId,
            externalMessageId: `${chatId}:${id}`,
            text: str(m.text) ?? str(m.caption) ?? "",
            receivedAt: Number.isFinite(date) && date > 0 ? new Date(date * 1000) : this.now(),
          },
        },
      ];
    }
    // The user blocked the bot.
    const member = asRecord(update.my_chat_member);
    const newStatus = str(asRecord(member.new_chat_member).status);
    const memberChat = str(asRecord(member.chat).id);
    if (memberChat && (newStatus === "kicked" || newStatus === "left")) {
      return [{ kind: "opt_out", optOut: { channel: "telegram", externalId: memberChat, reason: `bot ${newStatus}`, at: this.now() } }];
    }
    return [];
  }
}
