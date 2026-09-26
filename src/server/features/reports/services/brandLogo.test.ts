import { describe, expect, it } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  brandLogoKey,
  logoDimensions,
  parseLogoDataUrl,
} from "./brandLogo";

function toDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 29); // IEND marker bytes
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI + SOF0 (length 11: precision + h + w + components) + EOI.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b]);
  const dims = new Uint8Array([0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  const view = new DataView(dims.buffer);
  view.setUint16(1, height);
  view.setUint16(3, width);
  const out = new Uint8Array(6 + dims.length + 2);
  out.set(bytes, 0);
  out.set(dims, 6);
  out.set([0xff, 0xd9], 6 + dims.length);
  return out;
}

describe("parseLogoDataUrl", () => {
  it("accepts PNG and JPEG data URLs", () => {
    const png = parseLogoDataUrl(toDataUrl("image/png", pngBytes(100, 50)));
    expect(png.mime).toBe("image/png");
    expect(png.bytes.length).toBeGreaterThan(0);
    const jpeg = parseLogoDataUrl(
      toDataUrl("image/jpeg", jpegBytes(100, 50)),
    );
    expect(jpeg.mime).toBe("image/jpeg");
  });

  it("rejects non-image, SVG, WebP, and malformed URLs", () => {
    for (const input of [
      "not-a-url",
      toDataUrl("image/svg+xml", pngBytes(10, 10)),
      toDataUrl("image/webp", pngBytes(10, 10)),
      toDataUrl("text/plain", new Uint8Array([1, 2, 3])),
      "data:image/png;base64,!!!",
    ]) {
      expect(() => parseLogoDataUrl(input)).toThrow(AppError);
    }
  });

  it("rejects empty and oversized payloads", () => {
    expect(() =>
      parseLogoDataUrl(toDataUrl("image/png", new Uint8Array(0))),
    ).toThrow(AppError);
    expect(() =>
      parseLogoDataUrl(
        toDataUrl("image/png", new Uint8Array(512 * 1024 + 1)),
      ),
    ).toThrow(AppError);
  });
});

describe("logoDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(
      logoDimensions({ mime: "image/png", bytes: pngBytes(800, 600) }),
    ).toEqual({ width: 800, height: 600 });
  });

  it("reads JPEG dimensions from SOF0", () => {
    expect(
      logoDimensions({ mime: "image/jpeg", bytes: jpegBytes(300, 200) }),
    ).toEqual({ width: 300, height: 200 });
  });

  it("rejects corrupt magic and oversized images", () => {
    expect(() =>
      logoDimensions({
        mime: "image/png",
        bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      }),
    ).toThrow(AppError);
    expect(() =>
      logoDimensions({ mime: "image/png", bytes: pngBytes(2048, 10) }),
    ).toThrow(AppError);
    expect(() =>
      logoDimensions({ mime: "image/jpeg", bytes: jpegBytes(10, 5000) }),
    ).toThrow(AppError);
    expect(() =>
      logoDimensions({
        mime: "image/jpeg",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }),
    ).toThrow(AppError);
  });
});

describe("brandLogoKey", () => {
  it("derives stable content-addressed keys per scope", async () => {
    const bytes = pngBytes(10, 10);
    const first = await brandLogoKey("org-1", bytes, "image/png");
    const second = await brandLogoKey("org-1", bytes, "image/png");
    expect(first).toBe(second);
    expect(first).toMatch(/^branding\/org-1\/[0-9a-f]{64}\.png$/);
    const other = await brandLogoKey("org-2", bytes, "image/png");
    expect(other).not.toBe(first);
  });
});
