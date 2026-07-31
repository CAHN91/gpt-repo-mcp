import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(sourceRoot, "security", "oss-security-policy.json");
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_HISTORY_BLOB_BYTES = 5 * 1024 * 1024;

export async function runSecurityScan({
  candidateRoot,
  exportReportPath,
  publicRepo,
  gitleaksBin,
  policy
}) {
  policy ??= JSON.parse(await readFile(policyPath, "utf8"));
  validatePolicy(policy);
  const candidate = await requireDirectory(candidateRoot, "candidate");
  const publicRoot = await requireGitRoot(publicRepo);
  const scanner = await requireFile(gitleaksBin, "Gitleaks binary");
  const scannerAsset = `${process.platform}_${process.arch}`;
  const scannerPolicy = policy.gitleaks.assets[scannerAsset];
  if (!scannerPolicy) {
    throw new Error(`Gitleaks is not pinned for platform ${scannerAsset}.`);
  }
  const scannerDigest = createHash("sha256")
    .update(await readFile(scanner))
    .digest("hex");
  if (scannerDigest !== scannerPolicy.binary_sha256) {
    throw new Error(`Gitleaks binary checksum mismatch for ${scannerAsset}.`);
  }
  const version = (await run(scanner, ["version"])).stdout.trim();
  if (version !== policy.gitleaks.version) {
    throw new Error(`Gitleaks ${policy.gitleaks.version} is required; received ${version || "unknown"}.`);
  }

  const reportPath = await requireFile(exportReportPath, "export report");
  const exportReport = JSON.parse(
    await readFile(reportPath, "utf8")
  );
  const exportedFiles = await verifyExportedFiles(candidate, exportReport);
  const temporary = await mkdtemp(join(tmpdir(), "gpt-repo-security-scan."));
  try {
    const candidateScanRoot = join(temporary, "candidate-tree");
    await materializeCandidateScanTree(
      candidate,
      candidateScanRoot,
      exportedFiles
    );
    const candidateLeaks = await scanGitleaks({
      scanner,
      mode: "dir",
      target: candidateScanRoot,
      config: join(candidate, ".gitleaks.toml"),
      ignore: join(candidate, ".gitleaksignore"),
      reportPath: join(temporary, "candidate.json")
    });
    const historyLeaks = await scanGitleaks({
      scanner,
      mode: "git",
      target: publicRoot,
      config: join(candidate, ".gitleaks.toml"),
      ignore: join(candidate, ".gitleaksignore"),
      reportPath: join(temporary, "history.json")
    });

    const candidateEmails = classifyEmailOccurrences(
      await candidateEmailOccurrences(candidate, exportedFiles),
      policy.email
    );
    const historyEmails = classifyEmailOccurrences(
      await historyEmailOccurrences(publicRoot),
      policy.email
    );
    const licenses = classifyLicenseRecords(
      await installedLicenseRecords(candidate),
      policy.licenses.allowed
    );
    const audit = await auditCandidate(candidate, policy);
    const publicCheckedOutCommit = await git(publicRoot, ["rev-parse", "HEAD"]);
    const publicRefs = (await git(publicRoot, [
      "for-each-ref",
      "--format=%(refname)"
    ])).split("\n").filter(Boolean);
    const publicCommitCount = Number(await git(publicRoot, ["rev-list", "--all", "--count"]));

    const blockers = [
      ...(candidateLeaks.finding_count > 0 ? ["candidate_gitleaks_findings"] : []),
      ...(historyLeaks.finding_count > 0 ? ["public_history_gitleaks_findings"] : []),
      ...(candidateEmails.unclassified.length > 0 ? ["candidate_email_findings"] : []),
      ...(historyEmails.unclassified.length > 0 ? ["public_history_email_findings"] : []),
      ...(licenses.unapproved.length > 0 ? ["unapproved_dependency_licenses"] : []),
      ...(audit.production.total > 0 ? ["production_dependency_advisories"] : []),
      ...(audit.unknown_development.length > 0 ? ["unknown_development_advisories"] : []),
      ...(audit.expired_development.length > 0 ? ["expired_development_advisory_review"] : [])
    ];

    return {
      schema_version: 1,
      policy_version: policy.policy_version,
      scanner: { name: "gitleaks", version, platform: scannerAsset },
      candidate: {
        source_commit: exportReport.source_commit,
        tree_sha256: exportReport.tree_sha256,
        gitleaks: candidateLeaks,
        email: candidateEmails
      },
      public_history: {
        checked_out_commit: publicCheckedOutCommit,
        ref_count: publicRefs.length,
        commit_count: publicCommitCount,
        gitleaks: historyLeaks,
        email: historyEmails
      },
      dependencies: {
        licenses,
        audit
      },
      blockers,
      ok: blockers.length === 0
    };
  } finally {
    await rm(temporary, { recursive: true });
  }
}

export function classifyEmailOccurrences(occurrences, policy) {
  const allowedDomains = new Set(policy.allowed_domains.map((value) => value.toLowerCase()));
  const allowedAddresses = new Set(policy.allowed_addresses.map((value) => value.toLowerCase()));
  const reviewedHistoryLocations = new Set(
    (policy.reviewed_public_history_locations ?? []).flatMap((entry) =>
      entry.roles.map((role) => `${entry.commit}:${role}`)
    )
  );
  const unclassified = [];
  let allowedCount = 0;
  let reviewedHistoryCount = 0;

  for (const occurrence of occurrences) {
    const address = occurrence.address.toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (allowedAddresses.has(address) || allowedDomains.has(domain)) {
      allowedCount += 1;
    } else if (
      occurrence.location.source === "commit_metadata" &&
      reviewedHistoryLocations.has(
        `${occurrence.location.commit}:${occurrence.location.role}`
      )
    ) {
      allowedCount += 1;
      reviewedHistoryCount += 1;
    } else {
      unclassified.push(occurrence.location);
    }
  }
  return {
    occurrence_count: occurrences.length,
    allowed_count: allowedCount,
    reviewed_history_count: reviewedHistoryCount,
    unclassified
  };
}

export function classifyLicenseRecords(records, allowedLicenses) {
  const allowed = new Set(allowedLicenses);
  const counts = {};
  const unapproved = [];
  for (const record of records) {
    counts[record.license] = (counts[record.license] ?? 0) + 1;
    if (!allowed.has(record.license)) unapproved.push(record);
  }
  return {
    package_count: records.length,
    license_counts: Object.fromEntries(Object.entries(counts).sort()),
    unapproved: unapproved.sort((left, right) => left.name.localeCompare(right.name))
  };
}

export function classifyAudit(fullAudit, productionAudit, policy, today = new Date()) {
  const full = auditEntries(fullAudit);
  const production = auditEntries(productionAudit);
  const known = new Map(policy.known_development_advisories.map((entry) => [entry.package, entry]));
  const productionNames = new Set(production.entries.map(({ package: name }) => name));
  const development = full.entries.filter(({ package: name }) => !productionNames.has(name));
  const unknownDevelopment = development.filter((entry) => {
    const expected = known.get(entry.package);
    return !expected || expected.severity !== entry.severity;
  });
  const expiredDevelopment = development.filter((entry) => {
    const expected = known.get(entry.package);
    return expected && new Date(`${expected.review_by}T23:59:59Z`) < today;
  });

  return {
    production,
    development: {
      total: development.length,
      entries: development
    },
    unknown_development: unknownDevelopment,
    expired_development: expiredDevelopment
  };
}

async function scanGitleaks({ scanner, mode, target, config, ignore, reportPath }) {
  const result = await runAllowFailure(scanner, [
    mode,
    target,
    "--config",
    config,
    "--gitleaks-ignore-path",
    ignore,
    "--no-banner",
    "--no-color",
    "--redact=100",
    "--report-format",
    "json",
    "--report-path",
    reportPath,
    "--timeout",
    "120"
  ]);
  if (![0, 1].includes(result.exitCode)) {
    throw new Error(`Gitleaks ${mode} scan failed with exit code ${result.exitCode}.`);
  }
  let findings = [];
  try {
    findings = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    if (result.exitCode !== 0 || error?.code !== "ENOENT") throw error;
  }
  const ruleCounts = {};
  for (const finding of findings) {
    const rule = typeof finding.RuleID === "string" ? finding.RuleID : "unknown";
    ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
  }
  return {
    finding_count: findings.length,
    rule_counts: Object.fromEntries(Object.entries(ruleCounts).sort())
  };
}

async function candidateEmailOccurrences(candidate, files) {
  const occurrences = [];
  for (const entry of files) {
    if (!entry || typeof entry.path !== "string" || entry.bytes > MAX_HISTORY_BLOB_BYTES) continue;
    const bytes = await readFile(join(candidate, entry.path));
    if (bytes.includes(0)) continue;
    collectEmails(bytes.toString("utf8"), (line) => ({
      source: "candidate",
      path: entry.path,
      line
    }), occurrences);
  }
  return occurrences;
}

async function verifyExportedFiles(candidate, report) {
  if (!Array.isArray(report.files) || typeof report.tree_sha256 !== "string") {
    throw new Error("Malformed candidate export report.");
  }
  const verified = [];
  const seenPaths = new Set();
  for (const entry of report.files) {
    if (!entry || typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.bytes) ||
        typeof entry.sha256 !== "string") {
      throw new Error("Malformed candidate export report file entry.");
    }
    const absolutePath = resolve(candidate, entry.path);
    if (!entry.path ||
        isAbsolute(entry.path) ||
        absolutePath === candidate ||
        !absolutePath.startsWith(`${candidate}${sep}`) ||
        seenPaths.has(entry.path)) {
      throw new Error(`Unsafe candidate report path: ${entry.path || "<empty>"}`);
    }
    seenPaths.add(entry.path);
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Candidate report path is not a regular file: ${entry.path}`);
    }
    const bytes = await readFile(absolutePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
      throw new Error(`Candidate checksum mismatch: ${entry.path}`);
    }
    verified.push(entry);
  }
  const tree = createHash("sha256");
  for (const entry of [...verified].sort((left, right) => left.path.localeCompare(right.path))) {
    tree.update(entry.path);
    tree.update("\0");
    tree.update(entry.sha256);
    tree.update("\0");
    tree.update(String(entry.bytes));
    tree.update("\n");
  }
  if (tree.digest("hex") !== report.tree_sha256) {
    throw new Error("Candidate tree checksum does not match its export report.");
  }
  return verified;
}

async function materializeCandidateScanTree(candidate, destination, files) {
  await mkdir(destination, { recursive: true });
  for (const entry of files) {
    const destinationPath = resolve(destination, entry.path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(resolve(candidate, entry.path), destinationPath);
  }
}

async function historyEmailOccurrences(repo) {
  const occurrences = [];
  const metadata = await git(repo, ["log", "--all", "--format=%H%x09%ae%x09%ce"]);
  for (const line of metadata.split("\n").filter(Boolean)) {
    const [commit, author, committer] = line.split("\t");
    for (const [role, address] of [["author", author], ["committer", committer]]) {
      if (address) {
        occurrences.push({
          address,
          location: { source: "commit_metadata", commit, role }
        });
      }
    }
  }

  const objects = await git(repo, ["rev-list", "--objects", "--all"]);
  const seen = new Set();
  for (const line of objects.split("\n").filter(Boolean)) {
    const separator = line.indexOf(" ");
    const object = separator < 0 ? line : line.slice(0, separator);
    const path = separator < 0 ? undefined : line.slice(separator + 1);
    if (seen.has(object) || !path) continue;
    seen.add(object);
    if (await git(repo, ["cat-file", "-t", object]) !== "blob") continue;
    const size = Number(await git(repo, ["cat-file", "-s", object]));
    if (!Number.isSafeInteger(size) || size > MAX_HISTORY_BLOB_BYTES) continue;
    const bytes = await gitBuffer(repo, ["cat-file", "blob", object]);
    if (bytes.includes(0)) continue;
    collectEmails(bytes.toString("utf8"), (lineNumber) => ({
      source: "git_blob",
      blob: object,
      path,
      line: lineNumber
    }), occurrences);
  }
  return occurrences;
}

function collectEmails(text, location, output) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const offset = match.index ?? 0;
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    output.push({
      address: match[0],
      location: location(Math.max(1, low))
    });
  }
}

async function installedLicenseRecords(candidate) {
  const nodeModules = join(candidate, "node_modules");
  if (!(await stat(nodeModules)).isDirectory()) {
    throw new Error("Candidate node_modules is missing. Run npm ci --ignore-scripts before the security scan.");
  }
  const records = [];
  const visited = new Set();

  async function scanModules(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(join(directory, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) await scanPackage(join(directory, entry.name, scoped.name));
        }
      } else {
        await scanPackage(join(directory, entry.name));
      }
    }
  }

  async function scanPackage(directory) {
    const resolved = await realpath(directory);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const license = typeof value.license === "string"
      ? value.license
      : Array.isArray(value.licenses)
        ? value.licenses.map((entry) => entry?.type).filter(Boolean).join(" OR ")
        : "MISSING";
    records.push({
      name: typeof value.name === "string" ? value.name : "unknown",
      version: typeof value.version === "string" ? value.version : "unknown",
      license
    });
    try {
      await scanModules(join(directory, "node_modules"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  await scanModules(nodeModules);
  return records.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
  );
}

async function auditCandidate(candidate, policy) {
  const full = await npmAudit(candidate, []);
  const production = await npmAudit(candidate, ["--omit=dev"]);
  return classifyAudit(full, production, policy);
}

async function npmAudit(candidate, extra) {
  const result = await runAllowFailure("npm", [
    "audit",
    "--json",
    "--package-lock-only",
    ...extra
  ], candidate);
  if (![0, 1].includes(result.exitCode)) {
    throw new Error(`npm audit failed with exit code ${result.exitCode}.`);
  }
  return JSON.parse(result.stdout);
}

function auditEntries(audit) {
  const entries = Object.entries(audit.vulnerabilities ?? {}).map(([name, value]) => ({
    package: name,
    severity: value.severity,
    direct: value.isDirect === true,
    fix_available: Boolean(value.fixAvailable)
  })).sort((left, right) => left.package.localeCompare(right.package));
  return { total: entries.length, entries };
}

function validatePolicy(policy) {
  if (!policy || policy.schema_version !== 1 ||
      typeof policy.policy_version !== "string" ||
      typeof policy.gitleaks?.version !== "string" ||
      typeof policy.gitleaks?.assets !== "object" ||
      !Array.isArray(policy.email?.allowed_domains) ||
      !Array.isArray(policy.email?.allowed_addresses) ||
      !Array.isArray(policy.email?.reviewed_public_history_locations) ||
      !Array.isArray(policy.licenses?.allowed) ||
      !Array.isArray(policy.known_development_advisories)) {
    throw new Error("Malformed OSS security policy.");
  }
  const reviewed = policy.email.reviewed_public_history_locations;
  const locations = new Set();
  for (const entry of reviewed) {
    if (!entry ||
        !/^[a-f0-9]{40}$/.test(entry.commit) ||
        !Array.isArray(entry.roles) ||
        entry.roles.length === 0 ||
        entry.roles.some((role) => !["author", "committer"].includes(role)) ||
        typeof entry.context !== "string" ||
        entry.context.length === 0) {
      throw new Error("Malformed reviewed public-history email location.");
    }
    for (const role of entry.roles) {
      const location = `${entry.commit}:${role}`;
      if (locations.has(location)) {
        throw new Error(`Duplicate reviewed public-history email location: ${location}`);
      }
      locations.add(location);
    }
  }
}

async function requireDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} path must not be a symlink.`);
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} path must be a directory.`);
  return resolved;
}

async function requireFile(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} path must not be a symlink.`);
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isFile()) throw new Error(`${label} must be a file.`);
  return resolved;
}

async function requireGitRoot(path) {
  const resolved = await requireDirectory(path, "public repository");
  const root = await git(resolved, ["rev-parse", "--show-toplevel"]);
  if (await realpath(root) !== resolved) throw new Error("Public repository path must be its Git root.");
  return resolved;
}

async function git(cwd, args) {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}

async function gitBuffer(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function run(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

function runAllowFailure(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        rejectPromise(error);
        return;
      }
      resolvePromise({
        exitCode: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr
      });
    });
  });
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (![
      "--candidate",
      "--export-report",
      "--public-repo",
      "--gitleaks-bin"
    ].includes(flag) || !value) {
      throw new Error(
        "Usage: oss-security-scan.mjs --candidate <absolute-path> --export-report <absolute-path> --public-repo <absolute-path> --gitleaks-bin <absolute-path>"
      );
    }
    if (options[flag]) throw new Error(`Duplicate argument: ${flag}`);
    options[flag] = value;
  }
  for (const flag of [
    "--candidate",
    "--export-report",
    "--public-repo",
    "--gitleaks-bin"
  ]) {
    if (!options[flag]) throw new Error(`Missing required argument: ${flag}`);
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const result = await runSecurityScan({
    candidateRoot: options["--candidate"],
    exportReportPath: options["--export-report"],
    publicRepo: options["--public-repo"],
    gitleaksBin: options["--gitleaks-bin"]
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] &&
    await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(
      `OSS security scan failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
