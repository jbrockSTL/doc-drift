/**
 * Documentation Drift Detector
 * ============================
 *
 * A GitHub Action that detects when code changes may have made documentation stale.
 *
 * How it works:
 * 1. Extracts meaningful tokens from PR diffs (API paths, UI strings, config keys)
 * 2. Detects dependency changes from package manifests
 * 3. Searches documentation sources for mentions of changed tokens
 * 4. Uses AI to determine if found mentions are now stale
 * 5. Posts a report as a PR comment
 */

import core from "@actions/core";
import github from "@actions/github";
import fetch from "node-fetch";

/* ============================================================================
   CONFIGURATION
   
   All tunables gathered in one place with sensible defaults.
============================================================================ */

const Config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },

  drift: {
    failsBuild: (process.env.DRIFT_FAILS_BUILD || "true").toLowerCase() === "true",
    confidenceThreshold: parseFloat(process.env.DRIFT_CONFIDENCE_THRESHOLD || "0.75"),
    maxFindings: parseInt(process.env.MAX_FINDINGS || "25", 10),
  },

  limits: {
    maxDocBytes: parseInt(process.env.MAX_DOC_BYTES || "250000", 10),
    maxPatchLength: 4000,
    maxTokens: 40,
    maxDependencies: 50,
    maxSnippetsPerToken: 3,
    snippetContextRadius: 250,
  },
};

const PR_COMMENT_MARKER = "<!-- doc-drift-report -->";

/* ============================================================================
   UTILITY FUNCTIONS
============================================================================ */

/**
 * Validates that a required environment variable exists.
 * Fails fast with a clear error message if missing.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Truncates a string to a maximum length.
 * Prevents memory issues with large diffs or documents.
 */
function truncate(str, maxLength) {
  if (!str) return "";
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "\n...[truncated]...";
}

/**
 * Checks if a diff line represents an actual code change.
 * Excludes diff metadata lines (--- and +++ headers).
 */
function isChangedLine(line) {
  const isAddedOrRemoved = line.startsWith("+") || line.startsWith("-");
  const isDiffMetadata = line.startsWith("+++ ") || line.startsWith("--- ");
  return isAddedOrRemoved && !isDiffMetadata;
}

/* ============================================================================
   TOKEN EXTRACTION
   
   Identifies documentation-relevant tokens from code changes.
   Not all code changes need doc updates, but certain patterns almost always do:
   API paths, UI strings, CLI flags, environment variables.
============================================================================ */

/**
 * Extracts tokens from a patch that commonly require documentation updates.
 *
 * Target patterns:
 * - Quoted strings (UI labels, messages, identifiers)
 * - URL paths (API endpoints)
 * - CLI flags (--option-name)
 * - Environment variables (UPPER_CASE_WITH_UNDERSCORES)
 * - File references (containing dots or slashes)
 */
function extractDocRelevantTokens(patch) {
  if (!patch) return [];

  const tokens = new Set();

  for (const line of patch.split("\n")) {
    if (!isChangedLine(line)) continue;
    extractQuotedStrings(line, tokens);
    extractTokenLikePatterns(line, tokens);
  }

  return filterAndLimitTokens(tokens);
}

/**
 * Extracts quoted strings from a line of code.
 * Handles single, double, and template literal quotes.
 *
 * Quoted strings often contain user-facing text, API endpoints,
 * or configuration values—all documentation-worthy.
 */
function extractQuotedStrings(line, tokens) {
  const quotedStringPattern = /(["'`])((?:\\\1|.)*?)\1/g;
  let match;

  while ((match = quotedStringPattern.exec(line)) !== null) {
    const value = match[2]?.trim();
    const isReasonableLength = value && value.length >= 4 && value.length <= 120;
    if (isReasonableLength) {
      tokens.add(value);
    }
  }
}

/**
 * Extracts token-like patterns that suggest documentation relevance.
 *
 * Heuristics:
 * - Contains "/" → likely a path or URL
 * - Contains "--" → likely a CLI flag
 * - ALL_CAPS → likely an environment variable or constant
 * - Contains "." → likely a filename or domain
 */
function extractTokenLikePatterns(line, tokens) {
  const tokenPattern = /([A-Za-z0-9_./-]{6,80})/g;
  let match;

  while ((match = tokenPattern.exec(line)) !== null) {
    const token = match[1];
    const looksLikePath = token.includes("/");
    const looksLikeCliFlag = token.includes("--");
    const looksLikeEnvVar = token === token.toUpperCase();
    const looksLikeFilename = token.includes(".");

    if (looksLikePath || looksLikeCliFlag || looksLikeEnvVar || looksLikeFilename) {
      tokens.add(token);
    }
  }
}

/**
 * Filters out noisy tokens and limits the total count.
 * Semantic versioning strings are filtered because version bumps
 * alone rarely indicate documentation drift.
 */
function filterAndLimitTokens(tokens) {
  const semverPattern = /^\d+\.\d+\.\d+/;

  return [...tokens]
    .filter((token) => !semverPattern.test(token))
    .slice(0, Config.limits.maxTokens);
}

/* ============================================================================
   DEPENDENCY CHANGE DETECTION
   
   Dependency changes are a major source of documentation drift.
   If you remove a library, any documentation referencing it is now stale.
============================================================================ */

/**
 * Extracts added, removed, and updated dependencies from a diff.
 *
 * Supports:
 * - package.json (JavaScript/TypeScript)
 * - requirements.txt, Pipfile (Python)
 * - pom.xml (Maven/Java)
 * - build.gradle, build.gradle.kts (Gradle/Kotlin)
 */
function extractDependencyChanges(filename, patch) {
  if (!patch) {
    return { added: [], removed: [], updated: [] };
  }

  const parser = selectDependencyParser(filename);
  if (!parser) {
    return { added: [], removed: [], updated: [] };
  }

  const { added, removed } = parseDependencyDiff(patch, parser);
  return reconcileUpdatedDependencies(added, removed);
}

/**
 * Selects the appropriate parser based on the dependency manifest type.
 * Returns null if the file is not a recognized dependency manifest.
 */
function selectDependencyParser(filename) {
  const parsers = {
    "package.json": parseJsonDependency,
    "requirements.txt": parsePythonRequirement,
    "Pipfile": parsePythonRequirement,
    "pom.xml": parseMavenDependency,
    "build.gradle": parseGradleDependency,
    "build.gradle.kts": parseGradleDependency,
  };

  for (const [suffix, parser] of Object.entries(parsers)) {
    if (filename.endsWith(suffix)) {
      return parser;
    }
  }

  return null;
}

/** Parses JSON-style dependency: "lodash": "^4.17.21" */
function parseJsonDependency(content) {
  const pattern = /"(@?[\w.-]+\/?[\w.-]*)"\s*:\s*"([^"]+)"/;
  const match = content.match(pattern);
  return match ? `${match[1]}@${match[2]}` : null;
}

/** Parses Python requirements-style: requests==2.28.0 or django>=4.0 */
function parsePythonRequirement(content) {
  const pattern = /^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|>|<)\s*([A-Za-z0-9_.-]+)\s*$/;
  const match = content.match(pattern);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/** Parses Maven pom.xml artifactId: <artifactId>spring-boot-starter</artifactId> */
function parseMavenDependency(content) {
  const pattern = /<artifactId>\s*([^<]+)\s*<\/artifactId>/;
  const match = content.match(pattern);
  return match ? match[1] : null;
}

/** Parses Gradle dependency: implementation("org.springframework:spring-core:5.3.0") */
function parseGradleDependency(content) {
  const pattern = /(implementation|api|compileOnly|runtimeOnly)\s*\(?["']([^"']+)["']/;
  const match = content.match(pattern);
  return match ? match[2] : null;
}

/**
 * Processes a diff to extract added and removed dependencies.
 */
function parseDependencyDiff(patch, parser) {
  const added = new Set();
  const removed = new Set();

  for (const line of patch.split("\n")) {
    if (!isChangedLine(line)) continue;

    const sign = line[0];
    const content = line.slice(1).trim();
    const dependency = parser(content);

    if (dependency) {
      if (sign === "+") added.add(dependency);
      if (sign === "-") removed.add(dependency);
    }
  }

  return { added, removed };
}

/**
 * Identifies updated dependencies (same name, different version).
 * When a dependency appears in both added and removed sets,
 * it's an update, not a true add/remove pair.
 */
function reconcileUpdatedDependencies(addedSet, removedSet) {
  const added = new Set(addedSet);
  const removed = new Set(removedSet);
  const updated = new Set();

  const removedByName = new Map();
  const addedByName = new Map();

  for (const dep of removed) {
    removedByName.set(extractDependencyName(dep), dep);
  }
  for (const dep of added) {
    addedByName.set(extractDependencyName(dep), dep);
  }

  for (const name of removedByName.keys()) {
    if (addedByName.has(name)) {
      const oldVersion = removedByName.get(name);
      const newVersion = addedByName.get(name);

      updated.add(`${oldVersion} -> ${newVersion}`);
      removed.delete(oldVersion);
      added.delete(newVersion);
    }
  }

  return {
    added: [...added].slice(0, Config.limits.maxDependencies),
    removed: [...removed].slice(0, Config.limits.maxDependencies),
    updated: [...updated].slice(0, Config.limits.maxDependencies),
  };
}

/**
 * Extracts the base name from a versioned dependency string.
 *
 * Examples:
 * - "lodash@4.17.21" → "lodash"
 * - "@types/node@18.0.0" → "@types/node"
 * - "org.springframework:spring-core:5.3.0" → "org.springframework:spring-core"
 * - "requests==2.28.0" → "requests"
 */
function extractDependencyName(versionedDep) {
  const lastAtIndex = versionedDep.lastIndexOf("@");
  if (lastAtIndex > 0) {
    return versionedDep.slice(0, lastAtIndex);
  }

  if (versionedDep.includes(":")) {
    return versionedDep.split(":").slice(0, 2).join(":");
  }

  return versionedDep.replace(/(==|>=|<=|~=|>|<).+$/, "");
}

/* ============================================================================
   DOCUMENTATION FETCHING AND EVIDENCE COLLECTION
   
   We don't guess at documentation drift—we find concrete evidence
   by searching for changed tokens in actual documentation.
============================================================================ */

/**
 * Fetches a documentation source from a URL.
 * Returns null if fetch fails (with a warning logged).
 */
async function fetchDocumentation(url) {
  try {
    const response = await fetch(url, { redirect: "follow" });

    if (!response.ok) {
      core.warning(`Skipping doc (HTTP ${response.status}): ${url}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buffer);

    return truncate(text, Config.limits.maxDocBytes);
  } catch (error) {
    core.warning(`Skipping doc (fetch error): ${url} - ${error.message}`);
    return null;
  }
}

/**
 * Finds context snippets around occurrences of a search term in a document.
 * Returns surrounding text for each match, providing context for AI assessment.
 */
function findContextSnippets(documentText, searchTerm) {
  if (!documentText || !searchTerm) return [];

  const lowerDoc = documentText.toLowerCase();
  const lowerTerm = searchTerm.toLowerCase();
  const snippets = [];
  const maxSnippets = 6;

  let position = lowerDoc.indexOf(lowerTerm);

  while (position !== -1 && snippets.length < maxSnippets) {
    const start = Math.max(0, position - Config.limits.snippetContextRadius);
    const end = Math.min(
      documentText.length,
      position + lowerTerm.length + Config.limits.snippetContextRadius
    );

    snippets.push(documentText.slice(start, end));
    position = lowerDoc.indexOf(lowerTerm, position + 1);
  }

  return snippets;
}

/**
 * Extracts the searchable name from a versioned dependency.
 * Used to find documentation mentions of dependencies.
 */
function extractSearchableDependencyName(versionedDep) {
  const lastAtIndex = versionedDep.lastIndexOf("@");

  if (lastAtIndex > 0 && versionedDep.startsWith("@")) {
    return versionedDep.slice(0, lastAtIndex);
  }

  if (lastAtIndex > 0) {
    return versionedDep.slice(0, lastAtIndex);
  }

  if (versionedDep.includes(":")) {
    return versionedDep.split(":").slice(0, 2).join(":");
  }

  return versionedDep.replace(/(==|>=|<=|~=|>|<).+$/, "").trim();
}

/**
 * Builds evidence of potential drift by searching docs for changed tokens.
 */
async function buildDocumentationEvidence(docSources, tokens, dependencyChanges) {
  const evidence = [];

  for (const source of docSources) {
    if (!source?.url) continue;

    const text = await fetchDocumentation(source.url);
    if (!text) continue;

    const hits = [];

    // Search for change tokens
    for (const token of tokens) {
      const snippets = findContextSnippets(text, token);
      if (snippets.length > 0) {
        hits.push({
          token,
          snippets: snippets.slice(0, Config.limits.maxSnippetsPerToken),
        });
      }
    }

    // Search for dependency names (without versions)
    const allDependencies = [
      ...dependencyChanges.added,
      ...dependencyChanges.removed,
      ...dependencyChanges.updated,
    ];

    const dependencyNames = allDependencies
      .map(extractSearchableDependencyName)
      .filter(Boolean);

    for (const depName of dependencyNames) {
      const snippets = findContextSnippets(text, depName);
      if (snippets.length > 0) {
        hits.push({
          token: depName,
          snippets: snippets.slice(0, Config.limits.maxSnippetsPerToken),
        });
      }
    }

    evidence.push({
      title: source.title || source.url,
      url: source.url,
      hits,
    });
  }

  return evidence;
}

/* ============================================================================
   AI ANALYSIS
   
   After gathering evidence, we use AI to assess whether the evidence
   indicates actual documentation drift requiring human attention.
============================================================================ */

/**
 * JSON Schema for the AI's structured response.
 * Strict schema ensures predictable, parseable output.
 */
const driftReportSchema = {
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
          change_summary: { type: "string" },
          impact_statement: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" } },
          suggested_revised_wording: { type: "string" },
        },
      },
    },
  },
};

/**
 * Builds the system prompt that guides the AI's analysis behavior.
 */
function buildSystemPrompt() {
  return (
    "You are a documentation drift detector. " +
    "You MUST ground every finding ONLY in the provided evidence text. Do not invent doc contents. " +
    "Return ALL drift instances you can justify. Do not stop after the first. " +
    "Create a SEPARATE finding for each distinct doc location that needs change. " +
    "Do NOT flag drift for generic statements like 'performance matters' unless the PR changed something that directly contradicts the statement. " +
    "Do NOT flag drift for version bumps alone unless the doc evidence contains a specific API/usage/step that is now incorrect. " +
    "For each finding, write change_summary as a concrete statement (e.g., 'Removed dependency X', 'Renamed endpoint /a to /b', 'Changed UI label Add Item to Create Item'). " +
    "impact_statement must explicitly connect the doc evidence to the change. " +
    "suggested_revised_wording must be specific and ready to paste: either a replacement sentence/paragraph or a concise instruction to delete a sentence plus replacement text."
  );
}

/**
 * Calls the OpenAI API with structured output.
 */
async function callOpenAI(messages, schema) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Config.openai.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Config.openai.model,
      input: messages,
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

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  const output = json.output?.[0]?.content?.[0]?.text;

  if (!output) {
    throw new Error("OpenAI returned empty structured output");
  }

  return JSON.parse(output);
}

/**
 * Analyzes PR changes against documentation evidence to detect drift.
 */
async function analyzeDrift(prFiles, tokens, dependencyChanges, docsEvidence) {
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          goal: "Determine whether code changes in this PR require documentation updates.",
          limits: { max_findings: Config.drift.maxFindings },
          pr_files: prFiles,
          extracted_change_tokens: tokens,
          dependency_changes: dependencyChanges,
          documentation_evidence: docsEvidence,
          required_behavior: [
            "Return up to max_findings findings.",
            "Return findings only when evidence contains specific text that should change.",
            "Do not output vague impact statements—say what changed and how docs are now stale.",
            "If a dependency was removed and docs reference it, say 'You dropped X' and suggest rewording.",
            "If you cannot propose concrete revised wording grounded in evidence, do not mark drift.",
          ],
        },
        null,
        2
      ),
    },
  ];

  const report = await callOpenAI(messages, driftReportSchema);

  // Enforce client-side limit as a safety measure
  if (Array.isArray(report.findings) && report.findings.length > Config.drift.maxFindings) {
    report.findings = report.findings.slice(0, Config.drift.maxFindings);
  }

  return report;
}

/* ============================================================================
   REPORT GENERATION
============================================================================ */

/**
 * Renders a single drift finding as Markdown.
 */
function renderFinding(finding, number) {
  let markdown = `### ${number}. ${finding.doc_title}\n`;
  markdown += `- Doc: ${finding.doc_url}\n`;
  markdown += `- Change: ${finding.change_summary}\n`;
  markdown += `- Impact: ${finding.impact_statement}\n`;
  markdown += `- Confidence: ${Math.round(finding.confidence * 100)}%\n\n`;

  if (finding.evidence?.length) {
    markdown += "**Evidence**\n";
    for (const excerpt of finding.evidence.slice(0, 3)) {
      const quoted = String(excerpt).trim().replace(/\n/g, "\n> ");
      markdown += `> ${quoted}\n\n`;
    }
  }

  if (finding.suggested_revised_wording?.trim()) {
    markdown += "**Suggested revised wording**\n```text\n";
    markdown += finding.suggested_revised_wording.trim() + "\n";
    markdown += "```\n\n";
  }

  return markdown;
}

/**
 * Renders the drift report as a Markdown PR comment.
 */
function renderReport(report) {
  const findingCount = Array.isArray(report.findings) ? report.findings.length : 0;

  let markdown = "## Documentation Drift Report\n\n";
  markdown += `**Drift detected:** ${report.drift_detected ? "YES" : "NO"}\n`;
  markdown += `**Total drift instances:** ${findingCount}\n\n`;

  if (findingCount === 0) {
    markdown += "_No documentation drift detected._\n";
    return markdown;
  }

  report.findings.forEach((finding, index) => {
    markdown += renderFinding(finding, index + 1);
  });

  return markdown;
}

/* ============================================================================
   GITHUB INTEGRATION
============================================================================ */

/**
 * Fetches all changed files from a pull request with pagination.
 */
async function fetchPRFiles(octokit, owner, repo, prNumber) {
  const files = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    files.push(...response.data);

    if (response.data.length < 100) break;
    page++;
  }

  return files;
}

/**
 * Creates or updates the drift report comment on a PR.
 */
async function upsertPRComment(octokit, owner, repo, prNumber, body) {
  const markedBody = `${PR_COMMENT_MARKER}\n${body}`;

  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.data.find((c) => (c.body || "").includes(PR_COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: markedBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: markedBody,
    });
  }
}

/**
 * Determines the maximum confidence score across all findings.
 */
function getMaxConfidence(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 0;
  }

  return findings.reduce((max, finding) => {
    const confidence = typeof finding.confidence === "number" ? finding.confidence : 0;
    return Math.max(max, confidence);
  }, 0);
}

/**
 * Handles the build failure logic based on drift detection results.
 */
function handleBuildResult(report) {
  const maxConfidence = getMaxConfidence(report.findings);
  const confidencePercent = Math.round(maxConfidence * 100);
  const thresholdPercent = Math.round(Config.drift.confidenceThreshold * 100);

  const shouldFail =
    report.drift_detected &&
    Config.drift.failsBuild &&
    maxConfidence >= Config.drift.confidenceThreshold;

  if (shouldFail) {
    core.setFailed(
      `Documentation drift detected (max confidence ${confidencePercent}% >= ${thresholdPercent}% threshold).`
    );
  } else if (report.drift_detected) {
    core.warning(
      `Possible documentation drift detected, but not failing build (max confidence ${confidencePercent}%).`
    );
  }
}

/* ============================================================================
   MAIN ORCHESTRATION
============================================================================ */

/**
 * Processes PR files to extract tokens and dependency changes.
 */
function processPRFiles(files) {
  const tokenSet = new Set();
  const prFiles = [];
  const dependencyChanges = {
    added: [],
    removed: [],
    updated: [],
  };

  for (const file of files) {
    const patch = file.patch || "";

    // Extract documentation-relevant tokens
    for (const token of extractDocRelevantTokens(patch)) {
      tokenSet.add(token);
    }

    // Detect dependency changes
    const deps = extractDependencyChanges(file.filename, patch);
    dependencyChanges.added.push(...deps.added);
    dependencyChanges.removed.push(...deps.removed);
    dependencyChanges.updated.push(...deps.updated);

    // Store file info for AI analysis
    prFiles.push({
      filename: file.filename,
      status: file.status,
      patch: truncate(patch, Config.limits.maxPatchLength),
    });
  }

  // Deduplicate dependency changes
  dependencyChanges.added = [...new Set(dependencyChanges.added)].slice(
    0,
    Config.limits.maxDependencies
  );
  dependencyChanges.removed = [...new Set(dependencyChanges.removed)].slice(
    0,
    Config.limits.maxDependencies
  );
  dependencyChanges.updated = [...new Set(dependencyChanges.updated)].slice(
    0,
    Config.limits.maxDependencies
  );

  return {
    tokens: [...tokenSet],
    prFiles,
    dependencyChanges,
  };
}

/**
 * Parses and validates the documentation sources configuration.
 */
function parseDocSources(rawJson) {
  let docSources;

  try {
    docSources = JSON.parse(rawJson);
  } catch {
    throw new Error("DOC_SOURCES_JSON must be valid JSON");
  }

  if (!Array.isArray(docSources) || docSources.length === 0) {
    throw new Error("DOC_SOURCES_JSON must be a non-empty JSON array");
  }

  return docSources;
}

/**
 * Main entry point. Orchestrates the entire drift detection workflow.
 */
async function run() {
  // Validate required configuration
  requireEnv("GITHUB_TOKEN");
  requireEnv("OPENAI_API_KEY");

  const docSources = parseDocSources(requireEnv("DOC_SOURCES_JSON"));

  // Initialize GitHub client
  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const context = github.context;

  if (!context.payload.pull_request) {
    throw new Error("This action must run on pull_request events");
  }

  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;

  // Fetch and process PR files
  const files = await fetchPRFiles(octokit, owner, repo, prNumber);
  const { tokens, prFiles, dependencyChanges } = processPRFiles(files);

  // Build evidence from documentation sources
  const docsEvidence = await buildDocumentationEvidence(docSources, tokens, dependencyChanges);

  // Analyze for drift using AI
  const report = await analyzeDrift(prFiles, tokens, dependencyChanges, docsEvidence);

  // Post results to PR
  const reportMarkdown = renderReport(report);
  await upsertPRComment(octokit, owner, repo, prNumber, reportMarkdown);

  // Handle build pass/fail
  handleBuildResult(report);
}

// Execute and handle top-level errors
run().catch((error) => {
  core.setFailed(error.message || String(error));
});
