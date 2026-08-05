export type ParsedBash = {
  commands: string[][];
  operators: Array<"&&" | "||" | ";" | "|" | "newline">;
};

type Quote = "single" | "double" | undefined;

function pushWord(words: string[], current: { value: string; started: boolean }): void {
  if (!current.started) return;
  words.push(current.value);
  current.value = "";
  current.started = false;
}

/**
 * Split only shell syntax whose execution structure is fully visible. Any
 * expansion, redirect, assignment, background job, or malformed quote is
 * intentionally rejected so the Reviewer receives the original command.
 */
export function parseConservativeBash(command: string): ParsedBash | undefined {
  if (!command.trim() || command.includes("\0")) return undefined;
  const commands: string[][] = [];
  const operators: ParsedBash["operators"] = [];
  let words: string[] = [];
  const current = { value: "", started: false };
  let quote: Quote;

  const finishCommand = (operator: ParsedBash["operators"][number]): boolean => {
    pushWord(words, current);
    if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return false;
    commands.push(words);
    words = [];
    operators.push(operator);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else current.value += char;
      current.started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        current.started = true;
      } else if (char === "\\") {
        if (next === undefined) return undefined;
        if (next === "\n") index += 1;
        else {
          current.value += next;
          current.started = true;
          index += 1;
        }
      } else {
        if (char === "$" || char === "`") return undefined;
        current.value += char;
        current.started = true;
      }
      continue;
    }

    if (char === "'") {
      quote = "single";
      current.started = true;
    } else if (char === '"') {
      quote = "double";
      current.started = true;
    } else if (char === "\\") {
      if (next === undefined) return undefined;
      if (next === "\n") index += 1;
      else {
        current.value += next;
        current.started = true;
        index += 1;
      }
    } else if (char === " " || char === "\t" || char === "\r") {
      pushWord(words, current);
    } else if (char === "\n") {
      if (!finishCommand("newline")) return undefined;
    } else if (char === "&" && next === "&") {
      if (!finishCommand("&&")) return undefined;
      index += 1;
    } else if (char === "|" && next === "|") {
      if (!finishCommand("||")) return undefined;
      index += 1;
    } else if (char === "|") {
      if (!finishCommand("|")) return undefined;
    } else if (char === ";") {
      if (!finishCommand(";")) return undefined;
    } else {
      if ("&<>`$#{}()*?[]~".includes(char)) return undefined;
      current.value += char;
      current.started = true;
    }
  }

  if (quote) return undefined;
  pushWord(words, current);
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return undefined;
  commands.push(words);
  return operators.length === commands.length - 1 ? { commands, operators } : undefined;
}

/** Serialize already-parsed argv tokens without introducing shell expansion. */
export function formatConservativeBashCommand(tokens: readonly string[]): string {
  return tokens.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(" ");
}

export function tokenizeSingleCommand(command: string): string[] | undefined {
  const parsed = parseConservativeBash(command);
  return parsed?.commands.length === 1 ? parsed.commands[0] : undefined;
}
