export type ParsedBash = {
  commands: string[][];
  operators: Array<"&&" | "||" | ";" | "|" | "newline">;
};

export type BashPathResolver = (value: string) => Promise<{ inside: boolean }>;
export type BashExecutableResolver = (command: string) => Promise<boolean>;

export type BashClassification = {
  safe: boolean;
  reason: string;
  parsed?: ParsedBash;
};

type Quote = "single" | "double" | undefined;

const SHELL_BUILTINS = new Set(["pwd", "true", "false", "type"]);
const SIMPLE_COMMANDS = new Set([...SHELL_BUILTINS, "uptime", "whoami", "id", "uname", "which"]);
const PATH_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "stat", "du", "df"]);
const FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);
const FIND_PREDICATES_WITH_VALUE = new Set([
  "-amin", "-anewer", "-atime", "-cmin", "-cnewer", "-ctime", "-fstype", "-gid", "-group", "-ilname",
  "-iname", "-inum", "-ipath", "-iregex", "-links", "-lname", "-maxdepth", "-mindepth", "-mmin", "-mtime",
  "-name", "-newer", "-newerXY", "-nogroup", "-nouser", "-path", "-perm", "-regex", "-samefile", "-size", "-type",
  "-uid", "-used", "-user", "-xtype",
]);
const FIND_FLAG_PREDICATES = new Set([
  "!", "(", ")", ",", "-a", "-and", "-daystart", "-depth", "-empty", "-executable", "-false", "-follow",
  "-ignore_readdir_race", "-leaf", "-mount", "-noignore_readdir_race", "-not", "-o", "-or", "-print", "-print0",
  "-prune", "-quit", "-readable", "-true", "-xdev",
]);

function pushWord(words: string[], current: { value: string; started: boolean }): void {
  if (!current.started) return;
  words.push(current.value);
  current.value = "";
  current.started = false;
}

export function parseConservativeBash(command: string): ParsedBash | undefined {
  if (!command.trim() || command.includes("\0")) return undefined;
  const commands: string[][] = [];
  const operators: ParsedBash["operators"] = [];
  let words: string[] = [];
  const current = { value: "", started: false };
  let quote: Quote;

  const finishCommand = (operator: ParsedBash["operators"][number]): boolean => {
    pushWord(words, current);
    if (!words.length) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return false;
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
      if ("&<>`$#{}()".includes(char)) return undefined;
      current.value += char;
      current.started = true;
    }
  }

  if (quote) return undefined;
  pushWord(words, current);
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return undefined;
  commands.push(words);
  if (operators.length !== commands.length - 1) return undefined;
  return { commands, operators };
}

export function tokenizeSingleCommand(command: string): string[] | undefined {
  const parsed = parseConservativeBash(command);
  return parsed?.commands.length === 1 ? parsed.commands[0] : undefined;
}

function optionName(token: string): string {
  return token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
}

async function pathsStayInside(paths: string[], resolvePath: BashPathResolver): Promise<boolean> {
  for (const value of paths) {
    if (value === "-") continue;
    if (value.startsWith("~") || /[*?[]/.test(value)) return false;
    if (process.platform === "win32" && value.startsWith("/")) return false;
    if (!(await resolvePath(value)).inside) return false;
  }
  return true;
}

function positionalArguments(args: string[]): string[] | undefined {
  const result: string[] = [];
  let options = true;
  for (const token of args) {
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-")) continue;
    result.push(token);
  }
  return result;
}

async function classifyPathCommand(argv: string[], resolvePath: BashPathResolver): Promise<boolean> {
  const command = argv[0]!;
  const args = argv.slice(1);
  const fileListOptions = new Set(["--exclude-from", "--files-from", "--files0-from", "--magic-file", "-f", "-m"]);
  if (args.some((arg) => fileListOptions.has(optionName(arg)))) return false;
  if (command === "ls" && args.some((arg) => optionName(arg) === "--hyperlink")) return false;
  if (["head", "tail"].includes(command) && args.some((arg) => ["-f", "--follow", "-F"].includes(optionName(arg)))) return false;
  const paths = positionalArguments(args);
  return Boolean(paths && (await pathsStayInside(paths, resolvePath)));
}

async function classifyGrep(argv: string[], resolvePath: BashPathResolver): Promise<boolean> {
  const args = argv.slice(1);
  const optionsWithValue = new Set(["-A", "-B", "-C", "-e", "-f", "-m", "--after-context", "--before-context", "--context", "--exclude", "--exclude-dir", "--exclude-from", "--file", "--include", "--label", "--max-count"]);
  const pathOptions = new Set(["-f", "--exclude-from", "--file"]);
  const paths: string[] = [];
  let patternSeen = false;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") {
      let name = optionName(token);
      if (token.startsWith("-f") && !token.startsWith("--") && token.length > 2) {
        if (!(await pathsStayInside([token.slice(2)], resolvePath))) return false;
        name = "-f";
      }
      if (token.startsWith("-e") && !token.startsWith("--") && token.length > 2) {
        patternSeen = true;
        continue;
      }
      if (name === "--binary-files" || name === "--directories" || name === "--devices") return false;
      if (pathOptions.has(name) && token.includes("=")) {
        if (!(await pathsStayInside([token.slice(token.indexOf("=") + 1)], resolvePath))) return false;
      } else if (optionsWithValue.has(name) && !token.includes("=")) {
        index += 1;
        if (index >= args.length) return false;
        if (name === "-e") patternSeen = true;
        if (pathOptions.has(name) && !(await pathsStayInside([args[index]!], resolvePath))) return false;
      }
      continue;
    }
    if (!patternSeen) patternSeen = true;
    else paths.push(token);
  }
  return patternSeen && pathsStayInside(paths, resolvePath);
}

async function classifyRipgrep(argv: string[], resolvePath: BashPathResolver): Promise<boolean> {
  const args = argv.slice(1);
  const dangerous = new Set(["--hostname-bin", "--pre", "--pre-glob", "--search-zip"]);
  const optionsWithValue = new Set(["-A", "-B", "-C", "-e", "-f", "-g", "-j", "-m", "-M", "-r", "-t", "-T", "--after-context", "--before-context", "--context", "--encoding", "--engine", "--glob", "--iglob", "--ignore-file", "--max-columns", "--max-count", "--max-depth", "--regexp", "--replace", "--threads", "--type", "--type-not"]);
  const pathOptions = new Set(["-f", "--ignore-file"]);
  const paths: string[] = [];
  let patternSeen = args.includes("--files") || args.includes("--files-with-matches") || args.includes("--files-without-match");
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") {
      let name = optionName(token);
      if (token.startsWith("-f") && !token.startsWith("--") && token.length > 2) {
        if (!(await pathsStayInside([token.slice(2)], resolvePath))) return false;
        name = "-f";
      }
      if (token.startsWith("-e") && !token.startsWith("--") && token.length > 2) {
        patternSeen = true;
        continue;
      }
      if (dangerous.has(name)) return false;
      if (pathOptions.has(name) && token.includes("=")) {
        if (!(await pathsStayInside([token.slice(token.indexOf("=") + 1)], resolvePath))) return false;
      } else if (optionsWithValue.has(name) && !token.includes("=")) {
        index += 1;
        if (index >= args.length) return false;
        if (name === "-e" || name === "--regexp") patternSeen = true;
        if (pathOptions.has(name) && !(await pathsStayInside([args[index]!], resolvePath))) return false;
      }
      continue;
    }
    if (!patternSeen) patternSeen = true;
    else paths.push(token);
  }
  return patternSeen && pathsStayInside(paths, resolvePath);
}

async function classifyFind(argv: string[], resolvePath: BashPathResolver): Promise<boolean> {
  const args = argv.slice(1);
  const paths: string[] = [];
  let index = 0;
  while (index < args.length && !args[index]!.startsWith("-") && !["!", "("].includes(args[index]!)) {
    paths.push(args[index]!);
    index += 1;
  }
  if (!paths.length) paths.push(".");
  if (!(await pathsStayInside(paths, resolvePath))) return false;

  while (index < args.length) {
    const token = args[index]!;
    if (FIND_ACTIONS.has(token)) return false;
    if (FIND_PREDICATES_WITH_VALUE.has(token) || /^-newer[A-Za-z]{2}$/.test(token)) {
      const value = args[index + 1];
      if (value === undefined) return false;
      if (["-anewer", "-cnewer", "-newer", "-samefile"].includes(token) || /^-newer[A-Za-z]{2}$/.test(token)) {
        if (!(await pathsStayInside([value], resolvePath))) return false;
      }
      index += 2;
      continue;
    }
    if (!FIND_FLAG_PREDICATES.has(token)) return false;
    index += 1;
  }
  return true;
}

async function classifyArgv(
  argv: string[],
  resolvePath: BashPathResolver,
  resolveExecutable: BashExecutableResolver,
): Promise<boolean> {
  if (!argv.length || argv[0]!.includes("/")) return false;
  const command = argv[0]!;
  if (!SHELL_BUILTINS.has(command) && !(await resolveExecutable(command))) return false;
  if (SIMPLE_COMMANDS.has(command)) return true;
  if (PATH_COMMANDS.has(command)) return classifyPathCommand(argv, resolvePath);
  if (command === "grep") return classifyGrep(argv, resolvePath);
  if (command === "rg") return classifyRipgrep(argv, resolvePath);
  if (command === "find") return classifyFind(argv, resolvePath);
  return false;
}

export async function classifyBash(
  command: string,
  resolvePath: BashPathResolver,
  resolveExecutable: BashExecutableResolver = async () => false,
): Promise<BashClassification> {
  const parsed = parseConservativeBash(command);
  if (!parsed) return { safe: false, reason: "unsupported Bash syntax" };
  for (const argv of parsed.commands) {
    if (!(await classifyArgv(argv, resolvePath, resolveExecutable))) {
      return { safe: false, reason: `command is not provably read-only: ${argv[0] ?? "unknown"}`, parsed };
    }
  }
  return { safe: true, reason: "every Bash command is in the read-only safelist", parsed };
}
