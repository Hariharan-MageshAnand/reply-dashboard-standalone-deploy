import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import {
  escapeSoqlString,
  resolveSalesforceLoginUrl,
  websiteHostMatchesDomain,
} from './salesforce.service.js';

// Live Salesforce calls are exercised by scripts/salesforce-smoke.ts; tests
// cover the pure pieces and the not-configured API behavior (SF_READY is
// false in the test env).
describe('salesforce service', () => {
  it('resolves domain tokens and full URLs to login endpoints', () => {
    expect(resolveSalesforceLoginUrl('login')).toBe('https://login.salesforce.com');
    expect(resolveSalesforceLoginUrl('Production')).toBe('https://login.salesforce.com');
    expect(resolveSalesforceLoginUrl('sandbox')).toBe('https://test.salesforce.com');
    expect(resolveSalesforceLoginUrl('https://emergence.my.salesforce.com/')).toBe(
      'https://emergence.my.salesforce.com',
    );
    expect(() => resolveSalesforceLoginUrl('bogus')).toThrow(/Unrecognized/);
    expect(() => resolveSalesforceLoginUrl('  ')).toThrow(/non-empty/);
  });

  it('escapes SOQL string values against quote/backslash injection', () => {
    expect(escapeSoqlString("o'brien@example.com")).toBe("o\\'brien@example.com");
    expect(escapeSoqlString('back\\slash')).toBe('back\\\\slash');
    expect(escapeSoqlString("x' OR Email != '")).toBe("x\\' OR Email != \\'");
  });

  it('domain fallback matches a Website host exactly, not by substring', () => {
    // The bug: a %domain% Website LIKE let acme.com resolve notacme.com, and an
    // audited engine edit would then write to that unrelated account.
    expect(websiteHostMatchesDomain('https://notacme.com', 'acme.com')).toBe(false);
    expect(websiteHostMatchesDomain('https://myacme.com/contact', 'acme.com')).toBe(false);
    expect(websiteHostMatchesDomain('https://acme.com.br', 'acme.com')).toBe(false);
    expect(websiteHostMatchesDomain('https://acmezcom', 'acme.com')).toBe(false);
    expect(websiteHostMatchesDomain(null, 'acme.com')).toBe(false);
    expect(websiteHostMatchesDomain('', 'acme.com')).toBe(false);
    // Exact host and approved subdomains resolve.
    expect(websiteHostMatchesDomain('https://acme.com', 'acme.com')).toBe(true);
    expect(websiteHostMatchesDomain('http://www.acme.com/', 'acme.com')).toBe(true);
    expect(websiteHostMatchesDomain('acme.com', 'acme.com')).toBe(true);
    expect(websiteHostMatchesDomain('https://mail.acme.com', 'acme.com')).toBe(true);
    expect(websiteHostMatchesDomain('https://ACME.com', 'acme.com')).toBe(true);
  });

  it('the conversation endpoint reports not-ready without credentials', async () => {
    const app = createApp();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: `sf-${Date.now()}@emsoft.com` });
    const res = await request(app)
      .get('/api/conversations/nonexistent/salesforce')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: false,
      match: null,
      sequence: null,
      account: null,
      opportunities: [],
      matchedBy: null,
      related: [],
    });
  });

  it('engine edits are rejected without credentials — nothing speculative is written', async () => {
    const app = createApp();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: `sf-eng-${Date.now()}@emsoft.com` });
    const res = await request(app)
      .patch('/api/conversations/nonexistent/salesforce/engine')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ engine: 'Engine A' });
    expect(res.status).toBe(400);
  });
});
