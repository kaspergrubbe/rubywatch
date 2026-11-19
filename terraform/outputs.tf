output "worker_name" {
  value      = cloudflare_worker.rubywatch.name
  depends_on = [cloudflare_workers_deployment.rubywatch]
}
