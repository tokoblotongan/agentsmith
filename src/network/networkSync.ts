// ─────────────────────────────────────────────────────────────────────────────
// NetworkSync — Phase 1: dependency-free stub (single-player, zero cost).
// Phase 2: uncomment the Supabase blocks below, add your URL/anon key in
// gameConfig.ts, set network.enabled = true. Nothing else in the game changes:
// main loop already broadcasts at a fixed tick rate and renders remote agents.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentAnimationState } from '../character/agentSmith';

export interface NetworkConfig {
  enabled?: boolean;
  tickRate?: number;
  channelName?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface PlayerNetState {
  id?: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  animationState: AgentAnimationState;
  sentAt: number;
}

type RemoteListener = (payload: PlayerNetState) => void;

export class NetworkSync {
  public readonly config: NetworkConfig;
  public readonly enabled: boolean;
  public readonly playerId: string;
  private _listeners: Set<RemoteListener>;
  private _channel: unknown;

  constructor(config: NetworkConfig = {}) {
    this.config = config;
    this.enabled = !!config.enabled;
    this.playerId =
      globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : 'p-' + Math.random().toString(36).slice(2, 10);
    this._listeners = new Set();
    this._channel = null;
  }

  async connect(): Promise<boolean> {
    if (!this.enabled) return false;
    console.info('[NetworkSync] enabled=true, but Supabase wiring is still commented out.');
    return false;
  }

  /** Called ~tickRate times/sec with the local player's state. */
  broadcastState(_state: PlayerNetState): void {
    if (!this.enabled || !this._channel) return; // no-op in Phase 1
  }

  /** Subscribe to remote player states. Returns an unsubscribe function. */
  onRemotePlayerUpdate(callback: RemoteListener): () => void {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  disconnect(): void {
    this._channel = null;
    this._listeners.clear();
  }
}
