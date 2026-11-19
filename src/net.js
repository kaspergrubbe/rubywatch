export class OutOfBudget extends Error {}

export class Net {
  constructor(budget) {
    this.left = budget;
    this.memo = new Map();
  }

  request(url, { method = "GET", headers = {}, cost = 1, body = true } = {}) {
    const key = `${method} ${url}`;
    if (!this.memo.has(key)) this.memo.set(key, this.send(url, method, headers, cost, body));
    return this.memo.get(key);
  }

  async send(url, method, headers, cost, body) {
    if (this.left < cost) throw new OutOfBudget(url);
    this.left -= cost;
    const res = await fetch(url, {
      method,
      headers: { "user-agent": "liverubyp (ruby release rollout tracker)", ...headers },
      signal: AbortSignal.timeout(12000),
    });
    const text = method === "GET" && body ? await res.text() : "";
    if (res.status >= 500 || res.status === 429 || res.status === 403) throw new Error(`${res.status} ${url}`);
    const modified = res.headers.get("last-modified");
    return { ok: res.ok, status: res.status, text, modified: modified ? new Date(modified) : null };
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
