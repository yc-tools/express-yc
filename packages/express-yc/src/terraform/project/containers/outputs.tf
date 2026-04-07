output "container_id" {
  description = "Serverless Container ID"
  value       = yandex_serverless_container.app.id
}

output "container_url" {
  description = "Serverless Container URL"
  value       = yandex_serverless_container.app.url
}

output "registry_id" {
  description = "Container Registry ID"
  value       = yandex_container_registry.main.id
}

output "api_gateway_domain" {
  description = "API Gateway domain (if custom domain configured)"
  value       = length(yandex_api_gateway.main) > 0 ? yandex_api_gateway.main[0].domain : null
}

output "custom_domain" {
  description = "Custom domain (if configured)"
  value       = local.has_domain ? var.domain_name : null
}

output "service_account_id" {
  description = "Service account ID"
  value       = yandex_iam_service_account.container_sa.id
}
