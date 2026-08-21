import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeEnvView } from "../lib/shared/view-model.ts";

describe("normalizeEnvView", () => {
  it("defaults to table for empty or unsupported values", () => {
    assert.equal(normalizeEnvView(undefined), "table");
    assert.equal(normalizeEnvView("legacy"), "table");
  });

  it("accepts the matrix view option", () => {
    assert.equal(normalizeEnvView("matrix"), "matrix");
    assert.equal(normalizeEnvView("table"), "table");
  });
});
