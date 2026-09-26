/* Build-time OpenAPI artifact generation. Backend/openapi.yaml is the reviewed
 * source contract; this copies it beside compiled JS so deployments can serve
 * the exact spec for their build without depending on the repository layout. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "openapi.yaml");
const outputDir = path.join(root, "dist");
const spec = fs.readFileSync(source, "utf8");
if (!/^openapi:\s*["']?3\./m.test(spec) || !/^paths:\s*$/m.test(spec) || !/^components:\s*$/m.test(spec)) {
  throw new Error("openapi.yaml must declare an OpenAPI 3.x document with paths and components");
}
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "openapi.yaml"), spec);
console.log("Generated dist/openapi.yaml from openapi.yaml");
