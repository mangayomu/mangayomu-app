export type SqlValue = string | number | null | Uint8Array;

/**
 * The only database surface available to platform-neutral domain code.
 * Implementations may use browser sql.js, server sql.js, or better-sqlite3.
 */
export interface DatabasePort {
  get<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  write(sql: string, params?: SqlValue[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction?<T>(work: () => Promise<T>): Promise<T>;
}
