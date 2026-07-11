const commitPattern = /^[0-9a-f]{40}$/;
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ciWorkflow = "go.yml";
const tagsPerPage = 100;
const maxTagPages = 100;
const completedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const ciIdentity = {
  workflow: "Go",
  path: ".github/workflows/go.yml",
};

export async function resolveMemefishRefs({ githubJSON, upstream }) {
  const [mainRuns, publishedReleases, tagNames] = await Promise.all([
    githubJSON(
      `/repos/${upstream}/actions/workflows/${ciWorkflow}/runs?` +
        "branch=main&event=push&status=success&exclude_pull_requests=true&per_page=20",
    ),
    githubJSON(`/repos/${upstream}/releases?per_page=100`),
    listTagNames(githubJSON, upstream),
  ]);

  const mainRun = successfulMainRun(mainRuns, upstream);
  if (mainRun === null) {
    throw new Error("memefish main has no successful Go workflow run");
  }

  const latestPublishedTag = latestPublishedStableTag(publishedReleases);
  const stableTags = uniqueStableTags(tagNames).sort(compareStableTagsDescending);
  if (stableTags.length === 0) {
    throw new Error("memefish has no stable version tags");
  }
  if (!stableTags.includes(latestPublishedTag)) {
    throw new Error(`latest published release ${latestPublishedTag} was not found in Git tags`);
  }
  const resolvedTags = await Promise.all(
    stableTags.map((tag) => resolveReleaseRef(tag, githubJSON, upstream)),
  );
  const release = resolvedTags.find((candidate) => candidate.label === latestPublishedTag);
  if (release === undefined) {
    throw new Error(`latest published release ${latestPublishedTag} could not be resolved`);
  }
  // Keep the default published release first for the manifest/UI contract,
  // then retain every other stable tag in descending semantic-version order.
  // A tag may precede its GitHub Release without freezing main or older-tag
  // refreshes; it remains selectable but is not mislabeled as the default.
  const releases = [
    release,
    ...resolvedTags.filter((candidate) => candidate.label !== latestPublishedTag),
  ];

  return {
    release,
    releases,
    main: {
      label: "main snapshot",
      commit: mainRun.headSHA,
      upstreamCI: checkedCIMetadata(mainRun),
    },
  };
}

export function notCheckedCIMetadata() {
  return {
    ...ciIdentity,
    status: "not_checked",
  };
}

async function listTagNames(githubJSON, upstream) {
  const names = [];
  for (let page = 1; page <= maxTagPages; page += 1) {
    const value = await githubJSON(`/repos/${upstream}/tags?per_page=${tagsPerPage}&page=${page}`);
    if (!Array.isArray(value)) {
      throw new Error("GitHub tags response was not an array");
    }
    for (const entry of value) {
      if (!isRecord(entry)) {
        throw new Error("GitHub tags response contained an invalid entry");
      }
      names.push(nonEmptyString(entry.name, "tag name"));
    }
    if (value.length < tagsPerPage) {
      return names;
    }
  }
  throw new Error(`GitHub tags response exceeded ${maxTagPages} pages`);
}

function latestPublishedStableTag(value) {
  if (!Array.isArray(value)) {
    throw new Error("GitHub releases response was not an array");
  }

  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new Error("GitHub releases response contained an invalid entry");
    }
    if (typeof candidate.draft !== "boolean" || typeof candidate.prerelease !== "boolean") {
      throw new Error("GitHub release response had invalid publication state");
    }
    const tag = nonEmptyString(candidate.tag_name, "release tag");
    if (!candidate.draft && !candidate.prerelease && stableTagPattern.test(tag)) {
      return tag;
    }
  }
  throw new Error("memefish has no published stable release");
}

function uniqueStableTags(tagNames) {
  return [...new Set(tagNames.filter((tag) => stableTagPattern.test(tag)))];
}

function compareStableTagsDescending(left, right) {
  const leftParts = stableTagParts(left);
  const rightParts = stableTagParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return -1;
    }
    if (leftParts[index] < rightParts[index]) {
      return 1;
    }
  }
  return 0;
}

function stableTagParts(tag) {
  const match = stableTagPattern.exec(tag);
  if (match === null) {
    throw new Error(`invalid stable tag: ${tag}`);
  }
  return match.slice(1).map(BigInt);
}

async function resolveReleaseRef(tag, githubJSON, upstream) {
  const commitResponse = await githubJSON(`/repos/${upstream}/commits/${encodeURIComponent(tag)}`);
  if (!isRecord(commitResponse)) {
    throw new Error(`GitHub commit response for ${tag} was invalid`);
  }
  const commit = fullCommit(commitResponse.sha, `${tag} commit`);
  const runs = await githubJSON(
    `/repos/${upstream}/actions/workflows/${ciWorkflow}/runs?` +
      `head_sha=${commit}&event=push&status=completed&exclude_pull_requests=true&per_page=20`,
  );
  const run = exactCompletedPushRun(runs, commit, upstream);

  return {
    label: tag,
    commit,
    upstreamCI:
      run === null
        ? {
            ...ciIdentity,
            status: "not_recorded",
          }
        : checkedCIMetadata(run),
  };
}

function successfulMainRun(value, upstream) {
  const runs = workflowRuns(value);
  if (runs.length === 0) {
    return null;
  }

  const run = decodeRun(runs[0], "main workflow run", upstream);
  if (
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.headBranch !== "main"
  ) {
    throw new Error("GitHub main workflow run was not a successful main push");
  }
  return run;
}

function exactCompletedPushRun(value, expectedCommit, upstream) {
  const runs = workflowRuns(value);
  if (runs.length === 0) {
    return null;
  }

  const run = decodeRun(runs[0], "release workflow run", upstream);
  if (run.event !== "push") {
    throw new Error("GitHub release workflow run was not triggered by push");
  }
  if (run.status !== "completed") {
    throw new Error("GitHub release workflow run was not completed");
  }
  if (run.headSHA !== expectedCommit) {
    throw new Error("GitHub release workflow run does not match the release commit");
  }
  return run;
}

function workflowRuns(value) {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error("GitHub workflow runs response was invalid");
  }
  return value.workflow_runs;
}

function decodeRun(value, field, upstream) {
  if (!isRecord(value)) {
    throw new Error(`GitHub ${field} was invalid`);
  }

  const runID = value.id;
  if (!Number.isSafeInteger(runID) || runID <= 0) {
    throw new Error("GitHub workflow run has an invalid ID");
  }

  const url = nonEmptyString(value.html_url, "workflow run URL");
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch {
    throw new Error("GitHub workflow run URL is not a matching github.com HTTPS URL");
  }
  if (
    parsedURL.protocol !== "https:" ||
    parsedURL.hostname !== "github.com" ||
    parsedURL.pathname !== `/${upstream}/actions/runs/${String(runID)}` ||
    parsedURL.search.length > 0 ||
    parsedURL.hash.length > 0
  ) {
    throw new Error("GitHub workflow run URL is not a matching github.com HTTPS URL");
  }

  const completedAt = nonEmptyString(
    value.updated_at ?? value.created_at,
    "workflow completion time",
  );
  if (Number.isNaN(Date.parse(completedAt))) {
    throw new Error("GitHub workflow run has an invalid completion time");
  }
  const conclusion = nonEmptyString(value.conclusion, "workflow conclusion");
  if (!completedConclusions.has(conclusion)) {
    throw new Error(`GitHub workflow run has an unsupported conclusion: ${conclusion}`);
  }

  return {
    id: runID,
    event: nonEmptyString(value.event, "workflow event"),
    status: nonEmptyString(value.status, "workflow status"),
    conclusion,
    headSHA: fullCommit(value.head_sha, "workflow head SHA"),
    headBranch: nonEmptyString(value.head_branch, "workflow head branch"),
    url,
    completedAt,
  };
}

function checkedCIMetadata(run) {
  return {
    ...ciIdentity,
    status: run.conclusion === "success" ? "passed" : "not_passed",
    runId: run.id,
    url: run.url,
    conclusion: run.conclusion,
    completedAt: run.completedAt,
  };
}

function fullCommit(value, field) {
  const commit = nonEmptyString(value, field);
  if (!commitPattern.test(commit)) {
    throw new Error(`GitHub ${field} is not a full commit SHA`);
  }
  return commit;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub response is missing ${field}`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
