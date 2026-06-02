import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as ini from 'ini';
import readline from 'readline';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'kicktipp-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.ini');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

// ── Password encryption ────────────────────────────────────────────

const CIPHER_ALGO = 'aes-256-gcm';

function deriveKey(): Buffer {
  const material = `kicktipp-agent:${os.hostname()}:${os.userInfo().username}`;
  return crypto.createHash('sha256').update(material).digest();
}

function encrypt(text: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return `enc.${packed.toString('base64')}`;
}

function decrypt(encoded: string): string {
  if (!encoded.startsWith('enc.')) return encoded; // backward compat: plaintext
  const packed = Buffer.from(encoded.slice(4), 'base64');
  const iv = packed.subarray(0, 16);
  const authTag = packed.subarray(16, 32);
  const ciphertext = packed.subarray(32);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Config I/O ──────────────────────────────────────────────────────

function readConfig(): Record<string, any> {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(config: Record<string, any>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpFile = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, ini.stringify(config));
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, CONFIG_FILE);
}

// ── Credentials ─────────────────────────────────────────────────────

export async function loadCredentials(): Promise<{ email: string; password: string }> {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) {
    return { email: process.env.KICKTIPP_EMAIL, password: process.env.KICKTIPP_PASSWORD };
  }
  const config = readConfig();
  if (config.auth?.email && config.auth?.password) {
    const password = decrypt(config.auth.password);
    // Migrate plaintext passwords to encrypted on read
    if (!config.auth.password.startsWith('enc.')) {
      config.auth.password = encrypt(password);
      writeConfig(config);
    }
    return { email: config.auth.email, password };
  }

  // Credentials not found and not in env vars - throw error instead of waiting for stdin
  throw new Error('No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.');
}

export function loadCommunity(): string | null {
  const config = readConfig();
  return config.community?.name || null;
}

export function saveCommunity(name: string): void {
  const config = readConfig();
  config.community = { name };
  writeConfig(config);
}

export function loadPlayer(): string | null {
  const config = readConfig();
  return config.player?.name || null;
}

export function savePlayer(name: string): void {
  const config = readConfig();
  config.player = { name };
  writeConfig(config);
}

export function hasCredentials(): boolean {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) return true;
  const config = readConfig();
  return !!(config.auth?.email && config.auth?.password);
}

export function logout(): void {
  const removed: string[] = [];
  for (const p of [CONFIG_FILE, SESSION_FILE]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(path.basename(p));
    }
  }
  console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove.');
}
