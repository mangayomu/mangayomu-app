// Compatibility export for existing views and API facade.
// The implementation lives in the browser database package so server and client
// share the same database contract and migration source.
export { getBrowserDatabase as getLocalDatabase } from "@mangayomu/db-browser";
