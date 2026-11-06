import { createNodeEnvironment } from '../../lib/runtime/node.js';
import { admitRequest } from '../../lib/shared-pool.js';

const environment = createNodeEnvironment(process.env);
process.send('ready');
process.on('message', async message => {
  if (message !== 'go') return;
  const result = await admitRequest(environment, 'terms');
  process.send(result.ok ? 200 : result.response.status, () => {
    environment.DB.close();
    process.disconnect();
  });
});
