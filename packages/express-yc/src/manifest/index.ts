import fs from 'fs-extra';
import path from 'path';
import { DeployManifestSchema, type DeployManifest } from './schema.js';

export type { DeployManifest };

export async function writeManifest(outputDir: string, manifest: DeployManifest): Promise<void> {
  const validated = DeployManifestSchema.parse(manifest);
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, 'deploy.manifest.json'), validated, { spaces: 2 });
}

export async function readManifest(buildDir: string): Promise<DeployManifest> {
  const manifestPath = path.join(buildDir, 'deploy.manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Manifest not found: ${manifestPath}. Run "express-yc build" first.`);
  }
  const raw: unknown = await fs.readJson(manifestPath);
  const parsed = DeployManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid deploy manifest at ${manifestPath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function generateBuildId(): string {
  return Date.now().toString(36).toUpperCase();
}
