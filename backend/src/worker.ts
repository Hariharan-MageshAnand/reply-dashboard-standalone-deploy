import {
  Worker,
  getRedisConnection,
  QUEUE_NAMES,
  MAINTENANCE_JOBS,
  enqueueMailboxSync,
  registerMaintenanceSchedulers,
} from './queue/queues.js';
import { prisma } from './lib/prisma.js';
import { syncMailbox } from './services/sync.service.js';
import { resurfaceDueSnoozed } from './services/conversation.service.js';
import { processDueScheduledSends } from './services/send.service.js';
import { classifyInboundMessage } from './services/ai.service.js';
import { tagSlaBreaches } from './services/sla.service.js';
import { processApprovalReminders } from './services/approval.service.js';

const connection = getRedisConnection();

const syncWorker = new Worker(
  QUEUE_NAMES.mailboxSync,
  async (job) => {
    const { mailboxId, mode } = job.data as {
      mailboxId: string;
      mode: 'initial' | 'incremental';
    };
    return syncMailbox(mailboxId, mode);
  },
  { connection },
);

const maintenanceWorker = new Worker(
  QUEUE_NAMES.maintenance,
  async (job) => {
    if (job.name === MAINTENANCE_JOBS.resurfaceSnoozed) {
      const count = await resurfaceDueSnoozed();
      if (count) console.log(`resurfaced ${count} snoozed conversation(s)`);
      return { resurfaced: count };
    }
    if (job.name === MAINTENANCE_JOBS.mailboxPoll) {
      const mailboxes = await prisma.senderMailbox.findMany({
        where: { disconnectedAt: null, health: { notIn: ['disconnected'] } },
        select: { id: true },
      });
      await Promise.all(mailboxes.map((m) => enqueueMailboxSync(m.id, 'incremental')));
      return { polled: mailboxes.length };
    }
    if (job.name === MAINTENANCE_JOBS.processScheduledSends) {
      const fired = await processDueScheduledSends();
      if (fired) console.log(`fired ${fired} scheduled send(s)`);
      return { fired };
    }
    if (job.name === MAINTENANCE_JOBS.slaCheck) {
      const tagged = await tagSlaBreaches();
      if (tagged) console.log(`tagged ${tagged} SLA breach(es)`);
      return { tagged };
    }
    if (job.name === MAINTENANCE_JOBS.approvalReminders) {
      const sent = await processApprovalReminders();
      if (sent) console.log(`sent ${sent} approval reminder(s)`);
      return { sent };
    }
    return {};
  },
  { connection },
);

const classifyWorker = new Worker(
  QUEUE_NAMES.classify,
  async (job) => {
    const { messageId } = job.data as { messageId: string };
    const classification = await classifyInboundMessage(messageId);
    return { label: classification.finalLabel, confidence: classification.aiConfidence };
  },
  { connection, concurrency: 4 },
);

syncWorker.on('failed', (job, err) => {
  console.error('mailbox-sync failed', job?.id, err.message);
});
classifyWorker.on('failed', (job, err) => {
  console.error('classify failed', job?.id, err.message);
});
maintenanceWorker.on('failed', (job, err) => {
  console.error('maintenance failed', job?.name, err.message);
});

await registerMaintenanceSchedulers();

console.log('Workers started: mailbox-sync, maintenance (poll + snooze resurface)');
