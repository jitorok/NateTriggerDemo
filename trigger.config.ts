import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  // Get your project ID from: cloud.trigger.dev → your project → Settings
  project: "proj_dylmeuhghervzywkdehu",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
});
