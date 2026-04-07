locals {
  manifest      = jsondecode(file(var.manifest_path))
  app_id        = "${var.app_name}-${var.env}"
  functions     = try(local.manifest.artifacts.functions, [])
  routing       = try(local.manifest.deployment.routing, "single")
  has_domain    = trimspace(var.domain_name) != ""

  deploy_bucket = trimspace(var.deploy_bucket_name) != "" ? var.deploy_bucket_name : "${local.app_id}-deploy"
}

# ── Deploy bucket (stores function zips) ────────────────────────────────────

resource "yandex_storage_bucket" "deploy" {
  bucket = local.deploy_bucket
  acl    = "private"

  versioning {
    enabled = false
  }
}

# ── Service account ──────────────────────────────────────────────────────────

resource "yandex_iam_service_account" "functions_sa" {
  name        = "${local.app_id}-sa"
  description = "Service account for ${var.app_name} Cloud Functions"
  folder_id   = var.folder_id
}

resource "yandex_resourcemanager_folder_iam_member" "functions_invoker" {
  folder_id = var.folder_id
  role      = "serverless.functions.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.functions_sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_viewer" {
  folder_id = var.folder_id
  role      = "storage.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.functions_sa.id}"
}

# ── Cloud Functions ──────────────────────────────────────────────────────────

resource "yandex_function" "app" {
  count = local.routing == "single" ? 1 : 0

  name              = "${local.app_id}-fn"
  description       = "Express app function for ${var.app_name}"
  folder_id         = var.folder_id
  runtime           = var.nodejs_version
  entrypoint        = try(local.functions[0].entry, "index.handler")
  memory            = var.function_memory
  execution_timeout = tostring(var.function_timeout)

  user_hash = try(local.functions[0].zipPath, "")

  package {
    bucket_name = yandex_storage_bucket.deploy.bucket
    object_name = "functions/${try(local.functions[0].zipPath, "function.zip")}"
  }

  service_account_id = yandex_iam_service_account.functions_sa.id

  environment = try(local.functions[0].env, { NODE_ENV = "production" })

  log_options {
    disabled = false
    min_level = "WARN"
  }

  depends_on = [yandex_storage_bucket.deploy]
}

# Per-route functions
resource "yandex_function" "route" {
  for_each = local.routing == "per-route" ? {
    for fn in local.functions : fn.name => fn
  } : {}

  name              = "${local.app_id}-${each.key}-fn"
  description       = "Express route function for ${each.key}"
  folder_id         = var.folder_id
  runtime           = var.nodejs_version
  entrypoint        = each.value.entry
  memory            = try(each.value.memory, var.function_memory)
  execution_timeout = tostring(try(each.value.timeout, var.function_timeout))

  user_hash = each.value.zipPath

  package {
    bucket_name = yandex_storage_bucket.deploy.bucket
    object_name = "functions/${each.value.zipPath}"
  }

  service_account_id = yandex_iam_service_account.functions_sa.id

  environment = try(each.value.env, { NODE_ENV = "production" })

  log_options {
    disabled = false
    min_level = "WARN"
  }

  depends_on = [yandex_storage_bucket.deploy]
}

# ── API Gateway ──────────────────────────────────────────────────────────────

locals {
  single_function_id = local.routing == "single" && length(yandex_function.app) > 0 ? yandex_function.app[0].id : ""
  openapi_spec = local.routing == "single" ? templatefile("${var.build_dir}/artifacts/openapi.json", {
    function_id        = local.single_function_id
    service_account_id = yandex_iam_service_account.functions_sa.id
  }) : jsonencode(jsondecode(file("${var.build_dir}/artifacts/openapi.json")))
}

resource "yandex_api_gateway" "main" {
  name        = "${local.app_id}-apigw"
  description = "API Gateway for ${var.app_name}"
  folder_id   = var.folder_id

  spec = local.openapi_spec

  dynamic "custom_domains" {
    for_each = local.has_domain ? [1] : []
    content {
      fqdn           = var.domain_name
      certificate_id = local.effective_cert_id
    }
  }

  depends_on = [yandex_function.app, yandex_function.route]
}

# ── TLS Certificate ──────────────────────────────────────────────────────────

resource "yandex_cm_certificate" "main" {
  count  = local.has_domain && trimspace(var.certificate_id) == "" ? 1 : 0
  name   = "${local.app_id}-cert"
  folder_id = var.folder_id

  domains = [var.domain_name]

  managed {
    challenge_type = "DNS_CNAME"
  }
}

locals {
  effective_cert_id = trimspace(var.certificate_id) != "" ? var.certificate_id : (
    length(yandex_cm_certificate.main) > 0 ? yandex_cm_certificate.main[0].id : ""
  )
}

# ── DNS Zone ─────────────────────────────────────────────────────────────────

resource "yandex_dns_zone" "main" {
  count  = local.has_domain && var.create_dns_zone && trimspace(var.dns_zone_id) == "" ? 1 : 0
  name   = "${local.app_id}-zone"
  zone   = "${var.domain_name}."
  public = true

  folder_id = var.folder_id
}

locals {
  effective_dns_zone_id = trimspace(var.dns_zone_id) != "" ? var.dns_zone_id : (
    length(yandex_dns_zone.main) > 0 ? yandex_dns_zone.main[0].id : ""
  )
}

resource "yandex_dns_recordset" "apigw_cname" {
  count   = local.has_domain && local.effective_dns_zone_id != "" ? 1 : 0
  zone_id = local.effective_dns_zone_id
  name    = "${var.domain_name}."
  type    = "CNAME"
  ttl     = 300
  data    = ["${yandex_api_gateway.main.domain}."]
}

# DNS validation records for managed certificate
resource "yandex_dns_recordset" "cert_validation" {
  count = (
    local.has_domain &&
    local.effective_dns_zone_id != "" &&
    length(yandex_cm_certificate.main) > 0 &&
    length(yandex_cm_certificate.main[0].challenges) > 0
  ) ? 1 : 0

  zone_id = local.effective_dns_zone_id
  name    = yandex_cm_certificate.main[0].challenges[0].dns_name
  type    = yandex_cm_certificate.main[0].challenges[0].dns_type
  ttl     = 60
  data    = [yandex_cm_certificate.main[0].challenges[0].dns_value]
}
