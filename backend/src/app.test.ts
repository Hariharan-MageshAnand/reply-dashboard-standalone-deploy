import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

describe('API health and local auth', () => {
  const app = createApp();

  it('returns health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('reply-dashboard-api');
    expect(res.body.mocks.mailbox).toBe(true);
  });

  it('logs in and bootstraps a user workspace', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ops@emsoft.com', name: 'Ops' });
    expect(login.status).toBe(200);
    expect(login.body.token).toMatch(/^local\./);
    expect(login.body.bootstrap.user.email).toBe('ops@emsoft.com');
    expect(login.body.bootstrap.workspace.id).toBeTruthy();

    const boot = await request(app)
      .post('/api/auth/bootstrap')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(boot.status).toBe(200);
    expect(boot.body.user.authKey).toBe('local:ops@emsoft.com');
  });

  it('connects mock google and microsoft mailboxes', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ops2@emsoft.com' });
    const auth = `Bearer ${login.body.token}`;

    const google = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: 'outreach-a@example.com', provider: 'google' });
    expect(google.status).toBe(201);
    expect(google.body.provider).toBe('google');

    const microsoft = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: 'outreach-b@example.com', provider: 'microsoft' });
    expect(microsoft.status).toBe(201);
    expect(microsoft.body.provider).toBe('microsoft');

    const list = await request(app).get('/api/mailboxes').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.items.some((m: { email: string }) => m.email === 'outreach-a@example.com')).toBe(
      true,
    );
    expect(list.body.items.some((m: { provider: string }) => m.provider === 'microsoft')).toBe(true);
  });
});
