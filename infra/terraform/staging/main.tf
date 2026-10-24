locals {
  apis = toset([
    "compute.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com", "iam.googleapis.com",
    "storage.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com",
  ])
  app_secrets = toset(["interviewiq-mongodb-uri", "interviewiq-jwt-secret"])
}

resource "google_project_service" "apis" {
  for_each           = local.apis
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- network

resource "google_compute_network" "staging" {
  name                    = var.network_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "staging" {
  name                     = var.subnet_name
  region                   = var.region
  network                  = google_compute_network.staging.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = var.subnet_private_google_access
}

# MongoDB is reachable only from inside the subnet (Cloud Run's Direct VPC egress); no public ingress.
resource "google_compute_firewall" "mongo_private" {
  name          = "interviewiq-mongo-private"
  network       = google_compute_network.staging.name
  direction     = "INGRESS"
  source_ranges = [var.subnet_cidr]
  target_tags   = [var.mongo_network_tag]
  allow {
    protocol = "tcp"
    ports    = ["27017"]
  }
}

# ---------------------------------------------------------------- service accounts and secrets

# Display names and descriptions were set by hand; ignore them so adoption does not rewrite them.
resource "google_service_account" "app" {
  account_id = var.app_service_account_id
  lifecycle { ignore_changes = [display_name, description] }
}

resource "google_service_account" "build" {
  account_id = var.build_service_account_id
  lifecycle { ignore_changes = [display_name, description] }
}

resource "google_service_account" "mongo" {
  account_id = var.mongo_service_account_id
  lifecycle { ignore_changes = [display_name, description] }
}

# Secret containers only. Values are added with `gcloud secrets versions add` and never enter
# Terraform state. Replication is ignored because changing it would recreate the secret.
resource "google_secret_manager_secret" "app" {
  for_each  = local.app_secrets
  secret_id = each.key
  replication {
    auto {}
  }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [replication, labels, annotations]
  }
}

resource "google_secret_manager_secret" "mongo_password" {
  secret_id = "interviewiq-mongo-password"
  replication {
    auto {}
  }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [replication, labels, annotations]
  }
}

# Additive *_member grants only: they never remove access granted outside Terraform.
resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = local.app_secrets
  secret_id = google_secret_manager_secret.app[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "mongo_password" {
  secret_id = google_secret_manager_secret.mongo_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.mongo.email}"
}

resource "google_project_iam_member" "build_run_builder" {
  project = var.project_id
  role    = "roles/run.builder"
  member  = "serviceAccount:${google_service_account.build.email}"
}

# ---------------------------------------------------------------- MongoDB VM, data disk and backups

resource "google_compute_disk" "mongo_data" {
  name = var.mongo_data_disk_name
  zone = var.zone
  size = var.mongo_data_disk_size_gb
  type = var.mongo_data_disk_type
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [snapshot, image, labels]
  }
}

resource "google_compute_resource_policy" "hourly_snapshots" {
  name   = "interviewiq-hourly-7d"
  region = var.region
  snapshot_schedule_policy {
    schedule {
      hourly_schedule {
        hours_in_cycle = 1
        start_time     = "00:00"
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "APPLY_RETENTION_POLICY"
    }
    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "hourly_snapshots" {
  name = google_compute_resource_policy.hourly_snapshots.name
  disk = google_compute_disk.mongo_data.name
  zone = var.zone
}

resource "google_compute_instance" "mongo" {
  name                      = var.mongo_vm_name
  zone                      = var.zone
  machine_type              = var.mongo_machine_type
  tags                      = [var.mongo_network_tag]
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = var.mongo_boot_image
      size  = var.mongo_boot_disk_size_gb
    }
  }

  # deploy/mongo-startup.sh expects /dev/disk/by-id/google-mongo-data.
  attached_disk {
    source      = google_compute_disk.mongo_data.id
    device_name = "mongo-data"
  }

  # The external address is for outbound package and image downloads only; the firewall allows no
  # public ingress.
  network_interface {
    subnetwork = google_compute_subnetwork.staging.id
    network_ip = var.mongo_private_ip
    access_config {}
  }

  metadata = {
    startup-script = file("${path.module}/../../../deploy/mongo-startup.sh")
  }

  service_account {
    email  = google_service_account.mongo.email
    scopes = ["cloud-platform"]
  }

  # The boot disk holds the MongoDB root credentials; never let a plan recreate this VM.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [boot_disk[0].initialize_params, metadata["ssh-keys"], labels]
  }
}

# ---------------------------------------------------------------- deletion ledger

resource "google_storage_bucket" "deletion_ledger" {
  name                        = var.deletion_ledger_bucket
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  retention_policy {
    retention_period = 2592000 # 30 days, unlocked
    is_locked        = false
  }
  lifecycle { prevent_destroy = true }
}

# Create-only: the app can write receipts but cannot list, read, replace or delete them.
resource "google_storage_bucket_iam_member" "app_ledger_creator" {
  bucket = google_storage_bucket.deletion_ledger.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.app.email}"
}

# ---------------------------------------------------------------- Cloud Run

resource "google_cloud_run_v2_service" "app" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.app.email

    # One always-on instance so the embedded worker keeps running between requests.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      egress = var.run_vpc_egress
      network_interfaces {
        network    = google_compute_network.staging.name
        subnetwork = google_compute_subnetwork.staging.name
      }
    }

    containers {
      image = var.container_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = var.run_cpu
          memory = var.run_memory
        }
        cpu_idle = false # instance-based billing: CPU stays allocated for the worker
      }
      env {
        name  = "CLIENT_ORIGIN"
        value = var.client_origin
      }
      env {
        name  = "DELETION_LEDGER_BUCKET"
        value = google_storage_bucket.deletion_ledger.name
      }
      dynamic "env" {
        for_each = var.extra_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "MONGODB_URI"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["interviewiq-mongodb-uri"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["interviewiq-jwt-secret"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  # Releases (gcloud run deploy or CI) own the image and revision metadata.
  lifecycle {
    ignore_changes = [client, client_version, template[0].containers[0].image, template[0].revision, template[0].labels, template[0].annotations]
  }

  depends_on = [google_secret_manager_secret_iam_member.app]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public_invoker ? 1 : 0
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
