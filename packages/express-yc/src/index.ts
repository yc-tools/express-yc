#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Analyzer } from './analyze/index.js';
import { Builder } from './build/index.js';
import { Uploader } from './upload/index.js';
import {
  cleanupTerraformProject,
  extractOutputString,
  prepareTerraformProject,
  resolveBackendConfig,
  TerraformRunner,
  type TerraformMode,
} from './terraform/index.js';
import {
  firstDefined,
  getConfigBoolean,
  getConfigRecord,
  getConfigString,
  getEnvBoolean,
  getEnvString,
  loadExpressYcConfig,
} from './config/index.js';
import type { DeploymentMode, RoutingMode, ContainerTarget } from './build/index.js';

const program = new Command();

program
  .name('express-yc')
  .description('CLI tool for deploying Express.js applications to Yandex Cloud')
  .version('1.0.0');

function cliOptionValue<T>(command: Command, name: string, value: T): T | undefined {
  return command.getOptionValueSource(name) === 'cli' ? value : undefined;
}

function parseTfVarAssignments(assignments: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of assignments) {
    const index = raw.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid --tf-var value "${raw}". Expected key=value.`);
    }
    const key = raw.slice(0, index).trim().replace(/-/g, '_');
    const value = raw.slice(index + 1).trim();
    if (!key) throw new Error(`Invalid --tf-var value "${raw}". Variable key is empty.`);
    result[key] = value;
  }
  return result;
}

function collectTfVarsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('EYC_TF_VAR_') || value === undefined) continue;
    const tfVarKey = key.slice('EYC_TF_VAR_'.length).toLowerCase();
    if (tfVarKey) result[tfVarKey] = value;
  }
  return result;
}

function collectTfVarsFromConfig(config: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const tfVars = getConfigRecord(config, 'tfVars');
  if (!tfVars) return result;
  for (const [key, value] of Object.entries(tfVars)) {
    if (value !== undefined && value !== null) {
      result[key.replace(/-/g, '_')] = String(value);
    }
  }
  return result;
}

function collectCustomEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const PREFIX = 'EYC_ENV_';
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || value === undefined) continue;
    const envKey = key.slice(PREFIX.length);
    if (envKey) result[envKey] = value;
  }
  return result;
}

function buildTerraformVarEnv(options: {
  appName?: string;
  environment?: string;
  domainName?: string;
  cloudId?: string;
  folderId?: string;
  iamToken?: string;
  zone?: string;
  region?: string;
  dnsZoneId?: string;
  certificateId?: string;
  createDnsZone?: boolean;
  storageAccessKey?: string;
  storageSecretKey?: string;
  tfVarAssignments?: Record<string, string>;
  envTfVars?: Record<string, string>;
  configTfVars?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};

  const mapped = new Map<string, string | boolean | undefined>([
    ['app_name', options.appName],
    ['env', options.environment],
    ['domain_name', options.domainName],
    ['cloud_id', options.cloudId],
    ['folder_id', options.folderId],
    ['iam_token', options.iamToken],
    ['zone', options.zone],
    ['region', options.region],
    ['dns_zone_id', options.dnsZoneId],
    ['certificate_id', options.certificateId],
    ['create_dns_zone', options.createDnsZone],
    ['storage_access_key', options.storageAccessKey],
    ['storage_secret_key', options.storageSecretKey],
  ]);

  for (const [key, value] of mapped.entries()) {
    if (value !== undefined) output[`TF_VAR_${key}`] = String(value);
  }

  const mergedTfVars = {
    ...(options.configTfVars || {}),
    ...(options.envTfVars || {}),
    ...(options.tfVarAssignments || {}),
  };

  for (const [key, value] of Object.entries(mergedTfVars)) {
    output[`TF_VAR_${key}`] = value;
  }

  return output;
}

function buildBackendInput(options: {
  stateBucket?: string;
  stateKey?: string;
  stateRegion?: string;
  stateEndpoint?: string;
  stateAccessKey?: string;
  stateSecretKey?: string;
}) {
  return options;
}

function deploymentModeToTfMode(mode: DeploymentMode, containerTarget?: ContainerTarget): TerraformMode {
  if (mode === 'serverless') return 'serverless';
  if (containerTarget === 'instance-group') return 'instance-group';
  return 'containers';
}

// ── analyze ───────────────────────────────────────────────────────────────────

program
  .command('analyze')
  .description('Analyze Express project capabilities')
  .requiredOption('-p, --project <path>', 'Path to Express project')
  .option('-o, --output <dir>', 'Output directory for analysis results')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project as string);

      const capabilities = await analyzer.analyze({
        projectPath,
        outputDir: options.output ? path.resolve(options.output as string) : undefined,
        verbose: options.verbose as boolean | undefined,
      });

      console.log(chalk.green('✅ Analysis complete'));
      console.log(chalk.cyan('Express version:'), capabilities.expressVersion);
      console.log(chalk.cyan('TypeScript:'), capabilities.isTypeScript ? 'yes' : 'no');
      console.log(chalk.cyan('Entry file:'), capabilities.entryFile);
      console.log(chalk.cyan('Routes detected:'), capabilities.routes.length);
    } catch (error) {
      console.error(
        chalk.red('❌ Analysis failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// ── build ─────────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Build and package Express app for YC deployment')
  .requiredOption('-p, --project <path>', 'Path to Express project')
  .requiredOption('-o, --output <dir>', 'Output directory for build artifacts')
  .option('--app-name <name>', 'Application name')
  .option('--mode <mode>', 'Deployment mode: serverless | container', 'serverless')
  .option('--routing <routing>', 'Routing mode (serverless only): single | per-route', 'single')
  .option('--container-target <target>', 'Container target: serverless-containers | instance-group', 'serverless-containers')
  .option('--registry-id <id>', 'Yandex Container Registry ID (for container mode)')
  .option('-b, --build-id <id>', 'Custom build ID')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const builder = new Builder();
      const projectPath = path.resolve(options.project as string);
      const outputDir = path.resolve(options.output as string);

      const manifest = await builder.build({
        projectPath,
        outputDir,
        appName: options.appName as string | undefined,
        buildId: options.buildId as string | undefined,
        mode: options.mode as DeploymentMode,
        routing: options.routing as RoutingMode,
        containerTarget: options.containerTarget as ContainerTarget,
        registryId: options.registryId as string | undefined,
        verbose: options.verbose as boolean | undefined,
      });

      console.log(chalk.green('✅ Build complete'));
      console.log(chalk.cyan('📦 Artifacts:'), outputDir);
      console.log(chalk.cyan('🆔 Build ID:'), manifest.buildId);
    } catch (error) {
      console.error(
        chalk.red('❌ Build failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// ── upload ────────────────────────────────────────────────────────────────────

program
  .command('upload')
  .description('Upload build artifacts to Yandex Cloud Object Storage')
  .requiredOption('-b, --build-dir <dir>', 'Build artifacts directory')
  .requiredOption('--bucket <name>', 'S3 bucket name')
  .option('--region <region>', 'YC region', 'ru-central1')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be uploaded without uploading')
  .action(async (options) => {
    try {
      const uploader = new Uploader();
      await uploader.upload({
        buildDir: path.resolve(options.buildDir as string),
        bucket: options.bucket as string,
        region: options.region as string,
        endpoint: options.endpoint as string | undefined,
        verbose: options.verbose as boolean | undefined,
        dryRun: options.dryRun as boolean | undefined,
      });

      if (!options.dryRun) {
        console.log(chalk.green('✅ Upload complete'));
      }
    } catch (error) {
      console.error(
        chalk.red('❌ Upload failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// ── plan ──────────────────────────────────────────────────────────────────────

program
  .command('plan')
  .description('Show deployment plan without building or uploading')
  .requiredOption('-p, --project <path>', 'Path to Express project')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const analyzer = new Analyzer();
      const projectPath = path.resolve(options.project as string);

      const capabilities = await analyzer.analyze({ projectPath, verbose: false });

      console.log(chalk.cyan('\n📋 Deployment Plan'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.white('Express version:'), capabilities.expressVersion);
      console.log(chalk.white('TypeScript:'), capabilities.isTypeScript ? 'yes' : 'no');
      console.log(chalk.white('Entry file:'), capabilities.entryFile);
      console.log(chalk.white('Routes detected:'), capabilities.routes.length);

      if (capabilities.routes.length > 0) {
        console.log(chalk.white('\nRoutes:'));
        for (const route of capabilities.routes.slice(0, 10)) {
          console.log(chalk.gray(`  ${route.method.padEnd(6)} ${route.path}`));
        }
        if (capabilities.routes.length > 10) {
          console.log(chalk.gray(`  ... and ${capabilities.routes.length - 10} more`));
        }
      }

      if (capabilities.hasStaticFiles) {
        console.log(chalk.white('\nStatic files:'), capabilities.staticDir || 'detected');
      }

      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.green('✅ Plan complete. Run "express-yc build" to proceed.'));
    } catch (error) {
      console.error(
        chalk.red('❌ Planning failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// ── deploy ────────────────────────────────────────────────────────────────────

program
  .command('deploy')
  .description('Build, upload artifacts, and run terraform apply')
  .option('-p, --project <path>', 'Path to Express project')
  .option('--config <path>', 'Path to express-yc config file')
  .option('-o, --output <dir>', 'Output directory for build artifacts')
  .option('--app-name <name>', 'Application name (terraform app_name variable)')
  .option('--mode <mode>', 'Deployment mode: serverless | container')
  .option('--routing <routing>', 'Routing mode: single | per-route')
  .option('--container-target <target>', 'Container target: serverless-containers | instance-group')
  .option('--registry-id <id>', 'Yandex Container Registry ID')
  .option('--bucket <name>', 'Artifacts bucket name')
  .option('--region <region>', 'YC region')
  .option('--endpoint <url>', 'S3 endpoint URL')
  .option('--environment <name>', 'Deployment environment (terraform env variable)')
  .option('--domain-name <name>', 'Custom domain (terraform domain_name variable)')
  .option(
    '--tf-var <key=value>',
    'Additional terraform variable (repeatable)',
    (value, acc) => { acc.push(value); return acc; },
    [] as string[],
  )
  .option('--state-bucket <name>', 'Terraform backend S3 bucket')
  .option('--state-key <key>', 'Terraform backend key')
  .option('--state-region <region>', 'Terraform backend region')
  .option('--state-endpoint <url>', 'Terraform backend endpoint')
  .option('--state-access-key <key>', 'Backend access key')
  .option('--state-secret-key <key>', 'Backend secret key')
  .option('--auto-approve', 'Run terraform apply with -auto-approve')
  .option('-b, --build-id <id>', 'Custom build ID')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options, command: Command) => {
    try {
      const env = process.env;
      const cliProject = cliOptionValue(command, 'project', options.project as string | undefined);
      const envProject = getEnvString(env, 'EYC_PROJECT');
      const loadedConfig = await loadExpressYcConfig({
        configPath: cliOptionValue(command, 'config', options.config as string | undefined),
        projectPath: firstDefined(cliProject, envProject),
      });
      const mergedConfig = {
        ...loadedConfig.data,
        ...(getConfigRecord(loadedConfig.data, 'deploy') || {}),
      };

      const projectInput = firstDefined(
        cliProject,
        envProject,
        getConfigString(mergedConfig, 'project'),
      );
      if (!projectInput) {
        throw new Error(
          'Project path is required. Provide --project, EYC_PROJECT, or config "project".',
        );
      }

      const projectPath = path.resolve(projectInput);
      const outputDir = path.resolve(
        firstDefined(
          cliOptionValue(command, 'output', options.output as string | undefined),
          getEnvString(env, 'EYC_OUTPUT'),
          getConfigString(mergedConfig, 'output'),
          './build',
        ) as string,
      );
      const deployMode = firstDefined(
        cliOptionValue(command, 'mode', options.mode as string | undefined),
        getEnvString(env, 'EYC_MODE'),
        getConfigString(mergedConfig, 'mode'),
        'serverless',
      ) as DeploymentMode;
      const deployRouting = firstDefined(
        cliOptionValue(command, 'routing', options.routing as string | undefined),
        getEnvString(env, 'EYC_ROUTING'),
        getConfigString(mergedConfig, 'routing'),
        'single',
      ) as RoutingMode;
      const containerTarget = firstDefined(
        cliOptionValue(command, 'containerTarget', options.containerTarget as string | undefined),
        getEnvString(env, 'EYC_CONTAINER_TARGET'),
        getConfigString(mergedConfig, 'containerTarget'),
        'serverless-containers',
      ) as ContainerTarget;
      const deployRegion = firstDefined(
        cliOptionValue(command, 'region', options.region as string | undefined),
        getEnvString(env, 'EYC_REGION'),
        getConfigString(mergedConfig, 'region'),
        'ru-central1',
      ) as string;
      const deployEndpoint = firstDefined(
        cliOptionValue(command, 'endpoint', options.endpoint as string | undefined),
        getEnvString(env, 'EYC_ENDPOINT'),
        getConfigString(mergedConfig, 'endpoint'),
        'https://storage.yandexcloud.net',
      ) as string;

      const tfMode = deploymentModeToTfMode(deployMode, containerTarget);
      const terraformDir = await prepareTerraformProject(tfMode);

      try {
        const builder = new Builder();
        const uploader = new Uploader();
        const terraform = new TerraformRunner(terraformDir);

        const backend = resolveBackendConfig(
          buildBackendInput({
            stateBucket: firstDefined(
              cliOptionValue(command, 'stateBucket', options.stateBucket as string | undefined),
              getEnvString(env, 'EYC_STATE_BUCKET'),
              getConfigString(mergedConfig, 'stateBucket'),
            ),
            stateKey: firstDefined(
              cliOptionValue(command, 'stateKey', options.stateKey as string | undefined),
              getEnvString(env, 'EYC_STATE_KEY'),
              getConfigString(mergedConfig, 'stateKey'),
            ),
            stateRegion: firstDefined(
              cliOptionValue(command, 'stateRegion', options.stateRegion as string | undefined),
              getEnvString(env, 'EYC_STATE_REGION'),
              getConfigString(mergedConfig, 'stateRegion'),
            ),
            stateEndpoint: firstDefined(
              cliOptionValue(command, 'stateEndpoint', options.stateEndpoint as string | undefined),
              getEnvString(env, 'EYC_STATE_ENDPOINT'),
              getConfigString(mergedConfig, 'stateEndpoint'),
              'https://storage.yandexcloud.net',
            ),
            stateAccessKey: firstDefined(
              cliOptionValue(command, 'stateAccessKey', options.stateAccessKey as string | undefined),
              getEnvString(env, 'EYC_STATE_ACCESS_KEY'),
              getConfigString(mergedConfig, 'stateAccessKey'),
            ),
            stateSecretKey: firstDefined(
              cliOptionValue(command, 'stateSecretKey', options.stateSecretKey as string | undefined),
              getEnvString(env, 'EYC_STATE_SECRET_KEY'),
              getConfigString(mergedConfig, 'stateSecretKey'),
            ),
          }),
          {
            ...env,
            YC_REGION: firstDefined(getEnvString(env, 'YC_REGION'), deployRegion),
            YC_ACCESS_KEY: firstDefined(
              getEnvString(env, 'EYC_STORAGE_ACCESS_KEY'),
              getConfigString(mergedConfig, 'storageAccessKey'),
              getEnvString(env, 'YC_ACCESS_KEY'),
            ),
            YC_SECRET_KEY: firstDefined(
              getEnvString(env, 'EYC_STORAGE_SECRET_KEY'),
              getConfigString(mergedConfig, 'storageSecretKey'),
              getEnvString(env, 'YC_SECRET_KEY'),
            ),
          },
        );

        await terraform.init(backend || undefined);

        // Build
        const appName = firstDefined(
          cliOptionValue(command, 'appName', options.appName as string | undefined),
          getEnvString(env, 'EYC_APP_NAME'),
          getConfigString(mergedConfig, 'appName'),
        );

        await builder.build({
          projectPath,
          outputDir,
          appName,
          buildId: firstDefined(
            cliOptionValue(command, 'buildId', options.buildId as string | undefined),
            getEnvString(env, 'EYC_BUILD_ID'),
            getConfigString(mergedConfig, 'buildId'),
          ),
          mode: deployMode,
          routing: deployRouting,
          containerTarget,
          registryId: firstDefined(
            cliOptionValue(command, 'registryId', options.registryId as string | undefined),
            getEnvString(env, 'EYC_REGISTRY_ID'),
            getConfigString(mergedConfig, 'registryId'),
          ),
          region: deployRegion,
          verbose: options.verbose as boolean | undefined,
        });

        // Inject custom env vars into manifest
        const customEnv = collectCustomEnvVars(env);
        if (Object.keys(customEnv).length > 0 && options.verbose) {
          console.log(chalk.gray(`  Custom env vars: ${Object.keys(customEnv).join(', ')}`));
        }

        // Upload (serverless only)
        if (deployMode === 'serverless') {
          const outputs = await terraform.readOutputs();
          const explicitBucket = firstDefined(
            cliOptionValue(command, 'bucket', options.bucket as string | undefined),
            getEnvString(env, 'EYC_BUCKET'),
            getConfigString(mergedConfig, 'bucket'),
          );
          const deployBucket = explicitBucket || extractOutputString(outputs, 'deploy_bucket');

          if (!deployBucket) {
            throw new Error(
              'Artifacts bucket is required for upload. Provide --bucket or set EYC_BUCKET.',
            );
          }

          await uploader.upload({
            buildDir: outputDir,
            bucket: deployBucket,
            region: deployRegion,
            endpoint: deployEndpoint,
            verbose: options.verbose as boolean | undefined,
          });
        }

        // Terraform apply
        const terraformVarEnv = buildTerraformVarEnv({
          appName,
          environment: firstDefined(
            cliOptionValue(command, 'environment', options.environment as string | undefined),
            getEnvString(env, 'EYC_ENV'),
            getConfigString(mergedConfig, 'environment'),
          ),
          domainName: firstDefined(
            cliOptionValue(command, 'domainName', options.domainName as string | undefined),
            getEnvString(env, 'EYC_DOMAIN_NAME'),
            getConfigString(mergedConfig, 'domainName'),
          ),
          cloudId: firstDefined(
            getEnvString(env, 'EYC_CLOUD_ID'),
            getConfigString(mergedConfig, 'cloudId'),
          ),
          folderId: firstDefined(
            getEnvString(env, 'EYC_FOLDER_ID'),
            getConfigString(mergedConfig, 'folderId'),
          ),
          iamToken: firstDefined(
            getEnvString(env, 'EYC_IAM_TOKEN'),
            getConfigString(mergedConfig, 'iamToken'),
          ),
          zone: firstDefined(
            getEnvString(env, 'EYC_ZONE'),
            getConfigString(mergedConfig, 'zone'),
          ),
          region: firstDefined(
            getEnvString(env, 'EYC_REGION'),
            getConfigString(mergedConfig, 'region'),
          ),
          dnsZoneId: firstDefined(
            getEnvString(env, 'EYC_DNS_ZONE_ID'),
            getConfigString(mergedConfig, 'dnsZoneId'),
          ),
          certificateId: firstDefined(
            getEnvString(env, 'EYC_CERTIFICATE_ID'),
            getConfigString(mergedConfig, 'certificateId'),
          ),
          createDnsZone: firstDefined(
            getEnvBoolean(env, 'EYC_CREATE_DNS_ZONE'),
            getConfigBoolean(mergedConfig, 'createDnsZone'),
          ),
          storageAccessKey: firstDefined(
            getEnvString(env, 'EYC_STORAGE_ACCESS_KEY'),
            getConfigString(mergedConfig, 'storageAccessKey'),
          ),
          storageSecretKey: firstDefined(
            getEnvString(env, 'EYC_STORAGE_SECRET_KEY'),
            getConfigString(mergedConfig, 'storageSecretKey'),
          ),
          configTfVars: collectTfVarsFromConfig(mergedConfig),
          envTfVars: collectTfVarsFromEnv(env),
          tfVarAssignments: parseTfVarAssignments(
            cliOptionValue(command, 'tfVar', options.tfVar as string[]) || [],
          ),
        });

        const autoApprove =
          firstDefined(
            cliOptionValue(command, 'autoApprove', options.autoApprove as boolean),
            getEnvBoolean(env, 'EYC_AUTO_APPROVE'),
            getConfigBoolean(mergedConfig, 'autoApprove'),
          ) || false;

        const applyEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...terraformVarEnv,
          TF_VAR_manifest_path: path.join(outputDir, 'deploy.manifest.json'),
          TF_VAR_build_dir: outputDir,
        };

        await terraform.apply({ autoApprove, env: applyEnv });

        console.log(chalk.green('✅ Deploy complete'));
      } finally {
        await cleanupTerraformProject(terraformDir);
      }
    } catch (error) {
      console.error(
        chalk.red('❌ Deploy failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
