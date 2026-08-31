#!/usr/bin/env node
/**
 * One-command setup.
 *
 * Deploys the Worker, provisions its KV namespaces and R2 bucket, generates an
 * API key, stores it as a secret, and prints ready-to-paste client config.
 *
 * Written in Node rather than bash so it runs the same on Windows, macOS and
 * Linux — the whole point of this project is not caring what you run it on.
 *
 *   npm run setup
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const isWindows = process.platform === "win32";

const style = {
  bold: (s) => `[1m${s}[0m`,
  dim: (s) => `[2m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
};

function info(message) {
  console.log(`${style.dim("→")} ${message}`);
}
function ok(message) {
  console.log(`${style.green("✓")} ${message}`);
}
function warn(message) {
  console.log(`${style.yellow("!")} ${message}`);
}
function fail(message) {
  console.error(`${style.red("✗")} ${message}`);
  process.exit(1);
}

/** Run a command, streaming its output. Returns the exit status. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    shell: isWindows,
    encoding: "utf8",
    ...options,
  });
  return result;
}

/** Run a command and capture stdout, without echoing it. */
function capture(command, args) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    encoding: "utf8",
  });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

function wrangler(args, options) {
  return run("npx", ["--yes", "wrangler@4", ...args], options);
}

/** Put a secret without ever writing it to disk or a shell history line. */
function putSecret(name, value) {
  const result = wrangler(["secret", "put", name], { input: value });
  if (result.status !== 0) {
    fail(`Failed to set the ${name} secret.`);
  }
}

async function main() {
  console.log(style.bold("\nweb-fetch setup\n"));

  // --- Preflight -----------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) {
    fail(`Node 18+ is required (found ${process.versions.node}).`);
  }

  info("Checking your Cloudflare login…");
  const whoami = capture("npx", ["--yes", "wrangler@4", "whoami"]);
  if (!whoami || /not authenticated|you are not logged in/i.test(whoami)) {
    fail("Not logged in to Cloudflare. Run `npx wrangler login` and try again.");
  }
  ok("Cloudflare CLI is authenticated.");

  // --- Deploy --------------------------------------------------------------
  // Resource IDs are absent from wrangler.jsonc on purpose: this deploy is what
  // creates the KV namespaces and the R2 bucket and binds them.
  info("Deploying the Worker (this also provisions KV and R2). Takes about 30s…");
  // Captured rather than inherited so the deployed URL can be read back out of
  // the output; it is echoed below either way.
  const deploy = spawnSync("npx", ["--yes", "wrangler@4", "deploy"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    encoding: "utf8",
  });
  const deployOutput = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
  console.log(style.dim(deployOutput.trim()));
  if (deploy.status !== 0) {
    fail("Deploy failed. Fix the error above and re-run `npm run setup`.");
  }
  ok("Worker deployed.");

  // --- API key -------------------------------------------------------------
  const apiKey = randomBytes(32).toString("hex");
  info("Generating an API key and storing it as a secret…");
  putSecret("API_KEYS", apiKey);
  ok("API key stored.");

  // --- Optional secrets ----------------------------------------------------
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(
    style.dim(
      "\nThe Worker already works: plain-HTTP fetching needs nothing else.\n" +
        "The following unlock the rest, and can be added later.\n",
    ),
  );

  const wantsRest = await rl.question(
    "Add a Cloudflare API token for browser rendering (crawl, AI extract, screenshots)? [y/N] ",
  );
  if (/^y/i.test(wantsRest.trim())) {
    console.log(
      style.dim(
        "  Create one at https://dash.cloudflare.com/profile/api-tokens\n" +
          "  using the 'Edit Cloudflare Workers' template.\n",
      ),
    );
    const accountId = (await rl.question("  Cloudflare account ID: ")).trim();
    const apiToken = (await rl.question("  Cloudflare API token: ")).trim();
    if (accountId && apiToken) {
      putSecret("CF_ACCOUNT_ID", accountId);
      putSecret("CF_API_TOKEN", apiToken);
      ok("Browser Rendering credentials stored.");
    } else {
      warn("Skipped — both values are required.");
    }
  }

  const wantsAi = await rl.question(
    "\nRoute content compression through AI Gateway (recommended)? [y/N] ",
  );
  if (/^y/i.test(wantsAi.trim())) {
    console.log(
      style.dim(
        "  Create a gateway at https://dash.cloudflare.com → AI → AI Gateway.\n" +
          "  The model is `{provider}/{model}`, e.g. openai/gpt-5-mini\n" +
          "  or google-ai-studio/gemini-2.5-flash.\n",
      ),
    );
    const gatewayId = (await rl.question("  AI Gateway ID: ")).trim();
    const model = (await rl.question("  Model (provider/model): ")).trim();
    const providerKey = (await rl.question("  Provider API key: ")).trim();

    if (gatewayId && model && providerKey) {
      putSecret("AI_PROVIDER_KEY", providerKey);
      ok("Provider key stored.");
      warn(
        "Now set these two vars in wrangler.jsonc and redeploy:\n" +
          `      "AI_GATEWAY_ID": "${gatewayId}",\n` +
          `      "AI_MODEL": "${model}"`,
      );
    } else {
      warn("Skipped — all three values are required.");
    }
  }

  rl.close();

  // --- Report --------------------------------------------------------------
  const deployedUrl = findWorkerUrl(deployOutput) ?? "https://<your-worker>.workers.dev";

  console.log(style.bold("\n\nDone.\n"));
  console.log("Add this to your MCP client config:\n");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "web-fetch": {
            type: "http",
            url: `${deployedUrl}/mcp`,
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        },
      },
      null,
      2,
    ),
  );
  console.log(`\nCheck what this deployment can do:\n  curl ${deployedUrl}/health\n`);
  console.log(
    style.yellow("Save the API key now — it is stored as a secret and cannot be read back:"),
  );
  console.log(`  ${apiKey}\n`);
}

/** Pull the deployed URL out of wrangler's output, if it echoed one. */
function findWorkerUrl(output) {
  if (!output) return null;
  const match = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(output);
  return match ? match[0] : null;
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
