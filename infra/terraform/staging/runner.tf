# ---------------------------------------------------------------- code runner (coding lab, C2)
#
# A separate Cloud Run service that compiles and runs candidate code. Its service account has no IAM roles,
# only the app's service account may invoke it, and all of its egress goes into a VPC with no route out and a
# deny-all egress rule. Inside the container every program also runs under a seccomp filter without network
# sockets (runner/sandbox/iq-sandbox.c), so the network block does not depend on this layer alone.

resource "google_service_account" "runner" {
  account_id   = var.runner_service_account_id
  display_name = "InterviewIQ code runner (no roles)"
}

resource "google_compute_network" "runner" {
  name                    = var.runner_network_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "runner" {
  name                     = var.runner_subnet_name
  region                   = var.region
  network                  = google_compute_network.runner.id
  ip_cidr_range            = var.runner_subnet_cidr
  private_ip_google_access = false
}

resource "google_compute_firewall" "runner_deny_egress" {
  name               = "interviewiq-runner-deny-egress"
  network            = google_compute_network.runner.name
  direction          = "EGRESS"
  priority           = 1000
  destination_ranges = ["0.0.0.0/0"]
  deny {
    protocol = "all"
  }
}

resource "google_cloud_run_v2_service" "runner" {
  name                = var.runner_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.runner.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN1"
    timeout                          = "60s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.runner.name
        subnetwork = google_compute_subnetwork.runner.name
      }
    }

    containers {
      image = var.runner_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 2
        failure_threshold = 30
      }
    }
  }

  # Releases own the image; Terraform owns the isolation settings.
  lifecycle {
    ignore_changes = [client, client_version, template[0].containers[0].image, template[0].revision, template[0].labels, template[0].annotations]
  }
}

resource "google_cloud_run_v2_service_iam_member" "runner_app_invoker" {
  name     = google_cloud_run_v2_service.runner.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.app.email}"
}
