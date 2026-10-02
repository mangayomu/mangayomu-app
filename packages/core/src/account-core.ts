import bcrypt from "bcryptjs";
import type { DatabasePort } from "@mangayomu/db-contract";

type AccountRow = { id: number; email: string; password_hash: string };

export type Account = { id: number; email: string };

export class AccountCore {
  constructor(private readonly database: DatabasePort) {}

  async createAccount(email: string, password: string): Promise<Account> {
    const normalizedEmail = normalizeEmail(email);
    assertPassword(password);

    const existing = await this.database.get<AccountRow>(
      "SELECT id, email, password_hash FROM accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (existing) throw new Error("An account with this email already exists");

    const passwordHash = await bcrypt.hash(password, 10);
    await this.database.write(
      "INSERT INTO accounts (email, password_hash, created_at) VALUES (?, ?, ?)",
      [normalizedEmail, passwordHash, new Date().toISOString()]
    );

    const account = await this.getAccountByEmail(normalizedEmail);
    if (!account) throw new Error("Account creation did not complete");
    return account;
  }

  async authenticate(email: string, password: string): Promise<Account> {
    const normalizedEmail = normalizeEmail(email);
    const account = await this.database.get<AccountRow>(
      "SELECT id, email, password_hash FROM accounts WHERE email = ?",
      [normalizedEmail]
    );
    if (!account || !(await bcrypt.compare(password, account.password_hash))) {
      throw new Error("Incorrect email or password");
    }
    return { id: account.id, email: account.email };
  }

  async getAccount(accountId: number): Promise<Account | undefined> {
    return this.database.get<Account>("SELECT id, email FROM accounts WHERE id = ?", [accountId]);
  }

  async getAccountByEmail(email: string): Promise<Account | undefined> {
    return this.database.get<Account>("SELECT id, email FROM accounts WHERE email = ?", [email]);
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Email is required");
  return normalized;
}

function assertPassword(password: string): void {
  if (password.length < 4) throw new Error("Password must be at least 4 characters");
}
