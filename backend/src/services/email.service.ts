import { env } from '../config/env.js';

export const emailTestHooks: {
  onSend?: (input: { to: string; subject: string }) => void;
  deliveryOverride?: { delivered: boolean; retryable?: boolean; error?: string };
} = {};

export type EmailSendResult = {
  delivered: boolean;
  retryable?: boolean;
  error?: string;
};

/**
 * Transactional email with a pluggable provider. With RESEND_API_KEY set,
 * sends via Resend's HTTP API (the provider flagged in PRD Section 6 as
 * already connected elsewhere in the org — pending confirmation). Without it,
 * logs the email so flows stay testable end-to-end in dev; callers receive
 * delivered=false and must surface the failure, never block silently (PRD 5.5).
 */
export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<EmailSendResult> {
  emailTestHooks.onSend?.(input);
  if (emailTestHooks.deliveryOverride) {
    const override = emailTestHooks.deliveryOverride;
    return {
      delivered: override.delivered,
      retryable: override.retryable ?? !override.delivered,
      error: override.error,
    };
  }
  if (!env.EMAIL_READY) {
    console.log(
      `[email:dev] to=${input.to} subject="${input.subject}" (RESEND_API_KEY not set — not delivered)`,
    );
    return {
      delivered: false,
      retryable: false,
      error: 'Email provider not configured (RESEND_API_KEY missing).',
    };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        delivered: false,
        retryable: true,
        error: `Email provider error: ${text.slice(0, 300)}`,
      };
    }
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      retryable: true,
      error: error instanceof Error ? error.message : 'Email send failed',
    };
  }
}
