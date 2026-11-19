const raw = "https://raw.githubusercontent.com";
const after = (v) => new RegExp(`${v.replaceAll(".", "\\.")}(?![\\d.])`);
const found = (at = null) => ({ at });

async function atom(net, repo, kind = "releases") {
  const xml = await net.text(`https://github.com/${repo}/${kind}.atom`);
  if (xml === null) throw new Error(`no feed for ${repo}`);
  return xml.split("<entry>").slice(1).map((e) => ({
    title: e.match(/<title>([^<]*)</)?.[1] ?? "",
    tag: e.match(/<id>[^<]*\/([^<\/]+)<\/id>/)?.[1] ?? "",
    at: new Date(e.match(/<updated>([^<]+)</)[1]),
    content: e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "",
  }));
}

const earliest = (entries) => (entries.length ? found(new Date(Math.min(...entries.map((e) => e.at)))) : null);

async function rubyBuildRelease(net, v) {
  const entries = await atom(net, "rbenv/ruby-build");
  const match = entries.filter((e) => new RegExp(`Add ${after(v).source}`).test(e.content)).pop();
  return match && { at: match.at, number: Number(match.tag.replace(/\D/g, "")) };
}

async function lastModified(net, url, cost = 1) {
  const res = await net.head(url, { cost });
  return res.ok ? found(res.modified) : null;
}

async function registry(net, tokenUrl, base, v) {
  const { token } = await net.json(tokenUrl);
  const res = await net.head(`${base}/manifests/${v}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  return res.ok ? found() : null;
}

const dockerHub = (net, repo, v) =>
  registry(
    net,
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    `https://registry-1.docker.io/v2/${repo}`,
    v,
  );

async function fileHas(net, url, pattern) {
  const text = await net.text(url);
  if (text === null) throw new Error(`missing ${url}`);
  return pattern.test(text) ? found() : null;
}

const brewFormula = (s) => (s === "4.0" ? "ruby" : `ruby@${s}`);

export const groups = [
  {
    name: "Installers and version managers",
    targets: [
      {
        id: "ruby-build",
        name: "ruby-build",
        note: "rbenv, and mise when compiling",
        url: "https://github.com/rbenv/ruby-build/releases",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          return release ? found(release.at) : null;
        },
      },
      {
        id: "ruby-builder",
        name: "ruby/ruby-builder binaries",
        url: "https://github.com/ruby/ruby-builder/releases/tag/ruby-{v}",
        probe: (net, { version: v }) =>
          lastModified(net, `https://github.com/ruby/ruby-builder/releases/download/ruby-${v}/ruby-${v}-ubuntu-24.04-x64.tar.gz`, 2),
      },
      {
        id: "brew-ruby-build",
        name: "Homebrew ruby-build",
        url: "https://formulae.brew.sh/formula/ruby-build",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          if (!release) return null;
          const formula = await net.json("https://formulae.brew.sh/api/formula/ruby-build.json");
          return Number(formula.versions.stable) >= release.number ? found() : null;
        },
      },
      {
        id: "asdf",
        name: "asdf",
        url: "https://github.com/asdf-vm/asdf-ruby/commits/master",
        probe: async (net, { version }) => {
          const release = await rubyBuildRelease(net, version);
          if (!release) return null;
          const utils = await net.text(`${raw}/asdf-vm/asdf-ruby/master/lib/utils.sh`);
          return Number(utils.match(/ASDF_RUBY_BUILD_VERSION:-v(\d+)/)[1]) >= release.number ? found() : null;
        },
      },
      {
        id: "jdx",
        name: "jdx/ruby binaries",
        note: "mise's precompiled Rubies",
        url: "https://github.com/jdx/ruby/releases/tag/{v}",
        probe: async (net, { version }) => earliest((await atom(net, "jdx/ruby")).filter((e) => e.title === version)),
      },
      {
        id: "rubyinstaller",
        name: "RubyInstaller",
        note: "Windows",
        url: "https://github.com/oneclick/rubyinstaller2/releases",
        probe: async (net, { version }) =>
          earliest((await atom(net, "oneclick/rubyinstaller2")).filter((e) => e.tag.startsWith(`RubyInstaller-${version}-`))),
      },
      {
        id: "rvm",
        name: "RVM",
        url: "https://github.com/rvm/rvm/commits/master/config/known",
        probe: async (net, { version }) => {
          const known = await net.text(`${raw}/rvm/rvm/master/config/known`);
          return after(`ruby-${version}`).test(known.replace(/[[\]]/g, "")) ? found() : null;
        },
      },
      {
        id: "rv",
        name: "rv",
        url: "https://github.com/spinel-coop/rv-ruby/releases",
        probe: (net, { version: v }) =>
          lastModified(net, `https://github.com/spinel-coop/rv-ruby/releases/latest/download/ruby-${v}.x86_64_linux.tar.gz`, 3),
      },
      {
        id: "ruby-install",
        name: "ruby-install",
        note: "version metadata",
        url: "https://github.com/postmodern/ruby-versions/commits/master",
        probe: async (net, { version }) => {
          const versions = await net.text(`${raw}/postmodern/ruby-versions/master/ruby/versions.txt`);
          return versions.split("\n").includes(version) ? found() : null;
        },
      },
    ],
  },
  {
    name: "Container images",
    targets: [
      {
        id: "rubylang",
        name: "rubylang/ruby",
        note: "by the Ruby core team",
        url: "https://hub.docker.com/r/rubylang/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "rubylang/ruby", version),
      },
      {
        id: "bitnami",
        name: "bitnami/ruby",
        url: "https://github.com/bitnami/containers/commits/main/bitnami/ruby",
        series: ["4.0"],
        probe: async (net, { version, series }) => {
          const dockerfile = await net.text(`${raw}/bitnami/containers/main/bitnami/ruby/${series}/debian-12/Dockerfile`);
          if (!dockerfile.includes(`image.version="${version}"`)) return null;
          return found(new Date(dockerfile.match(/image\.created="([^"]+)"/)[1]));
        },
      },
      {
        id: "sorah-image",
        name: "sorah/ruby",
        note: "built from sorah-rbpkg",
        url: "https://gallery.ecr.aws/sorah/ruby",
        probe: (net, { version }) =>
          registry(net, "https://public.ecr.aws/token/", "https://public.ecr.aws/v2/sorah/ruby", version),
      },
      {
        id: "alpine-ruby",
        name: "bkuhlmann/alpine-ruby",
        url: "https://github.com/bkuhlmann/docker-alpine-ruby",
        series: ["4.0"],
        probe: (net, { version }) =>
          fileHas(net, `${raw}/bkuhlmann/docker-alpine-ruby/main/Dockerfile`, new RegExp(`RUBY_VERSION=${after(version).source}`)),
      },
      {
        id: "devcontainer",
        name: "rails/devcontainer",
        url: "https://github.com/rails/devcontainer/pkgs/container/devcontainer%2Fimages%2Fruby",
        probe: (net, { version }) =>
          registry(
            net,
            "https://ghcr.io/token?scope=repository:rails/devcontainer/images/ruby:pull",
            "https://ghcr.io/v2/rails/devcontainer/images/ruby",
            version,
          ),
      },
      {
        id: "docker-official",
        name: "ruby",
        note: "Docker official image",
        url: "https://hub.docker.com/_/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "library/ruby", version),
      },
    ],
  },
  {
    name: "CI",
    targets: [
      {
        id: "mise-action",
        name: "GitHub Actions mise-action",
        note: "Linux and macOS",
        url: "https://github.com/jdx/ruby/releases/tag/{v}",
        sameAs: "jdx",
      },
      {
        id: "setup-ruby",
        name: "GitHub Actions setup-ruby",
        note: "Linux and macOS",
        url: "https://github.com/ruby/setup-ruby/releases",
        probe: async (net, { version }) => {
          const versions = await net.json(`${raw}/ruby/setup-ruby/v1/ruby-builder-versions.json`);
          return versions.ruby.includes(version) ? found() : null;
        },
      },
      {
        id: "cimg",
        name: "CircleCI cimg/ruby",
        url: "https://hub.docker.com/r/cimg/ruby/tags?name={v}",
        probe: (net, { version }) => dockerHub(net, "cimg/ruby", version),
      },
      {
        id: "setup-ruby-windows",
        name: "GitHub Actions setup-ruby",
        note: "Windows",
        url: "https://github.com/ruby/setup-ruby/releases",
        probe: async (net, { version }) => {
          const versions = await net.json(`${raw}/ruby/setup-ruby/v1/windows-versions.json`);
          return version in versions ? found() : null;
        },
      },
    ],
  },
  {
    name: "Hosting platforms",
    targets: [
      {
        id: "render",
        name: "Render",
        note: "compiles any version from the tarball",
        url: "https://gist.github.com/nateberkopec/e8cdf967980d4c00d0592c140e3fd012",
        immediate: true,
      },
      {
        id: "heroku",
        name: "Heroku",
        url: "https://devcenter.heroku.com/changelog",
        probe: (net, { version: v }) =>
          lastModified(net, `https://heroku-buildpack-ruby.s3.us-east-1.amazonaws.com/heroku-24/amd64/ruby-${v}.tgz`),
      },
      {
        id: "digitalocean",
        name: "DigitalOcean App Platform",
        note: "Heroku's buildpack",
        url: "https://docs.digitalocean.com/products/app-platform/reference/buildpacks/ruby/",
        sameAs: "heroku",
      },
      {
        id: "northflank",
        name: "Northflank",
        note: "Heroku builder",
        url: "https://northflank.com/docs/v1/application/build/build-with-buildpacks",
        sameAs: "heroku",
      },
      {
        id: "scalingo",
        name: "Scalingo",
        url: "https://github.com/Scalingo/ruby-buildpack",
        probe: (net, { version: v }) => lastModified(net, `https://ruby-binaries.scalingo.com/scalingo-24/amd64/ruby-${v}.tgz`),
      },
      {
        id: "hatchbox",
        name: "Hatchbox",
        note: "uses asdf",
        url: "https://hatchbox.relationkit.io/articles/26-how-do-i-specify-a-ruby-version-for-my-app",
        sameAs: "asdf",
      },
      {
        id: "railway",
        name: "Railway",
        note: "Railpack compiles from source via mise",
        url: "https://railpack.com/languages/ruby#precompiled-ruby",
        immediate: true,
      },
      {
        id: "fly-kamal",
        name: "Fly.io, Kamal",
        note: "anything on the Docker official image",
        url: "https://hub.docker.com/_/ruby/tags?name={v}",
        sameAs: "docker-official",
      },
      {
        id: "gcp",
        name: "Google Cloud",
        note: "Cloud Run, App Engine",
        url: "https://console.cloud.google.com/artifacts/docker/serverless-runtimes/us/runtimes-ubuntu2404/ruby",
        probe: async (net, { version }) => {
          const list = await net.json("https://us-docker.pkg.dev/v2/serverless-runtimes/runtimes-ubuntu2404/ruby/tags/list");
          const image = Object.values(list.manifest).find((m) => m.tag.includes(version));
          return image ? found(new Date(Number(image.timeUploadedMs))) : null;
        },
      },
      {
        id: "beanstalk",
        name: "AWS Elastic Beanstalk",
        url: "https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html#platforms-supported.ruby",
        probe: (net, { version }) =>
          fileHas(net, "https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html", after(`Ruby ${version}`)),
      },
      {
        id: "lambda",
        name: "AWS Lambda",
        url: "https://gallery.ecr.aws/lambda/ruby",
        unsourced: "No source to check. The image tags don't name the Ruby patch version inside.",
      },
    ],
  },
  {
    name: "System packages",
    targets: [
      {
        id: "snap",
        name: "Snap",
        url: "https://snapcraft.io/ruby",
        probe: async (net, { version, series }) => {
          const info = await net.json("https://api.snapcraft.io/v2/snaps/info/ruby?architecture=amd64&fields=version", {
            headers: { "snap-device-series": "16" },
          });
          const channel = info["channel-map"].find((c) => c.channel.name === `${series}/stable` && c.version === version);
          return channel ? found(new Date(channel.channel["released-at"])) : null;
        },
      },
      {
        id: "sorah-rbpkg",
        name: "sorah-rbpkg",
        note: "APT packages for Ubuntu and Debian",
        url: "https://github.com/sorah-rbpkg/ruby/releases",
        probe: async (net, { version }) => {
          const res = await net.head(`https://github.com/sorah-rbpkg/ruby/releases/tag/debian%2F${version}-0nkmi1_noble`);
          return res.ok ? found() : null;
        },
      },
      {
        id: "brew",
        name: "Homebrew",
        url: "https://formulae.brew.sh/formula/ruby",
        probe: async (net, { version, series }) => {
          const formula = await net.json(`https://formulae.brew.sh/api/formula/${brewFormula(series)}.json`);
          return formula?.versions.stable === version ? found() : null;
        },
      },
      {
        id: "nixpkgs",
        name: "nixpkgs",
        url: "https://github.com/NixOS/nixpkgs/commits/master/pkgs/development/interpreters/ruby/default.nix",
        series: ["4.0", "3.4"],
        probe: (net, { version }) =>
          fileHas(
            net,
            `${raw}/NixOS/nixpkgs/master/pkgs/development/interpreters/ruby/default.nix`,
            new RegExp(`rubyVersion ${version.split(".").map((n) => `"${n}"`).join(" ")} ""`),
          ),
      },
      {
        id: "fedora",
        name: "Fedora",
        note: "Rawhide",
        url: "https://packages.fedoraproject.org/pkgs/ruby/ruby/",
        series: ["4.0"],
        probe: async (net, { version }) => {
          const pkg = await net.json("https://mdapi.fedoraproject.org/rawhide/pkg/ruby");
          return pkg.version === version ? found() : null;
        },
      },
      {
        id: "winget",
        name: "winget",
        url: "https://github.com/microsoft/winget-pkgs/tree/master/manifests/r/RubyInstallerTeam/Ruby",
        probe: async (net, { version, series }) => {
          const dir = `${raw}/microsoft/winget-pkgs/master/manifests/r/RubyInstallerTeam/Ruby/${series.replace(".", "/")}`;
          const res = await net.head(`${dir}/${version}-1/RubyInstallerTeam.Ruby.${series}.installer.yaml`);
          return res.ok ? found() : null;
        },
      },
      {
        id: "arch",
        name: "Arch Linux",
        url: "https://archlinux.org/packages/extra/x86_64/ruby/",
        series: ["3.4"],
        probe: async (net, { version }) => {
          const pkg = await net.json("https://archlinux.org/packages/extra/x86_64/ruby/json/");
          return pkg.pkgver === version ? found(new Date(pkg.last_update)) : null;
        },
      },
      {
        id: "alpine",
        name: "Alpine Linux",
        note: "edge",
        url: "https://pkgs.alpinelinux.org/packages?name=ruby&branch=edge&arch=x86_64",
        series: ["3.4"],
        probe: (net, { version }) =>
          fileHas(
            net,
            "https://pkgs.alpinelinux.org/packages?name=ruby&branch=edge&arch=x86_64",
            new RegExp(`<td class="version">[^<]*<[^>]*>${version.replaceAll(".", "\\.")}-r\\d+<`),
          ),
      },
      {
        id: "debian",
        name: "Debian",
        note: "any suite, including experimental and proposed updates",
        url: "https://tracker.debian.org/pkg/ruby{s}",
        series: ["3.4", "3.3"],
        probe: async (net, { version, series }) => {
          const src = await net.json(`https://sources.debian.org/api/src/ruby${series}/`);
          return src.versions.some((v) => v.version.startsWith(`${version}-`)) ? found() : null;
        },
      },
      {
        id: "ubuntu",
        name: "Ubuntu",
        note: "any series",
        url: "https://launchpad.net/ubuntu/+source/ruby{s}",
        series: ["3.3"],
        probe: async (net, { version, series }) => {
          const { entries } = await net.json(
            `https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedSources&source_name=ruby${series}&exact_match=true&status=Published&ws.size=50`,
          );
          const published = entries.filter((e) => e.source_package_version.startsWith(`${version}-`));
          return earliest(published.map((e) => ({ at: new Date(e.date_published) })));
        },
      },
    ],
  },
];

export const targets = groups.flatMap((g) => g.targets);
