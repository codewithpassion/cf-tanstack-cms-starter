#!/usr/bin/env bun
/**
 * Edits apps/web config for the setup-cloudflare skill without printing a
 * secret. Commands:
 *
 *   status              print what is still unset: resource ids that are
 *                       "local", empty vars, and which .env.local keys have a
 *                       value (names only, never values)
 *   account <id>        set CLOUDFLARE_ACCOUNT_ID in .env.local (wrangler reads
 *                       it from there)
 *   database <uuid>     set the D1 binding's database_id in wrangler.jsonc
 *   kv <BINDING> <id>   set a KV binding's id in wrangler.jsonc
 *   var <NAME> <value>  set a var in wrangler.jsonc (SITE_ORIGIN,
 *                       SITE_TIME_ZONE, SITE_NAME, GSC_PROPERTY)
 *   set ADMIN_EMAILS <comma-separated emails>
 *                       write ADMIN_EMAILS to .env.local. Only this key:
 *                       other secrets are typed into .env.local by the user so
 *                       they never pass through the transcript
 *   signing-key         write a fresh PREVIEW_SIGNING_KEY (32 random bytes,
 *                       base64url) to .env.local, only when it is empty
 *   secrets-file        write the keys the deployed Worker needs to a temp file
 *                       for `wrangler deploy --secrets-file`, and print its path
 */
import { tmpdir } from "node:os";
import { $, file, write } from "bun";

// An allowlist, so CLOUDFLARE_ACCOUNT_ID and DEV_LOGIN_* never reach a deployed
// Worker. DEV_LOGIN_* in particular turns on a route that signs anyone in.
const DEPLOYED_KEYS: readonly string[] = [
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "ADMIN_EMAILS",
  "PREVIEW_SIGNING_KEY",
  "ANTHROPIC_API_KEY",
  "GSC_CLIENT_ID",
  "GSC_CLIENT_SECRET",
  "GSC_REFRESH_TOKEN",
];

const KV_BINDINGS: readonly string[] = ["CMS_PAGES", "OAUTH_KV"];
const VARS: readonly string[] = [
  "SITE_ORIGIN",
  "SITE_TIME_ZONE",
  "SITE_NAME",
  "GSC_PROPERTY",
];

const SIGNING_KEY_BYTES = 32;
const DATABASE_ID = /("database_id":\s*)"[^"]*"/;
const ORIGIN = /^https?:\/\/[^\s/]+$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;
const BASE64URL_PADDING = /[=]+$/;

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const envPath = `${root}/apps/web/.env.local`;
const configPath = `${root}/apps/web/wrangler.jsonc`;

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

const usage = (): never =>
  fail(
    "usage: bun .claude/skills/setup-cloudflare/env.ts status | account <id> | database <uuid> | kv <BINDING> <id> | var <NAME> <value> | set ADMIN_EMAILS <emails> | signing-key | secrets-file"
  );

/** The .env.local text, or an exit if the file is not there yet. */
const readEnv = async (): Promise<string> => {
  const envFile = file(envPath);
  if (await envFile.exists()) {
    return await envFile.text();
  }
  return fail(`${envPath} does not exist. Copy apps/web/.env.example first.`);
};

const envValue = (text: string, key: string): string =>
  text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim() ?? "";

/** Sets KEY=value in .env.local text: replaces the line, or appends one. */
const withEnvValue = (text: string, key: string, value: string): string => {
  const line = `${key}=${value}`;
  const existing = new RegExp(`^${key}=.*$`, "m");
  return existing.test(text)
    ? text.replace(existing, () => line)
    : `${text.trimEnd()}\n${line}\n`;
};

const readConfig = (): Promise<string> => file(configPath).text();

const validZone = (zone: string): boolean =>
  zone === "UTC" || Intl.supportedValuesOf("timeZone").includes(zone);

const [, , command, argument, argument2] = process.argv;

if (command === "status") {
  const config = await readConfig();
  const unset: string[] = [];
  if (config.match(DATABASE_ID)?.[0].includes('"local"')) {
    unset.push("D1 database_id is still local");
  }
  for (const binding of KV_BINDINGS) {
    const idOf = new RegExp(
      `"binding":\\s*"${binding}",\\s*"id":\\s*"([^"]*)"`
    );
    if (config.match(idOf)?.[1] === "local") {
      unset.push(`KV ${binding} id is still local`);
    }
  }
  for (const name of ["SITE_ORIGIN", "SITE_TIME_ZONE"]) {
    const varField = new RegExp(`"${name}":\\s*"([^"]*)"`);
    if (!config.match(varField)?.[1]) {
      unset.push(`var ${name} is empty`);
    }
  }
  console.log(unset.length > 0 ? unset.join("\n") : "wrangler.jsonc: all set");
  const envFile = file(envPath);
  if (await envFile.exists()) {
    const text = await envFile.text();
    for (const key of DEPLOYED_KEYS) {
      console.log(`${key}: ${envValue(text, key) ? "set" : "empty"}`);
    }
  } else {
    console.log(".env.local: missing");
  }
} else if (command === "account" && argument) {
  await write(
    envPath,
    withEnvValue(await readEnv(), "CLOUDFLARE_ACCOUNT_ID", argument)
  );
  console.log(`CLOUDFLARE_ACCOUNT_ID=${argument}`);
} else if (command === "database" && argument) {
  const text = await readConfig();
  if (!DATABASE_ID.test(text)) {
    fail(`No "database_id" found in ${configPath}.`);
  }
  await write(configPath, text.replace(DATABASE_ID, `$1"${argument}"`));
  console.log(`database_id=${argument}`);
} else if (command === "kv" && argument && argument2) {
  if (!KV_BINDINGS.includes(argument)) {
    fail(`Unknown KV binding "${argument}". Known: ${KV_BINDINGS.join(", ")}.`);
  }
  const text = await readConfig();
  const idField = new RegExp(
    `("binding":\\s*"${argument}",\\s*"id":\\s*)"[^"]*"`
  );
  if (!idField.test(text)) {
    fail(`No KV binding "${argument}" found in ${configPath}.`);
  }
  await write(configPath, text.replace(idField, `$1"${argument2}"`));
  console.log(`${argument} id=${argument2}`);
} else if (command === "var" && argument && argument2 !== undefined) {
  if (!VARS.includes(argument)) {
    fail(`Unknown var "${argument}". Known: ${VARS.join(", ")}.`);
  }
  if (argument === "SITE_ORIGIN" && !ORIGIN.test(argument2)) {
    fail(
      `SITE_ORIGIN must be an http(s) origin without a path or trailing slash, got "${argument2}".`
    );
  }
  if (argument === "SITE_TIME_ZONE" && !validZone(argument2)) {
    fail(
      `"${argument2}" is not an IANA time zone (for example Europe/Berlin).`
    );
  }
  const text = await readConfig();
  const field = new RegExp(`("${argument}":\\s*)"[^"]*"`);
  if (!field.test(text)) {
    fail(`No var "${argument}" found in ${configPath}.`);
  }
  await write(
    configPath,
    text.replace(field, () => `"${argument}": "${argument2}"`)
  );
  console.log(`${argument}=${argument2}`);
} else if (command === "set" && argument === "ADMIN_EMAILS" && argument2) {
  const emails = argument2.split(",").map((email) => email.trim());
  if (!emails.every((email) => EMAIL.test(email))) {
    fail("ADMIN_EMAILS must be comma-separated email addresses.");
  }
  await write(
    envPath,
    withEnvValue(await readEnv(), "ADMIN_EMAILS", emails.join(","))
  );
  console.log(`ADMIN_EMAILS=${emails.join(",")}`);
} else if (command === "signing-key") {
  const text = await readEnv();
  if (envValue(text, "PREVIEW_SIGNING_KEY")) {
    // A new key invalidates every preview link, so a re-run keeps the old one.
    console.log("PREVIEW_SIGNING_KEY already set: kept.");
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(SIGNING_KEY_BYTES));
    const key = Buffer.from(bytes)
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(BASE64URL_PADDING, "");
    await write(envPath, withEnvValue(text, "PREVIEW_SIGNING_KEY", key));
    console.log("PREVIEW_SIGNING_KEY written to .env.local.");
  }
} else if (command === "secrets-file") {
  const text = await readEnv();
  const present = DEPLOYED_KEYS.filter((key) => envValue(text, key) !== "");
  if (present.length === 0) {
    console.log("Nothing to upload: deploy without --secrets-file.");
    process.exit(0);
  }
  const path = `${tmpdir()}/worker-secrets-${crypto.randomUUID()}.env`;
  await write(
    path,
    `${present.map((key) => `${key}=${envValue(text, key)}`).join("\n")}\n`
  );
  console.log(`${path}\n${present.join("\n")}`);
} else {
  usage();
}
