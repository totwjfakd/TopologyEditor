import YAML from "yaml";
import type { MapMetadata, MapRaster } from "../types";

export async function parseMapYamlFile(file: File): Promise<MapMetadata> {
  const text = await file.text();
  const parsed = YAML.parse(text);
  const source = typeof parsed === "object" && parsed ? parsed : {};
  const metadata = source as Record<string, unknown>;

  const resolution = Number(metadata.resolution);
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("YAML의 resolution 값이 올바르지 않습니다.");
  }

  const origin = metadata.origin;
  if (
    !Array.isArray(origin) ||
    origin.length < 3 ||
    origin.some((value) => !Number.isFinite(Number(value)))
  ) {
    throw new Error("YAML의 origin 값이 올바르지 않습니다.");
  }

  if (typeof metadata.image !== "string" || !metadata.image.trim()) {
    throw new Error("YAML의 image 값이 비어 있습니다.");
  }

  return {
    image: String(metadata.image).trim(),
    resolution,
    origin: [Number(origin[0]), Number(origin[1]), Number(origin[2])],
  };
}

export async function parsePgmFile(file: File): Promise<MapRaster> {
  const buffer = await file.arrayBuffer();
  const { width, height, pixels } = parsePgm(buffer);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("맵 이미지를 생성할 수 없습니다.");
  }

  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);

  return {
    name: file.name,
    width,
    height,
    canvas,
  };
}

export function matchMapFiles(
  files: FileList | null,
): { yamlFile: File; pgmFile: File } {
  if (!files) {
    throw new Error("선택된 파일이 없습니다.");
  }

  const entries = Array.from(files);
  const yamlFile = entries.find((file) => /\.(yaml|yml)$/i.test(file.name));
  const pgmFile = entries.find((file) => /\.pgm$/i.test(file.name));

  if (!yamlFile || !pgmFile) {
    throw new Error("YAML 파일과 PGM 파일을 함께 선택해야 합니다.");
  }

  return { yamlFile, pgmFile };
}

export function fileBaseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function parsePgm(buffer: ArrayBuffer): {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
} {
  const bytes = new Uint8Array(buffer);
  let cursor = 0;

  const readToken = (): string => {
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      if (byte === 35) {
        while (cursor < bytes.length && bytes[cursor] !== 10) {
          cursor += 1;
        }
      } else if (isWhitespace(byte)) {
        cursor += 1;
      } else {
        break;
      }
    }

    const start = cursor;
    while (
      cursor < bytes.length &&
      !isWhitespace(bytes[cursor]) &&
      bytes[cursor] !== 35
    ) {
      cursor += 1;
    }

    if (start === cursor) {
      throw new Error("PGM 파일을 읽는 중 토큰이 누락되었습니다.");
    }

    return new TextDecoder().decode(bytes.slice(start, cursor));
  };

  const magic = readToken();
  if (magic !== "P2" && magic !== "P5") {
    throw new Error("지원하지 않는 PGM 형식입니다. P2/P5만 지원합니다.");
  }

  const width = Number(readToken());
  const height = Number(readToken());
  const maxValue = Number(readToken());

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("PGM 파일의 크기 정보가 올바르지 않습니다.");
  }
  if (!Number.isFinite(maxValue) || maxValue < 1) {
    throw new Error("PGM 파일의 max value가 올바르지 않습니다.");
  }

  while (cursor < bytes.length && isWhitespace(bytes[cursor])) {
    cursor += 1;
  }

  const values =
    magic === "P2"
      ? readAsciiPixels(bytes, cursor, width * height)
      : readBinaryPixels(bytes, cursor, width * height, maxValue);

  const pixels = new Uint8ClampedArray(width * height * 4);
  values.forEach((value, index) => {
    const grayscale = Math.round((value / maxValue) * 255);
    const pixelIndex = index * 4;
    pixels[pixelIndex] = grayscale;
    pixels[pixelIndex + 1] = grayscale;
    pixels[pixelIndex + 2] = grayscale;
    pixels[pixelIndex + 3] = 255;
  });

  return {
    width,
    height,
    pixels,
  };
}

function readAsciiPixels(
  bytes: Uint8Array,
  start: number,
  count: number,
): number[] {
  const decoder = new TextDecoder();
  const body = decoder.decode(bytes.slice(start));
  const noComments = body.replace(/#[^\r\n]*/g, " ");
  const values = noComments
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .map((value) => Number(value));

  if (values.length < count) {
    throw new Error("PGM 픽셀 데이터가 부족합니다.");
  }

  return values;
}

function readBinaryPixels(
  bytes: Uint8Array,
  start: number,
  count: number,
  maxValue: number,
): number[] {
  const bytesPerSample = maxValue < 256 ? 1 : 2;
  const requiredLength = count * bytesPerSample;
  const slice = bytes.slice(start, start + requiredLength);
  if (slice.length < requiredLength) {
    throw new Error("PGM 픽셀 데이터가 부족합니다.");
  }

  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (bytesPerSample === 1) {
      values.push(slice[index]);
    } else {
      values.push((slice[index * 2] << 8) | slice[index * 2 + 1]);
    }
  }

  return values;
}

function isWhitespace(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}
