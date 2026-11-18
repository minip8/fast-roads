import { CAM_MODES, type CamMode } from './camera';
import { CARS, type CarId } from './cars';
import type { MouseDeadzone, MouseSensitivity, PadDeadzone } from './input';
import type { MirrorMode } from './mirror';
import { TRACKS, type TrackId } from './tracks';
import type { SceneryDetail } from './stage';
import { clamp, wrapI } from './util';
import type { WeatherQuality } from './weather';

// ============================================================================
// Player settings: menu rows, defaults and persistence. What each one does is the applySetting table in main.ts.
// ============================================================================
type OnOff = 'on' | 'off';

export interface Settings {
  // race (the menu's Race tab)
  track: TrackId; car: CarId;
  // driving
  gearbox: 'auto' | 'manual'; tc: OnOff; assist: OnOff; ghost: OnOff;
  // controls
  steering: 'keyboard' | 'mouse'; mouseSens: MouseSensitivity; mouseDeadzone: MouseDeadzone; padDeadzone: PadDeadzone;
  // camera
  camera: CamMode; fov: number; speedFov: OnOff; shake: OnOff; hands: OnOff;
  // HUD
  units: 'kmh' | 'mph'; timingPanel: 'full' | 'compact' | 'off'; delta: OnOff; minimap: 'off' | 'small' | 'medium' | 'large';
  tyres: OnOff; mirror: MirrorMode; mouseBar: OnOff; help:'auto' | 'always' | 'off'; fps: OnOff; hudScale: number; hudOpacity: number;
  // graphics
  resolution: number; shadows: 'off' | 'low' | 'high'; brightness: number; weather: WeatherQuality; scenery: SceneryDetail;
  // audio
  sound: OnOff; volume: number;
}
export type SettingKey = keyof Settings;

// Where a setting is in the menu: the Race tab (car, circuit), a section of the Settings tab, or the Controls tab.
export type SettingSection = 'race' | 'driving' | 'controls' | 'camera' | 'hud' | 'graphics' | 'audio';
export const SECTIONS: [SettingSection, string][] = [
  ['driving', 'Driving'], ['camera', 'Camera'], ['hud', 'HUD'], ['graphics', 'Graphics'], ['audio', 'Audio'],
];

interface SettingDef<K extends SettingKey> {
  label: string;
  section: SettingSection;
  hint?: string;                                // one line under the label; {action} is replaced by that action's keys
  options: [value: Settings[K], text: string][];
  slider?: boolean;                             // a slider over the options (in order) instead of buttons; ← → stop at the ends
}

const CAM_LABELS: Record<CamMode, string> = { onboard: 'Onboard', driver: 'Driver', chase: 'Chase', far: 'Far' };
const onOff = (on = 'On', off = 'Off'): [OnOff, string][] => [['on', on], ['off', off]];
const steps = (from: number, to: number, step: number, text: (v: number) => string): [number, string][] => {
  const out: [number, string][] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push([v, text(v)]);
  return out;
};
const pct = (v: number) => v + '%';

// Menu rows, in display order within each section.
export const SETTING_DEFS: { [K in SettingKey]: SettingDef<K> } = {
  track: { label: 'Circuit', section: 'race', options: Object.values(TRACKS).map((t) => [t.id, t.name]) },
  car: { label: 'Car', section: 'race', options: Object.values(CARS).map((c) => [c.id, c.name]) },

  gearbox: { label: 'Gears', section: 'driving', hint: 'Manual: shift with {shiftUp} / {shiftDown}, RB / LB or the mouse wheel', options: [['auto', 'Automatic'], ['manual', 'Manual']] },
  tc: { label: 'Traction control', section: 'driving', hint: 'Limits wheelspin on the throttle', options: onOff() },
  assist: { label: 'Countersteer assist', section: 'driving', hint: 'Drift car only: catches slides for you', options: [['off', 'Off'], ['on', 'On']] },
  ghost: { label: 'Ghost car', section: 'driving', hint: 'Your best lap here in this car, to race against', options: onOff('Shown', 'Hidden') },

  steering: { label: 'Steering', section: 'controls', hint: 'Mouse: the cursor’s distance from the screen centre turns the wheel', options: [['keyboard', 'Keyboard'], ['mouse', 'Mouse']] },
  mouseSens: { label: 'Mouse sensitivity', section: 'controls', hint: 'Low spreads the steering over more of the screen', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  mouseDeadzone: { label: 'Mouse deadzone', section: 'controls', hint: 'Room round the centre that does nothing', options: [['off', 'Off'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  padDeadzone: { label: 'Gamepad deadzone', section: 'controls', hint: 'Stick travel that does nothing', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },

  camera: { label: 'Camera', section: 'camera', hint: '{camera} cycles them while driving', options: CAM_MODES.map((m) => [m, CAM_LABELS[m]]) },
  fov: { label: 'Field of view', section: 'camera', hint: 'Added to every camera’s own', slider: true, options: steps(-15, 20, 5, (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '°') },
  speedFov: { label: 'Widen view with speed', section: 'camera', options: onOff() },
  shake: { label: 'Camera shake', section: 'camera', hint: 'Rumble on kerbs, grass and gravel', options: onOff() },
  hands: { label: 'Driver camera hands', section: 'camera', options: [['off', 'Hidden'], ['on', 'Shown']] },

  units: { label: 'Speed units', section: 'hud', options: [['kmh', 'km/h'], ['mph', 'mph']] },
  timingPanel: { label: 'Timing panel', section: 'hud', hint: 'Compact: lap time, delta and best lap only', options: [['full', 'Full'], ['compact', 'Compact'], ['off', 'Hidden']] },
  delta: { label: 'Live delta to best lap', section: 'hud', options: onOff('Shown', 'Hidden') },
  minimap: { label: 'Track map', section: 'hud', options: [['off', 'Hidden'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  tyres: { label: 'Tyre temperatures', section: 'hud', hint: 'F1 and GT3: blue cold, green in the working window, red hot', options: onOff('Shown', 'Hidden') },
  mirror: { label: 'Rear-view mirror', section: 'hud', hint: 'Hold {lookBack} to look behind', options: [['off', 'Hidden'], ['cockpit', 'Onboard & driver'], ['on', 'All cameras']] },
  mouseBar: { label: 'Mouse steering bar', section: 'hud', hint: 'Shows where the mouse holds the wheel', options: onOff('Shown', 'Hidden') },
  help: { label: 'Key help', section: 'hud', hint: 'At start: for the first seconds of driving; {help} shows it again', options: [['auto', 'At start'], ['always', 'Always'], ['off', 'Hidden']] },
  fps: { label: 'Frame rate counter', section: 'hud', options: onOff('Shown', 'Hidden') },
  hudScale: { label: 'HUD size', section: 'hud', slider: true, options: steps(70, 150, 10, pct) },
  hudOpacity: { label: 'Panel background', section: 'hud', hint: 'How dark the panels behind the HUD are', slider: true, options: steps(0, 100, 10, pct) },

  resolution: { label: 'Render resolution', section: 'graphics', hint: 'Lower is faster on slow GPUs and big screens', slider: true, options: steps(50, 100, 10, pct) },
  shadows: { label: 'Shadows', section: 'graphics', options: [['off', 'Off'], ['low', 'Low'], ['high', 'High']] },
  brightness: { label: 'Brightness', section: 'graphics', slider: true, options: steps(70, 130, 10, pct) },
  weather: { label: 'Weather effects', section: 'graphics', hint: 'Rain, spray and drops on the lens; lower is faster on slow GPUs', options: [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']] },
  scenery: { label: 'Scenery detail', section: 'graphics', hint: 'Low draws fewer trees; faster on slow GPUs', options: [['high', 'High'], ['low', 'Low']] },

  sound: { label: 'Sound', section: 'audio', options: onOff() },
  volume: { label: 'Volume', section: 'audio', slider: true, options: steps(0, 100, 10, pct) },
};
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];
export const DEFAULT_SETTINGS: Settings = {
  track: 'melbourne', car: 'lcf1',
  gearbox: 'auto', tc: 'on', assist: 'off', ghost: 'on',
  steering: 'keyboard', mouseSens: 'medium', mouseDeadzone: 'small', padDeadzone: 'medium',
  camera: 'onboard', fov: 0, speedFov: 'on', shake: 'on', hands: 'off',
  units: 'kmh', timingPanel: 'full', delta: 'on', minimap: 'medium', tyres: 'on', mirror: 'on', mouseBar: 'on', help: 'auto', fps: 'off', hudScale: 100, hudOpacity: 70,
  resolution: 100, shadows: 'high', brightness: 100, weather: 'full', scenery: 'high',
  sound: 'on', volume: 100,
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
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      for (const k of SETTING_KEYS) if (k in saved) (settings as Record<SettingKey, unknown>)[k] = (saved as Record<string, unknown>)[k];
    }
    // cars since removed: their twins on LibreCorsa's engine take their place
    const car: unknown = settings.car;
    if (car === 'f1' || car === 'gt3') settings.car = car === 'f1' ? 'lcf1' : 'lcgt3';
  } catch { /* storage unavailable or corrupt */ }
  const validate = <K extends SettingKey>(k: K) => {
    if (!SETTING_DEFS[k].options.some(([v]) => v === settings[k])) settings[k] = DEFAULT_SETTINGS[k];
  };
  SETTING_KEYS.forEach(validate);
  return settings;
}

export function saveSettings(settings: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// The option after (dir 1) or before (dir -1) the current one: wrapping round, or stopping at the ends of a slider.
export function nextOption<K extends SettingKey>(key: K, current: Settings[K], dir = 1): Settings[K] {
  const d = SETTING_DEFS[key], opts = d.options, i = opts.findIndex(([v]) => v === current);
  return opts[d.slider ? clamp(i + dir, 0, opts.length - 1) : wrapI(i + dir, opts.length)][0];
}

// The text shown for a setting's current value.
export function optionText<K extends SettingKey>(key: K, value: Settings[K]): string {
  return SETTING_DEFS[key].options.find(([v]) => v === value)?.[1] ?? String(value);
}
