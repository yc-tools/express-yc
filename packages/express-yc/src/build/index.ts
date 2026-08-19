import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import archiver from 'archiver';
import chalk from 'chalk';
import ora from 'ora';
import * as esbuild from 'esbuild';
import { Analyzer } from '../analyze/index.js';
import { writeManifest, generateBuildId } from '../manifest/index.js';
import { resolveAppName } from '../config/index.js';
import type { DeployManifest, FunctionArtifact } from '../manifest/schema.js';
import type { ExpressCapabilities } from '../analyze/index.js';

export type DeploymentMode = 'serverless' | 'container';
export type RoutingMode = 'single' | 'per-route';
export type ContainerTarget = 'serverless-containers' | 'instance-group';

export interface BuildOptions {
  projectPath: string;
  outputDir: string;
  appName?: string;
  buildId?: string;
  mode?: DeploymentMode;
  routing?: RoutingMode;
  containerTarget?: ContainerTarget;
  region?: string;
  registryId?: string;
  externalPackages?: string[];
  routePrefixDepth?: number;
  entries?: Record<string, string>;
  /** Extra environment variables injected into every function/container (EYC_ENV_*). */
  envVars?: Record<string, string>;
  verbose?: boolean;
}

export class Builder {
  async build(options: BuildOptions): Promise<DeployManifest> {
    const {
      projectPath,
      outputDir,
      mode = 'serverless',
      routing = 'single',
      containerTarget = 'serverless-containers',
      region = 'ru-central1',
      externalPackages,
      routePrefixDepth,
      entries,
      envVars,
      verbose,
    } = options;

    const spinner = ora();
    const artifactsDir = path.join(outputDir, 'artifacts');
    await fs.ensureDir(artifactsDir);

    // Step 1: Analyze
    spinner.start('Analyzing Express project...');
    const analyzer = new Analyzer();
    const capabilities = await analyzer.analyze({ projectPath, verbose });
    spinner.succeed(`Express ${capabilities.expressVersion} detected`);

    const buildId = options.buildId || generateBuildId();
    const appName = resolveAppName(options.appName || path.basename(projectPath));

    let manifest: DeployManifest;

    if (mode === 'serverless') {
      manifest = await this.buildServerless({
        projectPath,
        outputDir,
        artifactsDir,
        capabilities,
        routing,
        buildId,
        appName,
        region,
        externalPackages,
        routePrefixDepth,
        entries,
        envVars,
        verbose,
        spinner,
      });
    } else {
      manifest = await this.buildContainer({
        projectPath,
        outputDir,
        artifactsDir,
        capabilities,
        containerTarget,
        buildId,
        appName,
        region,
        registryId: options.registryId,
        envVars,
        verbose,
        spinner,
      });
    }

    // Write manifest
    await writeManifest(outputDir, manifest);
    if (verbose) {
      console.log(chalk.gray(`  Manifest written to: ${outputDir}/deploy.manifest.json`));
    }

    return manifest;
  }

  private async buildServerless(opts: {
    projectPath: string;
    outputDir: string;
    artifactsDir: string;
    capabilities: ExpressCapabilities;
    routing: RoutingMode;
    buildId: string;
    appName: string;
    region: string;
    externalPackages?: string[];
    routePrefixDepth?: number;
    entries?: Record<string, string>;
    envVars?: Record<string, string>;
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, artifactsDir, capabilities, routing, buildId, appName, region, externalPackages, routePrefixDepth, entries, envVars, verbose, spinner } = opts;

    if (entries && Object.keys(entries).length > 0) {
      return this.buildFromEntries({ ...opts, entries });
    }

    if (routing === 'single') {
      return this.buildSingleFunction({ ...opts, externalPackages });
    }

    // Per-route mode: create one function per route group
    spinner.start('Building per-route serverless functions...');

    const externals = externalPackages ?? [];
    // app.use() mounts are kept in the manifest for analysis display, but they
    // are middleware/sub-router mounts, not routable endpoints — grouping them
    // would create bogus per-route functions.
    const routableRoutes = capabilities.routes.filter((r) => r.method !== 'USE');
    const routeGroups = this.groupRoutes(routableRoutes, routePrefixDepth ?? 1);
    const functions: FunctionArtifact[] = [];
    const tempDir = path.join(opts.outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    try {
      // Every route group runs the same whole-app wrapper, so bundle and zip
      // once and point all functions at the same artifact.
      const entryAbsolute = path.resolve(projectPath, capabilities.entryFile);
      const wrapperPath = path.join(tempDir, 'app-entry.cjs');
      const distPath = path.join(tempDir, 'app-bundle.cjs');
      const zipPath = path.join(artifactsDir, 'app.zip');

      const wrapperCode = this.generateFunctionWrapper(entryAbsolute.replace(/\\/g, '/'));
      await fs.writeFile(wrapperPath, wrapperCode);
      await this.bundleAndZip({ entryPoint: wrapperPath, distPath, zipPath, externals, projectPath });

      const zipKey = `functions/${path.basename(zipPath)}`;
      const sha256 = await this.hashFile(zipPath);

      for (const group of routeGroups) {
        const funcName = this.slugify(group.prefix);

        functions.push({
          name: funcName,
          zipPath: zipKey,
          sha256,
          entry: 'index.handler',
          routes: group.routes.map((r) => r.path),
          memory: 256,
          timeout: 30,
          env: { NODE_ENV: 'production', ...envVars },
        });

        if (verbose) {
          console.log(chalk.gray(`  Built function: ${funcName} (${group.routes.length} routes)`));
        }
      }
    } finally {
      await fs.remove(tempDir);
    }

    spinner.succeed(`Built ${functions.length} serverless functions`);

    // Generate OpenAPI spec
    const openApiPath = path.join(artifactsDir, 'openapi.json');
    await this.generateOpenApiPerRoute(functions, openApiPath);

    return {
      schemaVersion: '1.0',
      buildId,
      timestamp: new Date().toISOString(),
      expressVersion: capabilities.expressVersion,
      appName,
      capabilities,
      deployment: {
        mode: 'serverless',
        routing: 'per-route',
        region,
      },
      artifacts: {
        functions,
        openApiPath: path.relative(opts.outputDir, openApiPath),
      },
    };
  }

  private async buildSingleFunction(opts: {
    projectPath: string;
    outputDir: string;
    artifactsDir: string;
    capabilities: ExpressCapabilities;
    routing: RoutingMode;
    buildId: string;
    appName: string;
    region: string;
    externalPackages?: string[];
    envVars?: Record<string, string>;
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, outputDir, artifactsDir, capabilities, buildId, appName, region, externalPackages, envVars, spinner } = opts;

    spinner.start('Bundling Express app (single function)...');

    const tempDir = path.join(outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    const entryAbsolute = path.resolve(projectPath, capabilities.entryFile);
    const entryForWrapper = entryAbsolute.replace(/\\/g, '/');

    const wrapperPath = path.join(tempDir, 'entry.cjs');
    const distPath = path.join(tempDir, 'bundle.cjs');
    const zipPath = path.join(artifactsDir, 'function.zip');

    const externals = externalPackages ?? [];

    try {
      const wrapperCode = this.generateFunctionWrapper(entryForWrapper);
      await fs.writeFile(wrapperPath, wrapperCode);
      await this.bundleAndZip({ entryPoint: wrapperPath, distPath, zipPath, externals, projectPath });
    } finally {
      await fs.remove(tempDir);
    }

    spinner.succeed('Express app bundled');

    // Generate OpenAPI catch-all spec
    const openApiPath = path.join(artifactsDir, 'openapi.json');
    await this.generateOpenApiCatchAll(openApiPath);

    const funcArtifact: FunctionArtifact = {
      name: 'app',
      zipPath: `functions/${path.basename(zipPath)}`,
      sha256: await this.hashFile(zipPath),
      entry: 'index.handler',
      memory: 256,
      timeout: 30,
      env: { NODE_ENV: 'production', ...envVars },
    };

    return {
      schemaVersion: '1.0',
      buildId,
      timestamp: new Date().toISOString(),
      expressVersion: capabilities.expressVersion,
      appName,
      capabilities,
      deployment: {
        mode: 'serverless',
        routing: 'single',
        region,
      },
      artifacts: {
        functions: [funcArtifact],
        openApiPath: path.relative(outputDir, openApiPath),
      },
    };
  }

  private async buildFromEntries(opts: {
    projectPath: string;
    outputDir: string;
    artifactsDir: string;
    capabilities: ExpressCapabilities;
    entries: Record<string, string>;
    buildId: string;
    appName: string;
    region: string;
    externalPackages?: string[];
    envVars?: Record<string, string>;
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, artifactsDir, entries, buildId, appName, region, externalPackages, envVars, verbose, spinner } = opts;

    spinner.start('Building native serverless handlers...');

    const externals = externalPackages ?? [];
    const functions: FunctionArtifact[] = [];
    const tempDir = path.join(opts.outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    try {
      for (const [name, entryRelative] of Object.entries(entries)) {
        const entryAbsolute = path.resolve(projectPath, entryRelative);
        const distPath = path.join(tempDir, `${name}-bundle.cjs`);
        const zipPath = path.join(artifactsDir, `${name}.zip`);

        await this.bundleAndZip({ entryPoint: entryAbsolute, distPath, zipPath, externals, projectPath });

        functions.push({
          name,
          zipPath: `functions/${path.basename(zipPath)}`,
          sha256: await this.hashFile(zipPath),
          entry: 'index.handler',
          memory: 256,
          timeout: 30,
          env: { NODE_ENV: 'production', ...envVars },
        });

        if (verbose) {
          console.log(chalk.gray(`  Built handler: ${name} ← ${entryRelative}`));
        }
      }
    } finally {
      await fs.remove(tempDir);
    }

    spinner.succeed(`Built ${functions.length} native handlers`);

    // Generate OpenAPI spec (catch-all to the last function; entries carry no
    // route metadata) so the API gateway template has a spec to render.
    const openApiPath = path.join(artifactsDir, 'openapi.json');
    await this.generateOpenApiPerRoute(functions, openApiPath);

    return {
      schemaVersion: '1.0',
      buildId,
      timestamp: new Date().toISOString(),
      expressVersion: opts.capabilities.expressVersion,
      appName,
      capabilities: opts.capabilities,
      deployment: {
        mode: 'serverless',
        routing: 'per-route',
        region,
      },
      artifacts: {
        functions,
        openApiPath: path.relative(opts.outputDir, openApiPath),
      },
    };
  }

  private async buildContainer(opts: {
    projectPath: string;
    outputDir: string;
    artifactsDir: string;
    capabilities: ExpressCapabilities;
    containerTarget: ContainerTarget;
    buildId: string;
    appName: string;
    region: string;
    registryId?: string;
    envVars?: Record<string, string>;
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, outputDir, capabilities, containerTarget, buildId, appName, region, registryId, envVars, verbose, spinner } = opts;

    // Ensure a Dockerfile exists
    const dockerfilePath = path.join(projectPath, 'Dockerfile');
    if (!(await fs.pathExists(dockerfilePath))) {
      spinner.start('Generating Dockerfile...');
      const dockerfile = this.generateDockerfile(capabilities);
      await fs.writeFile(dockerfilePath, dockerfile);
      spinner.succeed('Dockerfile generated');
      if (verbose) {
        console.log(chalk.gray(`  Dockerfile written to: ${dockerfilePath}`));
      }
      // The generated Dockerfile uses `COPY . .` with the project root as build
      // context; without a .dockerignore that would pull node_modules (and the
      // build output) into the image. Generate one alongside, if missing.
      const dockerignorePath = path.join(projectPath, '.dockerignore');
      if (!(await fs.pathExists(dockerignorePath))) {
        const outputRelative = path.relative(projectPath, outputDir);
        const ignoreEntries = [
          'node_modules',
          '.git',
          'Dockerfile',
          '.dockerignore',
          '*.log',
          // Ignore the build output dir when it lives inside the project.
          ...(outputRelative && !outputRelative.startsWith('..') && !path.isAbsolute(outputRelative)
            ? [outputRelative]
            : []),
        ];
        await fs.writeFile(dockerignorePath, ignoreEntries.join('\n') + '\n');
        console.log(
          chalk.yellow(
            `  Generated Dockerfile and .dockerignore in ${projectPath} (review and commit them, or add your own)`,
          ),
        );
      }
    } else {
      if (verbose) {
        console.log(chalk.gray('  Using existing Dockerfile'));
      }
    }

    const imageTag = buildId.toLowerCase();
    const imageRepo = registryId
      ? `cr.yandex/${registryId}/${appName}`
      : `${appName}`;
    const imageUri = `${imageRepo}:${imageTag}`;

    spinner.start('Building Docker image...');
    await this.runCommand('docker', ['build', '-t', imageUri, '.'], projectPath, verbose);
    spinner.succeed(`Docker image built: ${imageUri}`);

    if (registryId) {
      spinner.start('Pushing Docker image...');
      await this.runCommand('docker', ['push', imageUri], projectPath, verbose);
      spinner.succeed('Docker image pushed');
    } else {
      console.log(chalk.yellow('  Skipping image push: no --registry-id provided'));
    }

    return {
      schemaVersion: '1.0',
      buildId,
      timestamp: new Date().toISOString(),
      expressVersion: capabilities.expressVersion,
      appName,
      capabilities,
      deployment: {
        mode: 'container',
        containerTarget,
        region,
      },
      artifacts: {
        containerImage: {
          imageUri,
          tag: imageTag,
          port: capabilities.port,
          memory: 256,
          concurrency: 10,
          env: { NODE_ENV: 'production', ...envVars },
        },
      },
    };
  }

  private resolveRuntimeModule(): string {
    // Resolve the runtime package from the CLI's own installation, NOT from the
    // user's project — the user does not need to depend on it. esbuild bundles
    // the resolved file (and its serverless-http dependency) into the artifact.
    const requireFromCli = createRequire(import.meta.url);
    try {
      return requireFromCli.resolve('@yc-tools/express-yc-runtime');
    } catch {
      throw new Error(
        'Could not resolve @yc-tools/express-yc-runtime from the CLI installation. Reinstall @yc-tools/express-yc.',
      );
    }
  }

  private generateFunctionWrapper(entryAbsolutePath: string): string {
    const runtimePath = this.resolveRuntimeModule().replace(/\\/g, '/');
    return `
'use strict';
const { createFunctionHandler } = require(${JSON.stringify(runtimePath)});
let _handler;

async function getHandler() {
  if (_handler) return _handler;
  // Try default export, then named exports
  const mod = require(${JSON.stringify(entryAbsolutePath)});
  const app = mod.default || mod.app || mod;
  _handler = createFunctionHandler(app);
  return _handler;
}

exports.handler = async (event, context) => {
  const h = await getHandler();
  return h(event, context);
};
`.trimStart();
  }

  private generateDockerfile(capabilities: ExpressCapabilities): string {
    const entryJs = capabilities.isTypeScript
      ? capabilities.entryFile.replace(/\.ts$/, '.js').replace(/^src\//, 'dist/')
      : capabilities.entryFile;

    const hasTsConfig = capabilities.isTypeScript;

    return [
      'FROM node:20-alpine AS builder',
      'WORKDIR /app',
      '',
      'COPY package*.json ./',
      hasTsConfig ? 'RUN npm install' : null,
      hasTsConfig ? 'COPY tsconfig.json ./' : null,
      hasTsConfig ? 'COPY src ./src' : null,
      hasTsConfig ? 'RUN npm run build' : null,
      '',
      'FROM node:20-alpine',
      'WORKDIR /app',
      '',
      hasTsConfig
        ? 'COPY --from=builder /app/dist ./dist'
        : `COPY . .`,
      'COPY package*.json ./',
      'RUN npm install --omit=dev',
      '',
      `EXPOSE ${capabilities.port}`,
      `CMD ["node", "${entryJs}"]`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private groupRoutes(
    routes: Array<{ method: string; path: string }>,
    depth = 1,
  ): Array<{ prefix: string; routes: Array<{ method: string; path: string }> }> {
    if (routes.length === 0) {
      return [{ prefix: 'app', routes: [] }];
    }

    // Group routes by their top-level prefix segments (depth controls how many)
    const groups = new Map<string, Array<{ method: string; path: string }>>();
    for (const route of routes) {
      const parts = route.path.split('/').filter(Boolean);
      const prefix = parts.length > 0 ? '/' + parts.slice(0, depth).join('/') : '/';
      const existing = groups.get(prefix) || [];
      existing.push(route);
      groups.set(prefix, existing);
    }

    return Array.from(groups.entries()).map(([prefix, routeList]) => ({ prefix, routes: routeList }));
  }

  private slugify(prefix: string): string {
    return prefix.toLowerCase().replace(/^\//, '').replace(/[^a-z0-9]+/g, '-') || 'root';
  }

  private async bundleAndZip(opts: {
    entryPoint: string;
    distPath: string;
    zipPath: string;
    externals: string[];
    projectPath: string;
  }): Promise<void> {
    const { entryPoint, distPath, zipPath, externals, projectPath } = opts;

    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: distPath,
      minify: true,
      treeShaking: true,
      logLevel: 'warning',
      external: externals,
    });

    if (externals.length > 0) {
      await this.zipBundleWithNodeModules(distPath, projectPath, externals, zipPath);
    } else {
      await this.zipFile(distPath, zipPath, 'index.js');
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update(await fs.readFile(filePath));
    return hash.digest('hex');
  }

  private async zipFile(sourcePath: string, destZip: string, entryName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.pipe(output);
      archive.file(sourcePath, { name: entryName });
      archive.finalize().catch(reject);
    });
  }

  private async zipBundleWithNodeModules(
    bundlePath: string,
    projectPath: string,
    externals: string[],
    destZip: string,
  ): Promise<void> {
    // Note: only the listed external packages are copied — their transitive
    // dependencies are NOT included and must be listed explicitly if needed.
    const externalDirs: Array<{ pkg: string; dir: string }> = [];
    for (const pkg of externals) {
      const pkgDir = path.join(projectPath, 'node_modules', pkg);
      if (!(await fs.pathExists(pkgDir))) {
        throw new Error(
          `External package "${pkg}" not found in ${path.join(projectPath, 'node_modules')}. Install it in the project before building.`,
        );
      }
      // pnpm layouts symlink packages into node_modules; archive the real
      // directory so actual contents (not the symlink) end up in the zip.
      externalDirs.push({ pkg, dir: await fs.realpath(pkgDir) });
    }

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.pipe(output);
      archive.file(bundlePath, { name: 'index.js' });

      for (const { pkg, dir } of externalDirs) {
        archive.directory(dir, `node_modules/${pkg}`);
      }

      archive.finalize().catch(reject);
    });
  }

  private async generateOpenApiCatchAll(outputPath: string): Promise<void> {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Express App', version: '1.0.0' },
      paths: {
        '/': {
          'x-yc-apigateway-any-method': {
            operationId: 'root',
            'x-yc-apigateway-integration': {
              type: 'cloud_functions',
              function_id: '${function_id}',
              service_account_id: '${service_account_id}',
              payload_format_version: '1.0',
            },
          },
        },
        '/{proxy+}': {
          'x-yc-apigateway-any-method': {
            operationId: 'proxy',
            parameters: [{ name: 'proxy', in: 'path', required: true, schema: { type: 'string' } }],
            'x-yc-apigateway-integration': {
              type: 'cloud_functions',
              function_id: '${function_id}',
              service_account_id: '${service_account_id}',
              payload_format_version: '1.0',
            },
          },
        },
      },
    };

    await fs.writeJson(outputPath, spec, { spaces: 2 });
  }

  private async generateOpenApiPerRoute(
    functions: FunctionArtifact[],
    outputPath: string,
  ): Promise<void> {
    const paths: Record<string, unknown> = {};

    // Placeholder names must be valid terraform templatefile() variable names;
    // hyphens in function names are mapped to underscores. The terraform
    // template feeds `function_id_<name with - replaced by _>` per function.
    const functionIdVar = (name: string): string => `function_id_${name.replace(/-/g, '_')}`;

    for (const func of functions) {
      for (const routePath of func.routes || []) {
        const normalizedPath = routePath.replace(/:([^/]+)/g, '{$1}');
        paths[normalizedPath] = {
          'x-yc-apigateway-any-method': {
            operationId: `${func.name}_${normalizedPath.replace(/\//g, '_').replace(/[{}]/g, '')}`,
            'x-yc-apigateway-integration': {
              type: 'cloud_functions',
              function_id: `\${${functionIdVar(func.name)}}`,
              service_account_id: '${service_account_id}',
              payload_format_version: '1.0',
            },
          },
        };
      }
    }

    // Catch-all for the last function
    if (functions.length > 0) {
      const lastFunc = functions[functions.length - 1];
      paths['/{proxy+}'] = {
        'x-yc-apigateway-any-method': {
          operationId: 'catch_all',
          parameters: [{ name: 'proxy', in: 'path', required: true, schema: { type: 'string' } }],
          'x-yc-apigateway-integration': {
            type: 'cloud_functions',
            function_id: `\${${functionIdVar(lastFunc.name)}}`,
            service_account_id: '${service_account_id}',
            payload_format_version: '1.0',
          },
        },
      };
    }

    const spec = {
      openapi: '3.0.0',
      info: { title: 'Express App (per-route)', version: '1.0.0' },
      paths,
    };

    await fs.writeJson(outputPath, spec, { spaces: 2 });
  }

  private async runCommand(
    cmd: string,
    args: string[],
    cwd: string,
    verbose?: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: verbose ? 'inherit' : 'pipe',
      });

      let stdout = '';
      let stderr = '';
      if (!verbose) {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          reject(new Error(`Command "${cmd} ${args.join(' ')}" failed (${code})\n${detail}`));
        }
      });
    });
  }
}
