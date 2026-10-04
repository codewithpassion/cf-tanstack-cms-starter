// biome-ignore-all lint/suspicious/noBitwiseOperators: ported verbatim; byte and bit arithmetic (binary headers, hashing, colour channels).
/** Test fixtures for media-bytes and media-service tests (not shipped: only test files import it). */

/**
 * Real encoder output (Pillow 12): odd sizes over 255 so byte order and off-by-one errors show.
 * jpegProgressiveExif has an APP1 (EXIF) segment before its SOF2; the three WebPs cover the
 * VP8 (lossy), VP8L (lossless) and VP8X (lossy + alpha) containers.
 */
export const FIXTURES = {
  jpeg: {
    w: 301,
    h: 7,
    b64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAHAS0DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDOooopH0gUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//9k=",
  },
  jpegProgressiveExif: {
    w: 17,
    h: 260,
    b64: "/9j/4AAQSkZJRgABAQAAAQABAAD/4QA2RXhpZgAATU0AKgAAAAgAAgEPAAIAAAAIAAAAJgESAAMAAAABAAYAAAAAAABUZXN0Q2FtAP/bAEMAEAsMDgwKEA4NDhIREBMYKBoYFhYYMSMlHSg6Mz08OTM4N0BIXE5ARFdFNzhQbVFXX2JnaGc+TXF5cGR4XGVnY//bAEMBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY//CABEIAQQAEQMBIgACEQEDEQH/xAAVAAEBAAAAAAAAAAAAAAAAAAAABP/EABYBAQEBAAAAAAAAAAAAAAAAAAABBf/aAAwDAQACEAMQAAABmE0gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//EABQQAQAAAAAAAAAAAAAAAAAAAGD/2gAIAQEAAQUCR//EABQRAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQMBAT8BC//EABQRAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQIBAT8BC//EABQQAQAAAAAAAAAAAAAAAAAAAGD/2gAIAQEABj8CR//EABQQAQAAAAAAAAAAAAAAAAAAAGD/2gAIAQEAAT8hR//aAAwDAQACAAMAAAAQ++++++++++++++++++++++++++++++++++//xAAUEQEAAAAAAAAAAAAAAAAAAABQ/9oACAEDAQE/EAv/xAAUEQEAAAAAAAAAAAAAAAAAAABQ/9oACAECAQE/EAv/xAAUEAEAAAAAAAAAAAAAAAAAAABg/9oACAEBAAE/EEf/2Q==",
  },
  png: {
    w: 301,
    h: 7,
    b64: "iVBORw0KGgoAAAANSUhEUgAAAS0AAAAHCAIAAADSwYxdAAAAMklEQVR4nO3TQQEAEADAQKSRSWKxxJjHXYJ9Nu8+A0itOgDwIXzAh9DzIfR8CD0fQu8BoqoBWBhZMewAAAAASUVORK5CYII=",
  },
  gif: {
    w: 301,
    h: 7,
    b64: "R0lGODdhLQEHAIIAAMwAM8wzM8wAZpkzZswzZgAAAAAAAAAAACwAAAAALQEHAAAI/wAJCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgFAiCwsSPHjx5DghwpsiTJkyZTolypsiXLly5jwpwpsybNmzZz4nyZsafPn0CDCh1KtOjBjQEEBPiYdClSpUyhPnVKoGlUqlanXt2qtWtVqV+xgs0almtZr2TTjl0rtq1ZtW7Rsn07V27cs3jh0r2rd+AAgX8JBB4MuLBgw4QPK07MGLHjxY8bQ54suXLky5QxW87MebNnzaA7h/4smrPGj0pTo24qYLXqjamTupYNm/Xs1rVfE4iNe7ft3LR96+Z9uzjw3sSPGxcePDlz5L+fL3dOPXr14dazY9/eXHvwgksHhjAHf3A8QfPiy6s3iF5g+6rrybOPf55++vn45euvn5///vv/uWefgP0B6N+BBiZIYEAAOw==",
  },
  webpLossy: {
    w: 301,
    h: 7,
    b64: "UklGRlQAAABXRUJQVlA4IEgAAADwAwCdASotAQcAPtFor1KoJiQioagBABoJaQDP3AVtUanDhw4cOFYAAP7l69//EOf1t/3KZmqbXxRWiIVtsgRCttkCIVhAAAA=",
  },
  webpLossless: {
    w: 301,
    h: 7,
    b64: "UklGRiQAAABXRUJQVlA4TBcAAAAvLIEBAAdQlCJXq/8BICH8Xy9G9D9FAAA=",
  },
  webpAlpha: {
    w: 301,
    h: 7,
    b64: "UklGRn4AAABXRUJQVlA4WAoAAAAQAAAALAEABgAAQUxQSBAAAAABB1DAiAgACeH/ejGi/ykCVlA4IEgAAADwAwCdASotAQcAPtFor1KoJiQioagBABoJaQDP3AVtUanDhw4cOFYAAP7l69//EOf1t/3KZmqbXxRWiIVtsgRCttkCIVhAAAA=",
  },
  avif: {
    w: 301,
    h: 7,
    b64: "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAALwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAABLQAAAAcAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAN21kYXQSAAoJGCClmaICGg0IMiAUo8PDEMPPPPNAAADnZZkuQuXytbXXTkOwai8qPgz7NQ==",
  },
} as const;

export const bytes = (name: keyof typeof FIXTURES) =>
  new Uint8Array(Buffer.from(FIXTURES[name].b64, "base64"));

/**
 * A JPEG APP1 "Exif" segment (big-endian TIFF) with IFD0 holding Orientation and a pointer to a
 * GPS IFD with GPSLatitudeRef "N" and GPSLatitude 33/1, 51/1, 0/1: what a phone camera writes.
 */
export function exifApp1(orientation: number): Uint8Array {
  const tiff: number[] = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8]; // "MM", 42, IFD0 at 8.
  const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const u32 = (n: number) => [
    (n >>> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ];
  const gpsIfd = 8 + 2 + 2 * 12 + 4; // After IFD0 (2 entries) and its next-IFD offset.
  const rationals = gpsIfd + 2 + 2 * 12 + 4;
  tiff.push(...u16(2));
  tiff.push(...u16(0x01_12), ...u16(3), ...u32(1), ...u16(orientation), 0, 0); // Orientation, SHORT.
  tiff.push(...u16(0x88_25), ...u16(4), ...u32(1), ...u32(gpsIfd)); // GPS IFD pointer, LONG.
  tiff.push(...u32(0));
  tiff.push(...u16(2));
  tiff.push(...u16(0x00_01), ...u16(2), ...u32(2), 0x4e, 0, 0, 0); // GPSLatitudeRef "N".
  tiff.push(...u16(0x00_02), ...u16(5), ...u32(3), ...u32(rationals)); // GPSLatitude, 3 RATIONALs.
  tiff.push(...u32(0));
  tiff.push(...u32(33), ...u32(1), ...u32(51), ...u32(1), ...u32(0), ...u32(1));
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF.
  return new Uint8Array([0xff, 0xe1, ...u16(payload.length + 2), ...payload]);
}

/** `segment` inserted into a JPEG right after SOI. */
export function withSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2));
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}
