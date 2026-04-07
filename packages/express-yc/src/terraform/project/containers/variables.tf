variable "cloud_id" {
  type = string
}

variable "folder_id" {
  type = string
}

variable "iam_token" {
  type      = string
  sensitive = true
}

variable "app_name" {
  type = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,29}[a-z0-9]$", var.app_name))
    error_message = "app_name must be 3-31 lowercase alphanumeric characters or hyphens."
  }
}

variable "env" {
  type    = string
  default = "production"
}

variable "region" {
  type    = string
  default = "ru-central1"
}

variable "zone" {
  type    = string
  default = "ru-central1-a"
}

variable "domain_name" {
  type    = string
  default = ""
}

variable "manifest_path" {
  type = string
}

variable "container_memory" {
  description = "Memory (MB) for the serverless container"
  type        = number
  default     = 256
}

variable "container_concurrency" {
  description = "Concurrency for the serverless container"
  type        = number
  default     = 10
}

variable "container_timeout" {
  description = "Request timeout (seconds) for the container"
  type        = number
  default     = 30
}

variable "dns_zone_id" {
  type    = string
  default = ""
}

variable "certificate_id" {
  type    = string
  default = ""
}

variable "create_dns_zone" {
  type    = bool
  default = false
}
