import { eveChannel } from 'eve/channels/eve';
import { httpBasic } from 'eve/channels/auth';

export default eveChannel({
  auth: [
    (request) => {
      const token = process.env.LOCCA_RUNTIME_TOKEN;
      if (!token) throw new Error('Missing Locca runtime token');
      return httpBasic({ username: 'locca', password: token })(request);
    },
  ],
  turnPolicy: 'queue',
});
