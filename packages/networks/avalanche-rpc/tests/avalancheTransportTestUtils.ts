import { FetchRequest, JsonRpcProvider } from 'ethers';
import { Socket } from 'node:net';

import { avalancheGetUrl } from '../lib/avalancheTransport';
import { closeHttpFixtures } from './mocked/avalancheHttp.mock';

/** Real providers whose sockets belong to the current loopback test. */
export const providers: JsonRpcProvider[] = [];
/** Close all resources created by loopback transport fixtures. */
export const closeTransportFixtures = () => closeHttpFixtures(providers);
/** Build a real SDK request using the Avalanche owned transport hook. */
export const connection = (url: string, timeout = 120) => {
  const request = new FetchRequest(url);
  request.timeout = timeout;
  request.getUrlFunc = avalancheGetUrl;
  return request;
};
/** Wait until every socket belonging to an incomplete exchange is destroyed. */
export const closed = async (connections: Socket[]) => {
  expect(connections.length).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(connections.every((socket) => socket.destroyed)).toEqual(true),
  );
};

export {
  listen,
  servers,
  sockets,
  intervals,
} from './mocked/avalancheHttp.mock';
