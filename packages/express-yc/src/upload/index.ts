import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import ora from 'ora';

export interface UploadOptions {
  buildDir: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

export class Uploader {
  private s3Client!: S3Client;

  async upload(options: UploadOptions): Promise<void> {
    const spinner = ora();
    const {
      buildDir,
      bucket,
      region = 'ru-central1',
      endpoint = 'https://storage.yandexcloud.net',
      verbose,
      dryRun,
    } = options;

    this.s3Client = new S3Client({ region, endpoint });

    if (!(await fs.pathExists(buildDir))) {
      throw new Error(`Build directory not found: ${buildDir}`);
    }

    const artifactsDir = path.join(buildDir, 'artifacts');

    // Upload function zips
    const zipFiles = await glob('**/*.zip', { cwd: artifactsDir, nodir: true });
    for (const file of zipFiles) {
      const localPath = path.join(artifactsDir, file);
      const key = `functions/${file}`;
      spinner.start(`Uploading ${file}...`);
      if (!dryRun) {
        await this.uploadFile(localPath, bucket, key);
      }
      spinner.succeed(`Uploaded ${file}`);
      if (verbose) {
        console.log(chalk.gray(`  -> s3://${bucket}/${key}`));
      }
    }

    // Upload manifest
    const manifestPath = path.join(buildDir, 'deploy.manifest.json');
    if (await fs.pathExists(manifestPath)) {
      spinner.start('Uploading deployment manifest...');
      if (!dryRun) {
        await this.uploadFile(manifestPath, bucket, 'manifest.json');
      }
      spinner.succeed('Uploaded deployment manifest');
    }

    if (dryRun) {
      console.log(chalk.yellow('\nDry run mode enabled. No files were uploaded.'));
    } else {
      console.log(chalk.cyan('\nUpload summary:'));
      console.log(chalk.gray(`  Bucket: ${bucket}`));
    }
  }

  private async uploadFile(localPath: string, bucket: string, key: string): Promise<void> {
    const fileStream = fs.createReadStream(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.json': 'application/json',
      '.zip': 'application/zip',
    };

    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentTypes[ext] || 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });

    await upload.done();
  }
}
