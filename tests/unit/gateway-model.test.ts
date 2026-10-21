import { describe, expect, it } from "vitest";
import { wireModel } from "@/lib/ai/anthropic";

describe("wireModel", () => {
  it("keeps Anthropic ids when calling the Anthropic API directly", () => {
    expect(wireModel("claude-haiku-4-5", false)).toBe("claude-haiku-4-5");
  });

  it("maps to Vercel AI Gateway ids", () => {
    expect(wireModel("claude-haiku-4-5", true)).toBe("anthropic/claude-haiku-4.5");
    expect(wireModel("claude-sonnet-4-5", true)).toBe("anthropic/claude-sonnet-4.5");
    expect(wireModel("claude-sonnet-5", true)).toBe("anthropic/claude-sonnet-5");
  });

  it("leaves ids that are already in gateway form", () => {
    expect(wireModel("anthropic/claude-opus-5", true)).toBe("anthropic/claude-opus-5");
  });
});
