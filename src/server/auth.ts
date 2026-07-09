import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

interface StoredUser extends AuthUser {
  usernameKey: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

interface UserDb {
  users: StoredUser[];
}

const dataDir = path.resolve(process.cwd(), 'data');
const usersFile = path.join(dataDir, 'users.json');
const sessions = new Map<string, string>();

export function registerUser(usernameInput: string | undefined, passwordInput: string | undefined): AuthSession {
  const username = normalizeUsername(usernameInput);
  const password = normalizePassword(passwordInput);
  const db = loadDb();
  const usernameKey = username.toLowerCase();

  if (db.users.some((user) => user.usernameKey === usernameKey)) {
    throw new Error('用户名已存在');
  }

  const salt = randomBytes(16).toString('base64');
  const user: StoredUser = {
    id: randomUUID(),
    username,
    usernameKey,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: Date.now(),
  };

  db.users.push(user);
  saveDb(db);
  return createSession(user);
}

export function loginUser(usernameInput: string | undefined, passwordInput: string | undefined): AuthSession {
  const username = normalizeUsername(usernameInput);
  const password = normalizePassword(passwordInput);
  const db = loadDb();
  const user = db.users.find((candidate) => candidate.usernameKey === username.toLowerCase());

  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    throw new Error('用户名或密码错误');
  }

  return createSession(user);
}

export function getUserFromToken(token: string | undefined): AuthUser | null {
  if (!token) return null;

  const userId = sessions.get(token);
  if (!userId) return null;

  const user = loadDb().users.find((candidate) => candidate.id === userId);
  return user ? publicUser(user) : null;
}

export function requireAuth(token: string | undefined): AuthUser {
  const user = getUserFromToken(token);
  if (!user) {
    throw new Error('请先登录');
  }
  return user;
}

function createSession(user: StoredUser): AuthSession {
  const token = randomUUID();
  sessions.set(token, user.id);
  return {
    token,
    user: publicUser(user),
  };
}

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    username: user.username,
  };
}

function normalizeUsername(usernameInput: string | undefined): string {
  const username = String(usernameInput ?? '').trim();
  if (username.length < 2 || username.length > 20) {
    throw new Error('用户名长度需要是 2 到 20 个字符');
  }
  if (/[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('用户名不能包含控制字符');
  }
  return username;
}

function normalizePassword(passwordInput: string | undefined): string {
  const password = String(passwordInput ?? '');
  if (password.length < 6 || password.length > 128) {
    throw new Error('密码长度需要是 6 到 128 个字符');
  }
  return password;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('base64');
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'base64');
  const expected = Buffer.from(expectedHash, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function loadDb(): UserDb {
  if (!existsSync(usersFile)) {
    return { users: [] };
  }

  const parsed = JSON.parse(readFileSync(usersFile, 'utf8')) as UserDb;
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
  };
}

function saveDb(db: UserDb): void {
  mkdirSync(dataDir, { recursive: true });
  const tempFile = `${usersFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  renameSync(tempFile, usersFile);
}
