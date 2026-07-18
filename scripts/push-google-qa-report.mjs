import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPORT_PATH =
  process.env.PRIVATE_REPORT_PATH || path.join(os.tmpdir(), "google-qa-private-report.json");
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

  return githubRequest(`/repos/${REPOSITORY}/contents/${encodeRepositoryPath(repositoryPath)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function appendCsv(csvPath, headerFields, rowFields, message) {
  const existing = await getFile(csvPath);
  const header = `${headerFields.join(",")}\n`;
  let content = existing?.content
    ? Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString("utf8")
    : header;
  if (content && !content.endsWith("\n")) content += "\n";
  content += `${rowFields.map(csvEscape).join(",")}\n`;
  await putFile(csvPath, content, message, existing?.sha);
}

async function main() {
  assertConfiguration();
  const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
  const recordedAt = report.recordedAt || new Date().toISOString();
  const date = recordedAt.slice(0, 10);
  const safeTimestamp = recordedAt.replace(/[:.]/g, "-");
  const runId = report.workflowRunId || process.env.GITHUB_RUN_ID || "local";

  const baseDirectory = ".github/results/google-analytics-qa";
  const historyPath = `${baseDirectory}/history/${date}/${safeTimestamp}-run-${runId}.json`;
  const latestPath = `${baseDirectory}/latest.json`;
  const csvPath = `${baseDirectory}/history.csv`;
  const jsonContent = `${JSON.stringify(report, null, 2)}\n`;

  await putFile(historyPath, jsonContent, `Record Google analytics QA run ${runId}`);

  const latest = await getFile(latestPath);
  await putFile(
    latestPath,
    jsonContent,
    `Update latest Google analytics QA result ${runId}`,
    latest?.sha,
  );

  await appendCsv(
    csvPath,
    [
      "recorded_at",
      "workflow_run_id",
      "status",
      "analytics_blocked",
      "visitor_ip",
      "search_query",
      "google_result_page",
      "google_result_position",
      "google_clicked_url",
      "google_entry_referrer",
      "target_landing_url",
      "secondary_reached",
      "secondary_origin",
      "secondary_clicked_text",
      "secondary_clicked_url",
      "secondary_entry_referrer",
      "secondary_pages_visited",
      "final_url",
      "duration_ms",
      "error_message",
      "test_id",
    ],
    [
      recordedAt,
      runId,
      report.ok ? "success" : "failed",
      report.analyticsBlocked,
      report.visitorIp,
      report.searchQuery,
      report.google?.pageNumber,
      report.google?.position,
      report.google?.clickedUrl,
      report.google?.entryReferrer,
      report.primary?.landingUrl,
      report.secondary?.reached,
      report.secondary?.origin,
      report.secondary?.link?.text,
      report.secondary?.link?.originalUrl,
      report.secondary?.entryReferrer,
      report.secondary?.pagesVisited,
      report.finalUrl,
      report.durationMs,
      report.errorMessage,
      report.testId,
    ],
    `Append Google analytics QA history ${runId}`,
  );

  console.log("Private Google analytics QA report stored.");
}

main().catch(() => {
  console.error("Private Google analytics QA report delivery failed.");
  process.exitCode = 1;
});
