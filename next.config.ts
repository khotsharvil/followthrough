import type { NextConfig } from "next";
const config: NextConfig = {
  // Data files are read at runtime by the API route and pages.
  outputFileTracingIncludes: { "/**": ["./data/**/*", "./evals/results.json", "./public/samples/**/*"] },
};
export default config;
