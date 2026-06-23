import { Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const logger = new Logger('NetworkProxy');

export function configureGlobalProxy(): void {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || readWindowsProxy();
  if (!proxyUrl) return;

  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    logger.log(`Outbound HTTP proxy enabled: ${redactProxyUrl(proxyUrl)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.warn(`Ignoring invalid proxy configuration: ${message}`);
  }
}

function readWindowsProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;

  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = queryRegistryValue(key, 'ProxyEnable');
  if (!enabled || !/\b0x1\b|\b1\b/.test(enabled)) return undefined;

  const proxyServer = queryRegistryValue(key, 'ProxyServer');
  return parseWindowsProxyServer(proxyServer);
}

function queryRegistryValue(key: string, valueName: string): string | undefined {
  try {
    return execFileSync('reg.exe', ['query', key, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    });
  } catch {
    return undefined;
  }
}

function parseWindowsProxyServer(output?: string): string | undefined {
  const raw = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('ProxyServer'));
  if (!raw) return undefined;

  const value = raw.split(/\s{2,}/).at(-1)?.trim();
  if (!value) return undefined;

  const entries = value.includes(';') ? value.split(';') : [value];
  const preferred =
    entries.find((entry) => entry.toLowerCase().startsWith('https=')) ??
    entries.find((entry) => entry.toLowerCase().startsWith('http=')) ??
    entries[0];
  const proxy = preferred.replace(/^[a-z]+=/i, '').trim();
  if (!proxy || /^socks/i.test(proxy)) return undefined;

  return /^[a-z][a-z\d+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return proxyUrl;
  }
}
