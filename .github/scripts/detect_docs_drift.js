#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Get environment variables
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_SHA = process.env.PR_BASE_SHA;
const HEAD_SHA = process.env.PR_HEAD_SHA;

if (!API_KEY || !BASE_SHA || !HEAD_SHA) {
  console.error('Error: Missing required environment variables');
  process.exit(1);
}

// Function to execute shell commands
function runCommand(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(error.message);
    process.exit(1);
  }
}

// Get PR diff
function getPRDiff(baseSha, headSha) {
  console.log(`🔍 Generating diff: ${baseSha}...${headSha}`);
  const diff = runCommand(`git diff ${baseSha}...${headSha} --unified=3 --no-color`);
  return diff;
}

// Find documentation files
function findDocumentationFiles() {
  const docFiles = [];
  
  // Add README.md if it exists
  if (fs.existsSync('README.md')) {
    docFiles.push('README.md');
  }
  
  // Add all files under docs/
  if (fs.existsSync('docs') && fs.statSync('docs').isDirectory()) {
    const findAllFiles = (dir) => {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          findAllFiles(filePath);
        } else {
          docFiles.push(filePath);
        }
      });
    };
    findAllFiles('docs');
  }
  
  return docFiles.sort();
}

// Read documentation content
function readDocumentation(docFiles) {
  const docsContent = {};
  docFiles.forEach(filePath => {
    try {
      docsContent[filePath] = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.warn(`Warning: Could not read ${filePath}: ${error.message}`);
    }
  });
  return docsContent;
}

// Call Claude API
function callLLM(prDiff, docsContent) {
  return new Promise((resolve, reject) => {
    const docsText = Object.entries(docsContent)
      .map(([path, content]) => `=== ${path} ===\n${content}`)
      .join('\n\n');

    const prompt = `You are a documentation drift detector. Your job is to analyze code changes in a pull request and identify documentation that needs updating.

<PR_DIFF>
${prDiff}
</PR_DIFF>

<CURRENT_DOCUMENTATION>
${docsText}
</CURRENT_DOCUMENTATION>

Instructions:
1. Analyze the code diff carefully
2. Identify documentation sections that are now outdated or incorrect due to the code changes
3. Only suggest changes that are CLEARLY implied by the code diff
4. If you're not confident about a change, don't suggest it
5. Focus on concrete, actionable suggestions

Return your analysis as valid JSON matching this exact structure:
{
  "total_suggestions": <number>,
  "suggestions": [
    {
      "doc_path": "<path to documentation file>",
      "start_line": <approximate line number where change starts>,
      "end_line": <approximate line number where change ends>,
      "before": "<current text that needs updating>",
      "after": "<suggested new text>",
      "rationale": "<explanation tied to specific changes in the PR diff>"
    }
  ]
}

Return ONLY the JSON object, no other text.`;

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          let responseText = result.content[0].text.trim();

          // Strip markdown code blocks
          if (responseText.startsWith('```json')) {
            responseText = responseText.slice(7);
          }
          if (responseText.startsWith('```')) {
            responseText = responseText.slice(3);
          }
          if (responseText.endsWith('```')) {
            responseText = responseText.slice(0, -3);
          }
          responseText = responseText.trim();

          const parsed = JSON.parse(responseText);
          resolve(parsed);
        } catch (error) {
          reject(new Error(`Error parsing response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`API request failed: ${error.message}`));
    });

    req.write(requestBody);
    req.end();
  });
}

// Generate git patch file
function generatePatchFile(result, docsContent) {
  if (result.total_suggestions === 0) {
    return;
  }
  
  const suggestions = result.suggestions || [];
  const patchesByFile = {};
  
  // Group suggestions by file
  suggestions.forEach(suggestion => {
    const filePath = suggestion.doc_path;
    if (!patchesByFile[filePath]) {
      patchesByFile[filePath] = [];
    }
    patchesByFile[filePath].push(suggestion);
  });
  
  let patchContent = '';
  
  // Generate unified diff format for each file
  Object.entries(patchesByFile).forEach(([filePath, fileSuggestions]) => {
    const originalContent = docsContent[filePath];
    if (!originalContent) return;
    
    let modifiedContent = originalContent;
    
    // Apply all suggestions to this file
    fileSuggestions.forEach(suggestion => {
      modifiedContent = modifiedContent.replace(suggestion.before, suggestion.after);
    });
    
    // Generate unified diff
    const originalLines = originalContent.split('\n');
    const modifiedLines = modifiedContent.split('\n');
    
    patchContent += `diff --git a/${filePath} b/${filePath}\n`;
    patchContent += `--- a/${filePath}\n`;
    patchContent += `+++ b/${filePath}\n`;
    
    // Simple diff generation
    let hunkStart = -1;
    let hunkLines = [];
    
    for (let i = 0; i < Math.max(originalLines.length, modifiedLines.length); i++) {
      const origLine = originalLines[i] || '';
      const modLine = modifiedLines[i] || '';
      
      if (origLine !== modLine) {
        if (hunkStart === -1) {
          hunkStart = Math.max(0, i - 3);
        }
        if (originalLines[i] !== undefined) {
          hunkLines.push(`-${origLine}`);
        }
        if (modifiedLines[i] !== undefined) {
          hunkLines.push(`+${modLine}`);
        }
      } else if (hunkStart !== -1 && i - hunkStart < 10) {
        hunkLines.push(` ${origLine}`);
      }
    }
    
    if (hunkLines.length > 0) {
      patchContent += `@@ -${hunkStart + 1},${originalLines.length} +${hunkStart + 1},${modifiedLines.length} @@\n`;
      patchContent += hunkLines.join('\n') + '\n';
    }
    
    patchContent += '\n';
  });
  
  fs.writeFileSync('docs_drift.patch', patchContent);
  console.log('  → Generated patch file: docs_drift.patch');
}

// Generate markdown report with enhanced UI
function generateReport(result) {
  const total = result.total_suggestions || 0;
  const suggestions = result.suggestions || [];

  if (total === 0) {
    return `# 📄 Documentation Drift Check

✅ **No documentation drift detected**

All documentation appears to be up-to-date with the code changes in this PR.
`;
  }

  let report = `# 📄 Documentation Drift Check

⚠️ **Suggested Documentation Edits: ${total}**

The following documentation updates are recommended based on the code changes in this PR:

---

`;

  suggestions.forEach((suggestion, i) => {
    const lineRange = suggestion.start_line === suggestion.end_line
      ? `line ${suggestion.start_line}`
      : `lines ${suggestion.start_line}-${suggestion.end_line}`;

    report += `### ${i + 1}. \`${suggestion.doc_path}\` (${lineRange})

**Rationale:** ${suggestion.rationale}

<details>
<summary><b>📋 View Current Text</b></summary>

\`\`\`
${suggestion.before}
\`\`\`

</details>

<details>
<summary><b>✅ View Suggested Change (Click to Copy)</b></summary>

\`\`\`
${suggestion.after}
\`\`\`

**To apply:** Replace the content in \`${suggestion.doc_path}\` at ${lineRange} with the text above.

</details>

<details>
<summary><b>🔄 View Side-by-Side Comparison</b></summary>

**Before:**
\`\`\`diff
- ${suggestion.before.split('\n').join('\n- ')}
\`\`\`

**After:**
\`\`\`diff
+ ${suggestion.after.split('\n').join('\n+ ')}
\`\`\`

</details>

---

`;
  });

  // Add quick apply section
  report += `
## 💡 How to Apply These Changes

### Option 1: Manual Copy-Paste
1. Click "✅ View Suggested Change" for each suggestion above
2. Copy the suggested text
3. Replace the corresponding section in your file
4. Commit and push

### Option 2: Download Patch File
1. Download \`docs-drift-patch\` from the artifacts section below
2. Extract and run:
   \`\`\`bash
   git apply docs_drift.patch
   \`\`\`

### Option 3: Edit Directly on GitHub
1. Go to the file mentioned in each suggestion
2. Click the pencil icon (✏️) to edit
3. Apply the changes
4. Commit directly to this branch
`;

  return report;
}

// Main execution
async function main() {
  console.log('🔍 Detecting documentation drift...');

  // Get PR diff
  const prDiff = getPRDiff(BASE_SHA, HEAD_SHA);

  if (!prDiff.trim()) {
    console.log('  → No code changes detected');
    fs.writeFileSync('docs_drift_count.txt', '0');
    fs.writeFileSync('docs_drift_report.md', generateReport({ total_suggestions: 0, suggestions: [] }));
    console.log('✅ Complete: 0 suggestion(s) detected');
    return;
  }

  // Find and read documentation
  console.log('  → Finding documentation files...');
  const docFiles = findDocumentationFiles();
  console.log(`  → Found ${docFiles.length} documentation file(s)`);

  if (docFiles.length === 0) {
    console.log('  → No documentation files found');
    fs.writeFileSync('docs_drift_count.txt', '0');
    fs.writeFileSync('docs_drift_report.md', generateReport({ total_suggestions: 0, suggestions: [] }));
    console.log('✅ Complete: 0 suggestion(s) detected');
    return;
  }

  const docsContent = readDocumentation(docFiles);

  // Call LLM
  console.log('  → Analyzing with Claude...');
  const result = await callLLM(prDiff, docsContent);

  // Write outputs
  const totalSuggestions = result.total_suggestions || 0;
  fs.writeFileSync('docs_drift_count.txt', totalSuggestions.toString());
  
  // Generate patch file
  generatePatchFile(result, docsContent);
  
  // Generate report
  fs.writeFileSync('docs_drift_report.md', generateReport(result));

  console.log(`✅ Complete: ${totalSuggestions} suggestion(s) detected`);
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
