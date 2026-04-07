output "api_gateway_domain" {
  description = "Default API Gateway domain"
  value       = yandex_api_gateway.main.domain
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = yandex_api_gateway.main.id
}

output "custom_domain" {
  description = "Custom domain (if configured)"
  value       = local.has_domain ? var.domain_name : null
}

output "deploy_bucket" {
  description = "Object Storage bucket for function artifacts"
  value       = yandex_storage_bucket.deploy.bucket
}

output "function_id" {
  description = "Main function ID (single routing mode)"
  value       = local.routing == "single" && length(yandex_function.app) > 0 ? yandex_function.app[0].id : null
}

output "service_account_id" {
  description = "Service account ID for functions"
  value       = yandex_iam_service_account.functions_sa.id
}

output "certificate_id" {
  description = "TLS certificate ID"
  value       = local.effective_cert_id != "" ? local.effective_cert_id : null
}

output "dns_zone_id" {
  description = "DNS zone ID"
  value       = local.effective_dns_zone_id != "" ? local.effective_dns_zone_id : null
}

output "deployment_info" {
  description = "Deployment summary"
  value = {
    build_id    = try(local.manifest.buildId, "unknown")
    deployed_at = timestamp()
    region      = var.region
    environment = var.env
  }
}
