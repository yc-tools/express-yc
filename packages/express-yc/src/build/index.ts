import fs from 'fs-extra';
import path from 'path';
import { execSync, spawn } from 'child_process';
import archiver from 'archiver';
import chalk from 'chalk';
import ora from 'ora';
import * as esbuild from 'esbuild';
import { Analyzer } from '../analyze/index.js';
import { writeManifest, generateBuildId } from '../manifest/index.js';
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
    const appName = options.appName || path.basename(projectPath);

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
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, artifactsDir, capabilities, routing, buildId, appName, region, verbose, spinner } = opts;

    if (routing === 'single') {
      return this.buildSingleFunction(opts);
    }

    // Per-route mode: create one function per route group
    spinner.start('Building per-route serverless functions...');

    const routeGroups = this.groupRoutes(capabilities.routes);
    const functions: FunctionArtifact[] = [];
    const tempDir = path.join(opts.outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    try {
      for (const group of routeGroups) {
        const funcName = this.slugify(group.prefix);
        const wrapperPath = path.join(tempDir, `${funcName}-entry.cjs`);
        const distPath = path.join(tempDir, `${funcName}-bundle.cjs`);
        const zipPath = path.join(artifactsDir, `${funcName}.zip`);

        // Resolve entry file relative to project
        const entryRelative = capabilities.entryFile;
        const entryAbsolute = path.resolve(projectPath, entryRelative);
        const entryForWrapper = entryAbsolute.replace(/\\/g, '/');

        const wrapperCode = this.generateFunctionWrapper(entryForWrapper);
        await fs.writeFile(wrapperPath, wrapperCode);

        await esbuild.build({
          entryPoints: [wrapperPath],
          bundle: true,
          platform: 'node',
          target: 'node20',
          format: 'cjs',
          outfile: distPath,
          minify: true,
          treeShaking: true,
          logLevel: 'warning',
        });

        await this.zipFile(distPath, zipPath, 'index.js');

        functions.push({
          name: funcName,
          zipPath: path.relative(opts.outputDir, zipPath),
          entry: 'index.handler',
          routes: group.routes.map((r) => r.path),
          memory: 256,
          timeout: 30,
          env: { NODE_ENV: 'production' },
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
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, outputDir, artifactsDir, capabilities, buildId, appName, region, verbose, spinner } = opts;

    spinner.start('Bundling Express app (single function)...');

    const tempDir = path.join(outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    const entryAbsolute = path.resolve(projectPath, capabilities.entryFile);
    const entryForWrapper = entryAbsolute.replace(/\\/g, '/');

    const wrapperPath = path.join(tempDir, 'entry.cjs');
    const distPath = path.join(tempDir, 'bundle.cjs');
    const zipPath = path.join(artifactsDir, 'function.zip');

    try {
      const wrapperCode = this.generateFunctionWrapper(entryForWrapper);
      await fs.writeFile(wrapperPath, wrapperCode);

      await esbuild.build({
        entryPoints: [wrapperPath],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        outfile: distPath,
        minify: true,
        treeShaking: true,
        logLevel: 'warning',
      });

      await this.zipFile(distPath, zipPath, 'index.js');
    } finally {
      await fs.remove(tempDir);
    }

    spinner.succeed('Express app bundled');

    // Generate OpenAPI catch-all spec
    const openApiPath = path.join(artifactsDir, 'openapi.json');
    await this.generateOpenApiCatchAll(openApiPath);

    const funcArtifact: FunctionArtifact = {
      name: 'app',
      zipPath: path.relative(outputDir, zipPath),
      entry: 'index.handler',
      memory: 256,
      timeout: 30,
      env: { NODE_ENV: 'production' },
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
    verbose?: boolean;
    spinner: ReturnType<typeof ora>;
  }): Promise<DeployManifest> {
    const { projectPath, capabilities, containerTarget, buildId, appName, region, registryId, verbose, spinner } = opts;

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
          env: { NODE_ENV: 'production' },
        },
      },
    };
  }

  private generateFunctionWrapper(entryAbsolutePath: string): string {
    return `
'use strict';
const serverlessHttp = require('serverless-http');
let _handler;

async function getHandler() {
  if (_handler) return _handler;
  // Try default export, then named exports
  const mod = require(${JSON.stringify(entryAbsolutePath)});
  const app = mod.default || mod.app || mod;
  _handler = serverlessHttp(app);
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
  ): Array<{ prefix: string; routes: Array<{ method: string; path: string }> }> {
    if (routes.length === 0) {
      return [{ prefix: 'app', routes: [] }];
    }

    // Group routes by their top-level prefix (e.g. /api/users → /api)
    const groups = new Map<string, Array<{ method: string; path: string }>>();
    for (const route of routes) {
      const parts = route.path.split('/').filter(Boolean);
      const prefix = parts.length > 0 ? `/${parts[0]}` : '/';
      const existing = groups.get(prefix) || [];
      existing.push(route);
      groups.set(prefix, existing);
    }

    return Array.from(groups.entries()).map(([prefix, routeList]) => ({ prefix, routes: routeList }));
  }

  private slugify(prefix: string): string {
    return prefix.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'root';
  }

  private async zipFile(sourcePath: string, destZip: string, entryName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.file(sourcePath, { name: entryName });
      void archive.finalize();
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

    for (const func of functions) {
      for (const routePath of func.routes || []) {
        const normalizedPath = routePath.replace(/:([^/]+)/g, '{$1}');
        paths[normalizedPath] = {
          'x-yc-apigateway-any-method': {
            operationId: `${func.name}_${normalizedPath.replace(/\//g, '_').replace(/[{}]/g, '')}`,
            'x-yc-apigateway-integration': {
              type: 'cloud_functions',
              function_id: `\${function_id_${func.name}}`,
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
            function_id: `\${function_id_${lastFunc.name}}`,
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

      let stderr = '';
      if (!verbose) {
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command "${cmd} ${args.join(' ')}" failed (${code})\n${stderr}`));
        }
      });
    });
  }
}
