import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { env } from '../config/env.js';

describe('shared-workspace bootstrap', () => {
  const app = createApp();
  const originalMode = env.WORKSPACE_MODE;

  afterEach(() => {
    env.WORKSPACE_MODE = originalMode;
  });

  it('concurrent first sign-ins land in the same shared workspace', async () => {
    env.WORKSPACE_MODE = 'shared';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Join-or-create is serialized on a global advisory lock, so even when
    // both logins race the empty-table create path, exactly one workspace
    // exists afterwards and both users are members of it.
    const [a, b] = await Promise.all([
      request(app).post('/api/auth/login').send({ email: `shared-a-${suffix}@emsoft.com` }),
      request(app).post('/api/auth/login').send({ email: `shared-b-${suffix}@emsoft.com` }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.bootstrap.workspace.id).toBe(b.body.bootstrap.workspace.id);
  });
});
