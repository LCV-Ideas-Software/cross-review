import type { AppConfig, PeerId } from "./types.js";

/** Resolve the effective provider output ceiling with legacy fallback. */
export function maxOutputTokensForPeer(config: AppConfig, peer: PeerId): number {
  return config.max_output_tokens_by_peer?.[peer] ?? config.max_output_tokens;
}
