locals {
  manifest   = jsondecode(file(var.manifest_path))
  app_id     = "${var.app_name}-${var.env}"
  image_uri  = try(local.manifest.artifacts.containerImage.imageUri, "")
  port       = try(local.manifest.artifacts.containerImage.port, 3000)
  has_domain = trimspace(var.domain_name) != ""
  env_vars   = try(local.manifest.artifacts.containerImage.env, { NODE_ENV = "production" })
}

# ── Container Registry ───────────────────────────────────────────────────────

resource "yandex_container_registry" "main" {
  name      = "${local.app_id}-registry"
  folder_id = var.folder_id
}

resource "yandex_container_repository" "app" {
  name = "${yandex_container_registry.main.id}/${var.app_name}"
}

# ── Service Account ──────────────────────────────────────────────────────────

resource "yandex_iam_service_account" "container_sa" {
  name      = "${local.app_id}-container-sa"
  folder_id = var.folder_id
}

resource "yandex_resourcemanager_folder_iam_member" "container_invoker" {
  folder_id = var.folder_id
  role      = "serverless.containers.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.container_sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "registry_puller" {
  folder_id = var.folder_id
  role      = "container-registry.images.puller"
  member    = "serviceAccount:${yandex_iam_service_account.container_sa.id}"
}

# ── Serverless Container ─────────────────────────────────────────────────────

resource "yandex_serverless_container" "app" {
  name               = "${local.app_id}-container"
  description        = "Express app container for ${var.app_name}"
  folder_id          = var.folder_id
  memory             = var.container_memory
  execution_timeout  = "${var.container_timeout}s"
  concurrency        = var.container_concurrency
  service_account_id = yandex_iam_service_account.container_sa.id

  image {
    url = local.image_uri

    dynamic "environment" {
      for_each = local.env_vars
      content {
        key   = environment.key
        value = environment.value
      }
    }
  }
}

# ── API Gateway (optional, for custom domain / TLS) ──────────────────────────

resource "yandex_api_gateway" "main" {
  count     = local.has_domain ? 1 : 0
  name      = "${local.app_id}-apigw"
  folder_id = var.folder_id

  spec = jsonencode({
    openapi = "3.0.0"
    info    = { title = var.app_name, version = "1.0.0" }
    paths = {
      "/" = {
        "x-yc-apigateway-any-method" = {
          operationId = "root"
          "x-yc-apigateway-integration" = {
            type               = "serverless_containers"
            container_id       = yandex_serverless_container.app.id
            service_account_id = yandex_iam_service_account.container_sa.id
          }
        }
      }
      "/{proxy+}" = {
        "x-yc-apigateway-any-method" = {
          operationId = "proxy"
          parameters  = [{ name = "proxy", in = "path", required = true, schema = { type = "string" } }]
          "x-yc-apigateway-integration" = {
            type               = "serverless_containers"
            container_id       = yandex_serverless_container.app.id
            service_account_id = yandex_iam_service_account.container_sa.id
          }
        }
      }
    }
  })

  dynamic "custom_domains" {
    for_each = local.has_domain ? [1] : []
    content {
      fqdn           = var.domain_name
      certificate_id = local.effective_cert_id
    }
  }
}

# ── TLS Certificate ──────────────────────────────────────────────────────────

resource "yandex_cm_certificate" "main" {
  count     = local.has_domain && trimspace(var.certificate_id) == "" ? 1 : 0
  name      = "${local.app_id}-cert"
  folder_id = var.folder_id
  domains   = [var.domain_name]

  managed {
    challenge_type = "DNS_CNAME"
  }
}

locals {
  effective_cert_id = trimspace(var.certificate_id) != "" ? var.certificate_id : (
    length(yandex_cm_certificate.main) > 0 ? yandex_cm_certificate.main[0].id : ""
  )
}

# ── DNS ──────────────────────────────────────────────────────────────────────

resource "yandex_dns_zone" "main" {
  count     = local.has_domain && var.create_dns_zone && trimspace(var.dns_zone_id) == "" ? 1 : 0
  name      = "${local.app_id}-zone"
  zone      = "${var.domain_name}."
  public    = true
  folder_id = var.folder_id
}

locals {
  effective_dns_zone_id = trimspace(var.dns_zone_id) != "" ? var.dns_zone_id : (
    length(yandex_dns_zone.main) > 0 ? yandex_dns_zone.main[0].id : ""
  )
}

resource "yandex_dns_recordset" "container_cname" {
  count   = local.has_domain && local.effective_dns_zone_id != "" && length(yandex_api_gateway.main) > 0 ? 1 : 0
  zone_id = local.effective_dns_zone_id
  name    = "${var.domain_name}."
  type    = "CNAME"
  ttl     = 300
  data    = ["${yandex_api_gateway.main[0].domain}."]
}
