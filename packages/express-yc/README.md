# @yc-tools/express-yc

CLI for deploying Express.js applications to Yandex Cloud (Cloud Functions + API Gateway, or containers).

## Install

```bash
npm install -g @yc-tools/express-yc
```

## Commands

| Command | Description |
| --- | --- |
| `express-yc analyze -p <path>` | Analyze an Express project (entry file, routes, static files, port) |
| `express-yc build -p <path> -o <dir>` | Build and package the app for deployment (writes `deploy.manifest.json`) |
| `express-yc upload -b <dir> --bucket <name>` | Upload build artifacts to Object Storage |
| `express-yc plan -p <path>` | Show the deployment plan without building |
| `express-yc deploy` | Build, upload artifacts, and run `terraform apply` |

## Deployment modes

- `--mode serverless` (default) — Cloud Functions behind an API Gateway
  - `--routing single` (default) — the whole app in one function
  - `--routing per-route` — one function per route-prefix group (`--route-depth <n>` controls grouping depth)
- `--mode container` — Docker image
  - `--container-target serverless-containers` (default) or `instance-group`

## Configuration

Options are resolved from (in order): CLI flags, `EYC_*` environment variables, config file.

Config file: `express-yc.config.json` (also `.express-yc.json`, `express-yc.config.yml`/`.yaml`) in the working directory or the project directory. Keys mirror the deploy options, e.g.:

```json
{
  "project": ".",
  "output": "./build",
  "appName": "my-app",
  "mode": "serverless",
  "routing": "single",
  "environment": "production",
  "stateBucket": "my-tf-state",
  "stateKey": "my-app/terraform.tfstate",
  "cloudId": "...",
  "folderId": "...",
  "externalPackages": [],
  "tfVars": {}
}
```

A `deploy` object in the config overrides top-level keys.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `EYC_PROJECT`, `EYC_OUTPUT` | Project path / build output dir |
| `EYC_APP_NAME`, `EYC_ENV` | App name / environment (`dev`, `staging`, `production`) |
| `EYC_MODE`, `EYC_ROUTING`, `EYC_CONTAINER_TARGET` | Deployment mode options |
| `EYC_REGISTRY_ID` | Container registry ID |
| `EYC_BUCKET`, `EYC_REGION`, `EYC_ENDPOINT` | Artifacts bucket / region / S3 endpoint |
| `EYC_STATE_BUCKET`, `EYC_STATE_KEY`, `EYC_STATE_REGION`, `EYC_STATE_ENDPOINT` | Terraform s3 backend |
| `EYC_STATE_ACCESS_KEY`, `EYC_STATE_SECRET_KEY` | Terraform backend credentials |
| `EYC_STORAGE_ACCESS_KEY`, `EYC_STORAGE_SECRET_KEY` | Object Storage credentials (fallback: `YC_ACCESS_KEY`/`YC_SECRET_KEY`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) |
| `EYC_CLOUD_ID`, `EYC_FOLDER_ID`, `EYC_IAM_TOKEN` | Yandex Cloud provider settings |
| `EYC_ZONE`, `EYC_DOMAIN_NAME`, `EYC_DNS_ZONE_ID`, `EYC_CERTIFICATE_ID`, `EYC_CREATE_DNS_ZONE` | Optional infrastructure settings |
| `EYC_BUILD_ID`, `EYC_AUTO_APPROVE` | Custom build ID / non-interactive `terraform apply` |
| `EYC_TF_VAR_<name>` | Extra terraform variable |
| `EYC_ENV_<NAME>` | Extra environment variable injected into the deployed function/container |

## Requirements

- Node.js >= 20
- `terraform` on `PATH` (for `deploy`)
- `docker` on `PATH` (for container mode)

## License

MIT
