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

variable "instance_count" {
  description = "Number of VM instances in the group"
  type        = number
  default     = 2
}

variable "instance_cores" {
  description = "vCPU count per instance"
  type        = number
  default     = 2
}

variable "instance_memory" {
  description = "RAM (GB) per instance"
  type        = number
  default     = 2
}

variable "instance_disk_size" {
  description = "Boot disk size (GB) per instance"
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
