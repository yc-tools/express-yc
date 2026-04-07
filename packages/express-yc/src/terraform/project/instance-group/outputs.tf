output "load_balancer_ip" {
  description = "External IP address of the Application Load Balancer"
  value       = local.alb_external_ip
}

output "load_balancer_id" {
  description = "ALB ID"
  value       = yandex_alb_load_balancer.app.id
}

output "instance_group_id" {
  description = "Compute Instance Group ID"
  value       = yandex_compute_instance_group.app.id
}

output "registry_id" {
  description = "Container Registry ID"
  value       = yandex_container_registry.main.id
}

output "custom_domain" {
  description = "Custom domain (if configured)"
  value       = local.has_domain ? var.domain_name : null
}

output "service_account_id" {
  description = "Service account ID"
  value       = yandex_iam_service_account.ig_sa.id
}

output "network_id" {
  description = "VPC Network ID"
  value       = yandex_vpc_network.main.id
}
