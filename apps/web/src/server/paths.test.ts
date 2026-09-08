import { describe, expect, it } from "vitest";
import {
  containerPath,
  fromToolbox,
  hostPath,
  pathMap,
  toPosix,
  toRelative,
  toToolbox,
  workFolder,
} from "./paths.ts";

/**
 * The developer's machine: a Windows library root bound to `/library` in the toolbox.
 * These are the exact strings the two sides exchange, so the expectations are literal.
 */
const windows = pathMap({
  host: "D:\\srv\\music-manager\\library",
  container: "/library",
});

/** Production, where both ends are Linux but the paths still differ. */
const linux = pathMap({ host: "/srv/music", container: "/library" });

describe("toPosix", () => {
  it("normalises separators and collapses duplicates", () => {
    expect(toPosix("D:\\a\\\\b/c")).toBe("D:/a/b/c");
  });
});

describe("hostPath / containerPath", () => {
  it("renders a library-relative path for each side", () => {
    const relative = "Daft Punk/Discovery (2001)/01 One More Time.opus";
    expect(toPosix(hostPath(windows, relative))).toBe(
      "D:/srv/music-manager/library/Daft Punk/Discovery (2001)/01 One More Time.opus",
    );
    expect(containerPath(windows, relative)).toBe(
      "/library/Daft Punk/Discovery (2001)/01 One More Time.opus",
    );
  });

  it("tolerates a leading slash on the relative part", () => {
    expect(containerPath(linux, "/Daft Punk/x.opus")).toBe("/library/Daft Punk/x.opus");
  });
});

describe("toRelative", () => {
  it("strips either root", () => {
    expect(toRelative(windows, "/library/Daft Punk/x.opus")).toBe("Daft Punk/x.opus");
    expect(toRelative(windows, "D:\\srv\\music-manager\\library\\a\\b.opus")).toBe("a/b.opus");
  });

  it("ignores drive-letter case, which Windows does too", () => {
    expect(toRelative(windows, "d:/srv/MUSIC-MANAGER/library/a.opus")).toBe("a.opus");
  });

  it("returns null for a path outside the library", () => {
    expect(toRelative(windows, "/tmp/elsewhere.opus")).toBeNull();
  });
});

describe("round trip across the bridge", () => {
  it("rewrites a path the toolbox returned into a host path and back", () => {
    const returned = "/library/.mm-work/imp_1/itr_1.opus";
    const onHost = fromToolbox(windows, returned);
    expect(toPosix(onHost)).toBe("D:/srv/music-manager/library/.mm-work/imp_1/itr_1.opus");
    expect(toToolbox(windows, onHost)).toBe(returned);
  });

  it("leaves a path outside the library alone rather than inventing one", () => {
    expect(fromToolbox(windows, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("workFolder", () => {
  it("keeps downloads inside the library mount, hidden from the scanner", () => {
    expect(workFolder(windows, "imp_01H")).toBe(".mm-work/imp_01H");
    expect(containerPath(windows, workFolder(windows, "imp_01H"))).toBe(
      "/library/.mm-work/imp_01H",
    );
  });
});
