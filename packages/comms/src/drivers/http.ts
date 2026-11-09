import { timingSafeEqual } from "node:crypto";

import type { SendError, SendResult } from "../adapter";
import { TemplateError } from "../templates";

/** The slice of `fetch` the drivers use — injectable so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface DriverOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

/** 408, 429 and 5xx are worth retrying; any other 4xx is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function httpError(status: number, code: string, message: string, optOut = false): SendResult {
  const error: SendError = { code, message: message.slice(0, 500), retryable: isRetryableStatus(status) };
  if (optOut) error.optOut = true;
  return { ok: false, error };
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Runs one provider call; template problems are permanent, transport problems retryable. */
export async function guardSend(run: () => Promise<SendResult>): Promise<SendResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TemplateError) return { ok: false, error: { code: "template_error", message: e.message, retryable: false } };
    return { ok: false, error: { code: "network_error", message: e instanceof Error ? e.message : String(e), retryable: true } };
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Case-insensitive header lookup (frameworks disagree on header casing). */
export function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}
