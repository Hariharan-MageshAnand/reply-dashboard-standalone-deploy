import { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { env } from '../config/env.js';
import { testSalesforceConnection } from '../services/salesforce.service.js';

export const salesforceRouter = Router();
salesforceRouter.use(authMiddleware);

/**
 * Workspace-level Salesforce connection status. Salesforce is one shared org
 * connection configured on the server (not per-user OAuth like mailboxes), so
 * this exists purely to make that visible in the UI.
 */
salesforceRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    if (!env.SF_READY) {
      res.json({ configured: false, connected: false, instanceUrl: null, username: null });
      return;
    }
    try {
      const identity = await testSalesforceConnection();
      res.json({
        configured: true,
        connected: true,
        instanceUrl: identity.instanceUrl,
        username: identity.username,
      });
    } catch {
      res.json({ configured: true, connected: false, instanceUrl: null, username: null });
    }
  }),
);
