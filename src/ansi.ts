export const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

export type AnsiColor = (typeof ANSI_COLORS)[number];

export interface AnsiStyle {
  readonly bold: boolean;
  readonly foreground?: AnsiColor;
  readonly background?: AnsiColor;
}

export interface AnsiToken {
  readonly text: string;
  readonly style: AnsiStyle;
}

export interface AnsiPaginationOptions {
  readonly maxTokens: number;
  readonly maxLineBreaks: number;
}

export type AnsiPage = readonly AnsiToken[];

interface MutableAnsiStyle {
  bold: boolean;
  foreground: AnsiColor | undefined;
  background: AnsiColor | undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences start with ESC.
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/** Splits ANSI SGR text into plain-text runs with independent style snapshots. */
export function tokenizeAnsi(input: string): readonly AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const style: MutableAnsiStyle = {
    bold: false,
    foreground: undefined,
    background: undefined,
  };
  let textStart = 0;

  for (const match of input.matchAll(SGR_PATTERN)) {
    const escapeStart = match.index;
    if (escapeStart > textStart) {
      tokens.push({
        text: input.slice(textStart, escapeStart),
        style: snapshotStyle(style),
      });
    }

    applySgr(style, match[1] ?? "");
    textStart = escapeStart + match[0].length;
  }

  if (textStart < input.length) {
    tokens.push({
      text: input.slice(textStart),
      style: snapshotStyle(style),
    });
  }

  return tokens;
}

/** Paginates styled text without changing its text or splitting between non-newline characters. */
export function paginateAnsiTokens(
  tokens: readonly AnsiToken[],
  options: AnsiPaginationOptions,
): readonly AnsiPage[] {
  validatePageLimit("maxTokens", options.maxTokens);
  validatePageLimit("maxLineBreaks", options.maxLineBreaks);

  const pages: AnsiToken[][] = [];
  let page: AnsiToken[] = [];
  let pageLineBreaks = 0;

  const flushPage = () => {
    if (page.length > 0) {
      pages.push(page);
      page = [];
      pageLineBreaks = 0;
    }
  };

  for (const token of tokens) {
    if (token.text.length === 0) {
      if (page.length === options.maxTokens) {
        flushPage();
      }
      page.push(token);
      continue;
    }

    let textStart = 0;
    while (textStart < token.text.length) {
      if (page.length === options.maxTokens) {
        flushPage();
      }

      const textEnd = prefixEndWithinLineLimit(
        token.text,
        textStart,
        options.maxLineBreaks - pageLineBreaks,
      );
      if (textEnd === textStart) {
        flushPage();
        continue;
      }

      const text = token.text.slice(textStart, textEnd);
      page.push(
        textStart === 0 && textEnd === token.text.length ? token : { text, style: token.style },
      );
      pageLineBreaks += countLineBreaks(text);
      textStart = textEnd;

      if (textStart < token.text.length) {
        flushPage();
      }
    }
  }

  flushPage();
  return pages;
}

function applySgr(style: MutableAnsiStyle, parameters: string): void {
  const codes = parameters === "" ? [0] : parameters.split(";").map(toSgrCode);

  for (const code of codes) {
    if (code === 0) {
      style.bold = false;
      style.foreground = undefined;
      style.background = undefined;
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 22) {
      style.bold = false;
    } else if (code >= 30 && code <= 37) {
      const foreground = ANSI_COLORS[code - 30];
      if (foreground !== undefined) {
        style.foreground = foreground;
      }
    } else if (code === 39) {
      style.foreground = undefined;
    } else if (code >= 40 && code <= 47) {
      const background = ANSI_COLORS[code - 40];
      if (background !== undefined) {
        style.background = background;
      }
    } else if (code === 49) {
      style.background = undefined;
    }
  }
}

function toSgrCode(parameter: string): number {
  return parameter === "" ? 0 : Number(parameter);
}

function snapshotStyle(style: MutableAnsiStyle): AnsiStyle {
  return {
    bold: style.bold,
    ...(style.foreground === undefined ? {} : { foreground: style.foreground }),
    ...(style.background === undefined ? {} : { background: style.background }),
  };
}

function validatePageLimit(name: keyof AnsiPaginationOptions, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function prefixEndWithinLineLimit(text: string, start: number, maxLineBreaks: number): number {
  let searchFrom = start;
  let prefixEnd = start;

  for (let lineBreaks = 0; lineBreaks <= maxLineBreaks; lineBreaks += 1) {
    const lineBreak = text.indexOf("\n", searchFrom);
    if (lineBreak === -1) {
      return text.length;
    }
    if (lineBreaks === maxLineBreaks) {
      return prefixEnd;
    }
    prefixEnd = lineBreak + 1;
    searchFrom = prefixEnd;
  }

  return text.length;
}

function countLineBreaks(text: string): number {
  let count = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const lineBreak = text.indexOf("\n", searchFrom);
    if (lineBreak === -1) {
      break;
    }
    count += 1;
    searchFrom = lineBreak + 1;
  }

  return count;
}
