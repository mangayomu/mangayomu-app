// Pick which source id Browse should request. In the server-extension
// milestone the connected server's enabled-source list is the only
// authoritative source of truth; a stale persisted id (from the route URL or
// localStorage) must never be routed to the server if the server did not
// provide it in this build.
export function selectBrowseSource(sourcesList, routeSource, savedDefault) {
  if (!Array.isArray(sourcesList)) return "";
  if (routeSource && sourcesList.some((s) => s.id === routeSource)) return routeSource;
  if (savedDefault && sourcesList.some((s) => s.id === savedDefault)) return savedDefault;
  return sourcesList.length > 0 ? sourcesList[0].id : "";
}
