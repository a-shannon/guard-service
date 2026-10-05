import { AxiosAdapter } from '@rosen-clients/rate-limited-axios';

/**
 * Return a successful synthetic node submission response.
 */
export const success: AxiosAdapter = async (config) => ({
  config,
  status: 200,
  statusText: 'OK',
  headers: {},
  data: '"txid"',
});
