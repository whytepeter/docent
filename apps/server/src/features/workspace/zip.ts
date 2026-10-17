import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Total unpacked size. */
  maxBytes: number;
  maxFiles: number;
}

export const ZIP_LIMITS: ZipLimits = { maxBytes: 1024 * 1024 * 1024, maxFiles: 60_000 };

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  mtime: Date;
}

/** macOS resource forks, Finder litter, and git folders (a zipped .git's config could name commands git would run). */
const SKIP = /(^|\/)(__MACOSX|\.git)(\/|$)|(^|\/)\.DS_Store$/;

/**
 * Unpacks a zip into `dest` with plain files only: no symlinks, no exec bits, and nothing outside `dest`
 * (an entry with an absolute path or `..` stops the whole import). When every entry sits under one top folder,
 * that folder's contents land in `dest` directly. Returns how many files it wrote.
 */
export function unzip(buf: Buffer, dest: string, limits: ZipLimits = ZIP_LIMITS): number {
  const entries = readDirectory(buf);
  const files = entries.filter((e) => !e.name.endsWith("/") && !SKIP.test(e.name));
  if (!files.length) throw new Error("That zip has no files in it.");
  if (files.length > limits.maxFiles) throw new Error(`That zip holds ${files.length.toLocaleString()} files; Docent opens up to ${limits.maxFiles.toLocaleString()}.`);
  const total = files.reduce((n, e) => n + e.size, 0);
  if (total > limits.maxBytes) throw new Error(`That zip unpacks to ${mb(total)}; Docent opens up to ${mb(limits.maxBytes)}.`);

  const top = files[0]!.name.split("/")[0]!;
  const strip = files.every((e) => e.name.startsWith(`${top}/`)) ? top.length + 1 : 0;
  const root = resolve(dest);
  let written = 0;
  for (const e of files) {
    const target = resolve(root, e.name.slice(strip));
    if (!target.startsWith(root + sep)) throw new Error(`That zip has an entry that would land outside its folder (${e.name}), so Docent won’t open it.`);
    const data = e.method === 0 ? buf.subarray(dataStart(buf, e), dataStart(buf, e) + e.compressed) : inflate(buf, e);
    if (data.length !== e.size) throw new Error(`That zip looks damaged (${e.name} isn’t the size it says).`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: 0o644 });
    // The zip's own times, so unpacking the same zip again reads as unchanged.
    utimesSync(target, e.mtime, e.mtime);
    written++;
  }
  return written;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024).toLocaleString()} MB`;

function inflate(buf: Buffer, e: Entry): Buffer {
  const start = dataStart(buf, e);
  try {
    // Capped at the declared size, so a zip bomb that lies about it stops there.
    return inflateRawSync(buf.subarray(start, start + e.compressed), { maxOutputLength: Math.max(1, e.size) });
  } catch {
    throw new Error(`That zip looks damaged (couldn’t unpack ${e.name}).`);
  }
}

function dataStart(buf: Buffer, e: Entry): number {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("That zip looks damaged.");
  return e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
}

/** The central directory at the end of the file: every entry's name, sizes and where its data starts. */
function readDirectory(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file isn’t a zip Docent can read.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("That zip is in the ZIP64 format, which Docent can’t read yet. Zip a smaller folder, or open the folder itself.");

  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("That zip looks damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;

    if (/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)|\0/.test(name)) throw new Error(`That zip has an entry that would land outside its folder (${name}), so Docent won’t open it.`);
    if ((mode & 0o170000) === 0o120000) continue; // a symlink: skipped, never created
    if (name.endsWith("/") || SKIP.test(name)) {
      entries.push({ name, method, compressed, size, offset, mtime: new Date() });
      continue;
    }
    if (flags & 1) throw new Error("That zip is password-protected. Unzip it yourself and open the folder instead.");
    if (method !== 0 && method !== 8) throw new Error(`That zip uses a compression Docent can’t read (${name}).`);
    const mtime = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
    entries.push({ name, method, compressed, size, offset, mtime: Number.isNaN(mtime.getTime()) ? new Date() : mtime });
  }
  return entries;
}
