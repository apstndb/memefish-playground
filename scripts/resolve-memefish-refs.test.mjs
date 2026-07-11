import { describe, expect, it, vi } from "vitest";
import { resolveMemefishRefs } from "./resolve-memefish-refs.mjs";

const upstream = "cloudspannerecosystem/memefish";
const mainSHA = "a".repeat(40);
const latestReleaseSHA = "b".repeat(40);
const olderReleaseSHA = "c".repeat(40);

function workflowRun(id, headSHA, conclusion = "success", headBranch = "main") {
  return {
    id,
    event: "push",
    status: "completed",
    conclusion,
    head_sha: headSHA,
    head_branch: headBranch,
    html_url: `https://github.com/cloudspannerecosystem/memefish/actions/runs/${id}`,
    updated_at: "2026-07-11T00:00:00Z",
  };
}

function resolverAPI({ releaseRuns = {} } = {}) {
  const commits = {
    "v2.0.0": latestReleaseSHA,
    "v1.9.0": olderReleaseSHA,
  };
  return vi.fn(async (path) => {
    if (path.includes("branch=main")) {
      return { workflow_runs: [workflowRun(101, mainSHA)] };
    }
    if (path.endsWith("/releases?per_page=100")) {
      return [
        { tag_name: "v2.0.0", draft: false, prerelease: false },
        { tag_name: "v1.9.0", draft: false, prerelease: false },
      ];
    }
    if (path.endsWith("/tags?per_page=100&page=1")) {
      return [{ name: "v1.9.0" }, { name: "v2.0.0" }];
    }
    for (const [tag, sha] of Object.entries(commits)) {
      if (path.endsWith(`/commits/${tag}`)) {
        return { sha };
      }
      if (path.includes(`head_sha=${sha}`)) {
        return { workflow_runs: releaseRuns[tag] ?? [] };
      }
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

describe("resolveMemefishRefs", () => {
  it("selects the latest stable release even when its upstream CI failed", async () => {
    const githubJSON = resolverAPI({
      releaseRuns: {
        "v2.0.0": [workflowRun(102, latestReleaseSHA, "failure")],
      },
    });

    const refs = await resolveMemefishRefs({ githubJSON, upstream });

    expect(refs.main).toMatchObject({
      commit: mainSHA,
      upstreamCI: { status: "passed", runId: 101, conclusion: "success" },
    });
    expect(refs.release).toMatchObject({
      label: "v2.0.0",
      commit: latestReleaseSHA,
      upstreamCI: { status: "not_passed", runId: 102, conclusion: "failure" },
    });
    expect(refs.releases.map((release) => release.label)).toEqual(["v2.0.0", "v1.9.0"]);
    expect(githubJSON).toHaveBeenCalledWith(
      expect.stringContaining(`head_sha=${latestReleaseSHA}&event=push&status=completed&`),
    );
    expect(githubJSON).not.toHaveBeenCalledWith(
      expect.stringContaining(`head_sha=${latestReleaseSHA}&event=push&status=success`),
    );
  });

  it("selects the latest stable release when no upstream CI run was recorded", async () => {
    const refs = await resolveMemefishRefs({ githubJSON: resolverAPI(), upstream });

    expect(refs.release).toMatchObject({
      label: "v2.0.0",
      commit: latestReleaseSHA,
      upstreamCI: {
        workflow: "Go",
        path: ".github/workflows/go.yml",
        status: "not_recorded",
      },
    });
    expect(refs.release.upstreamCI).not.toHaveProperty("runId");
  });

  it("skips draft and prerelease entries before selecting the latest stable release", async () => {
    const githubJSON = resolverAPI();
    githubJSON.mockImplementation(async (path) => {
      if (path.endsWith("/releases?per_page=100")) {
        return [
          { tag_name: "v3.0.0", draft: true, prerelease: false },
          { tag_name: "v2.1.0-rc.1", draft: false, prerelease: true },
          { tag_name: "v2.0.0", draft: false, prerelease: false },
        ];
      }
      return resolverAPI()(path);
    });

    const refs = await resolveMemefishRefs({ githubJSON, upstream });

    expect(refs.release.label).toBe("v2.0.0");
    expect(githubJSON).not.toHaveBeenCalledWith(expect.stringContaining("v3.0.0"));
    expect(githubJSON).not.toHaveBeenCalledWith(expect.stringContaining("v2.1.0-rc.1"));
  });

  it("paginates tags, sorts semver numerically, and de-duplicates repeated tags", async () => {
    const shas = new Map([
      ["v3.0.0", "3".repeat(40)],
      ["v2.10.0", "4".repeat(40)],
      ["v2.9.9", "5".repeat(40)],
      ["v1.0.0", "6".repeat(40)],
    ]);
    const firstPage = [
      { name: "v1.0.0" },
      ...Array.from({ length: 99 }, (_, index) => ({ name: `snapshot-${index}` })),
    ];
    const githubJSON = vi.fn(async (path) => {
      if (path.includes("branch=main")) {
        return { workflow_runs: [workflowRun(101, mainSHA)] };
      }
      if (path.endsWith("/releases?per_page=100")) {
        return [{ tag_name: "v3.0.0", draft: false, prerelease: false }];
      }
      if (path.endsWith("/tags?per_page=100&page=1")) {
        return firstPage;
      }
      if (path.endsWith("/tags?per_page=100&page=2")) {
        return [{ name: "v2.9.9" }, { name: "v3.0.0" }, { name: "v1.0.0" }, { name: "v2.10.0" }];
      }
      for (const [tag, sha] of shas) {
        if (path.endsWith(`/commits/${tag}`)) {
          return { sha };
        }
        if (path.includes(`head_sha=${sha}`)) {
          return { workflow_runs: [] };
        }
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const refs = await resolveMemefishRefs({ githubJSON, upstream });

    expect(refs.releases.map((release) => release.label)).toEqual([
      "v3.0.0",
      "v2.10.0",
      "v2.9.9",
      "v1.0.0",
    ]);
    expect(githubJSON).toHaveBeenCalledWith(`/repos/${upstream}/tags?per_page=100&page=2`);
    expect(githubJSON.mock.calls.filter(([path]) => path.endsWith("/commits/v1.0.0"))).toHaveLength(
      1,
    );
  });

  it("keeps a newer stable tag selectable before its GitHub Release is published", async () => {
    const newerReleaseSHA = "d".repeat(40);
    const api = resolverAPI();
    const githubJSON = vi.fn(async (path) => {
      if (path.endsWith("/tags?per_page=100&page=1")) {
        return [{ name: "v3.0.0" }, { name: "v2.0.0" }, { name: "v1.9.0" }];
      }
      if (path.endsWith("/commits/v3.0.0")) {
        return { sha: newerReleaseSHA };
      }
      if (path.includes(`head_sha=${newerReleaseSHA}`)) {
        return { workflow_runs: [] };
      }
      return api(path);
    });

    const refs = await resolveMemefishRefs({ githubJSON, upstream });

    expect(refs.release.label).toBe("v2.0.0");
    expect(refs.releases.map((release) => release.label)).toEqual(["v2.0.0", "v3.0.0", "v1.9.0"]);
  });

  it("keeps distinct stable tags even when they resolve to the same commit", async () => {
    const api = resolverAPI();
    const githubJSON = vi.fn(async (path) =>
      path.endsWith("/commits/v1.9.0") ? { sha: latestReleaseSHA } : api(path),
    );

    const refs = await resolveMemefishRefs({ githubJSON, upstream });

    expect(refs.releases.map((release) => release.label)).toEqual(["v2.0.0", "v1.9.0"]);
    expect(refs.releases.map((release) => release.commit)).toEqual([
      latestReleaseSHA,
      latestReleaseSHA,
    ]);
  });

  it("still rejects an update when main has no successful run", async () => {
    const api = resolverAPI();
    const githubJSON = vi.fn(async (path) =>
      path.includes("branch=main") ? { workflow_runs: [] } : api(path),
    );

    await expect(resolveMemefishRefs({ githubJSON, upstream })).rejects.toThrow(
      "main has no successful Go workflow run",
    );
  });

  it.each([
    {
      name: "non-GitHub workflow URL",
      mutate: (run) => ({ ...run, html_url: "https://example.test/run" }),
      message: "matching github.com HTTPS URL",
    },
    {
      name: "mismatched release SHA",
      mutate: (run) => ({ ...run, head_sha: "d".repeat(40) }),
      message: "does not match the release commit",
    },
    {
      name: "abbreviated workflow SHA",
      mutate: (run) => ({ ...run, head_sha: "b".repeat(12) }),
      message: "not a full commit SHA",
    },
    {
      name: "unsupported workflow conclusion",
      mutate: (run) => ({ ...run, conclusion: "unknown_future_value" }),
      message: "unsupported conclusion",
    },
  ])("fails closed for malformed provenance: $name", async ({ mutate, message }) => {
    const githubJSON = resolverAPI({
      releaseRuns: {
        "v2.0.0": [mutate(workflowRun(102, latestReleaseSHA, "failure"))],
      },
    });

    await expect(resolveMemefishRefs({ githubJSON, upstream })).rejects.toThrow(message);
  });
});
