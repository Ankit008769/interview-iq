# ---------------------------------------------------------------- open models (scale to zero)
#
# Ollama (deploy/ollama) and faster-whisper (deploy/whisper) run as their own private Cloud Run services that
# scale to zero, so staging pays for model CPU only while a question is written, an answer is scored or a voice
# answer is transcribed. The always-on app reaches them over HTTPS with its service account's identity token
# (AI_PROVIDER=local, LOCAL_MODEL_AUTH=google, LLM_BASE_URL and TRANSCRIPTION_BASE_URL set by the release).
# Billing is request-based: CPU is granted only while a request is in flight, which is why the app's warm-up
# request, not a start-up script, loads the model. Neither service holds secrets or has IAM roles.

resource "google_service_account" "models" {
  account_id   = var.models_service_account_id
  display_name = "InterviewIQ open model services (no roles)"
}

resource "google_cloud_run_v2_service" "model" {
  name                = var.model_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.models.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "1200s" # scoring five answers on CPU can take several minutes
    max_instance_request_concurrency = 4       # one copy of the weights; Ollama queues requests in turn

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.model_image
      ports {
        container_port = 11434
      }
      env {
        name  = "OLLAMA_PRELOAD"
        value = "0"
      }
      resources {
        limits = {
          cpu    = var.model_cpu
          memory = var.model_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      startup_probe {
        http_get {
          path = "/api/version"
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60
      }
    }
  }

  lifecycle {
    ignore_changes = [client, client_version, template[0].containers[0].image, template[0].revision, template[0].labels, template[0].annotations]
  }
}

resource "google_cloud_run_v2_service" "voice" {
  count               = var.voice_image == "" ? 0 : 1
  name                = var.voice_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.models.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "600s"
    max_instance_request_concurrency = 2

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.voice_image
      ports {
        container_port = 8000
      }
      resources {
        limits = {
          cpu    = var.voice_cpu
          memory = var.voice_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 60
      }
    }
  }

  lifecycle {
    ignore_changes = [client, client_version, template[0].containers[0].image, template[0].revision, template[0].labels, template[0].annotations]
  }
}

resource "google_cloud_run_v2_service_iam_member" "model_app_invoker" {
  name     = google_cloud_run_v2_service.model.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.app.email}"
}

resource "google_cloud_run_v2_service_iam_member" "voice_app_invoker" {
  count    = var.voice_image == "" ? 0 : 1
  name     = google_cloud_run_v2_service.voice[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.app.email}"
}
