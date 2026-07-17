import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPORT_PATH =
  process.env.PRIVATE_REPORT_PATH || path.join(os.tmpdir(), "private-report.json");
const TOKEN = process.env.PRIVATE_REPORTS_TOKEN;
const REPOSITORY = process.env.PRIVATE_REPORTS_REPO;
const BRANCH = process.env.PRIVATE_REPORTS_BRANCH || "main";

function assertConfiguration() {
  if (!TOKEN || !REPOSITORY || !/^[^/]+\/[^/]+$/.test(REPOSITORY)) {
    throw new Error("private_report_configuration");
  }
}

function encodeRepositoryPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function githubRequest(endpoint, options = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = new Error(`github_api_${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

async function getFile(repositoryPath) {
  try {
    return await githubRequest(
      `/repos/${REPOSITORY}/contents/${encodeRepositoryPath(repositoryPath)}?ref=${encodeURIComponent(BRANCH)}`,
    );
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function putFile(repositoryPath, content, message, sha) {
  const body = {
    message,
    branch: BRANCH,
    content: Buffer.from(content, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;

  return githubRequest(
    `/repos/${REPOSITORY}/contents/${encodeRepositoryPath(repositoryPath)}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function main() {
  assertConfiguration();
  const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
  const recordedAt = report.recordedAt || new Date().toISOString();
  const date = recordedAt.slice(0, 10);
  const safeTimestamp = recordedAt.replace(/[:.]/g, "-");
  const runId = report.workflowRunId || process.env.GITHUB_RUN_ID || "local";

  const baseDirectory = ".github/results/public-monitor";
  const historyPath = `${baseDirectory}/history/${date}/${safeTimestamp}-run-${runId}.json`;
  const latestPath = `${baseDirectory}/latest.json`;
  const csvPath = `${baseDirectory}/ip-history.csv`;
  const jsonContent = JSON.stringify(report, null, 2) + "\n";

  await putFile(
    historyPath,
    jsonContent,
    `Record public monitor run ${runId}`,
  );

  const latest = await getFile(latestPath);
  await putFile(
    latestPath,
    jsonContent,
    `Update latest public monitor result ${runId}`,
    latest?.sha,
  );

  const existingCsv = await getFile(csvPath);
  const header = [
    "recorded_at",
    "workflow_run_id",
    "status",
    "profile_id",
    "browser",
    "device_category",
    "visitor_ip",
    "source_url",
    "target_url",
    "entry_referrer",
    "final_url",
    "pages_visited",
    "duration_ms",
    "test_id",
  ].join(",") + "\n";

  let csvContent = existingCsv?.content
    ? Buffer.from(existingCsv.content.replace(/\n/g, ""), "base64").toString("utf8")
    : header;
  if (csvContent && !csvContent.endsWith("\n")) csvContent += "\n";

  const row = [
    recordedAt,
    runId,
    report.ok ? "success" : "failed",
    report.profileId,
    report.browser,
    report.deviceCategory,
    report.visitorIp,
    report.sourceUrl,
    report.targetUrl,
    report.entryReferrer,
    report.finalUrl,
    report.pagesVisited,
    report.durationMs,
    report.testId,
  ].map(csvEscape).join(",") + "\n";

  csvContent += row;
  await putFile(
    csvPath,
    csvContent,
    `Append public monitor IP history ${runId}`,
    existingCsv?.sha,
  );

  console.log("Private report stored.");
}

main().catch(() => {
  console.error("Private report delivery failed.");
  process.exitCode = 1;
});
