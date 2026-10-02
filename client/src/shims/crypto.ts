/** Browser replacement for the small Node crypto surface used by bcryptjs. */
export function randomBytes(size: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is required to generate secure password salts");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

export default { randomBytes };
