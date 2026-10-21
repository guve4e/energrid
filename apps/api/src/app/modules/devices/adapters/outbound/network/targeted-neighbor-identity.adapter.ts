import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NeighborIdentityObservation } from '../../../../llm/network-endpoint-identity-refresh';

const execFileAsync = promisify(execFile);
const routeTimeoutMs = 1_000;
const arpProbeTimeoutMs = 5_000;
const maxRouteOutput = 4_096;
const maxXmlOutput = 16_384;
type CommandRunner = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
const runCommand: CommandRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, { ...options, encoding: 'utf8' });
  return { stdout };
};

/**
 * Obtains a new link-layer reply for exactly one directly connected IPv4 target.
 * A cached OS neighbor entry is never accepted as refresh evidence.
 */
export async function refreshLocalNeighborIdentity(
  ipAddress: string,
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): Promise<NeighborIdentityObservation> {
  if (!isIpv4Address(ipAddress)) return { reachable: false };

  try {
    const route = await resolveDirectInterface(ipAddress, platform, run);
    if (!route) return { reachable: false };

    const { stdout } = await run('nmap', [
      '-sn', '-PR', '-n', '-e', route.interfaceName, '-oX', '-', ipAddress,
    ], { timeout: arpProbeTimeoutMs, maxBuffer: maxXmlOutput });
    const host = findTargetHost(stdout, ipAddress);
    if (!host || !/<status\s+[^>]*state="up"/.test(host)) return { reachable: false };

    const macAddress = host.match(/<address\s+[^>]*addr="([0-9a-f:.-]+)"\s+addrtype="mac"/i)?.[1];
    return {
      reachable: true,
      ...(macAddress ? { macAddress: normalizeMac(macAddress) } : {}),
      interfaceName: route.interfaceName,
    };
  } catch {
    return { reachable: false };
  }
}

async function resolveDirectInterface(
  ipAddress: string,
  platform: NodeJS.Platform,
  run: CommandRunner,
): Promise<{ interfaceName: string } | null> {
  if (platform === 'darwin') {
    const { stdout } = await run('route', ['-n', 'get', ipAddress], {
      timeout: routeTimeoutMs,
      maxBuffer: maxRouteOutput,
    });
    const interfaceName = stdout.match(/^\s*interface:\s*(\S+)/m)?.[1];
    const gateway = stdout.match(/^\s*gateway:\s*(\S+)/m)?.[1];
    if (!interfaceName || (gateway && !/^link#\d+$/i.test(gateway))) return null;
    return { interfaceName };
  }

  if (platform === 'linux') {
    const { stdout } = await run('ip', ['-4', 'route', 'get', ipAddress], {
      timeout: routeTimeoutMs,
      maxBuffer: maxRouteOutput,
    });
    const route = stdout.trim().split(/\s+/);
    const via = route.indexOf('via');
    const dev = route.indexOf('dev');
    if (via >= 0 || dev < 0 || !route[dev + 1]) return null;
    return { interfaceName: route[dev + 1] };
  }
  return null;
}

function findTargetHost(xml: string, expectedIp: string): string | null {
  const hosts = xml.match(/<host\b[\s\S]*?<\/host>/g) || [];
  return hosts.find(host => {
    const addresses = [...host.matchAll(/<address\s+[^>]*addr="([^"]+)"\s+addrtype="ipv4"/g)];
    return addresses.some(match => match[1] === expectedIp);
  }) || null;
}

function normalizeMac(value: string): string | undefined {
  const octets = value.split(':');
  if (octets.length !== 6 || octets.some(octet => !/^[0-9a-f]{1,2}$/i.test(octet))) return undefined;
  const normalized = octets.map(octet => octet.padStart(2, '0')).join(':').toLowerCase();
  return normalized;
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}
