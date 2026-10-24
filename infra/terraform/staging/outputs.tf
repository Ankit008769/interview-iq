output "service_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "app_service_account" {
  value = google_service_account.app.email
}

output "mongo_private_ip" {
  value = google_compute_instance.mongo.network_interface[0].network_ip
}
