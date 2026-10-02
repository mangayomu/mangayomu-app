export type BackupPayload = { version: number; manga: any[]; skipped: string[] };
export function isSupportedBackupFile(name: string): boolean;
export function decodeBackup(bytes: Uint8Array | ArrayBuffer, fileName?: string): Promise<BackupPayload>;
export function previewBackup(payload: BackupPayload): { mangaTotal: number; favorites: number; progress: number; skipped: number };
export function applyBackup(payload: BackupPayload, target: any): Promise<any>;
