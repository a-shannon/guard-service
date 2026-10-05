import { GuardsAvalancheConfigs } from '../../src/configs/guardsAvalancheConfigs';
import * as ScannerStartup from '../../src/jobs/initScanner';
import { isAvalancheManagementRouteEnabled } from '../../src/utils/avalancheManagementRoutes';
import { valid } from '../configs/avalancheConfigTestData';
import { reader } from '../configs/avalancheConfigTestUtils';
import {
  routeNames,
  routePolicies,
} from '../configs/avalancheManagementRoutesTestData';
import { contracts } from './avalancheChainTestUtils';

describe('prepared Avalanche management routes', () => {
  afterEach(() => vi.restoreAllMocks());
  /**
   * @target isAvalancheManagementRouteEnabled resolves $cold/$manual/$arbitrary
   * @dependencies Actual validated config snapshot; captured startup-input port.
   * @scenario Resolve each route in all eight synthetic boolean policies.
   * @expected Preserve the exact field without enabling another route.
   */
  it.each(routePolicies)('resolves $cold/$manual/$arbitrary', (routes) => {
    const config = GuardsAvalancheConfigs.read(
      reader({ ...valid, 'avalanche.routes': routes }),
    )!;
    vi.spyOn(ScannerStartup, 'getPreparedAvalancheInputs').mockReturnValue({
      config,
      contracts: contracts(),
    });
    for (const route of routeNames)
      expect(isAvalancheManagementRouteEnabled(route)).toBe(routes[route]);
  });
  /**
   * @target isAvalancheManagementRouteEnabled defaults absent preparation %s to false
   * @dependencies Startup accessor returning no captured policy.
   * @scenario Resolve one route before an enabled configuration is available.
   * @expected Return false.
   */
  it.each(routeNames)('defaults absent preparation %s to false', (route) => {
    vi.spyOn(ScannerStartup, 'getPreparedAvalancheInputs').mockReturnValue(
      undefined,
    );
    expect(isAvalancheManagementRouteEnabled(route)).toBe(false);
  });
  /**
   * @target isAvalancheManagementRouteEnabled defaults unfinished preparation %s to false
   * @dependencies Startup accessor throwing its real not-prepared error.
   * @scenario Resolve one route while startup is not prepared.
   * @expected Return false without propagating activation.
   */
  it.each(routeNames)(
    'defaults unfinished preparation %s to false',
    (route) => {
      vi.spyOn(ScannerStartup, 'getPreparedAvalancheInputs').mockImplementation(
        () => {
          throw new Error('Avalanche startup inputs are not prepared');
        },
      );
      expect(isAvalancheManagementRouteEnabled(route)).toBe(false);
    },
  );
});
