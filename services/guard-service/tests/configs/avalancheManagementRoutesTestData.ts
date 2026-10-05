/** The only supported management route opt-ins. */
export const routeNames = ['cold', 'manual', 'arbitrary'] as const;
/** Distinguishable policies exercise every combination without activating a chain. */
export const routePolicies = Array.from({ length: 8 }, (_, bits) => ({
  cold: !!(bits & 1),
  manual: !!(bits & 2),
  arbitrary: !!(bits & 4),
}));
/** Present flags must be booleans; omission is exercised separately. */
export const routeValueFaults = routeNames.flatMap((route) =>
  [undefined, null, 'true', 'false', 0, 1, [], {}].map((value) => ({
    route,
    value,
  })),
);
/** Malformed blocks differ in one shape boundary. */
export const routeBlockFaults = [null, false, 'false', 1, [], new Date(0)];
/** Unknown spellings must not be accepted as route aliases. */
export const unknownRouteKeys = ['payment', 'Cold', 'manual ', '__proto__'];
/** Exercise unknown nonenumerable string and symbol keys independently. */
export const hiddenKeyKinds = [false, true];
/** Adds a nonenumerable or symbol key which structured cloning would otherwise omit. */
export const extraRouteKey = (symbol: boolean) => {
  const routes = { cold: false, manual: false, arbitrary: false };
  Object.defineProperty(routes, symbol ? Symbol('extra') : 'extra', {
    value: false,
  });
  return routes;
};
