import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

export interface RouteInfo {
  method: string;
  path: string;
}

export interface ExpressCapabilities {
  expressVersion: string;
  isTypeScript: boolean;
  entryFile: string;
  routes: RouteInfo[];
  hasStaticFiles: boolean;
  staticDir?: string;
  dependencies: string[];
  port: number;
}

export interface AnalyzeOptions {
  projectPath: string;
  outputDir?: string;
  verbose?: boolean;
}

export class Analyzer {
  async analyze(options: AnalyzeOptions): Promise<ExpressCapabilities> {
    const { projectPath, outputDir, verbose } = options;

    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Project path not found: ${projectPath}`);
    }

    const pkgPath = path.join(projectPath, 'package.json');
    if (!(await fs.pathExists(pkgPath))) {
      throw new Error(`No package.json found in: ${projectPath}`);
    }

    const pkg = (await fs.readJson(pkgPath)) as Record<string, unknown>;
    const deps = this.collectDeps(pkg);

    const expressVersion = this.resolveVersion(deps, 'express') || 'unknown';

    // Detect entry file
    const entryFile = await this.resolveEntryFile(projectPath, pkg);
    if (verbose) {
      console.log(chalk.gray(`  Entry file: ${entryFile}`));
    }

    // Detect TypeScript
    const isTypeScript =
      entryFile.endsWith('.ts') || (await fs.pathExists(path.join(projectPath, 'tsconfig.json')));

    // Detect routes from entry file
    const routes = await this.extractRoutes(path.join(projectPath, entryFile), verbose);
    if (verbose) {
      console.log(chalk.gray(`  Routes detected: ${routes.length}`));
    }

    // Detect static files
    const { hasStaticFiles, staticDir } = await this.detectStaticFiles(projectPath, entryFile);

    // Detect port
    const port = await this.detectPort(path.join(projectPath, entryFile));

    const capabilities: ExpressCapabilities = {
      expressVersion,
      isTypeScript,
      entryFile,
      routes,
      hasStaticFiles,
      staticDir,
      dependencies: Object.keys(deps),
      port,
    };

    if (outputDir) {
      await fs.ensureDir(outputDir);
      await fs.writeJson(path.join(outputDir, 'capabilities.json'), capabilities, { spaces: 2 });
      if (verbose) {
        console.log(chalk.gray(`  Capabilities written to: ${outputDir}/capabilities.json`));
      }
    }

    return capabilities;
  }

  private collectDeps(pkg: Record<string, unknown>): Record<string, string> {
    const deps: Record<string, string> = {};
    for (const key of ['dependencies', 'devDependencies']) {
      const section = pkg[key];
      if (typeof section === 'object' && section !== null) {
        for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
          deps[name] = typeof version === 'string' ? version : 'unknown';
        }
      }
    }
    return deps;
  }

  private resolveVersion(deps: Record<string, string>, name: string): string | undefined {
    const raw = deps[name];
    if (!raw) return undefined;
    // Strip semver prefix characters
    return raw.replace(/^[^0-9]*/, '');
  }

  private async resolveEntryFile(
    projectPath: string,
    pkg: Record<string, unknown>,
  ): Promise<string> {
    // Check package.json "main"
    const main = typeof pkg['main'] === 'string' ? pkg['main'] : undefined;
    if (main) {
      // Check if a TS variant exists
      const tsVariant = main.replace(/\.js$/, '.ts');
      if (await fs.pathExists(path.join(projectPath, tsVariant))) {
        return tsVariant;
      }
      if (await fs.pathExists(path.join(projectPath, main))) {
        return main;
      }
    }

    // Common entry file candidates
    const candidates = [
      'src/index.ts',
      'src/app.ts',
      'src/server.ts',
      'index.ts',
      'app.ts',
      'server.ts',
      'src/index.js',
      'src/app.js',
      'src/server.js',
      'index.js',
      'app.js',
      'server.js',
    ];

    for (const candidate of candidates) {
      if (await fs.pathExists(path.join(projectPath, candidate))) {
        return candidate;
      }
    }

    throw new Error(
      'Could not detect Express entry file. Set "main" in package.json or use a standard file name (index.ts, app.ts, server.ts).',
    );
  }

  private async extractRoutes(entryFilePath: string, verbose?: boolean): Promise<RouteInfo[]> {
    if (!(await fs.pathExists(entryFilePath))) {
      return [];
    }

    const content = await fs.readFile(entryFilePath, 'utf8');
    const routes: RouteInfo[] = [];

    // Match app.METHOD('path', ...) or router.METHOD('path', ...)
    const routeRegex =
      /(?:app|router)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;

    while ((match = routeRegex.exec(content)) !== null) {
      routes.push({ method: match[1].toUpperCase(), path: match[2] });
    }

    // Also match app.use('path', ...) for sub-router mounts
    const useRegex = /(?:app|router)\.use\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = useRegex.exec(content)) !== null) {
      routes.push({ method: 'USE', path: match[1] });
    }

    if (verbose && routes.length > 0) {
      for (const r of routes) {
        console.log(chalk.gray(`    ${r.method} ${r.path}`));
      }
    }

    return routes;
  }

  private async detectStaticFiles(
    projectPath: string,
    entryFile: string,
  ): Promise<{ hasStaticFiles: boolean; staticDir?: string }> {
    // Check entry file for express.static() usage
    const entryPath = path.join(projectPath, entryFile);
    if (await fs.pathExists(entryPath)) {
      const content = await fs.readFile(entryPath, 'utf8');
      const staticMatch = /express\.static\s*\(\s*(?:path\.join\s*\([^)]+\)|['"`]([^'"`]+)['"`])/.exec(content);
      if (staticMatch) {
        return { hasStaticFiles: true, staticDir: staticMatch[1] || 'public' };
      }
    }

    // Check for common static dirs
    const commonDirs = ['public', 'static', 'dist/public'];
    for (const dir of commonDirs) {
      if (await fs.pathExists(path.join(projectPath, dir))) {
        return { hasStaticFiles: true, staticDir: dir };
      }
    }

    return { hasStaticFiles: false };
  }

  private async detectPort(entryFilePath: string): Promise<number> {
    if (!(await fs.pathExists(entryFilePath))) {
      return 3000;
    }

    const content = await fs.readFile(entryFilePath, 'utf8');
    // Match app.listen(PORT) or app.listen(3000) or listen(port)
    const portMatch =
      /\.listen\s*\(\s*(?:parseInt\s*\([^,)]+\)\s*,\s*)?(\d{4,5})|process\.env\.PORT[^|]*\|\|\s*(\d{4,5})/.exec(
        content,
      );
    if (portMatch) {
      const port = parseInt(portMatch[1] || portMatch[2], 10);
      if (!isNaN(port)) {
        return port;
      }
    }

    return 3000;
  }
}
