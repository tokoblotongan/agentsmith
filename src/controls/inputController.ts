// Local keyboard -> normalized movement intent.
// The character NEVER reads the keyboard directly; main loop feeds intents in.
// This keeps AgentSmith reusable for remote (Supabase-driven) players later.

const KEYMAP = {
  forward:  ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left:     ['KeyA', 'ArrowLeft'],
  right:    ['KeyD', 'ArrowRight'],
  sprint:   ['ShiftLeft', 'ShiftRight'],
} as const;

const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export interface MovementIntent {
  forward: number;
  turn: number;
  sprint: boolean;
}

export class InputController {
  private _target: Window | HTMLElement;
  private _keys: Set<string>;
  private _onDown: (e: Event) => void;
  private _onUp: (e: Event) => void;
  private _onBlur: () => void;

  constructor(target: Window | HTMLElement = window) {
    this._target = target;
    this._keys = new Set();

    this._onDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (PREVENT_DEFAULT.has(ke.code)) ke.preventDefault();
      this._keys.add(ke.code);
    };
    this._onUp = (e: Event) => {
      const ke = e as KeyboardEvent;
      this._keys.delete(ke.code);
    };
    this._onBlur = () => this._keys.clear(); // avoid "stuck keys" on tab switch

    target.addEventListener('keydown', this._onDown);
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
  }

  private _any(codes: readonly string[]): boolean {
    return codes.some((c) => this._keys.has(c));
  }

  /** values in [-1, 1] */
  getIntent(): MovementIntent {
    const forward = (this._any(KEYMAP.forward) ? 1 : 0) - (this._any(KEYMAP.backward) ? 1 : 0);
    const turn    = (this._any(KEYMAP.left)    ? 1 : 0) - (this._any(KEYMAP.right)    ? 1 : 0);
    return { forward, turn, sprint: this._any(KEYMAP.sprint) };
  }

  dispose(): void {
    this._target.removeEventListener('keydown', this._onDown);
    this._target.removeEventListener('keyup', this._onUp);
    this._target.removeEventListener('blur', this._onBlur);
  }
}
