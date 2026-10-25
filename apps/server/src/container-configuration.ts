import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { PoolConfig } from 'pg';

type Environment = Readonly<Record<string, string | undefined>>;
export type ContainerConfiguration = {
  database: PoolConfig;
  mediaRoot: string;
  /** Durable frame-result staging. Always beneath `mediaRoot`, the one durable writable root. */
  frameStagingRoot: string;
  apiPort: number;
  gatewayPort: number;
  publicOrigin: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  autoStartWorkers: boolean;
};

function exactName(value: string | undefined, variable: string) {
  if (!value || value.length > 63 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`${variable} must be an explicit database identifier.`);
  return value;
}
function port(value: string | undefined, fallback: number, variable: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error(`${variable} must be an unprivileged TCP port.`);
  return parsed;
}
function loopbackOrigin(value: string | undefined, variable: string) {
  if (!value) throw new Error(`${variable} is required.`);
  const parsed = new URL(value);
  if (parsed.origin !== value || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${variable} must be an exact loopback HTTP origin.`);
  }
  return parsed;
}
export async function readSecretFile(path: string | undefined, variable: string): Promise<string> {
  if (!path || !isAbsolute(path) || path.includes('\0')) throw new Error(`${variable} must name an absolute secret file.`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024) throw new Error(`${variable} must be a non-empty regular file no larger than 1024 bytes.`);
    let value = await file.readFile('utf8');
    if (value.endsWith('\n')) value = value.slice(0, -1);
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${variable} contains an invalid control character.`);
    return value;
  } finally { await file.close(); }
}

export async function readContainerConfiguration(env: Environment): Promise<ContainerConfiguration> {
  const password = await readSecretFile(env.POSTGRES_PASSWORD_FILE, 'POSTGRES_PASSWORD_FILE');
  const publicOrigin = loopbackOrigin(env.FLUME_PUBLIC_ORIGIN, 'FLUME_PUBLIC_ORIGIN');
  const devOrigin = !env.FLUME_DEV_ORIGIN ? undefined : loopbackOrigin(env.FLUME_DEV_ORIGIN, 'FLUME_DEV_ORIGIN');
  const tailnetOrigin = env.FLUME_TAILNET_ORIGIN === undefined ? undefined : new URL(env.FLUME_TAILNET_ORIGIN);
  // Opt-in additional origin for a loopback-bound gateway behind Tailscale Serve.
  // Exact host matching is retained; this is not a wildcard or an authentication bypass.
  if (tailnetOrigin && (tailnetOrigin.origin !== env.FLUME_TAILNET_ORIGIN
    || tailnetOrigin.protocol !== 'https:' || tailnetOrigin.port !== ''
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(tailnetOrigin.hostname))) {
    throw new Error('FLUME_TAILNET_ORIGIN must be an exact HTTPS machine.tailnet.ts.net origin on port 443.');
  }
  const workers = env.FLUME_WORKERS_ENABLED ?? '0';
  if (!['0', '1'].includes(workers)) throw new Error('FLUME_WORKERS_ENABLED must be 0 or 1.');
  if (workers === '1' && env.FLUME_QUEUE_AUDITED !== '1') throw new Error('Worker activation requires FLUME_QUEUE_AUDITED=1 after an explicit queue audit.');
  if (!env.FLUME_STORAGE_ROOT || !isAbsolute(env.FLUME_STORAGE_ROOT) || env.FLUME_STORAGE_ROOT === '/') throw new Error('FLUME_STORAGE_ROOT must be an absolute non-root path.');
  // Frame-result staging must be durable. The container root filesystem is read-only and its only
  // writable durable path is the media volume, so staging lives beneath it by default and an
  // explicit path outside it (a temp directory, a second writable root) is refused at startup.
  const durableRoot = resolve(env.FLUME_STORAGE_ROOT);
  const configuredStaging = env.FLUME_FRAME_STAGING_ROOT;
  const declaredStaging = configuredStaging === undefined ? join(durableRoot, 'frame-staging') : configuredStaging;
  const frameStagingRoot = resolve(declaredStaging);
  if (!isAbsolute(declaredStaging) || /[\x00-\x1f\x7f]/.test(declaredStaging)
    || frameStagingRoot === durableRoot || !frameStagingRoot.startsWith(durableRoot + sep)) {
    throw new Error('FLUME_FRAME_STAGING_ROOT must be an absolute path beneath FLUME_STORAGE_ROOT.');
  }
  const database: PoolConfig = {
    host: exactName(env.POSTGRES_HOST, 'POSTGRES_HOST'), port: port(env.POSTGRES_PORT, 5432, 'POSTGRES_PORT'),
    database: exactName(env.POSTGRES_DB, 'POSTGRES_DB'), user: exactName(env.POSTGRES_USER, 'POSTGRES_USER'),
    max: 12, connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000,
  };
  Object.defineProperty(database, 'password', { value: password, enumerable: false, configurable: false, writable: false });
  return {
    database, mediaRoot: env.FLUME_STORAGE_ROOT, frameStagingRoot, apiPort: port(env.FLUME_INTERNAL_API_PORT, 4311, 'FLUME_INTERNAL_API_PORT'),
    gatewayPort: port(env.FLUME_GATEWAY_PORT, 8080, 'FLUME_GATEWAY_PORT'), publicOrigin: publicOrigin.origin,
    allowedHosts: [publicOrigin.host, ...(tailnetOrigin ? [tailnetOrigin.host] : [])], allowedOrigins: [publicOrigin.origin, ...(devOrigin ? [devOrigin.origin] : []), ...(tailnetOrigin ? [tailnetOrigin.origin] : [])],
    autoStartWorkers: workers === '1',
  };
}
