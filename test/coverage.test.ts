// Every operation in the spec is reachable as client.<group>.<method>() and
// sends the method and path the spec documents.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { json, mockClient } from "./helpers.js";

const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"));
const ops = Object.entries(spec.paths as Record<string, Record<string, any>>).flatMap(([path, item]) =>
  ["get", "post", "put", "patch", "delete"].filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m] })),
);

describe("every operation", () => {
  it.each(ops.map((o) => [`${[...o.op["x-sdk-group"], o.op["x-sdk-method"]].join(".")}`, o]))("%s", async (_, o) => {
    const { client, calls } = mockClient([json({})]);
    let target: any = client;
    for (const g of o.op["x-sdk-group"]) target = target[g];
    const fn = target[o.op["x-sdk-method"]];
    expect(typeof fn).toBe("function");
    const pathParams = [...o.path.matchAll(/\{(\w+)\}/g)].map((_m, i) => `p${i}`);
    const args: unknown[] = [...pathParams];
    if (o.op.requestBody) args.push({});
    await fn(...args);
    expect(calls[0].method).toBe(o.method.toUpperCase());
    let i = 0;
    expect(calls[0].url.pathname).toBe("/api" + o.path.replace(/\{\w+\}/g, () => `p${i++}`));
  });
});
