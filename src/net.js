export class OutOfBudget extends Error {}

export class Net {
  constructor(budget, remembered = {}) {
    this.left = budget;
    this.memo = new Map();
    this.remembered = new Map(Object.entries(remembered));
  }

  async remember(key, compute) {
    const value = this.remembered.has(key) ? this.remembered.get(key) : await compute();
    this.remembered.delete(key);
    this.remembered.set(key, value);
    return value;
  }

  recent(limit) {
    return Object.fromEntries([...this.remembered].slice(-limit));
  }

  request(url, { method = "GET", headers = {}, cost = 1, body = true, binary = false } = {}) {
    const key = `${method} ${url}`;
    if (!this.memo.has(key)) this.memo.set(key, this.send(url, method, headers, cost, body, binary));
    return this.memo.get(key);
  }

  async send(url, method, headers, cost, body, binary) {
    if (this.left < cost) throw new OutOfBudget(url);
    this.left -= cost;
    const res = await fetch(url, {
      method,
      headers: { "user-agent": "rubywatch.speedshop.co (ruby release rollout tracker)", ...headers },
      signal: AbortSignal.timeout(12000),
    });
    const bytes = binary ? new Uint8Array(await res.arrayBuffer()) : null;
    const text = method === "GET" && body && !binary ? await res.text() : "";
    if (res.status >= 500 || res.status === 429 || res.status === 403) throw new Error(`${res.status} ${url}`);
    const modified = res.headers.get("last-modified");
    return { ok: res.ok, status: res.status, text, bytes, modified: modified ? new Date(modified) : null };
  }

  async bytes(url, opts) {
    const res = await this.request(url, { ...opts, binary: true });
    return res.ok ? res.bytes : null;
  }

  async json(url, opts) {
    const res = await this.request(url, opts);
    return res.ok ? JSON.parse(res.text) : null;
  }

  async text(url, opts) {
    const res = await this.request(url, opts);
    return res.ok ? res.text : null;
  }

  head(url, opts) {
    return this.request(url, { method: "HEAD", ...opts });
  }
}
