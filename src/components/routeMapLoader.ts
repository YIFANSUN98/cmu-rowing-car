type MapModule = typeof import('./RouteMap');
let loaded: MapModule['default'] | undefined;
let pending: Promise<MapModule> | undefined;

// Warm the map code during authentication, without requesting tiles or route data.
export function loadRouteMap(): Promise<MapModule> {
  return (pending ??= import('./RouteMap').then(
    (module) => {
      loaded = module.default;
      return module;
    },
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  ));
}
export const preloadedRouteMap = () => loaded;
export const preloadRouteMap = () => {
  void loadRouteMap().catch(() => {});
};
