import type { OutputWriter } from "../commands/common.js";
import { shouldUseAnsi, type TerminalStyleOptions } from "./style.js";

export type LoginLogoOptions = TerminalStyleOptions & {
  stream: OutputWriter;
};

const fullLogo = [
  "++=+====+             + =*++++*        :=+++*xx**;:,               '~;**x* *xx+           ~;=++x*+*x+*;:        /     \\",
  "+++x++xxx*           :++xx*+**       ,*x  **+*x ++x* +,          ,++*x+x*x+++++*:      .+x++++xx+++**+x+x+,    |   M   |",
  "++x+*+x**+;          *+*++x*+:      :x+x**+~;;;=*+x+x+++`       +xx*++x=+=;++=+xx      ;++*x+x==~==++**+++++   |  . .  |",
  "*x**+xxx x          :xxx**x*=      ,+x*;'        ;++x *+*;     =+*+*+*`          `      =xx*:        ;xx +*x;   \\_____/",
  "*+xx ++*+*+=        ++ ++x x       +xx:            *x*****;    =x+x+x+                  `**x          =x+xxx",
  "++++x**x++*+~      =++*+x *:      .*+=             :*+*+ +*    =x+ +xx+.'                +++ ::",
  " ***+* +***++     ~+xx**; *.      ;*x               +*+x*x*~    +++xx+x +++=;~:`         ;+x*xx+x*=;:,",
  "++ *x= .+x+++*    +*+xxx '*       =*+               ~+xx++x;     ,*+x*x+x*x ++x*x;       ~* ++x *x*x+*x*=~",
  "*++*x=  *+*++*.  ;x+++x.  x       + =               :x *x**=        ,:;++**++x+****       ::+=++++x*x*xx+*x=.",
  "x++* *   +++xxx :++x*+;   +`      =*x               ; +*x*x.              ..;+*x*+=              ::;+x*x++*+*,",
  "x*x*x=   :++* + *+*xx*     ~      ,x*;              *+x x*x   ,:,,:,'           +x;                   .*x+x+x+",
  "*+*+x+    ;* **xx*xxx.   `**       *+*;           . **x+*     **++xx*             '      :             ~x*++*+",
  "x*x**+     +*+*+x **:    'x++      ~*  +:'     `;+xx+*+**.    ,++****=:        .+       =x++,         ;xxxx++~",
  "*** ++     :+**+*x *      **+~      ++*++*++ + + *++x**+       .+*x+++** ==+=+**+      ~x**++*= =;=+=+xx +xx+",
  "x+++**      =*+xx*+`      ++**;      .*++**xx*+++** +=           ~*+*xxxx +x**x*:      ,=***+*xx+x*+x*+*+*+",
  "+;+++;       =++;;:       +;=;=`        ~=+*x++ +=~.               ':~+=++xxx*;'          .~++x*+*x+x =:",
];

const compactLogo = [
  " __  __                  ___ _____ _   _ ",
  "|  \\/  | ___  __ _  __ _| __|_   _| |_| |",
  "| |\\/| |/ _ \\/ _` |/ _` | _|  | | |  _  |",
  "|_|  |_|\\___/\\__, |\\__,_|___| |_| |_| |_|",
  "             |___/                       ",
];

export async function renderLoginLogo(
  options: LoginLogoOptions,
): Promise<void> {
  if (!shouldRenderLoginLogo(options)) {
    return;
  }

  const lines = (options.stream.columns ?? 0) >= 124 ? fullLogo : compactLogo;
  await renderBootSequence(options.stream, lines);
}

export function shouldRenderLoginLogo(options: LoginLogoOptions): boolean {
  if (!shouldUseAnsi(options)) {
    return false;
  }

  return (options.stream.columns ?? 0) >= 44;
}

async function renderBootSequence(
  stream: OutputWriter,
  lines: readonly string[],
): Promise<void> {
  stream.write("\n");
  stream.write(`${color256(34)}MOSS${reset()}\n`);
  stream.write(`${color256(240)}boot system initialized${reset()}\n\n`);

  stream.write(hideCursor());
  try {
    for (const [row, line] of lines.entries()) {
      for (const [column, char] of [...line].entries()) {
        if (char === " ") {
          stream.write(char);
        } else {
          stream.write(
            `${color256(mossColor({ char, column, row }))}${char}${reset()}`,
          );
          await wait(2);
        }
      }

      stream.write("\n");
      await wait(16);
    }
    stream.write("\n");
  } finally {
    stream.write(showCursor());
  }
}

function mossColor(point: {
  char: string;
  column: number;
  row: number;
}): number {
  const palette = [28, 34, 40, 64, 70, 76, 106, 114];
  const offset = point.char.charCodeAt(0) + point.column * 7 + point.row * 13;

  return palette[offset % palette.length]!;
}

function color256(code: number): string {
  return `\x1b[38;5;${code}m`;
}

function hideCursor(): string {
  return "\x1b[?25l";
}

function showCursor(): string {
  return "\x1b[?25h";
}

function reset(): string {
  return "\x1b[0m";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
