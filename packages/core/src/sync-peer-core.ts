import bcrypt from "bcryptjs";
import type { DatabasePort } from "@mangayomu/db-contract";

export type SyncPeer = {
  pair_id: string;
  local_account_id: number;
  remote_account_id: string;
  remote_peer_url: string;
  remote_peer_id: string;
  state: "pending" | "active" | "revoked";
  created_at: string;
  activated_at: string | null;
};

export class SyncPeerCore {
  constructor(private readonly database: DatabasePort) {}

  async createPendingPair(
    localAccountId: number,
    remotePeerUrl: string,
    remotePeerId: string,
    remoteAccountId: string,
    pairingPin: string
  ): Promise<SyncPeer> {
    const normalizedUrl = normalizePeerUrl(remotePeerUrl);
    const normalizedPin = validatePin(pairingPin);
    if (!remotePeerId.trim() || !remoteAccountId.trim()) {
      throw new Error("Remote peer and account identifiers are required");
    }

    const pairId = createPairId();
    const now = new Date().toISOString();
    const pinHash = await bcrypt.hash(normalizedPin, 10);
    await this.database.write(
      `INSERT INTO sync_peers (
        pair_id, local_account_id, remote_account_id, remote_peer_url,
        remote_peer_id, pairing_pin_hash, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [pairId, localAccountId, remoteAccountId.trim(), normalizedUrl, remotePeerId.trim(), pinHash, now]
    );
    return this.requirePair(pairId, localAccountId);
  }

  async activatePair(pairId: string, localAccountId: number, pairingPin: string): Promise<SyncPeer> {
    const peer = await this.database.get<SyncPeer & { pairing_pin_hash: string }>(
      "SELECT * FROM sync_peers WHERE pair_id = ? AND local_account_id = ?",
      [pairId, localAccountId]
    );
    if (!peer || peer.state === "revoked") throw new Error("Sync pair is not available");
    if (!(await bcrypt.compare(validatePin(pairingPin), peer.pairing_pin_hash))) {
      throw new Error("Incorrect pairing PIN");
    }

    const now = new Date().toISOString();
    await this.database.write(
      "UPDATE sync_peers SET state = 'active', activated_at = ? WHERE pair_id = ? AND local_account_id = ?",
      [now, pairId, localAccountId]
    );
    return this.requirePair(pairId, localAccountId);
  }

  async revokePair(pairId: string, localAccountId: number): Promise<void> {
    await this.database.write(
      "UPDATE sync_peers SET state = 'revoked' WHERE pair_id = ? AND local_account_id = ?",
      [pairId, localAccountId]
    );
  }

  async listPairs(localAccountId: number): Promise<SyncPeer[]> {
    return this.database.all<SyncPeer>(
      `SELECT pair_id, local_account_id, remote_account_id, remote_peer_url,
              remote_peer_id, state, created_at, activated_at
       FROM sync_peers WHERE local_account_id = ? ORDER BY created_at DESC`,
      [localAccountId]
    );
  }

  async enqueue(pairId: string, entityType: "favorite" | "progress", entityKey: string): Promise<void> {
    const now = new Date().toISOString();
    await this.database.write(
      `INSERT INTO sync_outbox (pair_id, entity_type, entity_key, created_at, sent_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(pair_id, entity_type, entity_key) DO UPDATE SET
         created_at = excluded.created_at,
         sent_at = NULL`,
      [pairId, entityType, entityKey, now]
    );
  }

  private async requirePair(pairId: string, localAccountId: number): Promise<SyncPeer> {
    const peer = await this.database.get<SyncPeer>(
      `SELECT pair_id, local_account_id, remote_account_id, remote_peer_url,
              remote_peer_id, state, created_at, activated_at
       FROM sync_peers WHERE pair_id = ? AND local_account_id = ?`,
      [pairId, localAccountId]
    );
    if (!peer) throw new Error("Sync pair was not created");
    return peer;
  }
}

function validatePin(pin: string): string {
  const normalized = String(pin).trim();
  if (!/^\d{4,8}$/.test(normalized)) throw new Error("Pairing PIN must contain 4 to 8 digits");
  return normalized;
}

function normalizePeerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote server URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote server URL must use HTTP or HTTPS");
  }
  return url.origin;
}

function createPairId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("This platform cannot generate a sync pair identifier");
}
