// ============================================================================
// Key bindings: the keyboard actions, two keys each, rebindable in the menu's Controls tab and saved in localStorage
// `fastroads.keys`. Esc always opens the menu (it also cancels rebinding, so it can't be bound). Gamepad buttons and
// the mouse wheel are fixed (input.ts).
// ============================================================================
export const ACTIONS = {
  throttle: 'Throttle',
  brake: 'Brake / reverse',
  left: 'Steer left',
  right: 'Steer right',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  restart: 'Restart lap',
  camera: 'Change camera',
  gearbox: 'Automatic / manual gears',
  tc: 'Traction control on / off',
  steering: 'Mouse steering on / off',
  mute: 'Sound on / off',
  help: 'Show / hide key help',
  menu: 'Pause menu',
} as const;
export type Action = keyof typeof ACTIONS;
export const ACTION_KEYS = Object.keys(ACTIONS) as Action[];

export type Slot = 0 | 1;
export type Bindings = Record<Action, [string | null, string | null]>;   // KeyboardEvent.code per slot, null = unbound

export const MENU_KEY = 'Escape';   // fixed: opens the menu, closes it, cancels a rebind

export const DEFAULT_BINDINGS: Readonly<Bindings> = {
  throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE', null], shiftDown: ['KeyQ', null], restart: ['KeyR', 'Enter'], camera: ['KeyC', null],
  gearbox: ['KeyG', null], tc: ['KeyT', null], steering: ['KeyV', null], mute: ['KeyM', null], help: ['KeyH', null],
  menu: ['KeyP', null],
};

const STORE_KEY = 'fastroads.keys';

export const copyBindings = (b: Readonly<Bindings>): Bindings =>
  Object.fromEntries(ACTION_KEYS.map((a) => [a, [...b[a]]])) as Bindings;

const validCode = (c: unknown): c is string => typeof c === 'string' && c.length > 0 && c.length < 40 && c !== MENU_KEY;

// Saved bindings, with anything missing or invalid replaced by its default (and no key bound twice).
export function loadBindings(): Bindings {
  const b = copyBindings(DEFAULT_BINDINGS);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (!saved || typeof saved !== 'object') return b;
    for (const a of ACTION_KEYS) {
      const v = (saved as Record<string, unknown>)[a];
      if (Array.isArray(v) && v.length === 2 && v.every((c) => c === null || validCode(c))) b[a] = [v[0], v[1]];
    }
  } catch { return copyBindings(DEFAULT_BINDINGS); }
  // a key on two actions (hand-edited storage): keep the first
  const seen = new Set<string>();
  for (const a of ACTION_KEYS) for (const s of [0, 1] as const) {
    const c = b[a][s];
    if (c && seen.has(c)) b[a][s] = null; else if (c) seen.add(c);
  }
  return b;
}

export function saveBindings(b: Readonly<Bindings>) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(b)); } catch { /* storage unavailable */ }
}

// Put a key on an action's slot (null clears it). The key leaves whatever action had it: one key, one action.
export function bindKey(b: Readonly<Bindings>, action: Action, slot: Slot, code: string | null): Bindings {
  const out = copyBindings(b);
  if (code === MENU_KEY) return out;
  if (code) for (const a of ACTION_KEYS) for (const s of [0, 1] as const) if (out[a][s] === code) out[a][s] = null;
  out[action][slot] = code;
  return out;
}

// The keys bound to an action, in slot order.
export const keysFor = (b: Readonly<Bindings>, a: Action) => b[a].filter((c): c is string => c != null);

const NAMED: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', Escape: 'Esc',
  Backspace: 'Backspace', Tab: 'Tab', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', MetaLeft: 'L Meta', MetaRight: 'R Meta',
  CapsLock: 'Caps', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', PageUp: 'PgUp', PageDown: 'PgDn',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End',
};

// A short label for a KeyboardEvent.code: 'KeyW' -> 'W', 'Digit1' -> '1', 'Numpad8' -> 'Num 8', 'ArrowUp' -> '↑'.
export function keyLabel(code: string): string {
  if (NAMED[code]) return NAMED[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + ({ Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Decimal: '.', Enter: 'Enter' }[m[1]] ?? m[1]);
  return code;
}
