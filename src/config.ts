import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as ini from 'ini';
import readline from 'readline';
import { requestContext } from './request-context.js';

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
  const ctx = requestContext.getStore();
  if (ctx?.email && ctx?.password) {
    return { email: ctx.email, password: ctx.password };
  }
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('No credentials found. Please enter your kicktipp.com login:');
  const email = await ask('Email: ');
  const password = await new Promise<string>((resolve) => {
    process.stdout.write('Password: ');
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let pwd = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (c === '\u0003') {
        process.exit(1);
      } else if (c === '\u007f') {
        pwd = pwd.slice(0, -1);
      } else {
        pwd += c;
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
  rl.close();

  const config2 = readConfig();
  config2.auth = { email, password: encrypt(password) };
  writeConfig(config2);
  console.log('Credentials saved to config.');
  return { email, password };
}

export function loadCommunity(): string | null {
  const ctx = requestContext.getStore();
  if (ctx?.community) return ctx.community;
  if (process.env.KICKTIPP_COMMUNITY) return process.env.KICKTIPP_COMMUNITY;
  const config = readConfig();
  return config.community?.name || null;
}

export function saveCommunity(name: string): void {
  if (requestContext.getStore()?.community || process.env.KICKTIPP_COMMUNITY) {
    throw new Error('Community is set per-request or via KICKTIPP_COMMUNITY env var and cannot be changed at runtime.');
  }
  const config = readConfig();
  config.community = { name };
  writeConfig(config);
}

export function loadPlayer(): string | null {
  const ctx = requestContext.getStore();
  if (ctx?.player) return ctx.player;
  if (process.env.KICKTIPP_PLAYER) return process.env.KICKTIPP_PLAYER;
  const config = readConfig();
  return config.player?.name || null;
}

export function savePlayer(name: string): void {
  if (requestContext.getStore()?.player || process.env.KICKTIPP_PLAYER) {
    throw new Error('Player is set per-request or via KICKTIPP_PLAYER env var and cannot be changed at runtime.');
  }
  const config = readConfig();
  config.player = { name };
  writeConfig(config);
}

export function hasCredentials(): boolean {
  const ctx = requestContext.getStore();
  if (ctx?.email && ctx?.password) return true;
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
