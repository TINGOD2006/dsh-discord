const RPC_AUTHORITIES = new Set(['loopback', 'trusted-host']);

/**
 * Resolve the browser authority accepted by an IM management RPC channel.
 *
 * Defaults to `loopback`: the management surface can rewrite bot tokens,
 * personas and allowlists, so a caller must prove it is on this machine before
 * it is admitted. `trusted-host` stays available but has to be asked for
 * explicitly — a trusted Host/Origin only proves reachability, not identity.
 */
export function resolveRpcAuthority(value) {
  if (value === undefined) return 'loopback';
  if (RPC_AUTHORITIES.has(value)) return value;
  throw new TypeError('dsh-im rpcAuthority must be "loopback" or "trusted-host"');
}
