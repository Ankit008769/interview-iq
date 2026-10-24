# Adopt the hand-built staging resources instead of creating new ones. After the first successful
# apply these blocks are no-ops; they can stay as documentation or be removed.
locals {
  p = var.project_id
}

import {
  for_each = local.apis
  to       = google_project_service.apis[each.key]
  id       = "${local.p}/${each.key}"
}

import {
  to = google_compute_network.staging
  id = "projects/${local.p}/global/networks/${var.network_name}"
}

import {
  to = google_compute_subnetwork.staging
  id = "projects/${local.p}/regions/${var.region}/subnetworks/${var.subnet_name}"
}

import {
  to = google_compute_firewall.mongo_private
  id = "projects/${local.p}/global/firewalls/interviewiq-mongo-private"
}

import {
  to = google_service_account.app
  id = "projects/${local.p}/serviceAccounts/${var.app_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_service_account.build
  id = "projects/${local.p}/serviceAccounts/${var.build_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_service_account.mongo
  id = "projects/${local.p}/serviceAccounts/${var.mongo_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  for_each = local.app_secrets
  to       = google_secret_manager_secret.app[each.key]
  id       = "projects/${local.p}/secrets/${each.key}"
}

import {
  to = google_secret_manager_secret.mongo_password
  id = "projects/${local.p}/secrets/interviewiq-mongo-password"
}

import {
  for_each = local.app_secrets
  to       = google_secret_manager_secret_iam_member.app[each.key]
  id       = "projects/${local.p}/secrets/${each.key} roles/secretmanager.secretAccessor serviceAccount:${var.app_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_secret_manager_secret_iam_member.mongo_password
  id = "projects/${local.p}/secrets/interviewiq-mongo-password roles/secretmanager.secretAccessor serviceAccount:${var.mongo_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_project_iam_member.build_run_builder
  id = "${local.p} roles/run.builder serviceAccount:${var.build_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_compute_disk.mongo_data
  id = "projects/${local.p}/zones/${var.zone}/disks/${var.mongo_data_disk_name}"
}

import {
  to = google_compute_resource_policy.hourly_snapshots
  id = "projects/${local.p}/regions/${var.region}/resourcePolicies/interviewiq-hourly-7d"
}

import {
  to = google_compute_disk_resource_policy_attachment.hourly_snapshots
  id = "${local.p}/${var.zone}/${var.mongo_data_disk_name}/interviewiq-hourly-7d"
}

import {
  to = google_compute_instance.mongo
  id = "projects/${local.p}/zones/${var.zone}/instances/${var.mongo_vm_name}"
}

import {
  to = google_storage_bucket.deletion_ledger
  id = var.deletion_ledger_bucket
}

import {
  to = google_storage_bucket_iam_member.app_ledger_creator
  id = "b/${var.deletion_ledger_bucket} roles/storage.objectCreator serviceAccount:${var.app_service_account_id}@${local.p}.iam.gserviceaccount.com"
}

import {
  to = google_cloud_run_v2_service.app
  id = "projects/${local.p}/locations/${var.region}/services/${var.service_name}"
}

import {
  for_each = var.public_invoker ? toset(["allUsers"]) : toset([])
  to       = google_cloud_run_v2_service_iam_member.public[0]
  id       = "projects/${local.p}/locations/${var.region}/services/${var.service_name} roles/run.invoker ${each.key}"
}
