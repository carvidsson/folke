import { describe, expect, it } from "vitest";

import { stripMathDelimiters } from "./text";

describe("stripMathDelimiters", () => {
  it("removes inline and block LaTeX delimiters", () => {
    expect(stripMathDelimiters(String.raw`Det motsvarar 10,5 % \((42-38) / 38\).`)).toBe("Det motsvarar 10,5 % (42-38) / 38.");
    expect(stripMathDelimiters(String.raw`\[ 4 / 38 \]`)).toBe("4 / 38");
  });

  it("turns common LaTeX commands into plain characters", () => {
    expect(stripMathDelimiters(String.raw`Beräkning: \((42-38) / 38 \times 100\).`)).toBe("Beräkning: (42-38) / 38 × 100.");
    expect(stripMathDelimiters(String.raw`\(\frac{4}{38} \approx 10{,}5\,\%\)`)).toBe("(4) / (38) ≈ 10,5 %");
  });

  it("leaves ordinary text and citations untouched", () => {
    expect(stripMathDelimiters("Pris 512 300 kr [1] (inkl. moms).")).toBe("Pris 512 300 kr [1] (inkl. moms).");
  });
});
