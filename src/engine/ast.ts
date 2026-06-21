import { Project, SyntaxKind, ts } from "ts-morph";
import type { Repo } from "./ingest.js";

export interface FnInfo {
  name: string;
  file: string;
  line: number;
  lines: number;
}

export interface ClassInfo {
  name: string;
  file: string;
  line: number;
  methods: number;
}

// The structural model — the backbone every code-quality / design check reads from.
export interface CodeModel {
  functions: FnInfo[];
  classes: ClassInfo[];
}

// Layer 1 — parse every source file into an AST and extract structure.
export function buildModel(repo: Repo): CodeModel {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
  });

  const functions: FnInfo[] = [];
  const classes: ClassInfo[] = [];

  for (const f of repo.files) {
    const sf = project.createSourceFile(f.path, f.content, { overwrite: true });

    // top-level function declarations
    for (const fn of sf.getFunctions()) {
      functions.push({
        name: fn.getName() ?? "(anonymous)",
        file: f.path,
        line: fn.getStartLineNumber(),
        lines: fn.getEndLineNumber() - fn.getStartLineNumber() + 1,
      });
    }

    // arrow functions assigned to variables (const foo = () => {})
    for (const vd of sf.getVariableDeclarations()) {
      const arrow = vd.getInitializerIfKind(SyntaxKind.ArrowFunction);
      if (arrow) {
        functions.push({
          name: vd.getName(),
          file: f.path,
          line: vd.getStartLineNumber(),
          lines: arrow.getEndLineNumber() - arrow.getStartLineNumber() + 1,
        });
      }
    }

    // classes + method counts (the SRP / god-class signal)
    for (const cls of sf.getClasses()) {
      classes.push({
        name: cls.getName() ?? "(anonymous)",
        file: f.path,
        line: cls.getStartLineNumber(),
        methods: cls.getMethods().length,
      });
    }
  }

  return { functions, classes };
}
