import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
  console.log(
    `Mocks — mailbox=${env.MAILBOX_MOCK} | OAuth google=${env.GOOGLE_OAUTH_READY} microsoft=${env.MICROSOFT_OAUTH_READY}`,
  );
});
