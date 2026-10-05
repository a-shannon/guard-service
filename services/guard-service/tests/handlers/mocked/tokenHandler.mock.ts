import fs from 'fs';

import { RosenTokens } from '@rosen-bridge/tokens';

/** Mocks one token-map existence check and one JSON read without changing later reads. */
export const mockTokenMapRead = (tokens: RosenTokens): void => {
  vi.spyOn(fs, 'existsSync').mockReturnValueOnce(true);
  vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify({ tokens }));
};
