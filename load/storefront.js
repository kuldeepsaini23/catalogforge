// k6 load test: storefront product + collection pages while a large import runs.
//   k6 run -e BASE_URL=http://localhost:3000 load/storefront.js
// Product handles and collection slugs are discovered once in setup().
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const DURATION = __ENV.DURATION || "2m";
const COUNTRIES = ["DE", "FR", "US", "AT", "CH-de", "BE-fr", "GB"];

export const options = {
  scenarios: {
    product_pages: { executor: "constant-arrival-rate", rate: Number(__ENV.PRODUCT_RPS || 40), timeUnit: "1s", duration: DURATION, preAllocatedVUs: 40, maxVUs: 200, exec: "product" },
    collection_pages: { executor: "constant-arrival-rate", rate: Number(__ENV.COLLECTION_RPS || 10), timeUnit: "1s", duration: DURATION, preAllocatedVUs: 10, maxVUs: 100, exec: "collection" },
  },
  thresholds: {
    "http_req_duration{page:product}": ["p(95)<500"],
    "http_req_duration{page:collection}": ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const res = http.get(`${BASE}/api/storefront-index`);
  const body = res.json();
  if (!body.handles.length) throw new Error("No published products: approve some products before running the load test");
  return body;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function product(data) {
  const res = http.get(`${BASE}/store/${pick(COUNTRIES)}/products/${pick(data.handles)}`, { tags: { page: "product" } });
  check(res, { "product 200": (r) => r.status === 200 });
}

export function collection(data) {
  const res = http.get(`${BASE}/store/${pick(COUNTRIES)}/collections/${pick(data.collections)}`, { tags: { page: "collection" } });
  check(res, { "collection 200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  const pick = (name) => {
    const m = data.metrics[name];
    return m ? { p50: m.values.med, p95: m.values["p(95)"], p99: m.values["p(99)"], avg: m.values.avg, count: data.metrics.http_reqs.values.count } : null;
  };
  const summary = {
    product: pick("http_req_duration{page:product}"),
    collection: pick("http_req_duration{page:collection}"),
    failedRate: data.metrics.http_req_failed.values.rate,
    totalRequests: data.metrics.http_reqs.values.count,
    rps: data.metrics.http_reqs.values.rate,
  };
  return {
    stdout: JSON.stringify(summary, null, 2) + "\n",
    [__ENV.SUMMARY_FILE || "load/results/k6-summary.json"]: JSON.stringify(summary, null, 2),
  };
}
