import { describe, expect, it } from "vitest";
import { csvCell, csvText, toCsv } from "./csv.js";

describe("csvCell", () => {
  it("quotes every cell and doubles quotes", () => {
    expect(csvCell("Ada Lovelace")).toBe('"Ada Lovelace"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b\nc")).toBe('"a,b\nc"');
  });

  it("neutralises text that starts like a formula", () => {
    expect(csvCell('=HYPERLINK("https://evil.example","x")')).toBe(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(csvText("+1 858 555 0100")).toBe("'+1 858 555 0100");
    expect(csvText("-2+3")).toBe("'-2+3");
    expect(csvText("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvText("\t=1")).toBe("'\t=1");
    expect(csvText("\r=1")).toBe("'\r=1");
  });

  it("leaves ordinary text and numbers alone (same rule as the site's csv.ts)", () => {
    expect(csvText("DH27-H12")).toBe("DH27-H12");
    expect(csvText("858-555-0100")).toBe("858-555-0100");
    expect(csvText("a=b")).toBe("a=b");
    expect(csvText(-5)).toBe("-5");
    expect(csvText(42)).toBe("42");
  });

  it("handles empty values and arrays", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell("")).toBe('""');
    expect(csvText(["hacker", "mentor"])).toBe("hacker; mentor");
    expect(csvText(["=x", "y"])).toBe("'=x; y");
  });
});

describe("toCsv", () => {
  it("joins cells and rows", () => {
    expect(toCsv([["Name", "Code"], ["=1+1", "DH27-H1"]])).toBe('"Name","Code"\n"\'=1+1","DH27-H1"');
  });
});
