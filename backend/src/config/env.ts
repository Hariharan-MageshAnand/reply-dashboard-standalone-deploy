import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

config({ path: resolve(process.cwd(), '../.env') });
config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:4000/api/oauth/google/callback'),
  MICROSOFT_CLIENT_ID: z.string().optional().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
  MICROSOFT_TENANT_ID: z.string().optional().default('common'),
  MICROSOFT_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:4000/api/oauth/microsoft/callback'),
  MAILBOX_MOCK: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Legacy alias still accepted
  GMAIL_MOCK: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  // 'shared': every sign-in joins one team workspace (pilot model).
  // 'personal': each email gets its own workspace (used by tests).
  WORKSPACE_MODE: z.enum(['shared', 'personal']).optional().default('shared'),
  RESEND_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().optional().default('Reply Dashboard <onboarding@resend.dev>'),
  API_PUBLIC_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const googleReady = Boolean(parsed.data.GOOGLE_CLIENT_ID && parsed.data.GOOGLE_CLIENT_SECRET);
const microsoftReady = Boolean(
  parsed.data.MICROSOFT_CLIENT_ID && parsed.data.MICROSOFT_CLIENT_SECRET,
);

export const env = {
  ...parsed.data,
  MAILBOX_MOCK:
    parsed.data.MAILBOX_MOCK ||
    parsed.data.GMAIL_MOCK ||
    (!googleReady && !microsoftReady),
  GOOGLE_OAUTH_READY: googleReady,
  MICROSOFT_OAUTH_READY: microsoftReady,
  AI_READY: Boolean(parsed.data.ANTHROPIC_API_KEY),
  EMAIL_READY: Boolean(parsed.data.RESEND_API_KEY),
  API_PUBLIC_URL: parsed.data.API_PUBLIC_URL ?? `http://localhost:${parsed.data.PORT}`,
};
