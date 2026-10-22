import { CAM_MODES, type CamMode } from './camera';
import { CARS, type CarId } from './cars';
import type { MouseDeadzone, MouseSensitivity } from './input';
import { wrapI } from './util';

// ============================================================================
// Player settings: menu rows, defaults and persistence. What each one does is the applySetting table in main.ts.
// ============================================================================
type OnOff = 'on' | 'off';

export interface Settings {
  car: CarId; gearbox: 'auto' | 'manual'; steering: 'keyboard' | 'mouse';
  mouseSens: MouseSensitivity; mouseDeadzone: MouseDeadzone; camera: CamMode; tc: OnOff; sound: OnOff;
}
export type SettingKey = keyof Settings;
interface SettingDef<K extends SettingKey> { label: string; options: [value: Settings[K], text: string][] }

const CAM_LABELS: Record<CamMode, string> = { onboard: 'Onboard', chase: 'Chase', far: 'Far' };

// Menu rows, in display order.
export const SETTING_DEFS: { [K in SettingKey]: SettingDef<K> } = {
  car: { label: 'Car', options: Object.values(CARS).map((c) => [c.id, c.name]) },
  gearbox: { label: 'Gears', options: [['auto', 'Automatic'], ['manual', 'Manual']] },
  steering: { label: 'Steering', options: [['keyboard', 'Keyboard'], ['mouse', 'Mouse']] },
  mouseSens: { label: 'Mouse sensitivity', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  mouseDeadzone: { label: 'Mouse deadzone', options: [['off', 'Off'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  camera: { label: 'Camera', options: CAM_MODES.map((m) => [m, CAM_LABELS[m]]) },
  tc: { label: 'Traction control', options: [['on', 'On'], ['off', 'Off']] },
  sound: { label: 'Sound', options: [['on', 'On'], ['off', 'Off']] },
};
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];
export const DEFAULT_SETTINGS: Settings = {
  car: 'f1', gearbox: 'auto', steering: 'keyboard', mouseSens: 'medium', mouseDeadzone: 'small', camera: 'onboard', tc: 'on', sound: 'on',
};

const SETTINGS_KEY = 'fastroads.settings';

// Saved settings, with anything unknown or invalid replaced by its default.
export function loadSettings(): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  try {
    // carry over choices saved by earlier versions (validated below)
    const g = localStorage.getItem('fastroads.gearbox'), st = localStorage.getItem('fastroads.steering');
    if (g) settings.gearbox = g as Settings['gearbox'];
    if (st) settings.steering = st as Settings['steering'];
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch { /* storage unavailable */ }
  const validate = <K extends SettingKey>(k: K) => {
    if (!SETTING_DEFS[k].options.some(([v]) => v === settings[k])) settings[k] = DEFAULT_SETTINGS[k];
  };
  SETTING_KEYS.forEach(validate);
  return settings;
}

export function saveSettings(settings: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// The option after (dir 1) or before (dir -1) the current one, wrapping round.
export function nextOption<K extends SettingKey>(key: K, current: Settings[K], dir = 1): Settings[K] {
  const opts = SETTING_DEFS[key].options, i = opts.findIndex(([v]) => v === current);
  return opts[wrapI(i + dir, opts.length)][0];
}
