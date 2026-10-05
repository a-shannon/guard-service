import { GuardsAvalancheConfig } from '../configs/guardsAvalancheConfigs';
import { getPreparedAvalancheInputs } from '../jobs/initScanner';

/** Resolves an explicit opt-in only from the prepared, validated policy snapshot. */
export const isAvalancheManagementRouteEnabled = (
  route: keyof GuardsAvalancheConfig['routes'],
): boolean => {
  try {
    return getPreparedAvalancheInputs()?.config.routes[route] === true;
  } catch {
    // Startup has not prepared the policy, so no management route is enabled.
    return false;
  }
};
