/**
 * Live smoke test for the Salesforce connection: SOAP login, identity, and a
 * lookup by email (optional first CLI arg).
 *
 * Run from backend/ with explicit env exports (dotenv injection is unreliable
 * for one-off scripts — see memory/env-loading-backend-scripts):
 *   export SALESFORCE_...=... && npx tsx scripts/salesforce-smoke.ts [email]
 */
import { env } from '../src/config/env.js';
import {
  findSalesforcePersonByEmail,
  listSampleContacts,
  testSalesforceConnection,
} from '../src/services/salesforce.service.js';

async function main() {
  if (!env.SF_READY) {
    console.error('SF_READY is false — SALESFORCE_* env vars missing.');
    process.exitCode = 1;
    return;
  }
  const identity = await testSalesforceConnection();
  console.log(`Connected as ${identity.username} (${identity.instanceUrl})`);

  let email = process.argv[2];
  if (email === '--sample') {
    const samples = await listSampleContacts(1);
    email = samples[0]?.email;
    if (!email) {
      console.log('Org has no contacts with emails to sample.');
      return;
    }
  }
  if (email) {
    const match = await findSalesforcePersonByEmail(email);
    if (match) {
      console.log(
        `Match: [${match.recordType}] ${match.name}` +
          `${match.title ? ` — ${match.title}` : ''}` +
          `${match.company ? ` @ ${match.company}` : ''}` +
          `${match.ownerName ? ` (owner: ${match.ownerName})` : ''}` +
          `${match.status ? ` [${match.status}]` : ''}`,
      );
      console.log(`URL: ${match.url}`);
    } else {
      console.log(`No Contact or Lead found for ${email}`);
    }
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
