import fs from 'fs-extra';
import path from 'path';
import type { DeployManifest } from './schema.js';

export type { DeployManifest };

export async function writeManifest(outputDir: string, manifest: DeployManifest): Promise<void> {
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, 'deploy.manifest.json'), manifest, { spaces: 2 });
}

export async function readManifest(buildDir: string): Promise<DeployManifest> {
  const manifestPath = path.join(buildDir, 'deploy.manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Manifest not found: ${manifestPath}. Run "express-yc build" first.`);
  }
  return fs.readJson(manifestPath) as Promise<DeployManifest>;
}

export function generateBuildId(): string {
  return Date.now().toString(36).toUpperCase();
}
