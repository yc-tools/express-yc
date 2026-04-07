import { z } from 'zod';

export const RouteInfoSchema = z.object({
  method: z.string(),
  path: z.string(),
});

export const CapabilitiesSchema = z.object({
  expressVersion: z.string(),
  isTypeScript: z.boolean(),
  entryFile: z.string(),
  routes: z.array(RouteInfoSchema),
  hasStaticFiles: z.boolean(),
  staticDir: z.string().optional(),
  dependencies: z.array(z.string()),
  port: z.number(),
});

export const FunctionArtifactSchema = z.object({
  name: z.string(),
  zipPath: z.string(),
  entry: z.string(),
  routes: z.array(z.string()).optional(),
  memory: z.number().default(256),
  timeout: z.number().default(30),
  env: z.record(z.string()).optional(),
});

export const ContainerArtifactSchema = z.object({
  imageUri: z.string(),
  tag: z.string(),
  port: z.number(),
  memory: z.number().default(256),
  concurrency: z.number().default(10),
  env: z.record(z.string()).optional(),
});

export const DeployManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  buildId: z.string(),
  timestamp: z.string(),
  expressVersion: z.string(),
  appName: z.string(),

  capabilities: CapabilitiesSchema,

  deployment: z.object({
    mode: z.enum(['serverless', 'container']),
    routing: z.enum(['single', 'per-route']).optional(),
    containerTarget: z.enum(['serverless-containers', 'instance-group']).optional(),
    region: z.string().default('ru-central1'),
  }),

  artifacts: z.object({
    functions: z.array(FunctionArtifactSchema).optional(),
    containerImage: ContainerArtifactSchema.optional(),
    openApiPath: z.string().optional(),
  }),
});

export type DeployManifest = z.infer<typeof DeployManifestSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type FunctionArtifact = z.infer<typeof FunctionArtifactSchema>;
export type ContainerArtifact = z.infer<typeof ContainerArtifactSchema>;
