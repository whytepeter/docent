import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkoutDir, explain, parseGithub } from "./github.ts";
import { unzip } from "./zip.ts";

/** A minimal zip writer: enough to build the archives these tests need, deflated or stored, symlinks included. */
function zip(entries: { name: string; data?: string; symlink?: boolean; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? "");
    const body = e.store || e.symlink || e.name.endsWith("/") ? raw : deflateRawSync(raw);
    const method = body === raw ? 0 : 8;
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE((1 << 5) | 1, 14); // 1 Jan 1980
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.symlink ? 0o120777 : 0o100755) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const scratch = () => join(mkdtempSync(join(tmpdir(), "docent-zip-")), "out");

describe("parseGithub", () => {
  it("reads the usual ways to name a repo", () => {
    for (const s of ["https://github.com/honojs/hono", "https://github.com/honojs/hono.git", "github.com/honojs/hono/", "http://www.github.com/honojs/hono?tab=readme", "honojs/hono"]) {
      expect(parseGithub(s), s).toMatchObject({ owner: "honojs", repo: "hono", branch: undefined, url: "https://github.com/honojs/hono.git" });
    }
    expect(parseGithub("git@github.com:honojs/hono.git")).toMatchObject({ repo: "hono", url: "git@github.com:honojs/hono.git" });
    expect(parseGithub("https://github.com/honojs/hono/tree/next/src/router")).toMatchObject({ repo: "hono", branch: "next" });
  });

  it("refuses anything else, including names git would read as options", () => {
    for (const s of ["", "https://gitlab.com/a/b", "honojs", "https://github.com/honojs", "-u/x", "a/--upload-pack=x", "../etc", "a/b c"]) expect(parseGithub(s), s).toBeNull();
  });

  it("keeps one checkout per repo and branch, whatever the case", () => {
    expect(checkoutDir(parseGithub("Honojs/Hono")!)).toBe(checkoutDir(parseGithub("honojs/hono")!));
    expect(checkoutDir(parseGithub("github.com/honojs/hono/tree/next")!)).toMatch(/honojs-hono@next$/);
  });

  it("explains a repo that isn't there or isn't visible without asking for a token", () => {
    const msg = explain("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found", parseGithub("a/b")!);
    expect(msg).toMatch(/doesn’t exist, or it’s private/);
    expect(msg).toMatch(/never asks for or stores a token/);
  });
});

describe("unzip", () => {
  it("unpacks files and lifts a single top folder to the root", () => {
    const out = scratch();
    const n = unzip(zip([{ name: "app-main/" }, { name: "app-main/src/a.ts", data: "export const a = 1;\n" }, { name: "app-main/README.md", data: "# app", store: true }, { name: "__MACOSX/app-main/._a.ts", data: "x" }]), out);
    expect(n).toBe(2);
    expect(readdirSync(out).sort()).toEqual(["README.md", "src"]);
    expect(readFileSync(join(out, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    // No exec bits, whatever the zip said.
    expect(lstatSync(join(out, "src/a.ts")).mode & 0o111).toBe(0);
  });

  it("keeps the layout when there are several top-level entries", () => {
    const out = scratch();
    unzip(zip([{ name: "a.ts", data: "1" }, { name: "lib/b.ts", data: "2" }]), out);
    expect(readdirSync(out).sort()).toEqual(["a.ts", "lib"]);
  });

  it("refuses entries that would land outside the folder", () => {
    for (const name of ["../evil.ts", "a/../../evil.ts", "/etc/evil", "C:/evil"]) {
      const out = scratch();
      expect(() => unzip(zip([{ name: "ok.ts", data: "1" }, { name, data: "x" }]), out), name).toThrow(/outside its folder/);
      expect(existsSync(join(out, "..", "evil.ts"))).toBe(false);
    }
  });

  it("never creates symlinks and drops .git folders", () => {
    const out = scratch();
    unzip(zip([{ name: "p/link", data: "/etc/passwd", symlink: true }, { name: "p/.git/config", data: "[core]\n\tfsmonitor = touch /tmp/pwned\n" }, { name: "p/a.ts", data: "1" }]), out);
    expect(readdirSync(out)).toEqual(["a.ts"]);
  });

  it("caps the unpacked size and the file count", () => {
    expect(() => unzip(zip([{ name: "big.txt", data: "x".repeat(5000) }]), scratch(), { maxBytes: 1000, maxFiles: 10 })).toThrow(/unpacks to/);
    expect(() => unzip(zip([{ name: "a", data: "1" }, { name: "b", data: "2" }]), scratch(), { maxBytes: 1000, maxFiles: 1 })).toThrow(/holds 2 files/);
  });

  it("says when a file isn't a zip", () => {
    expect(() => unzip(Buffer.from("not a zip at all, just some text here"), scratch())).toThrow(/isn’t a zip/);
  });
});
