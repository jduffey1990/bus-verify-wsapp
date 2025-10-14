#!/usr/bin/env node

/**
 * Zero-dependency Lambda deploy script.
 * Requires: AWS CLI configured with creds + default region (or set AWS_REGION).
 *
 * Usage:
 *   FUNCTION_NAME=my-func ALIAS=prod node deploy.js
 *   # or rely on env vars already configured in your shell
 *
 * Env vars:
 *   FUNCTION_NAME   (required) Lambda function name or ARN
 *   AWS_REGION      (optional) falls back to your AWS CLI default
 *   ALIAS           (optional) e.g., "prod" — if set, will point alias to new version
 *   EXCLUDES        (optional) space-separated patterns to exclude from zip
 *                    default: ".git node_modules tests .github .DS_Store *.md dist.zip deploy.js devServer.js"
 *   ZIP_NAME        (optional) default "dist.zip"
 *   INSTALL_CMD     (optional) default "npm ci --omit=dev"
 *
 * Behavior:
 *   - Installs prod deps
 *   - Creates a zip
 *   - aws lambda update-function-code --publish
 *   - If ALIAS provided, moves alias to new version
 */

const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runAndGet(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
}

(async () => {
  try {
    const FUNCTION_NAME = process.env.FUNCTION_NAME;
    if (!FUNCTION_NAME) {
      console.error('ERROR: FUNCTION_NAME env var is required.');
      process.exit(1);
    }

    const AWS_REGION = process.env.AWS_REGION || '';
    const REGION_FLAG = AWS_REGION ? ` --region ${AWS_REGION}` : '';

    const ALIAS = process.env.ALIAS || ''; // e.g., "prod"
    const ZIP_NAME = process.env.ZIP_NAME || 'dist.zip';
    const INSTALL_CMD = process.env.INSTALL_CMD || 'npm ci --omit=dev';

    // Default exclusions keep the bundle lean; add more via EXCLUDES env var.
    const DEFAULT_EXCLUDES = [
      '.git',
      ".env",
      'node_modules',         // we'll rebuild prod deps
      'tests',
      '.github',
      '.DS_Store',
      '*.md',
      ZIP_NAME,
      'deploy.js',
      'devServer.js',
    ];
    const EXTRA_EXCLUDES = (process.env.EXCLUDES || '').split(' ').filter(Boolean);
    const EXCLUDES = [...DEFAULT_EXCLUDES, ...EXTRA_EXCLUDES];

    // Safety checks
    const hasPackage = fs.existsSync('package.json');
    if (!hasPackage) {
      console.error('ERROR: No package.json found in current directory.');
      process.exit(1);
    }

    // 1) Clean previous zip
    if (fs.existsSync(ZIP_NAME)) {
      fs.rmSync(ZIP_NAME);
    }

    // 2) Install production dependencies fresh
    run(INSTALL_CMD);

    // 3) Create zip (exclude junk/dev files)
    const excludeArgs = EXCLUDES.map(p => `-x "${p}${p.endsWith('/') ? '' : (p.includes('*') ? '' : '/*')}"`).join(' ');
    // The pattern above tries to exclude dirs recursively; for files/globs it leaves as-is.
    // To be more explicit, we also add -x entries without /* for each.
    const excludeArgsDup = EXCLUDES.map(p => `-x "${p}"`).join(' ');

    // Ensure we include node_modules produced by INSTALL_CMD
    const zipCmd = `bash -lc 'zip -r ${ZIP_NAME} . ${excludeArgs} ${excludeArgsDup}'`;
    run(zipCmd);

    // 4) Update Lambda code (publish a new version)
    const updateCmd = `aws lambda update-function-code --function-name "${FUNCTION_NAME}" --zip-file fileb://${ZIP_NAME} --publish${REGION_FLAG}`;
    console.log('\nUpdating Lambda function code…');
    run(updateCmd);

    // 5) Get the latest published version number
    const getVersionCmd = `aws lambda list-versions-by-function --function-name "${FUNCTION_NAME}" --query "Versions[-1].Version" --output text${REGION_FLAG}`;
    const version = runAndGet(getVersionCmd);
    console.log(`\nPublished version: ${version}`);

    // 6) If ALIAS provided, move alias to new version
    if (ALIAS) {
      console.log(`\nPointing alias "${ALIAS}" to version ${version}…`);
      // Try update-alias; if it doesn't exist, create-alias.
      try {
        run(`aws lambda update-alias --function-name "${FUNCTION_NAME}" --name "${ALIAS}" --function-version "${version}"${REGION_FLAG}`);
      } catch (e) {
        console.log(`Alias "${ALIAS}" not found. Creating it…`);
        run(`aws lambda create-alias --function-name "${FUNCTION_NAME}" --name "${ALIAS}" --function-version "${version}"${REGION_FLAG}`);
      }
      console.log(`Alias "${ALIAS}" now points to version ${version}.`);
    }

    console.log('\n✅ Deploy complete.');
    console.log(`Function: ${FUNCTION_NAME}`);
    console.log(`Version:  ${version}`);
    if (ALIAS) console.log(`Alias:    ${ALIAS} -> ${version}`);
  } catch (err) {
    console.error('\n❌ Deploy failed.');
    if (err?.stdout) console.error(err.stdout.toString());
    if (err?.stderr) console.error(err.stderr.toString());
    process.exit(1);
  }
})();
