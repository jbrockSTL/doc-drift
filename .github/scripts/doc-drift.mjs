import core from "@actions/core";
import github from "@actions/github";
import fetch from "node-fetch";

/* ============================================================================
   ENV + CONSTANTS
============================================================================ */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DRIFT_FAILS_BUILD =
  (process.env.DRIFT_FAILS_BUILD || "true").toLowerCase() === "true";
const MAX_DOC_BYTES = parseInt(process.env.MAX_DOC_BYTES || "250000", 10);
const DRIFT_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.DRIFT_CONFIDENCE_THRESHOLD || "0.75"
);
const MAX_FINDINGS = parseInt(process.env.MAX_FINDINGS || "25", 10);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "\n...[truncated]..." : str;
}

/* ============================================================================
   DIFF ANALYSIS (deterministic, no AI)
============================================================================ */

/**
 * Extract tokens that commonly require documentation updates:
 * - UI strings
 * - API paths
 * - CLI flags
 * - config keys / env vars
 */
function extractDocRelevantTokens(patch) {
  if (!patch) return [];

  const tokens = new Set();
  const lines = patch.split("\n");

  for (const line of lines) {
    if (!(line.startsWith("+") || line.startsWith("-"))) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;

    // Quoted strings
    const quoted = /(["'`])((?:\\\1|.)*?)\1/g;
    let m;
    while ((m = quoted.exec(line)) !== null) {
      const val = m[2]?.trim();
      if (val && val.length >= 4 && val.length <= 120) {
        tokens.add(val);
      }
    }

    // Token-like patterns (paths, flags, env vars, filenames)
    const tokenish = /([A-Za-z0-9_./-]{6,80})/g;
    while ((m = tokenish.exec(line)) !== null) {
      const t = m[1];
      if (
        t.includes("/") ||
        t.includes("--") ||
        t === t.toUpperCase() ||
        t.includes(".")
      ) {
        tokens.add(t);
      }
    }
  }

  // Remove pure semver tokens (noise)
  const filtered = [...tokens].filter((t) => !/^\d+\.\d+\.\d+/.test(t));

  return filtered.slice(0, 40);
}

/**
 * Extract dependency changes from common dependency manifests by reading diff lines.
 * This makes the LLM suggestions much more concrete (e.g., "dependency removed").
 *
 * Handles:
 * - package.json (JS/TS)
 * - requirements.txt (Python)
 * - pom.xml / build.gradle (basic heuristics)
 */
function extractDependencyChanges(filename, patch) {
  if (!patch) return { added: [], removed: [], updated: [] };

  const added = new Set();
  const removed = new Set();
  const updated = new Set();

  const isPackageJson = filename.endsWith("package.json");
  const isRequirements = filename.endsWith("requirements.txt");
  const isPipfile = filename.endsWith("Pipfile");
  const isPom = filename.endsWith("pom.xml");
  const isGradle = filename.endsWith("build.gradle") || filename.endsWith("build.gradle.kts");

  const lines = patch.split("\n");

  // Helper: for JSON-style deps:   "dep-name": "1.2.3"
  const jsonDepRe = /"(@?[\w.-]+\/?[\w.-]*)"\s*:\s*"([^"]+)"/;

  // Helper: requirements style: dep==1.2.3 or dep>=1.0
  const reqRe = /^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|>|<)\s*([A-Za-z0-9_.-]+)\s*$/;

  for (const line of lines) {
    if (!(line.startsWith("+") || line.startsWith("-"))) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;

    const sign = line[0]; // + or -
    const content = line.slice(1).trim();

    if (isPackageJson) {
      const m = content.match(jsonDepRe);
      if (m) {
        const dep = m[1];
        const ver = m[2];
        if (sign === "+") added.add(`${dep}@${ver}`);
        if (sign === "-") removed.add(`${dep}@${ver}`);
      }
      continue;
    }

    if (isRequirements || isPipfile) {
      const m = content.match(reqRe);
      if (m) {
        const dep = m[1];
        const spec = `${m[2]}${m[3]}`;
        if (sign === "+") added.add(`${dep}${spec}`);
        if (sign === "-") removed.add(`${dep}${spec}`);
      }
      continue;
    }

    if (isPom) {
      // Basic: look for <artifactId>xyz</artifactId>
      const art = content.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/);
      if (art) {
        if (sign === "+") added.add(art[1]);
        if (sign === "-") removed.add(art[1]);
      }
      continue;
    }

    if (isGradle) {
      // Basic: implementation("group:artifact:version") or implementation 'group:artifact:version'
      const g = content.match(/(implementation|api|compileOnly|runtimeOnly)\s*\(?["']([^"']+)["']/);
      if (g) {
        if (sign === "+") added.add(g[2]);
        if (sign === "-") removed.add(g[2]);
      }
      continue;
    }
  }

  // Detect "updates": same dep appears in both removed+added with different version
  // For package.json, convert dep@ver into map dep -> vers
  const normalizeDepName = (s) => {
    const at = s.lastIndexOf("@");
    // scoped packages have @ in the name, so split by last @ only if it looks like dep@ver
    return at > 0 ? s.slice(0, at) : s;
  };

  const removedNames = new Map();
  const addedNames = new Map();

  for (const r of removed) removedNames.set(normalizeDepName(r), r);
  for (const a of added) addedNames.set(normalizeDepName(a), a);

  for (const name of removedNames.keys()) {
    if (addedNames.has(name)) {
      updated.add(`${removedNames.get(name)} -> ${addedNames.get(name)}`);
      removed.delete(removedNames.get(name));
      added.delete(addedNames.get(name));
    }
  }

  return {
    added: [...added].slice(0, 25),
    removed: [...removed].slice(0, 25),
    updated: [...updated].slice(0, 25),
  };
}

/* ============================================================================
   DOC FETCHING + EVIDENCE EXTRACTION
============================================================================ */

async function fetchDoc(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    core.warning(`Skipping doc (fetch failed): ${url} (${res.status})`);
    return null;
  }
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);
  return truncate(text, MAX_DOC_BYTES);
}

function findSnippets(docText, needle) {
  if (!docText || !needle) return [];

  const lower = docText.toLowerCase();
  const search = needle.toLowerCase();
  const snippets = [];

  let idx = lower.indexOf(search);
  while (idx !== -1 && snippets.length < 6) {
    const start = Math.max(0, idx - 250);
    const end = Math.min(docText.length, idx + search.length + 250);
    snippets.push(docText.slice(start, end));
    idx = lower.indexOf(search, idx + 1);
  }

  return snippets;
}

/* ============================================================================
   OPENAI CALL (STRICT STRUCTURED OUTPUT)
============================================================================ */

async function callOpenAI(prompt, schema) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "doc_drift_report",
          schema,
          strict: true,
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error: ${res.status}\n${text}`);
  }

  const json = await res.json();
  const output = json.output?.[0]?.content?.[0]?.text;
  if (!output) throw new Error("Missing structured output from OpenAI");

  return JSON.parse(output);
}

/* ============================================================================
   MAIN
============================================================================ */

async function run() {
  requireEnv("GITHUB_TOKEN");
  requireEnv("OPENAI_API_KEY");

  const rawDocSources = requireEnv("DOC_SOURCES_JSON");
  let docSources;
  try {
    docSources = JSON.parse(rawDocSources);
  } catch {
    throw new Error("DOC_SOURCES_JSON must be valid JSON");
  }

  if (!Array.isArray(docSources) || docSources.length === 0) {
    throw new Error("DOC_SOURCES_JSON must be a non-empty JSON array");
  }

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const context = github.context;

  if (!context.payload.pull_request) {
    throw new Error("This action must run on pull_request events");
  }

  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;

  /* ----------------------------------------
     Load PR files + patches
  ---------------------------------------- */

  const files = [];
  let page = 1;

  while (true) {
    const res = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    files.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }

  const tokenSet = new Set();
  const prFiles = [];
  const dependencyChanges = {
    added: [],
    removed: [],
    updated: [],
  };

  for (const f of files) {
    const patch = f.patch || "";
    for (const t of extractDocRelevantTokens(patch)) tokenSet.add(t);

    // Detect dependency changes if this file looks like a dependency manifest
    const dep = extractDependencyChanges(f.filename, patch);
    dependencyChanges.added.push(...dep.added);
    dependencyChanges.removed.push(...dep.removed);
    dependencyChanges.updated.push(...dep.updated);

    prFiles.push({
      filename: f.filename,
      status: f.status,
      patch: truncate(patch, 4000),
    });
  }

  // De-dupe dependency changes
  dependencyChanges.added = [...new Set(dependencyChanges.added)].slice(0, 50);
  dependencyChanges.removed = [...new Set(dependencyChanges.removed)].slice(0, 50);
  dependencyChanges.updated = [...new Set(dependencyChanges.updated)].slice(0, 50);

  const tokens = [...tokenSet];

  /* ----------------------------------------
     Fetch docs and build evidence hits
  ---------------------------------------- */

  const docsEvidence = [];
  for (const src of docSources) {
    if (!src?.url) continue;

    const text = await fetchDoc(src.url);
    if (!text) continue;

    const hits = [];
    for (const token of tokens) {
      const snippets = findSnippets(text, token);
      if (snippets.length) {
        hits.push({
          token,
          snippets: snippets.slice(0, 3),
        });
      }
    }

    // ALSO: if dependency removal happened, explicitly search for the dependency name (without version)
    // Example: "@tanstack/react-query@5.32.0" => "@tanstack/react-query"
    const depNames = [
      ...dependencyChanges.added,
      ...dependencyChanges.removed,
      ...dependencyChanges.updated,
    ]
      .map((s) => {
        // package.json updates contain "dep@ver" - keep dep portion
        const lastAt = s.lastIndexOf("@");
        if (lastAt > 0 && s.startsWith("@")) {
          // scoped pkg: keep everything up to last @
          return s.slice(0, lastAt);
        }
        if (lastAt > 0) return s.slice(0, lastAt);
        // gradle strings group:artifact:ver - keep group:artifact
        if (s.includes(":")) return s.split(":").slice(0, 2).join(":");
        // requirements dep==ver - keep dep
        return s.replace(/(==|>=|<=|~=|>|<).+$/, "");
      })
      .map((s) => s.trim())
      .filter(Boolean);

    for (const dn of depNames) {
      const snippets = findSnippets(text, dn);
      if (snippets.length) {
        hits.push({
          token: dn,
          snippets: snippets.slice(0, 3),
        });
      }
    }

    docsEvidence.push({
      title: src.title || src.url,
      url: src.url,
      hits,
    });
  }

  /* ----------------------------------------
     STRICT JSON Schema
     - Numbering will be done in renderer
     - Total drift instances computed in renderer
     - Suggestions must reference concrete change (dep removed, renamed, etc.)
  ---------------------------------------- */

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["drift_detected", "findings"],
    properties: {
      drift_detected: { type: "boolean" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "doc_title",
            "doc_url",
            "change_summary",
            "impact_statement",
            "confidence",
            "evidence",
            "suggested_revised_wording",
          ],
          properties: {
            doc_title: { type: "string" },
            doc_url: { type: "string" },

            // What changed in the PR that triggers drift (must be concrete)
            change_summary: { type: "string" },

            // Tie doc reference to the change ("because this doc says X, it's stale now")
            impact_statement: { type: "string" },

            confidence: { type: "number", minimum: 0, maximum: 1 },

            // Evidence excerpts from docs (quoted text)
            evidence: { type: "array", items: { type: "string" } },

            // Ready-to-paste replacement wording, including "remove this sentence" if applicable
            suggested_revised_wording: { type: "string" },
          },
        },
      },
    },
  };

  /* ----------------------------------------
     Prompt
  ---------------------------------------- */

  const prompt = [
    {
      role: "system",
      content:
        "You are a documentation drift detector. " +
        "You MUST ground every finding ONLY in the provided evidence text. Do not invent doc contents. " +
        "Return ALL drift instances you can justify. Do not stop after the first. " +
        "Create a SEPARATE finding for each distinct doc location that needs change. " +
        "Do NOT flag drift for generic statements like 'performance matters' unless the PR changed something that directly contradicts the statement. " +
        "Do NOT flag drift for version bumps alone unless the doc evidence contains a specific API/usage/step that is now incorrect. " +
        "For each finding, write change_summary as a concrete statement (e.g., 'Removed dependency X', 'Renamed endpoint /a to /b', 'Changed UI label Add Item to Create Item'). " +
        "impact_statement must explicitly connect the doc evidence to the change. " +
        "suggested_revised_wording must be specific and ready to paste: either a replacement sentence/paragraph or a concise instruction to delete a sentence plus replacement text.",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          goal:
            "Determine whether code changes in this PR require documentation updates across the provided documentation sources.",
          limits: {
            max_findings: MAX_FINDINGS,
          },
          pr_files: prFiles,
          extracted_change_tokens: tokens,
          dependency_changes: dependencyChanges,
          documentation_evidence: docsEvidence,
          required_behavior: [
            "Return up to max_findings findings.",
            "Return findings only when the evidence contains specific text that should change.",
            "Do not output vague impact statements. You must say what changed and how the doc is now stale.",
            "If a dependency was removed and docs reference it, explicitly say 'You dropped X' and recommend how to reword or delete the mention.",
            "If you cannot propose a concrete revised wording grounded in the evidence, do not mark drift.",
          ],
        },
        null,
        2
      ),
    },
  ];

  let report = await callOpenAI(prompt, schema);

  // Safety cap client-side
  if (Array.isArray(report.findings) && report.findings.length > MAX_FINDINGS) {
    report.findings = report.findings.slice(0, MAX_FINDINGS);
  }

  /* ----------------------------------------
     Render PR comment
     - Total drift instances at top
     - Numbered instances
  ---------------------------------------- */

  const total = Array.isArray(report.findings) ? report.findings.length : 0;

  let body = "## Documentation Drift Report\n\n";
  body += `**Drift detected:** ${report.drift_detected ? "YES" : "NO"}\n`;
  body += `**Total drift instances:** ${total}\n\n`;

  if (!report.findings || total === 0) {
    body += "_No documentation drift detected._\n";
  } else {
    report.findings.forEach((f, idx) => {
      const n = idx + 1;
      body += `### ${n}. ${f.doc_title}\n`;
      body += `- Doc: ${f.doc_url}\n`;
      body += `- Change: ${f.change_summary}\n`;
      body += `- Impact: ${f.impact_statement}\n`;
      body += `- Confidence: ${Math.round(f.confidence * 100)}%\n\n`;

      if (f.evidence?.length) {
        body += "**Evidence**\n";
        for (const e of f.evidence.slice(0, 3)) {
          const q = String(e).trim().replace(/\n/g, "\n> ");
          body += `> ${q}\n\n`;
        }
      }

      if (f.suggested_revised_wording?.trim()) {
        body += "**Suggested revised wording**\n```text\n";
        body += f.suggested_revised_wording.trim() + "\n";
        body += "```\n\n";
      }
    });
  }

  const marker = "<!-- doc-drift-report -->";
  const finalBody = `${marker}\n${body}`;

  /* ----------------------------------------
     Create/Update PR comment
  ---------------------------------------- */

  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.data.find((c) => (c.body || "").includes(marker));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: finalBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: finalBody,
    });
  }

  /* ----------------------------------------
     Fail gate (optional + threshold)
  ---------------------------------------- */

  const maxFindingConfidence = (report.findings || []).reduce((acc, f) => {
    return Math.max(acc, typeof f.confidence === "number" ? f.confidence : 0);
  }, 0);

  if (
    report.drift_detected &&
    DRIFT_FAILS_BUILD &&
    maxFindingConfidence >= DRIFT_CONFIDENCE_THRESHOLD
  ) {
    core.setFailed(
      `Documentation drift detected (max finding confidence ${Math.round(
        maxFindingConfidence * 100
      )}% >= ${Math.round(DRIFT_CONFIDENCE_THRESHOLD * 100)}%).`
    );
  } else if (report.drift_detected) {
    core.warning(
      `Possible documentation drift detected, but not failing build (max finding confidence ${Math.round(
        maxFindingConfidence * 100
      )}%).`
    );
  }
}

run().catch((err) => core.setFailed(err.message || String(err)));
