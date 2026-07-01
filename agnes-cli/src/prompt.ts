// Tiny ANSI + interactive-confirm helpers. No external deps.

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function paint(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  green: (s: string) => paint("32", s),
  red: (s: string) => paint("31", s),
  yellow: (s: string) => paint("33", s),
  cyan: (s: string) => paint("36", s),
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
};

/** Ask a yes/no question. Returns true only on explicit y/yes. */
export async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} ${c.dim("[y/N]")} `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}
