# Defaults describe the existing staging environment as documented in docs/GOOGLE_CLOUD_STAGING.md.
# Values marked CONFIRM were not recorded when staging was created by hand: check them against the
# first `terraform plan` and adjust until the plan shows only imports (no updates, no replacements).

variable "project_id" {
  type    = string
  default = "project-12b39f1f-9d49-456e-957"
}

variable "project_number" {
  type    = string
  default = "341474411884"
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "zone" {
  type    = string
  default = "asia-south1-b"
}

variable "network_name" {
  type    = string
  default = "interviewiq-staging"
}

variable "subnet_name" {
  description = "CONFIRM: Direct VPC egress subnet; assumed to share the network's name."
  type        = string
  default     = "interviewiq-staging"
}

variable "subnet_cidr" {
  type    = string
  default = "10.42.0.0/24"
}

variable "subnet_private_google_access" {
  description = "CONFIRM."
  type        = bool
  default     = false
}

variable "mongo_vm_name" {
  type    = string
  default = "interviewiq-mongo"
}

variable "mongo_machine_type" {
  type    = string
  default = "e2-small"
}

variable "mongo_private_ip" {
  type    = string
  default = "10.42.0.10"
}

variable "mongo_network_tag" {
  description = "CONFIRM: network tag that the Mongo firewall rule targets."
  type        = string
  default     = "interviewiq-mongo"
}

variable "mongo_boot_image" {
  description = "CONFIRM. Ignored after import (changing it would recreate the VM); used only for a fresh environment."
  type        = string
  default     = "debian-cloud/debian-12"
}

variable "mongo_boot_disk_size_gb" {
  description = "CONFIRM. Ignored after import, like the image."
  type        = number
  default     = 10
}

variable "mongo_data_disk_name" {
  type    = string
  default = "interviewiq-mongo-data"
}

variable "mongo_data_disk_size_gb" {
  type    = number
  default = 20
}

variable "mongo_data_disk_type" {
  description = "CONFIRM."
  type        = string
  default     = "pd-balanced"
}

variable "mongo_service_account_id" {
  description = "CONFIRM: account ID (the part before @) of the Mongo VM's service account."
  type        = string
  default     = "interviewiq-mongo"
}

variable "app_service_account_id" {
  type    = string
  default = "interviewiq-app"
}

variable "build_service_account_id" {
  type    = string
  default = "interviewiq-build"
}

variable "deletion_ledger_bucket" {
  type    = string
  default = "interviewiq-deletion-ledger-341474411884"
}

variable "service_name" {
  type    = string
  default = "interview-iq"
}

variable "container_image" {
  description = "Used only when creating the service. Deploys change the image; Terraform ignores it afterwards."
  type        = string
  default     = "asia-south1-docker.pkg.dev/project-12b39f1f-9d49-456e-957/cloud-run-source-deploy/interview-iq:latest"
}

variable "run_cpu" {
  description = "CONFIRM."
  type        = string
  default     = "1"
}

variable "run_memory" {
  description = "CONFIRM."
  type        = string
  default     = "512Mi"
}

variable "run_vpc_egress" {
  description = "CONFIRM: PRIVATE_RANGES_ONLY or ALL_TRAFFIC."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"
}

variable "client_origin" {
  type    = string
  default = "https://interview-iq-341474411884.asia-south1.run.app"
}

variable "extra_env" {
  description = "CONFIRM: any other plain environment variables the live service has (for example AI_PROVIDER or TRUST_PROXY_HOPS). Never put secrets here."
  type        = map(string)
  default     = {}
}

variable "public_invoker" {
  description = "Staging currently allows public HTTP; application data still requires sign-in."
  type        = bool
  default     = true
}
