/**
 * Session state and its notifications.
 *
 * Two accounts can back a library: the client account of this installation and
 * the account of the connected server. Views used to read localStorage once at
 * mount and never hear about later changes, so signing in from the account
 * dialog left Browse stuck on "Sign in required" and Favorites on its
 * logged-out empty state.
 *
 * Every place that changes the session emits one event on the "mangayomu:session"
 * topic; views subscribe in init() and detach in beforeDestroy().
 */

import { bubble } from "tinybubble/events";
import { auth } from "./api.ts";
import { getConnection, hasActiveServerSession } from "./connection";

const TOPIC = "mangayomu:session";
const CHANGED = "session:changed";

function sessionTopic() {
  return bubble.events.topic(TOPIC);
}

/** True when this installation has a library to read: server account or client account. */
export function hasAccountSession() {
  return hasActiveServerSession(getConnection()) || Boolean(auth.getToken());
}

/** Email of the connected server account, or "" when there is none. */
export function serverAccountEmail() {
  const connection = getConnection();
  if (!hasActiveServerSession(connection)) return "";
  return connection.serverSession?.email || "";
}

/** Email to show in headers: the server account first, then the client account. */
export async function loadAccountEmail() {
  const serverEmail = serverAccountEmail();
  if (serverEmail) return serverEmail;
  try {
    const result = await auth.me();
    return result?.user?.email || "";
  } catch {
    return "";
  }
}

/**
 * Announce that the session changed. Called by every action that signs in,
 * signs out or swaps the connected server account.
 *
 * @param {string} origin short label used only for debugging
 */
export function notifySessionChanged(origin) {
  sessionTopic().emit(CHANGED, {
    origin: origin || "",
    signedIn: hasAccountSession(),
    email: serverAccountEmail(),
  });
}

/** @param {(detail: { origin: string, signedIn: boolean, email: string }) => void} handler */
export function onSessionChanged(handler) {
  sessionTopic().on(CHANGED, handler);
}

/** Detach with the same reference passed to onSessionChanged. */
export function offSessionChanged(handler) {
  sessionTopic().off(CHANGED, handler);
}
