import type { ConnectionState } from "@mangayomu/protocol";

const CONNECTION_KEY = "mangayomu.connection";
const RUNTIME_CONFIG_PATH = "/mangayomu-runtime.json";

type StoredConnectionState = ConnectionState & { hostedByNode?: boolean };

const directState: StoredConnectionState = {
  serverUrl: null,
  transport: "direct",
  clientAccountId: null,
  serverSession: null,
  activeLibrary: null,
  activePairId: null,
  hostedByNode: false
};

function read(): StoredConnectionState {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY);
    if (!raw) return { ...directState };
    return { ...directState, ...JSON.parse(raw) };
  } catch {
    return { ...directState };
  }
}

function save(next: StoredConnectionState): StoredConnectionState {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(next));
  return next;
}

export function getConnection(): StoredConnectionState {
  return read();
}

export function setServerConnection(serverUrl: string): StoredConnectionState {
  const normalized = new URL(serverUrl).origin;
  const previous = read();
  return save({
    ...previous,
    serverUrl: normalized,
    transport: "server",
    hostedByNode: normalized === window.location.origin
  });
}

/** Switch only the catalog transport; account sessions stay independent. */
export function setCatalogTransport(transport: "direct" | "server"): StoredConnectionState {
  const previous = read();
  if (transport === "server" && !previous.serverUrl) {
    throw new Error("Connect to a server first");
  }
  return save({ ...previous, transport });
}

export function clearServerConnection(): StoredConnectionState {
  const previous = read();
  return save({
    ...previous,
    serverUrl: null,
    transport: "direct",
    serverSession: null,
    activeLibrary: previous.clientAccountId ? "client" : null,
    activePairId: null,
    hostedByNode: false
  });
}

export function setRemoteSession(accountId: number, token: string, email?: string): StoredConnectionState {
  const previous = read();
  if (!previous.serverUrl) throw new Error("Connect to a server first");
  return save({
    ...previous,
    serverSession: { serverUrl: previous.serverUrl, accountId, email, token },
    activeLibrary: "server"
  });
}

export function clearRemoteSession(): StoredConnectionState {
  const previous = read();
  return save({
    ...previous,
    serverSession: null,
    activeLibrary: previous.clientAccountId ? "client" : null,
    activePairId: null
  });
}

/**
 * True when the stored server session belongs to the currently selected
 * server. URLs are compared by normalized origin so a trailing slash (or
 * other harmless URL form) never silently drops the Authorization header.
 */
export function hasActiveServerSession(state: StoredConnectionState): boolean {
  if (!state.serverSession || !state.serverUrl) return false;
  let sessionOrigin: string;
  let serverOrigin: string;
  try { sessionOrigin = new URL(state.serverSession.serverUrl).origin; }
  catch { sessionOrigin = String(state.serverSession.serverUrl || ""); }
  try { serverOrigin = new URL(state.serverUrl).origin; }
  catch { serverOrigin = String(state.serverUrl || ""); }
  return sessionOrigin !== "" && sessionOrigin === serverOrigin;
}

export function setClientAccount(accountId: number | null): StoredConnectionState {
  const previous = read();
  return save({
    ...previous,
    clientAccountId: accountId,
    activeLibrary: accountId ? previous.activeLibrary || "client" : previous.serverSession ? "server" : null
  });
}

const DEV_MODE = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

async function discoverOnce(): Promise<StoredConnectionState> {
  try {
    const response = await fetch(RUNTIME_CONFIG_PATH, { cache: "no-store" });
    if (!response.ok) return read();
    const config = await response.json();
    if (config?.kind !== "mangayomu-server") return read();

    const previous = read();
    const serverUrl = new URL(config.serverUrl || window.location.origin, window.location.origin).origin;
    return save({
      ...previous,
      serverUrl,
      // A Node-served page always starts with its own server selected. The
      // user can switch to the bundled direct client from the account menu.
      transport: "server",
      hostedByNode: true
    });
  } catch {
    return read();
  }
}

/**
 * A Node-served client discovers its own server with same-origin fetch. Static
 * builds receive a 404 and keep their explicit/direct connection unchanged.
 *
 * Under Vite dev the server process may still be booting (or selected a
 * fallback port) when this first runs, so retry briefly. Production keeps a
 * single attempt and is never delayed by the retry loop.
 */
export async function discoverHostedServer(): Promise<StoredConnectionState> {
  const attempts = DEV_MODE ? 8 : 1;
  let state = read();
  for (let i = 0; i < attempts; i++) {
    state = await discoverOnce();
    if (state.serverUrl && state.hostedByNode) return state;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state;
}
