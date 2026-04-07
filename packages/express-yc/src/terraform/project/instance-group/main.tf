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

# ── Service Account ──────────────────────────────────────────────────────────

resource "yandex_iam_service_account" "ig_sa" {
  name      = "${local.app_id}-ig-sa"
  folder_id = var.folder_id
}

resource "yandex_resourcemanager_folder_iam_member" "registry_puller" {
  folder_id = var.folder_id
  role      = "container-registry.images.puller"
  member    = "serviceAccount:${yandex_iam_service_account.ig_sa.id}"
}

# ── Network ──────────────────────────────────────────────────────────────────

resource "yandex_vpc_network" "main" {
  name      = "${local.app_id}-network"
  folder_id = var.folder_id
}

resource "yandex_vpc_subnet" "main" {
  name           = "${local.app_id}-subnet"
  zone           = var.zone
  network_id     = yandex_vpc_network.main.id
  v4_cidr_blocks = ["10.0.0.0/24"]
  folder_id      = var.folder_id
}

# ── Security Group ───────────────────────────────────────────────────────────

resource "yandex_vpc_security_group" "alb" {
  name       = "${local.app_id}-alb-sg"
  network_id = yandex_vpc_network.main.id
  folder_id  = var.folder_id

  ingress {
    protocol       = "TCP"
    port           = 80
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    protocol       = "TCP"
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  # Health checks from ALB
  ingress {
    protocol          = "TCP"
    port              = local.port
    predefined_target = "loadbalancer_healthchecks"
  }

  egress {
    protocol       = "ANY"
    from_port      = 0
    to_port        = 65535
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "yandex_vpc_security_group" "instances" {
  name       = "${local.app_id}-instances-sg"
  network_id = yandex_vpc_network.main.id
  folder_id  = var.folder_id

  ingress {
    protocol          = "TCP"
    port              = local.port
    predefined_target = "loadbalancer_healthchecks"
  }

  ingress {
    protocol       = "TCP"
    port           = local.port
    v4_cidr_blocks = ["10.0.0.0/8"]
  }

  egress {
    protocol       = "ANY"
    from_port      = 0
    to_port        = 65535
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── Instance Group ───────────────────────────────────────────────────────────

resource "yandex_compute_instance_group" "app" {
  name               = "${local.app_id}-ig"
  folder_id          = var.folder_id
  service_account_id = yandex_iam_service_account.ig_sa.id

  instance_template {
    platform_id = "standard-v3"

    resources {
      cores  = var.instance_cores
      memory = var.instance_memory
    }

    boot_disk {
      initialize_params {
        image_id = "fd8kdq6d0p3hur0bd2k9" # Container Optimized Image
        size     = var.instance_disk_size
      }
    }

    network_interface {
      subnet_ids = [yandex_vpc_subnet.main.id]
      security_group_ids = [yandex_vpc_security_group.instances.id]
      nat = false
    }

    container {
      image = local.image_uri

      dynamic "env" {
        for_each = local.env_vars
        content {
          key   = env.key
          value = env.value
        }
      }

      port {
        container_port = local.port
      }
    }

    service_account_id = yandex_iam_service_account.ig_sa.id
  }

  scale_policy {
    fixed_scale {
      size = var.instance_count
    }
  }

  allocation_policy {
    zones = [var.zone]
  }

  deploy_policy {
    max_unavailable = 1
    max_expansion   = 1
  }

  health_check {
    interval            = 30
    timeout             = 10
    unhealthy_threshold = 3
    healthy_threshold   = 2

    http_options {
      port = local.port
      path = "/health"
    }
  }

  load_balancer {
    target_group_name        = "${local.app_id}-tg"
    target_group_description = "Target group for ${var.app_name}"
  }
}

# ── Application Load Balancer ────────────────────────────────────────────────

resource "yandex_alb_backend_group" "app" {
  name      = "${local.app_id}-bg"
  folder_id = var.folder_id

  http_backend {
    name             = "app"
    port             = local.port
    target_group_ids = [yandex_compute_instance_group.app.load_balancer[0].target_group_id]
    weight           = 1

    healthcheck {
      timeout             = "10s"
      interval            = "30s"
      healthy_threshold   = 2
      unhealthy_threshold = 3

      http_healthcheck {
        path = "/health"
      }
    }
  }
}

resource "yandex_alb_http_router" "app" {
  name      = "${local.app_id}-router"
  folder_id = var.folder_id
}

resource "yandex_alb_virtual_host" "app" {
  name           = "default"
  http_router_id = yandex_alb_http_router.app.id

  route {
    name = "all"
    http_route {
      http_match {
        path {
          prefix = "/"
        }
      }
      http_route_action {
        backend_group_id = yandex_alb_backend_group.app.id
        timeout          = "30s"
      }
    }
  }
}

resource "yandex_alb_load_balancer" "app" {
  name      = "${local.app_id}-alb"
  folder_id = var.folder_id
  network_id = yandex_vpc_network.main.id
  security_group_ids = [yandex_vpc_security_group.alb.id]

  allocation_policy {
    location {
      zone_id   = var.zone
      subnet_id = yandex_vpc_subnet.main.id
    }
  }

  listener {
    name = "http"
    endpoint {
      address {
        external_ipv4_address {}
      }
      ports = [80]
    }
    http {
      handler {
        http_router_id = yandex_alb_http_router.app.id
      }
    }
  }

  dynamic "listener" {
    for_each = local.has_domain && local.effective_cert_id != "" ? [1] : []
    content {
      name = "https"
      endpoint {
        address {
          external_ipv4_address {}
        }
        ports = [443]
      }
      tls {
        default_handler {
          certificate_ids = [local.effective_cert_id]
          http_handler {
            http_router_id = yandex_alb_http_router.app.id
          }
        }
      }
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
  alb_external_ip = length(yandex_alb_load_balancer.app.listener) > 0 ? (
    length(yandex_alb_load_balancer.app.listener[0].endpoint) > 0 ? (
      yandex_alb_load_balancer.app.listener[0].endpoint[0].address[0].external_ipv4_address[0].address
    ) : ""
  ) : ""
}

resource "yandex_dns_recordset" "alb_a" {
  count   = local.has_domain && local.effective_dns_zone_id != "" && local.alb_external_ip != "" ? 1 : 0
  zone_id = local.effective_dns_zone_id
  name    = "${var.domain_name}."
  type    = "A"
  ttl     = 300
  data    = [local.alb_external_ip]
}
