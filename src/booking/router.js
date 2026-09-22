/** 极简正则路由：按注册顺序匹配 method + pathname，捕获组作为 params */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, pattern: new RegExp(pattern), handler });
  }

  get(pattern, handler) {
    this.add("GET", pattern, handler);
  }

  post(pattern, handler) {
    this.add("POST", pattern, handler);
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      await route.handler(req, res, { ...match.groups });
      return true; // 已匹配（即便 handler 无显式返回值）
    }
    return false;
  }
}
