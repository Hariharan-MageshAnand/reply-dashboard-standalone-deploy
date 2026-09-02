import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';

export const QUEUE_NAMES = {
  mailboxSync: 'mailbox-sync',
  maintenance: 'maintenance',
  classify: 'classify',
} as const;

export const MAINTENANCE_JOBS = {
  resurfaceSnoozed: 'resurface-snoozed',
  mailboxPoll: 'mailbox-poll',
  processScheduledSends: 'process-scheduled-sends',
  slaCheck: 'sla-check',
  approvalReminders: 'approval-reminders',
} as const;

// PRD 5.1: a new reply appears in the inbox within 5 minutes of arrival.
export const MAILBOX_POLL_INTERVAL_MS = 5 * 60_000;
export const RESURFACE_INTERVAL_MS = 60_000;

const connection: ConnectionOptions = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
};

export function createQueue(name: string) {
  return new Queue(name, { connection });
}

export const mailboxSyncQueue = createQueue(QUEUE_NAMES.mailboxSync);
export const maintenanceQueue = createQueue(QUEUE_NAMES.maintenance);
export const classifyQueue = createQueue(QUEUE_NAMES.classify);

export async function enqueueClassification(messageId: string) {
  await classifyQueue.add(
    'classify',
    { messageId },
    {
      // One job per message ever — replays after a re-sync are deduped.
      jobId: `classify-${messageId}`,
      removeOnComplete: 500,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    },
  );
}

export async function enqueueMailboxSync(
  mailboxId: string,
  mode: 'initial' | 'incremental' = 'incremental',
  opts?: JobsOptions,
) {
  await mailboxSyncQueue.add(
    'sync',
    { mailboxId, mode },
    {
      jobId: `sync-${mailboxId}-${mode}-${Date.now()}`,
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      ...opts,
    },
  );
}

export async function registerMaintenanceSchedulers() {
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.resurfaceSnoozed,
    { every: RESURFACE_INTERVAL_MS },
    { name: MAINTENANCE_JOBS.resurfaceSnoozed },
  );
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.mailboxPoll,
    { every: MAILBOX_POLL_INTERVAL_MS },
    { name: MAINTENANCE_JOBS.mailboxPoll },
  );
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.processScheduledSends,
    { every: RESURFACE_INTERVAL_MS },
    { name: MAINTENANCE_JOBS.processScheduledSends },
  );
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.slaCheck,
    { every: RESURFACE_INTERVAL_MS },
    { name: MAINTENANCE_JOBS.slaCheck },
  );
  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_JOBS.approvalReminders,
    { every: RESURFACE_INTERVAL_MS },
    { name: MAINTENANCE_JOBS.approvalReminders },
  );
}

export function getRedisConnection(): ConnectionOptions {
  return connection;
}

export { Worker };
