import { describe, expect, it } from "vitest";
import { CodeModeOutputImpl, isCanonicalBase64ImageData } from "../src/overseer.js";

describe("code mode image output", () => {
  it("validates screenshot-sized base64 without overflowing the stack", () => {
    expect(isCanonicalBase64ImageData("A".repeat(8 * 1024 * 1024))).toBe(true);
  });

  it.each([
    ["A", false],
    ["AA=A", false],
    ["AA==", true],
    ["AB==", false],
    ["AAA=", true],
    ["AAB=", false],
    ["AAAA", true],
    ["AAAA====", false],
    ["AAAA\n", false],
  ])("recognizes canonical base64 %j", (data, expected) => {
    expect(isCanonicalBase64ImageData(data)).toBe(expected);
  });

  it("accepts supported image signatures and returns a defensive copy", () => {
    const output = new CodeModeOutputImpl();
    output.image("iVBORw0KGgo=", "image/png");
    output.image("/9j/", "image/jpeg");
    output.image("UklGRgAAAABXRUJQ", "image/webp");

    const images = output.takeImages();
    expect(images.map(image => image.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    images.length = 0;
    expect(output.takeImages()).toHaveLength(3);
  });

  it("rejects an image whose bytes do not match its declared type", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image("iVBORw0KGgo=", "image/jpeg"))
      .toThrow("image bytes do not match their MIME type");
  });

  it("rejects unsupported media types", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image("iVBORw0KGgo=", "image/gif"))
      .toThrow("unsupported image type");
  });

  it("bounds the image count", () => {
    const output = new CodeModeOutputImpl();
    for (let i = 0; i < 4; i++) output.image("iVBORw0KGgo=", "image/png");
    expect(() => output.image("iVBORw0KGgo=", "image/png"))
      .toThrow("at most 4 images");
  });

  it("rejects encoded payloads larger than the aggregate byte budget", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image("A".repeat(8 * 1024 * 1024 + 4), "image/png"))
      .toThrow("canonical base64");
  });
});
