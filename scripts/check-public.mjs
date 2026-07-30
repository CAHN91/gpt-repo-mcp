import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import process from "node:process";

const forbiddenPublicFiles = [
  "MASTER_PROMPT.md",
  "docs/CHATGPT_DEV_MODE.md"
];

const forbiddenTrackedArtifacts = {
  exact: new Set([
    ".DS_Store",
    "config.local.json"
  ]),
  prefixes: [
    ".chatgpt/",
    ".agent-recorder/",
    ".agentbus/"
  ],
  patterns: [
    {
      regex: /(?:^|\/)[^/]+\.local\.json(?:\.[^/]+)?$/,
      label: "local config or local config backup"
    }
  ]
};

const scanRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "package.json",
  "config.example.json",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".gitignore",
  ".npmignore",
  "docs/",
  "security/",
  "src/",
  "scripts/",
  "tools/",
  "AGENTS.md"
];

const excludedScanPaths = [
  "node_modules/",
  "dist/",
  "coverage/",
  "package-lock.json"
];

const blockedMarkers = [
  "RECORDER_SUMMARY",
  "Agent Recorder",
  "Recorder is installed",
  "/Users/",
  "Do not add write tools",
  "No write tools",
  "read-only TypeScript MCP server",
  "MASTER_PROMPT",
  "CHATGPT_DEV_MODE",
  "Promptiva"
];

const allowlistedMarkerHits = new Set([
  "LICENSE::Promptiva"
]);

function gitLsFiles() {
  const output = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return output.split("\n").filter(Boolean);
}

function isUnderScanRoot(file) {
  return scanRoots.some((root) => root.endsWith("/") ? file.startsWith(root) : file === root);
}

function isExcluded(file) {
  return excludedScanPaths.some((path) => path.endsWith("/") ? file.startsWith(path) : file === path);
}

function isForbiddenTrackedArtifact(file) {
  if (forbiddenTrackedArtifacts.exact.has(file) || file.endsWith("/.DS_Store")) {
    return true;
  }
  if (forbiddenTrackedArtifacts.prefixes.some((prefix) => file.startsWith(prefix))) {
    return true;
  }
  return forbiddenTrackedArtifacts.patterns.some(({ regex }) => regex.test(file));
}

function forbiddenArtifactLabel(file) {
  const pattern = forbiddenTrackedArtifacts.patterns.find(({ regex }) => regex.test(file));
  return pattern?.label ?? file;
}

function isTextFile(file) {
  if (!existsSync(file)) {
    return false;
  }
  const stats = statSync(file);
  return stats.isFile();
}

const trackedFiles = gitLsFiles();
const failures = [];

for (const file of forbiddenPublicFiles) {
  if (existsSync(file)) {
    failures.push(`${file} must not be present in the public OSS branch.`);
  }
}

for (const file of trackedFiles) {
  if (isForbiddenTrackedArtifact(file)) {
    failures.push(`${file}: tracked local-only/private artifact is forbidden (${forbiddenArtifactLabel(file)}).`);
  }
}

for (const file of trackedFiles) {
  if (file === "scripts/check-public.mjs" || !isUnderScanRoot(file) || isExcluded(file) || !isTextFile(file)) {
    continue;
  }

  const text = readFileSync(file, "utf8");
  for (const marker of blockedMarkers) {
    if (text.includes(marker) && !allowlistedMarkerHits.has(`${file}::${marker}`)) {
      failures.push(`${file}: blocked public-release marker found: ${marker}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("Public hygiene check failed:\n");
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write("Public hygiene check passed.\n");
