export const THEME_STORAGE = {
    mode: "serverManager.theme",
    palette: "serverManager.colorTheme",
    primary: "serverManager.primaryColor",
    custom_tokens: "serverManager.customThemeTokens",
} as const;

export type ThemeMode = "system" | "light" | "dark";
export type PresetPalette = "violet" | "ocean" | "emerald";
export type ThemePalette = PresetPalette | "custom";
export type ThemeTokenMap = Record<string, string>;

export interface GeneratedTheme {
    light: ThemeTokenMap;
    dark: ThemeTokenMap;
    secondary: string;
    tertiary: string;
    neutral: string;
    warning: string;
    danger: string;
    harmony: string;
}

interface HslColor {
    h: number;
    s: number;
    l: number;
}

interface AccessibleColor {
    color: string;
    lightness: number;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function isHexColor(value: unknown): value is string {
    return typeof value === "string" && HEX_COLOR.test(value);
}

export function hexToHsl(hex: string): HslColor {
    if (!isHexColor(hex)) throw new Error(`Invalid hex color: ${hex}`);

    const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
    const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;

    if (max === min) return { h: 0, s: 0, l: lightness * 100 };

    const delta = max - min;
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue = 0;

    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);

    return { h: hue < 0 ? hue + 360 : hue, s: saturation * 100, l: lightness * 100 };
}

export function hslToHex(hue: number, saturation: number, lightness: number): string {
    const normalized_hue = (((hue % 360) + 360) % 360) / 60;
    const normalized_saturation = clamp(saturation, 0, 100) / 100;
    const normalized_lightness = clamp(lightness, 0, 100) / 100;
    const chroma = (1 - Math.abs(2 * normalized_lightness - 1)) * normalized_saturation;
    const x = chroma * (1 - Math.abs((normalized_hue % 2) - 1));
    const pairs = [
        [chroma, x, 0],
        [x, chroma, 0],
        [0, chroma, x],
        [0, x, chroma],
        [x, 0, chroma],
        [chroma, 0, x],
    ];
    const [red = 0, green = 0, blue = 0] = pairs[Math.floor(normalized_hue) % 6] ?? [];
    const match = normalized_lightness - chroma / 2;

    return `#${[red, green, blue]
        .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
        .join("")}`;
}

export function relativeLuminance(hex: string): number {
    if (!isHexColor(hex)) throw new Error(`Invalid hex color: ${hex}`);
    const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => {
        const value = Number.parseInt(part, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

export function contrastRatio(first: string, second: string): number {
    const first_luminance = relativeLuminance(first);
    const second_luminance = relativeLuminance(second);
    const lighter = Math.max(first_luminance, second_luminance);
    const darker = Math.min(first_luminance, second_luminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function accessibleColor(hue: number, saturation: number, lightness: number): AccessibleColor {
    let next_lightness = Math.min(lightness, 48);
    let color = hslToHex(hue, saturation, next_lightness);

    while (contrastRatio(color, "#ffffff") < 4.5 && next_lightness > 20) {
        next_lightness -= 1;
        color = hslToHex(hue, saturation, next_lightness);
    }

    return { color, lightness: next_lightness };
}

function chooseHarmony(primary_hsl: HslColor, palette_saturation: number) {
    if (primary_hsl.s < 8) {
        return { secondary_hue: 168, tertiary_hue: 208, saturation: 68, label: "Teal accent harmony" };
    }

    return {
        secondary_hue: (primary_hsl.h + 150) % 360,
        tertiary_hue: (primary_hsl.h + 210) % 360,
        saturation: clamp(palette_saturation * 0.82, 52, 72),
        label: "Split-complementary harmony",
    };
}

/** Builds a complete semantic light/dark palette from one user-selected color. */
export function generateThemeTokens(primary_color: string): GeneratedTheme {
    const normalized_color = primary_color.toLowerCase();
    const primary_hsl = hexToHsl(normalized_color);
    const palette_saturation = primary_hsl.s < 8 ? 0 : clamp(primary_hsl.s, 45, 85);
    const neutral_saturation = palette_saturation === 0 ? 0 : clamp(palette_saturation * 0.14, 6, 12);
    const harmony = chooseHarmony(primary_hsl, palette_saturation);
    const status_saturation = clamp(palette_saturation * 0.8, 58, 78);
    const accessible = accessibleColor(primary_hsl.h, palette_saturation, primary_hsl.l);
    const secondary = accessibleColor(harmony.secondary_hue, harmony.saturation, 42);
    const tertiary = accessibleColor(harmony.tertiary_hue, harmony.saturation, 42);
    const success_strong = accessibleColor(145, status_saturation, 38).color;
    const warning_strong = accessibleColor(38, Math.min(88, status_saturation + 10), 38).color;
    const danger_strong = accessibleColor(350, status_saturation, 40).color;
    const color = (hue: number, saturation: number, lightness: number) => hslToHex(hue, saturation, lightness);

    const light: ThemeTokenMap = {
        "--color-brand-50": color(primary_hsl.h, palette_saturation, 97),
        "--color-brand-100": color(primary_hsl.h, palette_saturation, 93),
        "--color-brand-200": color(primary_hsl.h, palette_saturation, 85),
        "--color-brand-300": color(primary_hsl.h, palette_saturation, 72),
        "--color-brand-500": accessible.color,
        "--color-brand-600": color(primary_hsl.h, palette_saturation, Math.max(22, accessible.lightness - 8)),
        "--color-brand-700": color(primary_hsl.h, palette_saturation, Math.max(16, accessible.lightness - 16)),
        "--color-canvas": color(primary_hsl.h, neutral_saturation, 94),
        "--color-surface": color(primary_hsl.h, neutral_saturation, 100),
        "--color-panel": color(primary_hsl.h, neutral_saturation, 98),
        "--color-subtle": color(primary_hsl.h, neutral_saturation, 97),
        "--color-subtle-2": color(primary_hsl.h, neutral_saturation, 94),
        "--color-line": color(primary_hsl.h, neutral_saturation, 93),
        "--color-line-2": color(primary_hsl.h, neutral_saturation, 87),
        "--color-line-soft": color(primary_hsl.h, neutral_saturation, 95),
        "--color-ink": color(primary_hsl.h, neutral_saturation + 5, 12),
        "--color-ink-2": color(primary_hsl.h, neutral_saturation + 4, 25),
        "--color-body": color(primary_hsl.h, neutral_saturation + 2, 36),
        "--color-muted": color(primary_hsl.h, neutral_saturation, 44),
        "--color-faint": color(primary_hsl.h, neutral_saturation, 60),
        "--color-faintest": color(primary_hsl.h, neutral_saturation, 78),
        "--color-accent": color(primary_hsl.h, neutral_saturation + 5, 12),
        "--color-accent-2": color(primary_hsl.h, neutral_saturation + 4, 22),
        "--color-on-accent": "#ffffff",
        "--color-ok": success_strong,
        "--color-ok-soft": color(145, status_saturation, 96),
        "--color-ok-strong": success_strong,
        "--color-warn": warning_strong,
        "--color-warn-soft": color(38, status_saturation, 96),
        "--color-warn-strong": warning_strong,
        "--color-bad": danger_strong,
        "--color-bad-soft": color(350, status_saturation, 96),
        "--color-bad-strong": danger_strong,
        "--color-info": accessible.color,
        "--color-info-soft": color(primary_hsl.h, palette_saturation, 96),
        "--color-alt": secondary.color,
        "--color-alt-soft": color(harmony.secondary_hue, harmony.saturation, 96),
        "--color-secondary": secondary.color,
        "--color-secondary-soft": color(harmony.secondary_hue, harmony.saturation, 96),
        "--color-tertiary": tertiary.color,
        "--color-tertiary-soft": color(harmony.tertiary_hue, harmony.saturation, 96),
        "--color-brand-fg": accessible.color,
        "--color-brand-soft": color(primary_hsl.h, palette_saturation, 96),
        "--color-neutral": color(primary_hsl.h, neutral_saturation, 40),
        "--color-neutral-soft": color(primary_hsl.h, neutral_saturation, 94),
    };

    const dark: ThemeTokenMap = {
        "--color-brand-50": color(primary_hsl.h, palette_saturation, 13),
        "--color-brand-100": color(primary_hsl.h, palette_saturation, 18),
        "--color-brand-200": color(primary_hsl.h, palette_saturation, 25),
        "--color-brand-300": color(primary_hsl.h, palette_saturation, 70),
        "--color-brand-500": accessible.color,
        "--color-brand-600": color(primary_hsl.h, palette_saturation, Math.max(22, accessible.lightness - 8)),
        "--color-brand-700": color(primary_hsl.h, palette_saturation, Math.max(16, accessible.lightness - 16)),
        "--color-canvas": color(primary_hsl.h, neutral_saturation + 2, 5),
        "--color-surface": color(primary_hsl.h, neutral_saturation + 2, 9),
        "--color-panel": color(primary_hsl.h, neutral_saturation + 2, 7),
        "--color-subtle": color(primary_hsl.h, neutral_saturation + 2, 12),
        "--color-subtle-2": color(primary_hsl.h, neutral_saturation + 2, 16),
        "--color-line": color(primary_hsl.h, neutral_saturation + 2, 16),
        "--color-line-2": color(primary_hsl.h, neutral_saturation + 2, 22),
        "--color-line-soft": color(primary_hsl.h, neutral_saturation + 2, 13),
        "--color-ink": color(primary_hsl.h, neutral_saturation, 92),
        "--color-ink-2": color(primary_hsl.h, neutral_saturation, 80),
        "--color-body": color(primary_hsl.h, neutral_saturation, 68),
        "--color-muted": color(primary_hsl.h, neutral_saturation, 60),
        "--color-faint": color(primary_hsl.h, neutral_saturation, 48),
        "--color-faintest": color(primary_hsl.h, neutral_saturation, 34),
        "--color-accent": color(primary_hsl.h, neutral_saturation, 92),
        "--color-accent-2": color(primary_hsl.h, neutral_saturation, 82),
        "--color-on-accent": color(primary_hsl.h, neutral_saturation + 2, 5),
        "--color-ok": color(145, status_saturation, 68),
        "--color-ok-soft": color(145, status_saturation * 0.72, 12),
        "--color-ok-strong": success_strong,
        "--color-warn": color(42, Math.min(90, status_saturation + 10), 68),
        "--color-warn-soft": color(42, status_saturation * 0.72, 12),
        "--color-warn-strong": warning_strong,
        "--color-bad": color(350, Math.min(85, status_saturation + 7), 72),
        "--color-bad-soft": color(350, status_saturation * 0.72, 13),
        "--color-bad-strong": danger_strong,
        "--color-info": color(primary_hsl.h, palette_saturation, 75),
        "--color-info-soft": color(primary_hsl.h, 48, 13),
        "--color-alt": color(harmony.secondary_hue, harmony.saturation, 75),
        "--color-alt-soft": color(harmony.secondary_hue, 48, 13),
        "--color-secondary": color(harmony.secondary_hue, harmony.saturation, 75),
        "--color-secondary-soft": color(harmony.secondary_hue, 48, 13),
        "--color-tertiary": color(harmony.tertiary_hue, harmony.saturation, 75),
        "--color-tertiary-soft": color(harmony.tertiary_hue, 48, 13),
        "--color-brand-fg": color(primary_hsl.h, palette_saturation, 75),
        "--color-brand-soft": color(primary_hsl.h, 48, 13),
        "--color-neutral": color(primary_hsl.h, neutral_saturation, 60),
        "--color-neutral-soft": color(primary_hsl.h, neutral_saturation + 2, 16),
    };

    return {
        light,
        dark,
        secondary: light["--color-secondary"]!,
        tertiary: light["--color-tertiary"]!,
        neutral: light["--color-neutral"]!,
        warning: light["--color-warn"]!,
        danger: light["--color-bad"]!,
        harmony: harmony.label,
    };
}

export const CUSTOM_THEME_PROPERTIES = Object.keys(generateThemeTokens("#007f6d").light);
