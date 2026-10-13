import { describe, expect, it } from "vitest";
import { CodeModeOutputImpl } from "../src/overseer.js";

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff);
const WEBP = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
);

describe("code mode image output", () => {
  it("accepts supported image signatures and returns a defensive copy", () => {
    const output = new CodeModeOutputImpl();
    const png = PNG.slice();
    output.image(png, "image/png");
    output.image(JPEG, "image/jpeg");
    output.image(WEBP, "image/webp");
    png[0] = 0;

    const images = output.takeImages();
    expect(images.map(image => image.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    expect(images[0].data).toEqual(PNG);
    images.length = 0;
    expect(output.takeImages()).toHaveLength(3);
  });

  it("rejects an image whose bytes do not match its declared type", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image(PNG, "image/jpeg"))
      .toThrow("image bytes do not match their MIME type");
  });

  it("rejects unsupported media types", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image(PNG, "image/gif"))
      .toThrow("unsupported image type");
  });

  it("rejects string data instead of decoding base64 at the capability boundary", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image("iVBORw0KGgo=" as unknown as Uint8Array, "image/png"))
      .toThrow("must be a Uint8Array");
  });

  it("bounds the image count", () => {
    const output = new CodeModeOutputImpl();
    for (let i = 0; i < 4; i++) output.image(PNG, "image/png");
    expect(() => output.image(PNG, "image/png"))
      .toThrow("at most 4 images");
  });

  it("rejects payloads larger than the aggregate byte budget", () => {
    const output = new CodeModeOutputImpl();
    const oversized = new Uint8Array(6 * 1024 * 1024 + 1);
    oversized.set(PNG);
    expect(() => output.image(oversized, "image/png"))
      .toThrow("exceeds 6 MiB");
  });
});
