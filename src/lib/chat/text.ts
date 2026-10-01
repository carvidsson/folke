/**
 * Display clean-up for model answers (no HTML is ever rendered).
 *
 * Models sometimes write formulas in LaTeX, e.g. \((42-38) / 38 \times 100\).
 * Folke does not render LaTeX, so the delimiters are removed and common
 * commands inside them become plain characters.
 */
const COMMANDS: Record<string, string> = {
  times: "×",
  cdot: "·",
  approx: "≈",
  div: "÷",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  pm: "±",
};

function plainMath(math: string): string {
  return math
    .replace(/\\(?:text|mathrm)\{([^}]*)\}/g, "$1")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1) / ($2)")
    .replace(/\\([a-z]+)/gi, (whole, name: string) => COMMANDS[name] ?? whole)
    .replace(/\\%/g, "%")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\{,\}/g, ",");
}

export function stripMathDelimiters(text: string): string {
  return text
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, math: string) => plainMath(math))
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, math: string) => plainMath(math));
}
