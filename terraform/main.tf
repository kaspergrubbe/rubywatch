locals {
  root     = "${path.module}/.."
  wrangler = jsondecode(file("${local.root}/wrangler.json"))
}

resource "cloudflare_worker" "rubywatch" {
  account_id = var.cloudflare_account_id
  name       = local.wrangler.name

  observability = {
    enabled = true
  }

  subdomain = {
    enabled = false
  }
}

resource "cloudflare_worker_version" "rubywatch" {
  account_id         = var.cloudflare_account_id
  worker_id          = cloudflare_worker.rubywatch.id
  compatibility_date = local.wrangler.compatibility_date
  main_module        = "index.js"

  modules = [
    for name in fileset("${local.root}/src", "*.js") : {
      name         = name
      content_type = "application/javascript+module"
      content_file = "${local.root}/src/${name}"
    }
  ]

  assets = {
    directory = "${local.root}/public"
  }

  bindings = [
    {
      type = "d1"
      name = "DB"
      id   = var.d1_database_id
    }
  ]
}

resource "cloudflare_workers_deployment" "rubywatch" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.rubywatch.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.rubywatch.id
    }
  ]
}

resource "cloudflare_workers_cron_trigger" "rubywatch" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.rubywatch.name
  schedules   = [for cron in local.wrangler.triggers.crons : { cron = cron }]

  depends_on = [cloudflare_workers_deployment.rubywatch]
}
