import { Connection } from 'jsforce';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { nativeSalesforceTransport } from '../lib/salesforce-transport.js';

/**
 * Salesforce connection for the Reply Dashboard, modeled on the Emergence
 * webapp's integration (backend/src/shared/services/integrations/
 * salesforce.service.ts): SOAP login with username + password+security-token,
 * a jsforce Connection pre-seeded with the session, the native HTTPS
 * transport, and automatic re-login when the session expires.
 */

const PRODUCTION_LOGIN_URL = 'https://login.salesforce.com';
const SANDBOX_LOGIN_URL = 'https://test.salesforce.com';

const SHORT_TOKEN_MAP: Record<string, string> = {
  login: PRODUCTION_LOGIN_URL,
  production: PRODUCTION_LOGIN_URL,
  test: SANDBOX_LOGIN_URL,
  sandbox: SANDBOX_LOGIN_URL,
};

export function resolveSalesforceLoginUrl(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) {
    throw new Error('SALESFORCE_DOMAIN must be a non-empty string');
  }
  if (trimmed.toLowerCase().startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }
  const mapped = SHORT_TOKEN_MAP[trimmed.toLowerCase()];
  if (mapped) return mapped;
  throw new Error(
    `Unrecognized SALESFORCE_DOMAIN "${trimmed}". Allowed short values: ${Object.keys(SHORT_TOKEN_MAP).join(', ')}; or provide a full https:// login URL.`,
  );
}

/** Escapes a value for interpolation inside a single-quoted SOQL string. */
export function escapeSoqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface SoapLoginResult {
  sessionId: string;
  serverUrl: string;
}

async function doSoapLogin(
  loginUrl: string,
  username: string,
  password: string,
): Promise<SoapLoginResult> {
  const soapBody = [
    '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
    '<se:Header/>',
    '<se:Body>',
    '<login xmlns="urn:partner.soap.sforce.com">',
    `<username>${escapeXml(username)}</username>`,
    `<password>${escapeXml(password)}</password>`,
    '</login>',
    '</se:Body>',
    '</se:Envelope>',
  ].join('');

  const res = await nativeSalesforceTransport.httpRequest({
    method: 'POST',
    url: `${loginUrl}/services/Soap/u/59.0`,
    headers: {
      'Content-Type': 'text/xml; charset=UTF-8',
      SOAPAction: '""',
      'Content-Length': String(Buffer.byteLength(soapBody)),
    },
    body: soapBody,
  });

  if (res.statusCode !== 200) {
    const fault = res.body.match(/<faultstring>([^<]+)<\/faultstring>/)?.[1];
    throw new Error(fault ?? `Salesforce SOAP login returned HTTP ${res.statusCode}`);
  }

  const sessionId = res.body.match(/<sessionId>([^<]+)<\/sessionId>/)?.[1];
  const serverUrl = res.body.match(/<serverUrl>([^<]+)<\/serverUrl>/)?.[1];
  if (!sessionId || !serverUrl) {
    throw new Error('Could not extract sessionId/serverUrl from SOAP login response');
  }
  return { sessionId, serverUrl };
}

let connection: Connection | null = null;
let initPromise: Promise<void> | null = null;

async function initialize(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const loginUrl = resolveSalesforceLoginUrl(env.SALESFORCE_DOMAIN);
    const username = env.SALESFORCE_USERNAME;
    const password = env.SALESFORCE_PASSWORD + env.SALESFORCE_SECURITY_TOKEN;

    const { sessionId, serverUrl } = await doSoapLogin(loginUrl, username, password);

    const conn = new Connection({
      loginUrl,
      sessionId,
      serverUrl,
      callOptions: { client: 'reply-dashboard' },
      refreshFn: async (
        _conn: Connection,
        callback: (err: Error | null, accessToken?: string) => void,
      ) => {
        try {
          const { sessionId: newId, serverUrl: newUrl } = await doSoapLogin(
            loginUrl,
            username,
            password,
          );
          (_conn as unknown as { _establish: (o: object) => void })._establish({
            sessionId: newId,
            serverUrl: newUrl,
          });
          callback(null, newId);
        } catch (err) {
          callback(err as Error);
        }
      },
    });
    (conn as unknown as { _transport: unknown })._transport = nativeSalesforceTransport;
    connection = conn;
    console.log(`Salesforce: connected (instanceUrl=${conn.instanceUrl})`);
  })();

  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    connection = null;
    throw error;
  }
}

async function ensureConnection(): Promise<Connection> {
  if (!env.SF_READY) {
    throw new AppError(
      'validation_error',
      'Salesforce is not configured. Set the SALESFORCE_* environment variables.',
      400,
    );
  }
  if (!connection) await initialize();
  if (!connection) {
    throw new AppError('provider_error', 'Salesforce connection could not be established.', 502);
  }
  return connection;
}

export async function testSalesforceConnection(): Promise<{ username: string; instanceUrl: string }> {
  const conn = await ensureConnection();
  const identity = await conn.identity();
  return { username: identity.username, instanceUrl: conn.instanceUrl ?? '' };
}

export interface SalesforceMatch {
  recordType: 'contact' | 'lead';
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  ownerName: string | null;
  status: string | null;
  email: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  url: string;
  /** Account link — contacts only; drives account/opportunity context. */
  accountId: string | null;
}

/** Contact-level sequencing context (field map confirmed by Hari, Sep 7). */
export interface SalesforceSequence {
  /** Sequence_Name__c — current sequence name. */
  name: string | null;
  /** Sequence_Status__c — general sequence status. */
  status: string | null;
  /** Current_Sequence_Status__c — current sequence lifecycle status. */
  currentStatus: string | null;
  /** Current_Sequence_Number_outreach__c — touchpoint number in sequence. */
  touchpoint: number | null;
}

export interface SalesforceAccount {
  id: string;
  name: string;
  /** Engine_V2__c (formula; per Hari: "use engine_v2 only no engine"). */
  engine: string | null;
  /** Engine_V2_Manual__c — the writable manual-override channel. */
  engineManual: string | null;
  /** Account_Score_V2__c (per Hari: the "EDIE score" equivalent). */
  accountScore: number | null;
  /** Account_Score_V2_Grade__c. */
  accountScoreGrade: string | null;
  industry: string | null;
  description: string | null;
  url: string;
}

export interface SalesforceOpportunity {
  id: string;
  name: string;
  stageName: string | null;
  amount: number | null;
  closeDate: string | null;
  url: string;
}

export interface SalesforceContext {
  person: SalesforceMatch | null;
  sequence: SalesforceSequence | null;
  account: SalesforceAccount | null;
  opportunities: SalesforceOpportunity[];
  /** How the context was found: exact person email, or company by domain. */
  matchedBy: 'email' | 'domain' | null;
}

/**
 * Company-domain fallback: CRM emails often differ from reply aliases
 * (sam.forman@ vs samuel.forman@), so an exact miss still resolves the
 * ACCOUNT via the email's domain. Free-mail domains never match a company.
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

// Platform/notification domains: a CRM account may exist for these companies
// (e.g. GitHub), but mail FROM them is tooling, not a prospect reply —
// domain-matching would tag every notification thread as a Salesforce hit.
const PLATFORM_DOMAINS = new Set([
  'github.com',
  'google.com',
  'linear.app',
  'atlassian.net',
  'atlassian.com',
  'slack.com',
  'notion.so',
  'zoom.us',
  'calendly.com',
  'docusign.com',
  'docusign.net',
  'stripe.com',
  'intuit.com',
  'salesforce.com',
  'vercel.com',
  'superhuman.com',
  'read.ai',
  'loom.com',
  'figma.com',
  'hubspot.com',
  'sendgrid.net',
  'mailchimp.com',
  'substack.com',
  'medium.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'apple.com',
  'microsoft.com',
  'amazonaws.com',
  'amazon.com',
]);

const AUTOMATED_LOCAL_PARTS =
  /^(no-?reply|do-?not-?reply|notifications?|mailer(-daemon)?|updates?|alerts?|digest|billing|receipts?|invoices?|marketing|newsletters?|news|support|info|bot)([+.-]|$)/;

export function companyDomainOf(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const [localPart, domain] = normalized.split('@');
  if (!domain || !domain.includes('.')) return null;
  if (FREE_MAIL_DOMAINS.has(domain) || PLATFORM_DOMAINS.has(domain)) return null;
  // Automated senders (noreply@, notifications@, …) are tooling — matching
  // their company by domain would mislabel notification threads as prospects.
  if (AUTOMATED_LOCAL_PARTS.test(localPart ?? '')) return null;
  return domain;
}

interface ContactRow {
  Id: string;
  Name: string;
  Title: string | null;
  Email: string;
  Phone: string | null;
  MailingCity: string | null;
  MailingState: string | null;
  AccountId: string | null;
  Account: { Name: string } | null;
  Owner: { Name: string } | null;
  Sequence_Name__c?: string | null;
  Sequence_Status__c?: string | null;
  Current_Sequence_Status__c?: string | null;
  Current_Sequence_Number_outreach__c?: number | null;
}

// Lead City/State are not queryable in this org (INVALID_FIELD), so leads
// carry no location; contacts use MailingCity/MailingState.
interface LeadRow {
  Id: string;
  Name: string;
  Title: string | null;
  Email: string;
  Phone: string | null;
  Company: string | null;
  Status: string | null;
  Owner: { Name: string } | null;
}

function recordUrl(conn: Connection, id: string): string {
  const base = (conn.instanceUrl ?? '').replace(/\/+$/, '');
  return `${base}/${id}`;
}

async function lookupPerson(
  conn: Connection,
  email: string,
): Promise<{ match: SalesforceMatch | null; sequence: SalesforceSequence | null }> {
  const escaped = escapeSoqlString(email.trim().toLowerCase());

  const contacts = await conn.query<ContactRow>(
    `SELECT Id, Name, Title, Email, Phone, MailingCity, MailingState, AccountId, Account.Name, Owner.Name, ` +
      `Sequence_Name__c, Sequence_Status__c, Current_Sequence_Status__c, Current_Sequence_Number_outreach__c ` +
      `FROM Contact WHERE Email = '${escaped}' LIMIT 1`,
  );
  const contact = contacts.records[0];
  if (contact) {
    return {
      match: {
        recordType: 'contact',
        id: contact.Id,
        name: contact.Name,
        title: contact.Title ?? null,
        company: contact.Account?.Name ?? null,
        ownerName: contact.Owner?.Name ?? null,
        status: null,
        email: contact.Email,
        phone: contact.Phone ?? null,
        city: contact.MailingCity ?? null,
        state: contact.MailingState ?? null,
        url: recordUrl(conn, contact.Id),
        accountId: contact.AccountId ?? null,
      },
      sequence: {
        name: contact.Sequence_Name__c ?? null,
        status: contact.Sequence_Status__c ?? null,
        currentStatus: contact.Current_Sequence_Status__c ?? null,
        touchpoint: contact.Current_Sequence_Number_outreach__c ?? null,
      },
    };
  }

  const leads = await conn.query<LeadRow>(
    `SELECT Id, Name, Title, Email, Phone, Company, Status, Owner.Name FROM Lead WHERE Email = '${escaped}' AND IsConverted = false LIMIT 1`,
  );
  const lead = leads.records[0];
  if (lead) {
    return {
      match: {
        recordType: 'lead',
        id: lead.Id,
        name: lead.Name,
        title: lead.Title ?? null,
        company: lead.Company ?? null,
        ownerName: lead.Owner?.Name ?? null,
        status: lead.Status ?? null,
        email: lead.Email,
        phone: lead.Phone ?? null,
        city: null,
        state: null,
        url: recordUrl(conn, lead.Id),
        accountId: null,
      },
      sequence: null,
    };
  }

  return { match: null, sequence: null };
}

/**
 * Looks up the prospect in Salesforce by email — Contacts first (already in
 * the CRM proper), then Leads. Returns null when the email is unknown to
 * Salesforce.
 */
export async function findSalesforcePersonByEmail(email: string): Promise<SalesforceMatch | null> {
  const conn = await ensureConnection();
  return (await lookupPerson(conn, email)).match;
}

interface AccountRow {
  Id: string;
  Name: string;
  Engine_V2__c: string | null;
  Engine_V2_Manual__c: string | null;
  Account_Score_V2__c: number | null;
  Account_Score_V2_Grade__c: string | null;
  Industry: string | null;
  Description: string | null;
}

interface OpportunityRow {
  Id: string;
  Name: string;
  StageName: string | null;
  Amount: number | null;
  CloseDate: string | null;
}

async function getAccount(conn: Connection, accountId: string): Promise<SalesforceAccount | null> {
  const escaped = escapeSoqlString(accountId);
  const res = await conn.query<AccountRow>(
    `SELECT Id, Name, Engine_V2__c, Engine_V2_Manual__c, Account_Score_V2__c, ` +
      `Account_Score_V2_Grade__c, Industry, Description FROM Account WHERE Id = '${escaped}' LIMIT 1`,
  );
  const row = res.records[0];
  if (!row) return null;
  return {
    id: row.Id,
    name: row.Name,
    engine: row.Engine_V2__c ?? null,
    engineManual: row.Engine_V2_Manual__c ?? null,
    accountScore: row.Account_Score_V2__c ?? null,
    accountScoreGrade: row.Account_Score_V2_Grade__c ?? null,
    industry: row.Industry ?? null,
    description: row.Description ?? null,
    url: recordUrl(conn, row.Id),
  };
}

async function getOpenOpportunities(
  conn: Connection,
  accountId: string,
): Promise<SalesforceOpportunity[]> {
  const escaped = escapeSoqlString(accountId);
  const res = await conn.query<OpportunityRow>(
    `SELECT Id, Name, StageName, Amount, CloseDate FROM Opportunity ` +
      `WHERE AccountId = '${escaped}' AND IsClosed = false ` +
      `ORDER BY CloseDate ASC NULLS LAST LIMIT 5`,
  );
  return res.records.map((o) => ({
    id: o.Id,
    name: o.Name,
    stageName: o.StageName ?? null,
    amount: o.Amount ?? null,
    closeDate: o.CloseDate ?? null,
    url: recordUrl(conn, o.Id),
  }));
}

/**
 * Bare hostname of a Salesforce Website value — lowercased, no scheme/path,
 * no leading "www.". Returns null when it can't be parsed.
 */
function websiteHostname(website: string): string | null {
  const raw = website.trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const host = new URL(withScheme).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/**
 * True when a Salesforce Account Website belongs to `domain` — an exact host
 * match or an approved subdomain of it. This guards the domain fallback against
 * a substring collision: acme.com must NOT match a Website of notacme.com.
 */
export function websiteHostMatchesDomain(
  website: string | null | undefined,
  domain: string,
): boolean {
  if (!website) return false;
  const host = websiteHostname(website);
  if (!host) return false;
  const d = domain.trim().toLowerCase().replace(/^www\./, '');
  if (!d) return false;
  return host === d || host.endsWith(`.${d}`);
}

async function findAccountByDomain(
  conn: Connection,
  domain: string,
): Promise<SalesforceAccount | null> {
  const escaped = escapeSoqlString(domain);
  // A %domain% Website match is only a candidate filter, never an account
  // identity — SOQL LIKE would let acme.com match https://notacme.com. Narrow
  // in the query, then require an exact host / approved-subdomain match in code
  // and take the newest survivor.
  const res = await conn.query<{ Id: string; Website: string | null }>(
    `SELECT Id, Website FROM Account WHERE Website LIKE '%${escaped}%' ` +
      `ORDER BY LastModifiedDate DESC LIMIT 25`,
  );
  const match = res.records.find((r) => websiteHostMatchesDomain(r.Website, domain));
  return match ? getAccount(conn, match.Id) : null;
}

/**
 * Full CRM context for a prospect email: person match, contact sequencing
 * fields, the account (Engine V2, Account Score V2, industry, description),
 * and open opportunities (SXP-90 scope; field map confirmed by Hari). When no
 * person matches exactly, falls back to the company via the email domain.
 */
export async function getSalesforceContext(email: string): Promise<SalesforceContext> {
  const conn = await ensureConnection();
  const { match, sequence } = await lookupPerson(conn, email);

  if (!match) {
    const domain = companyDomainOf(email);
    const account = domain ? await findAccountByDomain(conn, domain) : null;
    const opportunities = account ? await getOpenOpportunities(conn, account.id) : [];
    return {
      person: null,
      sequence: null,
      account,
      opportunities,
      matchedBy: account ? 'domain' : null,
    };
  }

  let account: SalesforceAccount | null = null;
  let opportunities: SalesforceOpportunity[] = [];
  if (match.accountId) {
    [account, opportunities] = await Promise.all([
      getAccount(conn, match.accountId),
      getOpenOpportunities(conn, match.accountId),
    ]);
  }
  return { person: match, sequence, account, opportunities, matchedBy: 'email' };
}

/**
 * Operator correction for an engine mismatch (SXP-90). Engine_V2__c is a
 * formula and not writable; Engine_V2_Manual__c is the designated manual
 * override channel. Returns the account re-read after the write so the
 * caller sees the effective values.
 */
export async function updateAccountEngine(
  accountId: string,
  engine: string,
): Promise<SalesforceAccount | null> {
  const conn = await ensureConnection();
  const result = await conn
    .sobject('Account')
    .update({ Id: accountId, Engine_V2_Manual__c: engine.trim() });
  if (!result.success) {
    throw new AppError('provider_error', 'Salesforce rejected the engine update.', 502);
  }
  return getAccount(conn, accountId);
}

export interface CreateOpportunityInput {
  accountId: string;
  /** Sourcing_Lead__c picklist value — the assigned team member's SF name. */
  sourcingLeadName: string;
  topContactName: string;
  topContactEmail: string;
}

export type CreateOpportunityResult =
  | { status: 'created'; id: string; name: string }
  | { status: 'skipped'; reason: string; opportunityId?: string; claimedBy?: string }
  | { status: 'error'; message: string };

interface OpportunityAccountRow {
  Id: string;
  Name: string | null;
  Thesis__c: string | null;
  Revenue_Estimates__c: number | string | null;
  Current_Sourcing_Lead__c: string | null;
}

/** YYYY-MM-DD, `months` from today (UTC), matching the webapp's CloseDate. */
function closeDatePlusMonths(months: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/**
 * Create a Salesforce Opportunity when a meeting is booked (SXP-90), ported
 * from the webapp's OpportunityUpdateService.createOpportunity. Guards:
 *   - skips if an open Opportunity already exists on the account (dedupe)
 *   - refuses if the account is already claimed by a different sourcing lead
 * Name format is "<Account> | <Thesis> | <Revenue in $M>"; the account is
 * claimed for the assigned lead when it is currently unclaimed.
 */
export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<CreateOpportunityResult> {
  const conn = await ensureConnection();
  const accountId = input.accountId.trim();
  const normalizedLead = input.sourcingLeadName.trim();

  const acctEscaped = escapeSoqlString(accountId);
  const existing = await conn.query<{ Id: string }>(
    `SELECT Id FROM Opportunity WHERE AccountId = '${acctEscaped}' AND IsClosed = false ` +
      `ORDER BY CreatedDate DESC LIMIT 1`,
  );
  if (existing.records[0]?.Id) {
    return {
      status: 'skipped',
      reason: 'opportunity_already_exists',
      opportunityId: existing.records[0].Id,
    };
  }

  const acctRes = await conn.query<OpportunityAccountRow>(
    `SELECT Id, Name, Thesis__c, Revenue_Estimates__c, Current_Sourcing_Lead__c ` +
      `FROM Account WHERE Id = '${acctEscaped}' LIMIT 1`,
  );
  const account = acctRes.records[0];
  if (!account) {
    return { status: 'error', message: 'Salesforce account not found.' };
  }

  const currentLead = account.Current_Sourcing_Lead__c?.trim();
  if (currentLead && normalizedLead && currentLead !== normalizedLead) {
    return { status: 'skipped', reason: 'account_claimed_by_other', claimedBy: currentLead };
  }

  const thesis = account.Thesis__c?.trim() || 'Other';
  const rawRevenue = account.Revenue_Estimates__c;
  const parsedRevenue = Number(
    typeof rawRevenue === 'string' ? rawRevenue.replace(/,/g, '').trim() : (rawRevenue ?? 0),
  );
  const revenueInMillions =
    Number.isFinite(parsedRevenue) && parsedRevenue > 0
      ? Math.round((parsedRevenue / 1_000_000) * 10) / 10
      : 0;
  const opportunityName = account.Name
    ? [account.Name, thesis, ...(revenueInMillions > 0 ? [revenueInMillions] : [])].join(' | ')
    : 'New Opportunity';

  const created = await conn.sobject('Opportunity').create({
    Name: opportunityName,
    AccountId: accountId,
    StageName: 'Prospecting',
    CloseDate: closeDatePlusMonths(3),
    Sourcing_Lead__c: normalizedLead,
    Top_Contact_Name__c: input.topContactName.trim(),
    Top_Contact_Email__c: input.topContactEmail.trim(),
  });
  if (!created.success) {
    return { status: 'error', message: JSON.stringify(created.errors) };
  }

  // Claim the account for this lead when it is currently unclaimed.
  if (!currentLead && normalizedLead) {
    try {
      await conn
        .sobject('Account')
        .update({ Id: accountId, Current_Sourcing_Lead__c: normalizedLead, Claim_Status__c: 'Claimed' });
    } catch {
      // Non-fatal: the Opportunity exists; the claim is a courtesy update.
    }
  }

  return { status: 'created', id: created.id, name: opportunityName };
}

/** Diagnostics (smoke script): field names/labels of an sObject, filterable. */
export async function describeSalesforceFields(
  objectName: string,
  contains?: string,
): Promise<Array<{ name: string; label: string; type: string; updateable: boolean }>> {
  const conn = await ensureConnection();
  const meta = await conn.sobject(objectName).describe();
  const needle = contains?.toLowerCase();
  return meta.fields
    .map((f) => ({ name: f.name, label: f.label, type: f.type, updateable: f.updateable }))
    .filter(
      (f) =>
        !needle ||
        f.name.toLowerCase().includes(needle) ||
        f.label.toLowerCase().includes(needle),
    );
}

/**
 * Background sweep: caches Salesforce presence on conversations that have
 * never been checked (list tag + "Salesforce first" sort). Emails are
 * deduped within a run; a thread with no inbound is marked checked/unmatched.
 */
export async function sweepSalesforceMatches(limit = 25): Promise<number> {
  if (!env.SF_READY) return 0;
  const { prisma } = await import('../lib/prisma.js');
  const candidates = await prisma.conversation.findMany({
    where: { sfCheckedAt: null, isWarmup: false },
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    select: {
      id: true,
      messages: {
        where: { direction: 'inbound' },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { fromEmail: true },
      },
    },
  });
  if (candidates.length === 0) return 0;

  const cache = new Map<string, string | null>();
  let updated = 0;
  for (const conversation of candidates) {
    const email = conversation.messages[0]?.fromEmail?.toLowerCase() ?? null;
    let matchType: string | null = null;
    if (email) {
      if (cache.has(email)) {
        matchType = cache.get(email)!;
      } else {
        try {
          const context = await getSalesforceContext(email);
          matchType = context.person?.recordType ?? (context.account ? 'domain' : null);
          cache.set(email, matchType);
        } catch (error) {
          // Leave sfCheckedAt null so the next sweep retries this thread.
          console.error('salesforce sweep lookup failed:', (error as Error).message);
          continue;
        }
      }
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      // The list tag/sort is about the PERSON being in Salesforce; a
      // domain-only company match keeps its type for the panel but does not
      // count as present.
      data: {
        sfMatched: matchType === 'contact' || matchType === 'lead',
        sfMatchType: matchType,
        sfCheckedAt: new Date(),
      },
    });
    updated += 1;
  }
  return updated;
}

/** Diagnostics only (smoke/probe scripts) — never exposed over HTTP. */
export async function runDiagnosticSoql<T extends Record<string, unknown>>(
  soql: string,
): Promise<T[]> {
  const conn = await ensureConnection();
  const res = await conn.query<T>(soql);
  return res.records;
}

/** Diagnostics (smoke script): a few real contact emails to round-trip. */
export async function listSampleContacts(limit = 3): Promise<Array<{ name: string; email: string }>> {
  const conn = await ensureConnection();
  const capped = Math.min(Math.max(1, limit), 10);
  const res = await conn.query<{ Name: string; Email: string }>(
    `SELECT Name, Email FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT ${capped}`,
  );
  return res.records.map((r) => ({ name: r.Name, email: r.Email }));
}

/**
 * Write-back: logs a completed Task on the matched Lead/Contact so the reply
 * activity is visible in Salesforce (PRD Week 3 write-back scope).
 */
export async function logReplyActivity(input: {
  whoId: string;
  subject: string;
  description: string;
}): Promise<{ taskId: string }> {
  const conn = await ensureConnection();
  const result = await conn.sobject('Task').create({
    WhoId: input.whoId,
    Subject: input.subject.slice(0, 255),
    Description: input.description.slice(0, 32_000),
    Status: 'Completed',
    ActivityDate: new Date().toISOString().slice(0, 10),
    TaskSubtype: 'Email',
  });
  if (!result.success) {
    throw new AppError('provider_error', 'Salesforce rejected the activity log.', 502);
  }
  return { taskId: result.id };
}
