import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    contrastRatio,
    generateThemeTokens,
    hexToHsl,
    isHexColor,
} from "../lib/shared/theme.ts";

const SAMPLE_COLORS = ["#007f6d", "#ffcc00", "#ef4444", "#3b82f6", "#777777"];

describe("generateThemeTokens", () => {
    it("builds complete light and dark semantic palettes", () => {
        for (const primary_color of SAMPLE_COLORS) {
            const generated = generateThemeTokens(primary_color);
            assert.deepEqual(Object.keys(generated.dark), Object.keys(generated.light));
            assert.ok(Object.keys(generated.light).length > 40);
            assert.ok(Object.values(generated.light).every(isHexColor));
            assert.ok(Object.values(generated.dark).every(isHexColor));
        }
    });

    it("keeps white text AA-readable on strong action and status colors", () => {
        for (const primary_color of SAMPLE_COLORS) {
            const { light } = generateThemeTokens(primary_color);
            for (const token of ["--color-brand-500", "--color-ok-strong", "--color-warn-strong", "--color-bad-strong"]) {
                assert.ok(contrastRatio(light[token]!, "#ffffff") >= 4.5, `${primary_color} ${token}`);
            }
        }
    });

    it("uses split-complementary accents for chromatic colors", () => {
        const generated = generateThemeTokens("#3b82f6");
        const primary_hue = hexToHsl(generated.light["--color-brand-500"]!).h;
        const secondary_hue = hexToHsl(generated.secondary).h;
        const tertiary_hue = hexToHsl(generated.tertiary).h;

        assert.equal(generated.harmony, "Split-complementary harmony");
        assert.ok(Math.abs(((secondary_hue - primary_hue + 360) % 360) - 150) < 3);
        assert.ok(Math.abs(((tertiary_hue - primary_hue + 360) % 360) - 210) < 3);
    });

    it("gives neutral selections useful teal and blue accents", () => {
        const generated = generateThemeTokens("#777777");
        assert.equal(generated.harmony, "Teal accent harmony");
        assert.ok(hexToHsl(generated.secondary).s > 50);
        assert.ok(hexToHsl(generated.tertiary).s > 50);
    });
});
