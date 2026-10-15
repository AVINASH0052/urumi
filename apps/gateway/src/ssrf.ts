// SSRF guard for admin-supplied upstream URLs. Checked when a server is saved and again
// before every connection (DNS can change between the two).
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { config } from './config.ts';

const alwaysBlocked = new BlockList();               // never reachable, not even via the allowlist
alwaysBlocked.addSubnet('169.254.0.0', 16);          // link-local incl. cloud metadata 169.254.169.254
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
alwaysBlocked.addSubnet('0.0.0.0', 8);

const internal = new BlockList();                    // private/cluster ranges: allowlisted hosts only
for (const [net, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const)
  internal.addSubnet(net, bits);
internal.addAddress('::1', 'ipv6');
internal.addSubnet('fc00::', 7, 'ipv6');
internal.addSubnet('198.18.0.0', 15);                // benchmarking range, sometimes routed internally

export async function assertSafeUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const raw of addrs) {
    // ::ffff:a.b.c.d is IPv4 in disguise; check it against the IPv4 lists.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw.address)?.[1];
    const address = mapped ?? raw.address;
    const type = mapped || raw.family !== 6 ? 'ipv4' : 'ipv6';
    if (alwaysBlocked.check(address, type)) throw new Error(`blocked address ${address}`);
    if (internal.check(address, type) && !config.ssrfAllowedHosts.includes(host))
      throw new Error(`${host} resolves to internal address ${address}; add it to ssrf.allowedHosts to allow`);
  }
  return url;
}
