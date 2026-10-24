terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # Remote state lives in a versioned, private bucket created once by hand
  # (docs/INFRASTRUCTURE_AS_CODE.md). Pass it with -backend-config="bucket=...".
  backend "gcs" {
    prefix = "staging"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
